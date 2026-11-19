const {db,get,all,fail,allow,can,integer,methods,origins}=require('./db');
const {allocate}=require('./amount');
const {dateValue,recentShift}=require('./operations');

const timezone=process.env.PDV_TIMEZONE || 'America/Sao_Paulo';
const dateFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'});
function localParts(date) {
  const parts=Object.fromEntries(dateFormatter.formatToParts(new Date(date)).map(part=>[part.type,part.value]));
  return {day:`${parts.year}-${parts.month}-${parts.day}`,hour:parts.hour};
}
function shift(day,count) {
  const instant=new Date(`${day}T00:00:00Z`);
  instant.setUTCDate(instant.getUTCDate()+count);
  return instant.toISOString().slice(0,10);
}
function range(query) {
  const period=query.get('period') || 'today';
  const today=localParts(Date.now()).day;
  let start=today,end=today;
  if (period==='yesterday') start=end=shift(today,-1);
  else if (period==='week') start=shift(today,-6);
  else if (period==='month') start=`${today.slice(0,7)}-01`;
  else if (period==='custom') {
    start=dateValue(query.get('start'),'Data inicial');
    end=dateValue(query.get('end'),'Data final');
  } else if (period!=='today') fail('Período inválido.');
  const days=Math.round((new Date(end)-new Date(start))/86400000)+1;
  if (days<1 || days>3660 || start<'1900-01-01' || end>'2100-12-31') fail('Use um período válido de até dez anos.');
  return {start,end,days,previousStart:shift(start,-days),previousEnd:shift(start,-1)};
}
const starts=new Map();
function dayStart(day) {
  if (starts.has(day)) return starts.get(day);
  const utc=Date.parse(`${day}T00:00:00Z`);
  let low=utc-36*3600000,high=utc+36*3600000;
  while (low<high) {
    const mid=Math.floor((low+high)/2);
    if (localParts(mid).day<day) low=mid+1;
    else high=mid;
  }
  const result=new Date(low).toISOString();
  if (starts.size>=512) starts.clear();
  starts.set(day,result);
  return result;
}
function bounds(start,end) {
  return [dayStart(start),dayStart(shift(end,1))];
}
function inside(date,start,end) {
  if (!date) return false;
  const [from,until]=bounds(start,end);
  return date>=from && date<until;
}
function normalize(text) {
  return String(text || '').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();
}
db.function('pdv_text',{deterministic:true},normalize);

function dimensions(query) {
  const id=key=>query.get(key)?integer(Number(query.get(key)),key,1,Number.MAX_SAFE_INTEGER):null;
  return {employee:id('employee'),product:id('product'),register:id('register'),shift:id('shift'),
    category:query.get('category') || null,method:query.get('method') || null};
}
function where() {
  const terms=[],args=[];
  return {
    args,
    add(sql,...params) {terms.push(sql);args.push(...params);},
    sql() {return terms.length?'WHERE '+terms.join(' AND '):'';}
  };
}
function applyDimensions(condition,filter,{employee='o.ended_by',turn='o.closed_shift_id',method='order',stockOnly=false}={}) {
  if (stockOnly) {
    if (filter.product) condition.add('p.id=?',filter.product);
    if (filter.category) condition.add('p.category=?',filter.category);
    return;
  }
  if (filter.employee) condition.add(`${employee}=?`,filter.employee);
  if (filter.shift) condition.add(`${turn}=?`,filter.shift);
  if (filter.register) condition.add(`${turn} IN (SELECT id FROM shifts WHERE register_id=?)`,filter.register);
  // Os filtros selecionam o atendimento inteiro. Os valores de múltiplos itens ou parcelas não são repetidos.
  if (filter.product && filter.category) {
    condition.add('EXISTS(SELECT 1 FROM items i WHERE i.order_id=o.id AND i.product_id=? AND i.category=?)',filter.product,filter.category);
  } else {
    if (filter.product) condition.add('EXISTS(SELECT 1 FROM items i WHERE i.order_id=o.id AND i.product_id=?)',filter.product);
    if (filter.category) condition.add('EXISTS(SELECT 1 FROM items i WHERE i.order_id=o.id AND i.category=?)',filter.category);
  }
  if (filter.method) {
    if (method==='order') condition.add("EXISTS(SELECT 1 FROM payments p WHERE p.order_id=o.id AND p.state='confirmed' AND p.method=?)",filter.method);
    else condition.add(`${method}=?`,filter.method);
  }
}
function applyReturnItems(condition,filter,returnId,optionalLink=false) {
  if (!filter.product && !filter.category) return;
  const tests=[],values=[];
  if (filter.product) {tests.push('i.product_id=?');values.push(filter.product);}
  if (filter.category) {tests.push('i.category=?');values.push(filter.category);}
  const criteria=tests.join(' AND ');
  const block=`EXISTS(SELECT 1 FROM return_items ri JOIN items i ON i.id=ri.item_id WHERE ri.return_id=${returnId} AND ${criteria})`;
  if (optionalLink) condition.add(`(${block} OR ${returnId} IS NULL AND
    EXISTS(SELECT 1 FROM items i WHERE i.order_id=o.id AND ${criteria}))`,...values,...values);
  else condition.add(block,...values);
}
function attach(rows,withReturns=false) {
  const groups=new Map(rows.map(row=>[row.id,{...row,items:[],payments:[],returned:0}]));
  const ids=[...groups.keys()];
  for (let index=0;index<ids.length;index+=500) {
    const batch=ids.slice(index,index+500);
    const params=batch.map(()=>'?').join(',');
    for (const line of all(`SELECT * FROM items WHERE order_id IN (${params}) ORDER BY id`,...batch)) groups.get(line.order_id).items.push(line);
    for (const payment of all(`SELECT * FROM payments WHERE order_id IN (${params}) ORDER BY id`,...batch)) groups.get(payment.order_id).payments.push(payment);
    for (const row of all(`SELECT order_id,SUM(amount) amount FROM returns WHERE order_id IN (${params}) GROUP BY order_id`,...batch)) {
      groups.get(row.order_id).returned=row.amount;
    }
    if (!withReturns) continue;
    const lines=new Map(batch.flatMap(id=>groups.get(id).items.map(line=>[line.id,line])));
    for (const row of all(`SELECT r.item_id,SUM(r.quantity) units,SUM(r.amount) amount,SUM(COALESCE(r.cost_restocked,0)) restored,
      SUM(CASE WHEN r.restock=1 AND r.cost_restocked IS NULL THEN 1 ELSE 0 END) unknown
      FROM items i JOIN return_items r ON r.item_id=i.id WHERE i.order_id IN (${params}) GROUP BY r.item_id`,...batch)) {
      lines.get(row.item_id).returns=row;
    }
    const payments=new Map(batch.flatMap(id=>groups.get(id).payments.map(payment=>[payment.id,payment])));
    for (const row of all(`SELECT r.payment_id,SUM(r.amount) amount
      FROM payments p JOIN payment_reversals r ON r.payment_id=p.id WHERE p.order_id IN (${params}) GROUP BY r.payment_id`,...batch)) {
      payments.get(row.payment_id).refunded=row.amount;
    }
  }
  return [...groups.values()];
}
const ORDER_JOIN='FROM orders o JOIN cards c ON c.id=o.card_id';
function pagination(query,size=50) {
  const requested=Number(query.get('page') || 1);
  const page=Number.isInteger(requested) ? Math.max(1,Math.min(2000000,requested)) : 1;
  return {page,limit:size,offset:(page-1)*size};
}
function history(actor,query,exporting=false) {
  const full=can(actor,'history_all');
  if (!full) allow(actor,'history_own');
  const condition=where();
  condition.add("o.status<>'open'");
  if (!full) condition.add(`(o.closed_shift_id=? OR (o.closed_shift_id IS NULL AND
    (o.ended_session=? OR (o.status='cancelled' AND o.ended_by=?))))`,recentShift(actor),actor.session_id,actor.id);
  const start=query.get('start')?dateValue(query.get('start'),'Data inicial'):null;
  const end=query.get('end')?dateValue(query.get('end'),'Data final'):null;
  if (start && end && start>end) fail('Período inválido.');
  if (start) condition.add('o.ended_at>=?',dayStart(start));
  if (end) condition.add('o.ended_at<?',dayStart(shift(end,1)));
  const status=query.get('status');
  if (status==='sales') condition.add("o.status IN ('closed','refunded')");
  else if (status) condition.add('o.status=?',status);
  const q=normalize(query.get('q')).replace(/^#\s*/,'').trim().slice(0,120);
  if (q) condition.add(`(INSTR(CAST(o.id AS TEXT),?) OR INSTR(CAST(c.number AS TEXT),?) OR INSTR(printf('%03d',c.number),?)
    OR INSTR(pdv_text(o.customer_name),?) OR INSTR(pdv_text(o.ended_name),?))`,q,q,q,q,q);
  applyDimensions(condition,dimensions(query));
  const {page,limit,offset}=pagination(query);
  const from=ORDER_JOIN+' '+condition.sql();
  const total=exporting?null:get('SELECT COUNT(*) n '+from,...condition.args).n;
  const rows=attach(all(`SELECT o.*,c.number,(SELECT s.register_id FROM shifts s WHERE s.id=o.closed_shift_id) register_id ${from}
    ORDER BY o.ended_at DESC,o.id DESC${exporting?'':' LIMIT ? OFFSET ?'}`,...condition.args,...(exporting?[]:[limit,offset])))
    .map(({items,payments,ended_session,...row})=>({
      ...row,returned:row.status==='refunded'?row.total:row.returned,
      units:sum(items,line=>line.quantity),
      methods:[...new Set(payments.filter(payment=>payment.state==='confirmed').map(payment=>payment.method))],
      change:sum(payments.filter(payment=>payment.state==='confirmed'),payment=>payment.change)
    }));
  return {rows,total:total ?? rows.length,page};
}
function increment(map,key,amount,count=0,name=key) {
  const value=map.get(key) || {name,amount:0,count:0};
  value.name=name;
  value.amount+=amount;
  value.count+=count;
  map.set(key,value);
}
const sum=(rows,read)=>rows.reduce((n,row)=>n+read(row),0);
const rank=map=>[...map.values()].sort((a,b)=>b.amount-a.amount || b.count-a.count);
function metrics(sales) {
  const grossSales=sum(sales,row=>row.total);
  const netSales=sum(sales,row=>row.net);
  return {grossSales,netSales,sales:netSales,grossOrders:sales.length,orders:sales.filter(row=>row.status==='closed').length,
    ticket:sales.length?Math.round(netSales/sales.length):0,units:sum(sales,row=>sum(row.items,line=>line.units)),
    averageMinutes:sales.length?Math.round(sum(sales,row=>Math.max(0,Date.parse(row.ended_at)-Date.parse(row.opened_at)))/sales.length/60000):0,
    discounts:sum(sales,row=>row.discount)};
}
function evaluateSales(sales) {
  return sales.map(row=>{
    const discounts=allocate(row.discount,row.items.map(line=>line.quantity*line.price));
    const items=row.items.map((line,index)=>{
      const returned=line.returns;
      const units=row.status==='refunded'?0:line.quantity-(returned?.units || 0);
      const net=row.status==='refunded'?0:line.quantity*line.price-discounts[index]-(returned?.amount || 0);
      const restored=returned?.restored || 0;
      const missing=line.cost_total==null || returned?.unknown || restored>line.cost_total ||
        row.status==='refunded' && returned?.units!==line.quantity;
      return {...line,units,net,netCost:missing?null:line.cost_total-restored};
    });
    return {...row,items,net:row.status==='refunded'?0:row.total-row.returned};
  });
}
function buckets(period) {
  const timeline=new Map();
  if (period.days===1) {
    for (let hour=0;hour<24;hour++) increment(timeline,`${String(hour).padStart(2,'0')}h`,0);
  } else {
    for (let day=period.start;day<=period.end;day=shift(day,1)) {
      const key=period.days>62?day.slice(0,7):day;
      if (!timeline.has(key)) increment(timeline,key,0);
    }
  }
  return timeline;
}
function getReturnEvents(filter,start,end) {
  const actual=where(),legacy=where();
  actual.add('r.created_at>=? AND r.created_at<?',start,end);
  legacy.add("o.status='refunded' AND o.refunded_at>=? AND o.refunded_at<?",start,end);
  legacy.add('NOT EXISTS(SELECT 1 FROM returns r WHERE r.order_id=o.id)');
  applyDimensions(actual,{...filter,product:null,category:null},{employee:'r.user_id',turn:'r.shift_id'});
  applyReturnItems(actual,filter,'r.id');
  applyDimensions(legacy,filter,{employee:'o.refunded_by',turn:'NULL'});
  return [
    ...all(`SELECT r.id,r.amount,r.created_at FROM returns r JOIN orders o ON o.id=r.order_id ${actual.sql()}`,...actual.args),
    ...all(`SELECT o.id,o.total amount,o.refunded_at created_at FROM orders o ${legacy.sql()}`,...legacy.args)
  ];
}
function stockRows(filter) {
  const condition=where();
  condition.add('p.active=1');
  applyDimensions(condition,filter,{stockOnly:true});
  return all(`SELECT p.id,p.code,p.name,p.minimum,p.stock-COALESCE(r.reserved,0) available FROM products p LEFT JOIN
    (SELECT i.product_id,SUM(i.quantity) reserved FROM orders o JOIN items i ON i.order_id=o.id WHERE o.status='open' GROUP BY i.product_id) r
    ON r.product_id=p.id ${condition.sql()} ORDER BY available,p.name`,...condition.args);
}
function creditWhere(filter,start,end) {
  const condition=where();
  condition.add('l.created_at>=? AND l.created_at<?',start,end);
  applyDimensions(condition,filter,{employee:'l.user_id',turn:'l.shift_id',method:'l.origin'});
  return condition;
}

function dashboard(actor,query) {
  allow(actor,'reports');
  const period=range(query), filter=dimensions(query);
  const [start,end]=bounds(period.start,period.end);
  const [earlier]=bounds(period.previousStart,period.previousEnd);
  const selection=where();
  selection.add("o.status IN ('closed','refunded') AND o.ended_at>=? AND o.ended_at<?",earlier,end);
  applyDimensions(selection,filter);
  const originals=evaluateSales(attach(all(`SELECT o.id,o.status,o.customer_id,o.ended_at,o.ended_name,o.ended_by,o.opened_at,o.total,o.discount
    FROM orders o ${selection.sql()} ORDER BY o.id`,...selection.args),true));
  const current=originals.filter(row=>row.ended_at>=start);
  const previous=originals.filter(row=>row.ended_at<start);
  const refunds=getReturnEvents(filter,start,end);
  const cancellation=where();
  cancellation.add("o.status='cancelled' AND o.merged_into IS NULL AND o.ended_at>=? AND o.ended_at<?",start,end);
  applyDimensions(cancellation,filter);
  const cancelled=get(`SELECT COUNT(*) count,COALESCE(SUM(o.total),0) amount FROM orders o ${cancellation.sql()}`,...cancellation.args);
  const opened=where();
  opened.add("o.status='open'");
  applyDimensions(opened,filter,{employee:'o.user_id',turn:'(SELECT s.id FROM shifts s WHERE s.opened_by=o.user_id AND s.closed_at IS NULL)'});
  const open=get(`SELECT COUNT(*) count,COALESCE(SUM((SELECT COALESCE(SUM(i.quantity*i.price),0) FROM items i WHERE i.order_id=o.id)-o.discount),0) amount
    FROM orders o ${opened.sql()}`,...opened.args);

  const staff=new Map(), payments=new Map(), products=new Map(), categories=new Map(), weekdays=new Map(), hours=new Map();
  const timeline=buckets(period);
  const days=['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
  for (const label of days) increment(weekdays,label,0);
  for (let hour=0;hour<24;hour++) increment(hours,`${String(hour).padStart(2,'0')}h`,0);
  const hourParts=new Map();
  for (const row of current) {
    const stamp=row.ended_at;
    if (!hourParts.has(stamp)) hourParts.set(stamp,localParts(stamp));
    const {day,hour}=hourParts.get(stamp);
    const hourLabel=`${hour}h`;
    increment(timeline,period.days===1?hourLabel:period.days>62?day.slice(0,7):day,row.net,1);
    increment(staff,row.ended_by,row.net,1,row.ended_name);
    increment(weekdays,days[new Date(`${day}T00:00:00Z`).getUTCDay()],row.net,1);
    increment(hours,hourLabel,row.net,1);
    for (const payment of row.payments.filter(p=>p.state==='confirmed' && row.status!=='refunded')) {
      increment(payments,methods[payment.method],payment.amount-(payment.refunded || 0),1);
    }
    for (const item of row.items) {
      if (!item.units) continue;
      increment(products,item.product_id,item.net,item.units,`${item.name} · ${item.code}`);
      increment(categories,item.category,item.net,item.units);
    }
  }
  const names=new Map();
  for (const entry of staff.values()) names.set(entry.name,(names.get(entry.name) || 0)+1);
  for (const [id,entry] of staff) if (names.get(entry.name)>1) entry.name+=` · #${id}`;

  const customers=[...new Set(current.map(row=>row.customer_id).filter(Boolean))];
  let newCustomers=0;
  for (let index=0;index<customers.length;index+=500) {
    const batch=customers.slice(index,index+500);
    const first=all(`SELECT MIN(ended_at) at FROM orders WHERE status IN ('closed','refunded') AND customer_id IN
      (${batch.map(()=>'?').join(',')}) GROUP BY customer_id`,...batch);
    newCustomers+=first.filter(row=>row.at>=start && row.at<end).length;
  }
  const scopedCredit=creditWhere(filter,start,end);
  const credit=all(`SELECT l.kind,l.source,l.origin,SUM(l.amount) amount,COUNT(*) count FROM ledger l
    LEFT JOIN orders o ON o.id=l.order_id ${scopedCredit.sql()} GROUP BY l.kind,l.source,l.origin`,...scopedCredit.args);
  const fromCredit=(kind,source)=>Math.abs(sum(credit.filter(row=>row.kind===kind && (!source || row.source===source)),row=>row.amount));
  const deposits=new Map();
  for (const row of credit.filter(entry=>entry.source==='funded' && ['deposit','deposit_reversal'].includes(entry.kind))) {
    increment(deposits,origins[row.origin],row.amount,row.count);
  }
  const soldLines=current.flatMap(row=>row.items);
  const missingCost=soldLines.filter(line=>line.netCost==null).length;
  const currentMetrics=metrics(current);
  const profit=!soldLines.length || missingCost ? null : currentMetrics.netSales-sum(soldLines,line=>line.netCost);
  const lowStock=stockRows(filter).filter(row=>row.available<=row.minimum);
  const refundValue=sum(refunds,row=>row.amount);
  return {
    period,timezone,previous:metrics(previous),timeline:[...timeline.values()],
    indicators:{...currentMetrics,open:open.count,openValue:open.amount,refunds:refunds.length,refundValue,
      cancellations:cancelled.count,cancelledValue:cancelled.amount,newCustomers,returningCustomers:customers.length-newCustomers,lowStock:lowStock.length,
      creditBalance:get('SELECT COALESCE(SUM(amount),0) n FROM ledger').n,deposits:fromCredit('deposit','funded'),
      used:fromCredit('use'),depositReversals:fromCredit('deposit_reversal','funded'),restored:fromCredit('use_reversal'),profit,missingCost,
      margin:profit===null || !currentMetrics.netSales ? null : +(profit/currentMetrics.netSales*100).toFixed(1)},
    staff:rank(staff),payments:rank(payments),products:rank(products),categories:rank(categories),weekdays:[...weekdays.values()],hours:[...hours.values()],
    deposits:rank(deposits),lowStock
  };
}
function filters(actor) {
  const full=can(actor,'history_all') || can(actor,'reports');
  if (!full) allow(actor,'history_own');
  const turns=full ? all('SELECT s.id,s.register_id,s.opened_at,s.opened_name,r.name register_name FROM shifts s JOIN registers r ON r.id=s.register_id ORDER BY s.id DESC')
    : all('SELECT s.id,s.register_id,s.opened_at,s.opened_name,r.name register_name FROM shifts s JOIN registers r ON r.id=s.register_id WHERE s.id=?',recentShift(actor));
  return {employees:full?all('SELECT id,name FROM users ORDER BY name COLLATE NOCASE'):[{id:actor.id,name:actor.name}],
    categories:all('SELECT category FROM products UNION SELECT category FROM items ORDER BY category').map(row=>row.category),
    products:all('SELECT id,code,name FROM products ORDER BY name COLLATE NOCASE'),
    registers:full?all('SELECT id,name FROM registers ORDER BY name COLLATE NOCASE'):
      turns.map(turn=>({id:turn.register_id,name:turn.register_name})),shifts:turns};
}
function csvLine(values) {
  return values.map(value=>{
    let cell=String(value ?? '');
    if (typeof value==='string' && !/^-\d+(?:,\d{2})?$/.test(cell) && /^[\s]*[=+\-@]|^[\t\r\n]/.test(cell)) cell="'"+cell;
    return '"'+cell.replaceAll('"','""')+'"';
  }).join(';');
}
const decimal=cents=>(cents/100).toFixed(2).replace('.',',');
function dashboardCsv(report) {
  const rows=[['Seção','Nome','Valor','Quantidade'],['Período',report.period.start,report.period.end,'']];
  const money=new Set(['grossSales','netSales','sales','ticket','discounts','openValue','refundValue','cancelledValue','creditBalance','deposits','used','depositReversals','restored','profit']);
  const labels={
    grossSales:'Vendas brutas do período',netSales:'Líquido atualizado das vendas originais',grossOrders:'Vendas concluídas',
    orders:'Vendas com saldo',ticket:'Ticket médio líquido',units:'Itens vendidos líquidos',averageMinutes:'Duração média em minutos',
    discounts:'Descontos',open:'Comandas abertas',openValue:'Valor em aberto',refunds:'Ocorrências de devolução',refundValue:'Devoluções pela data da ocorrência',
    cancellations:'Cancelamentos',cancelledValue:'Valor cancelado',newCustomers:'Clientes novos',returningCustomers:'Clientes recorrentes',
    lowStock:'Produtos com estoque baixo',creditBalance:'Saldo total de crédito',deposits:'Créditos adicionados',used:'Créditos utilizados',
    depositReversals:'Recargas estornadas',restored:'Créditos devolvidos',profit:'Lucro bruto atualizado',missingCost:'Linhas sem custo exato',margin:'Margem (%)'
  };
  for (const [section,group] of [['Indicadores',report.indicators],['Período anterior',report.previous]]) {
    for (const [key,value] of Object.entries(group)) if (labels[key]) rows.push([section,labels[key],money.has(key) && value!=null?decimal(value):value,'']);
  }
  for (const [key,label] of Object.entries({timeline:'Evolução líquida',staff:'Funcionários',payments:'Pagamentos',products:'Produtos',
    categories:'Categorias',weekdays:'Dias da semana',hours:'Horários',deposits:'Entradas de crédito'})) {
    for (const row of report[key]) rows.push([label,row.name,decimal(row.amount),row.count]);
  }
  for (const row of report.lowStock) rows.push(['Estoque baixo',row.name,'',row.available]);
  return rows.map(csvLine).join('\r\n');
}
function historyCsv(actor,query) {
  return [
    ['Atendimento','Cartão','Cliente','Status','Abertura','Encerramento','Responsável','Caixa','Turno','Desconto','Total original','Devolvido','Líquido','Troco','Pagamentos'],
    ...history(actor,query,true).rows.map(row=>[row.id,row.number,row.customer_name,
      row.merged_into?'Unida':{closed:'Concluída',cancelled:'Cancelada',refunded:'Estornada'}[row.status],row.opened_at,row.ended_at,row.ended_name,
      row.register_id,row.closed_shift_id,decimal(row.discount),decimal(row.total),decimal(row.returned),row.status==='cancelled'?'':decimal(row.total-row.returned),
      decimal(row.change),row.methods.map(method=>methods[method]).join(' / ')])
  ].map(csvLine).join('\r\n');
}
module.exports={dashboard,filters,history,dashboardCsv,historyCsv,timezone,range,shift,inside,localParts,bounds,where,dimensions,applyDimensions,
  creditWhere,applyReturnItems,stockRows,pagination,csvLine,decimal};
