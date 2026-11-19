const {get,all,allow,can,methods,origins}=require('./db');
const {dashboard,range,bounds,shift,where,dimensions,applyDimensions,applyReturnItems,creditWhere,stockRows,pagination,csvLine,decimal}=require('./reports');
const {shiftSummary}=require('./cash');
const labelSource={funded:'Carga de crédito',bonus:'Bonificação',adjustment:'Ajuste autorizado',card_purchase:'Compra de cartas',return:'Restituição do crédito',spend:'Uso de crédito'};
const total=(rows,key='amount')=>rows.reduce((sum,row)=>sum+row[key],0);

function receiptSource(filter,start,end) {
  const payments=where(),deposits=creditWhere(filter,start,end),refunds=where();
  payments.add('p.confirmed_at>=? AND p.confirmed_at<?',start,end);
  deposits.add("l.source='funded' AND l.kind IN ('deposit','deposit_reversal')");
  refunds.add('r.created_at>=? AND r.created_at<?',start,end);
  applyDimensions(payments,filter,{employee:'COALESCE(p.confirmed_by,p.received_by)',turn:'p.shift_id',method:'p.method'});
  applyDimensions(refunds,{...filter,product:null,category:null},{employee:'r.user_id',turn:'r.shift_id',method:'p.method'});
  applyReturnItems(refunds,filter,'r.return_id',true);
  const sql=`
    SELECT 'payment' entity,p.id,p.order_id,p.method,p.amount,p.shift_id,p.confirmed_at at,
      COALESCE(p.confirmed_name,p.received_name) actor,'Pagamento' label
    FROM payments p JOIN orders o ON o.id=p.order_id ${payments.sql()}
    UNION ALL
    SELECT 'ledger',l.id,l.order_id,l.origin,l.amount,l.shift_id,l.created_at,l.user_name,
      CASE l.kind WHEN 'deposit' THEN 'Carga de crédito' ELSE 'Estorno de carga' END
    FROM ledger l LEFT JOIN orders o ON o.id=l.order_id ${deposits.sql()}
    UNION ALL
    SELECT 'reversal',r.id,r.order_id,p.method,-r.amount,r.shift_id,r.created_at,r.user_name,'Devolução'
    FROM payment_reversals r JOIN payments p ON p.id=r.payment_id JOIN orders o ON o.id=r.order_id ${refunds.sql()}`;
  return {sql,args:[...payments.args,...deposits.args,...refunds.args]};
}
function receiptTotals(source) {
  return get(`SELECT COUNT(*) count,
    COALESCE(SUM(CASE WHEN entity='payment' AND method<>'store' THEN amount ELSE 0 END),0) received,
    COALESCE(SUM(CASE WHEN method<>'store' THEN amount ELSE 0 END),0) net FROM (${source.sql})`,...source.args);
}
function receiptPage(source,paging,exporting) {
  return all(`SELECT m.*,r.reviewed,r.reason,r.user_name reviewer,r.created_at reviewed_at
    FROM (${source.sql}) m LEFT JOIN reconciliations r ON r.id=(
      SELECT prev.id FROM reconciliations prev WHERE prev.entity=m.entity AND prev.entity_id=m.id ORDER BY prev.id DESC LIMIT 1
    )
    ORDER BY m.at DESC,m.entity,m.id DESC${exporting?'':' LIMIT ? OFFSET ?'}`,
    ...source.args,...(exporting?[]:[paging.limit,paging.offset])).map(({reviewed,reason,reviewer,reviewed_at,...row})=>({
    ...row,review:reviewed==null?null:{reviewed,reason,user_name:reviewer,created_at:reviewed_at}
  }));
}
function creditEvents(filter,start,end,paging,exporting) {
  const credit=creditWhere(filter,start,end);
  const source=' FROM ledger l LEFT JOIN orders o ON o.id=l.order_id '+credit.sql();
  const aggregate=get(`SELECT COUNT(*) count,
    COALESCE(SUM(CASE WHEN l.kind='deposit' AND l.source='funded' THEN l.amount ELSE 0 END),0) funded,
    COALESCE(SUM(CASE WHEN l.kind='deposit' AND l.source IN ('bonus','adjustment','card_purchase') THEN l.amount ELSE 0 END),0) granted,
    COALESCE(SUM(CASE WHEN l.kind='use' THEN -l.amount ELSE 0 END),0) used ${source}`,...credit.args);
  const rows=all(`SELECT l.id,l.customer_id,l.order_id,l.source,l.amount,l.kind,l.created_at,l.user_name ${source}
    ORDER BY l.created_at DESC,l.id DESC${exporting?'':' LIMIT ? OFFSET ?'}`,...credit.args,...(exporting?[]:[paging.limit,paging.offset]))
    .map(row=>({...row,label:labelSource[row.source]}));
  return {aggregate,rows};
}
function shiftReport(filter,start,end) {
  const conditions=where();
  conditions.add('(s.closed_at IS NULL OR s.closed_at>=? AND s.closed_at<?)',start,end);
  if (filter.employee) conditions.add('s.opened_by=?',filter.employee);
  if (filter.shift) conditions.add('s.id=?',filter.shift);
  if (filter.register) conditions.add('s.register_id=?',filter.register);
  return all(`SELECT s.id,s.opened_at,s.closed_at,s.opened_name,s.opening,s.counted,s.expected,s.difference,r.name register_name
    FROM shifts s JOIN registers r ON r.id=s.register_id ${conditions.sql()} ORDER BY s.id DESC`,...conditions.args)
    .map(row=>({...row,currentExpected:row.closed_at?row.expected:shiftSummary(row).expected}));
}
function replenishment(filter,period,days) {
  const [cutoff,end]=bounds(shift(period.end,1-days),period.end);
  const condition=where();
  condition.add("o.status='closed' AND o.ended_at<?",end);
  applyDimensions(condition,{...filter,category:null,product:null});
  if (filter.product) condition.add('i.product_id=?',filter.product);
  const products=all(`WITH returned AS (SELECT item_id,SUM(quantity) units FROM return_items GROUP BY item_id)
    SELECT i.product_id,MAX(o.ended_at) last,
      SUM(CASE WHEN o.ended_at>=? THEN i.quantity-COALESCE(r.units,0) ELSE 0 END) units
    FROM items i JOIN orders o ON o.id=i.order_id LEFT JOIN returned r ON r.item_id=i.id
    ${condition.sql()} AND i.quantity>COALESCE(r.units,0) GROUP BY i.product_id`,cutoff,...condition.args);
  const sold=new Map(products.map(row=>[row.product_id,row]));
  return stockRows(filter).map(row=>{
    const sales=sold.get(row.id);
    const units=sales?.units || 0;
    return {...row,last:sales?.last ?? null,units,suggested:Math.max(0,Math.max(row.minimum,units)-row.available)};
  });
}
function operatorReport(filter,start,end,paging,exporting) {
  const condition=where();
  condition.add("a.action IN ('comanda.desconto','comanda.cancelada') AND a.created_at>=? AND a.created_at<?",start,end);
  applyDimensions(condition,filter,{employee:'a.user_id',turn:`COALESCE(
    (SELECT s.id FROM shifts s WHERE s.opened_by=a.user_id AND s.opened_at<=a.created_at AND (s.closed_at IS NULL OR s.closed_at>=a.created_at) ORDER BY s.id DESC LIMIT 1),
    o.closed_shift_id)`});
  const source=`FROM audit a LEFT JOIN orders o ON o.id=a.entity_id ${condition.sql()}`;
  const operators=all(`SELECT a.user_name name,
    SUM(CASE WHEN a.action='comanda.cancelada' THEN 1 ELSE 0 END) cancellations,
    SUM(CASE WHEN a.action='comanda.desconto' THEN COALESCE(json_extract(a.after,'$.discount'),0)-COALESCE(json_extract(a.before,'$.discount'),0) ELSE 0 END) discounts
    ${source} GROUP BY a.user_id,a.user_name ORDER BY a.user_name`,...condition.args);
  const count=total(operators,'cancellations')+get(`SELECT COUNT(*) n ${source} AND a.action='comanda.desconto'`,...condition.args).n;
  const audits=all(`SELECT a.id,a.action,a.user_name,a.created_at,a.entity_id,a.reason,a.approved_name ${source}
    ORDER BY a.id DESC${exporting?'':' LIMIT ? OFFSET ?'}`,...condition.args,...(exporting?[]:[paging.limit,paging.offset]));
  return {operators,audits,count};
}
function management(actor,query,exporting=false) {
  allow(actor,'reports');
  const period=range(query),filter=dimensions(query);
  const [start,end]=bounds(period.start,period.end);
  const [prevStart]=bounds(period.previousStart,period.previousEnd);
  const page=pagination(query,100);
  const source=receiptSource(filter,start,end);
  const receipts=receiptTotals(source);
  const previous=receiptTotals(receiptSource(filter,prevStart,start));
  const shifts=shiftReport(filter,start,end);
  const credit=creditEvents(filter,start,end,page,exporting);
  const audit=operatorReport(filter,start,end,page,exporting);
  const stockDays=/^\d+$/.test(query.get('stockDays') || '')?Math.min(730,Math.max(1,Number(query.get('stockDays')))):30;
  const stock=replenishment(filter,period,stockDays);
  const sales=dashboard(actor,query);
  const ranked=sales.products.filter(row=>row.amount>0);
  const revenue=total(ranked);
  let cumulative=0;
  const abc=ranked.map(row=>{
    const band=cumulative*100<revenue*80?'A':cumulative*100<revenue*95?'B':'C';
    cumulative+=row.amount;
    return {...row,band,share:cumulative*100/revenue};
  });
  return {period,stockDays,page:page.page,pageSize:page.limit,
    total:Math.max(receipts.count,credit.aggregate.count,audit.count),
    receiptsCount:receipts.count,creditCount:credit.aggregate.count,auditCount:audit.count,
    indicators:{grossSales:sales.indicators.grossSales,netSales:sales.indicators.netSales,refundValue:sales.indicators.refundValue,
      receipts:receipts.received,previousReceipts:previous.received,netFinancial:receipts.net,
      cashExpected:total(shifts.filter(row=>!row.closed_at),'currentExpected'),difference:total(shifts.filter(row=>row.closed_at),'difference'),
      funded:credit.aggregate.funded,granted:credit.aggregate.granted,used:credit.aggregate.used},
    receipts:receiptPage(source,page,exporting),shifts,credit:credit.rows,abc,stock,operators:audit.operators,audits:audit.audits,
    canReconcile:can(actor,'reconcile')};
}
function managementCsv(report) {
  const rows=[['Seção','Registro','Data','Descrição','Forma','Valor','Turno','Operador']];
  for (const [key,label] of [['grossSales','Vendas brutas do período'],['refundValue','Devoluções pela data da ocorrência'],
    ['netSales','Líquido atualizado das vendas originais']]) rows.push(['Indicadores','','',label,'',decimal(report.indicators[key]),'','']);
  for (const row of report.receipts) rows.push(['Recebimentos',row.id,row.at,row.label,methods[row.method] || origins[row.method],decimal(row.amount),row.shift_id,row.actor]);
  for (const row of report.credit) rows.push(['Créditos',row.id,row.created_at,row.label,row.kind,decimal(row.amount),'',row.user_name]);
  for (const row of report.shifts) rows.push(['Caixa',row.id,row.closed_at || row.opened_at,row.register_name,row.closed_at?'Diferença':'Dinheiro esperado',decimal(row.closed_at?row.difference:row.currentExpected),row.id,row.opened_name]);
  for (const row of report.abc) rows.push(['Curva ABC','',null,row.name,row.band,decimal(row.amount),'',null]);
  for (const row of report.stock) rows.push(['Estoque',row.id,row.last,row.name,`Disponível: ${row.available}`,row.suggested,null,null]);
  for (const row of report.operators) rows.push(['Operadores',null,null,`${row.cancellations} cancelamentos`,'Descontos',decimal(row.discounts),null,row.name]);
  return rows.map(csvLine).join('\r\n');
}
module.exports={management,managementCsv};
