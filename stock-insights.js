const {all,allow,integer}=require('./db');
const {bounds,shift,localParts,csvLine,decimal}=require('./reports');
const {expiryInfo}=require('./expiry.mjs');
const {portion}=require('./amount');

const dayDistance=(from,to)=>Math.max(0,Math.round((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000));
function analyzeStock(actor,query=new URLSearchParams()) {
  allow(actor,'reports');
  const idleDays=query.has('idleDays')?integer(Number(query.get('idleDays')),'Dias sem saída',7,365):30;
  const today=localParts(Date.now()).day;
  const [recentStart,end]=bounds(shift(today,-29),today);
  const [previousStart]=bounds(shift(today,-59),today);
  const [longStart]=bounds(shift(today,-89),today);
  const products=all(`SELECT p.id,p.code,p.name,p.category,p.price,p.cost,p.stock,p.stock_value,p.active,p.expires_on,
    COALESCE(r.reserved,0) reserved FROM products p LEFT JOIN (
      SELECT i.product_id,SUM(i.quantity) reserved FROM items i JOIN orders o ON o.id=i.order_id
      WHERE o.status='open' GROUP BY i.product_id
    ) r ON r.product_id=p.id`);
  const sales=all(`WITH returned AS (SELECT item_id,SUM(quantity) units FROM return_items GROUP BY item_id)
    SELECT i.product_id,MAX(o.ended_at) last_sale,MIN(o.ended_at) first_sale,
      SUM(CASE WHEN o.ended_at>=? THEN i.quantity-COALESCE(r.units,0) ELSE 0 END) recent_units,
      SUM(CASE WHEN o.ended_at>=? AND o.ended_at<? THEN i.quantity-COALESCE(r.units,0) ELSE 0 END) previous_units,
      SUM(CASE WHEN o.ended_at>=? THEN i.quantity-COALESCE(r.units,0) ELSE 0 END) units_90
    FROM items i JOIN orders o ON o.id=i.order_id LEFT JOIN returned r ON r.item_id=i.id
    WHERE o.status='closed' AND o.ended_at<? AND i.quantity>COALESCE(r.units,0)
    GROUP BY i.product_id`,recentStart,previousStart,recentStart,longStart,end);
  const cycles=all(`WITH last_zero AS (
      SELECT product_id,MAX(id) id FROM stock_moves WHERE after=0 AND created_at<? GROUP BY product_id
    ) SELECT m.product_id,MIN(m.created_at) stock_since FROM stock_moves m
    LEFT JOIN last_zero z ON z.product_id=m.product_id
    WHERE m.after>0 AND m.id>COALESCE(z.id,0) AND m.created_at<? GROUP BY m.product_id`,end,end);
  const sold=new Map(sales.map(row=>[row.product_id,row]));
  const stocked=new Map(cycles.map(row=>[row.product_id,row.stock_since]));
  const partners=products.filter(product=>product.active && product.stock>product.reserved && !expiryInfo(product,today).blocked && (sold.get(product.id)?.recent_units || 0)>=3)
    .sort((a,b)=>sold.get(b.id).recent_units-sold.get(a.id).recent_units);
  const rows=products.filter(product=>product.stock>0).map(product=>{
    const sale=sold.get(product.id);
    const stockSince=stocked.get(product.id) || null;
    const stockDay=stockSince?localParts(stockSince).day:null;
    const saleDay=sale?.last_sale?localParts(sale.last_sale).day:null;
    const idleSince=stockDay?(saleDay && saleDay>stockDay?saleDay:stockDay):null;
    const idle=idleSince?dayDistance(idleSince,today):null;
    const observed=stockDay?Math.min(30,dayDistance(stockDay,today)+1):30;
    const available=Math.max(0,product.stock-product.reserved);
    const recent=sale?.recent_units || 0,previous=sale?.previous_units || 0;
    const daily=recent/30;
    const coverage=recent?Math.ceil(available/daily):null;
    const decline=previous>=5 && observed===30 && recent<=previous/2;
    const change=previous?Math.round((recent-previous)*100/previous):null;
    const expiry=expiryInfo(product,today);
    const signals=[],suggestions=[];
    let priority=0;
    const add=(type,title,evidence,score)=>{signals.push({type,title,evidence});priority=Math.max(priority,score);};
    const cost=product.stock_value==null?null:portion(product.stock_value,available,product.stock);
    if (expiry.blocked) {
      add('blocked',expiry.status==='expired'?'Produto vencido':'Validade pendente',expiry.label,100);
      suggestions.push(expiry.status==='expired'?'Separe as unidades vencidas e registre a perda por validade.':'Confira o rótulo e regularize a validade antes de disponibilizar o produto.');
    } else if (expiry.days!=null && expiry.days<=30 && available>0) {
      add('expiry','Validade próxima',expiry.label,expiry.days<=7?95:80);
      suggestions.push('Priorize a exposição e a saída deste produto dentro da validade.');
      const projected=Math.floor(daily*(expiry.days+1));
      if (observed>=7 && recent>=3 && available>projected) suggestions.push(`Ao ritmo recente, cerca de ${available-projected} unidades livres podem sobrar ao vencer. Reveja novas compras e teste uma oferta antes da data.`);
    }
    if (!stockDay) add('history_missing','Histórico de estoque incompleto','Sem registro do início do saldo atual; o tempo parado não pode ser confirmado.',25);
    if (available>0 && idle!=null && idle>=idleDays) {
      add('stagnant','Estoque parado',`${idle} dias sem saída no ciclo atual de estoque; ${available} unidades livres.`,70+Math.min(15,Math.floor(idle/30)));
      if (!expiry.blocked && product.active) suggestions.push('Mude a posição na loja e destaque o produto no atendimento por uma semana; depois compare as saídas.');
    }
    if (available>0 && coverage!=null && coverage>=90 && observed>=14 && recent>=3) {
      add('excess','Cobertura alta',`${available} unidades livres para cerca de ${coverage} dias ao ritmo recente.`,60);
      if (!expiry.blocked) suggestions.push('Reduza ou pause novas compras até diminuir o saldo livre.');
    }
    if (decline && available>0) {
      add('decline','Queda nas vendas',`${recent} unidades nos últimos 30 dias, contra ${previous} nos 30 dias anteriores (${change}%).`,65);
      if (!expiry.blocked && product.active) suggestions.push('Confira a exposição e o preço em relação aos produtos semelhantes da própria loja; teste uma mudança por vez.');
    }
    if (!product.active && available>0 && !expiry.blocked) {
      add('inactive','Produto inativo com saldo',`${available} unidades livres fora do catálogo de vendas.`,55);
      suggestions.push('Confira por que o produto está inativo e avalie reativá-lo se estiver próprio para venda.');
    }
    const actionable=signals.some(signal=>['stagnant','excess','decline','expiry'].includes(signal.type));
    let promotion=null;
    if (actionable && available>0 && product.active && !expiry.blocked) {
      const partner=partners.find(item=>item.id!==product.id && item.category.toLocaleLowerCase('pt-BR')===product.category.toLocaleLowerCase('pt-BR') && sold.get(item.id).recent_units>recent);
      if (partner) suggestions.push(`Avalie um combo com ${partner.name}, da mesma categoria, que vendeu ${sold.get(partner.id).recent_units} unidades líquidas nos últimos 30 dias. Confira se os produtos combinam e preserve a margem do conjunto.`);
      if (product.cost!=null && product.price>product.cost) {
        const discount=Math.min(Math.floor(product.price*0.1),Math.floor((product.price-product.cost)*0.5));
        if (discount>0) {
          promotion={discount,price:product.price-discount};
          suggestions.push('Se fizer sentido para a loja, teste um desconto pequeno. O preço de teste mantém parte da margem bruta; confira impostos, taxas e despesas antes de aplicar.');
        }
      } else if (product.cost==null) suggestions.push('Cadastre o custo antes de avaliar descontos.');
      else suggestions.push('O preço atual não cobre uma margem bruta positiva. Revise custo e preço antes de oferecer desconto.');
    }
    return {id:product.id,code:product.code,name:product.name,category:product.category,active:!!product.active,
      stock:product.stock,reserved:product.reserved,available,cost_value:cost,stock_since:stockSince,last_sale:sale?.last_sale || null,
      idle_days:idle,observed_days:observed,recent_units:recent,previous_units:previous,units_90:sale?.units_90 || 0,
      coverage_days:coverage,change_percent:change,expiry,signals,suggestions:[...new Set(suggestions)],promotion,priority,
      confidence:!stockDay?'insufficient':observed<14 || recent<3?'limited':'observed'};
  }).sort((a,b)=>b.priority-a.priority || (b.cost_value || 0)-(a.cost_value || 0) || a.name.localeCompare(b.name,'pt-BR'));
  const attention=rows.filter(row=>row.signals.length);
  const stagnant=rows.filter(row=>row.signals.some(signal=>signal.type==='stagnant'));
  const recentUnits=sales.reduce((sum,row)=>sum+row.recent_units,0);
  const previousUnits=sales.reduce((sum,row)=>sum+row.previous_units,0);
  const firstObserved=cycles.map(row=>row.stock_since).concat(sales.map(row=>row.first_sale)).filter(Boolean).sort()[0];
  return {generated_at:new Date(Date.now()).toISOString(),today,idle_days:idleDays,mode:'local',
    period:{start:shift(today,-29),end:today,previous_start:shift(today,-59),previous_end:shift(today,-30)},
    summary:{stocked_products:rows.length,attention:attention.length,stagnant:stagnant.length,
      stagnant_units:stagnant.reduce((sum,row)=>sum+row.available,0),
      stagnant_cost:stagnant.some(row=>row.cost_value==null)?null:stagnant.reduce((sum,row)=>sum+row.cost_value,0),
      missing_cost:stagnant.filter(row=>row.cost_value==null).length,
      recent_units:recentUnits,previous_units:previousUnits,
      sales_change_percent:previousUnits?Math.round((recentUnits-previousUnits)*100/previousUnits):null,
      history_days:firstObserved?dayDistance(localParts(firstObserved).day,today)+1:0,
      blocked:rows.filter(row=>row.expiry.blocked).length},rows};
}
function insightsCsv(report) {
  const rows=[['Código','Produto','Categoria','Estoque','Reservado','Livre','Dias sem saída','Última venda','Vendas 30 dias','Vendas 30 dias anteriores','Cobertura (dias)','Custo livre (R$)','Preço de teste (R$)','Desconto de teste (R$)','Sinais','Dicas']];
  for (const row of report.rows.filter(row=>row.signals.length)) rows.push([row.code,row.name,row.category,row.stock,row.reserved,row.available,
    row.idle_days,row.last_sale,row.recent_units,row.previous_units,row.coverage_days,row.cost_value==null?'':decimal(row.cost_value),row.promotion?decimal(row.promotion.price):'',row.promotion?decimal(row.promotion.discount):'',
    row.signals.map(signal=>signal.title+': '+signal.evidence).join(' | '),row.suggestions.join(' | ')]);
  return rows.map(csvLine).join('\r\n');
}
module.exports={analyzeStock,insightsCsv};
