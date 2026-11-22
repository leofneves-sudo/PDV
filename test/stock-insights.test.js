const {test,mock}=require('node:test');
const assert=require('node:assert/strict');
process.env.PDV_DB=':memory:';
process.env.PDV_TIMEZONE='America/Sao_Paulo';
const {db,get,run,idOf}=require('../db');
const ops=require('../operations');
const {analyzeStock,insightsCsv}=require('../stock-insights');
const {shift}=require('../reports');
const fixed='2026-11-22T15:00:00.000Z';
mock.method(Date,'now',()=>Date.parse(fixed));
run("INSERT INTO users(id,username,name,password,role) VALUES(1,'admin','Administrador','test','admin')");
run("INSERT INTO cards(id,number,token) VALUES(1,1,'test-card')");
const actor={id:1,name:'Administrador',role:'admin'};
const at=days=>shift('2026-11-22',days)+'T12:00:00.000Z';
let serial=0,cardSerial=100;
function product({age=60,...extra}={}) {
  const result=ops.saveProduct(actor,{code:'TEST'+(++serial),name:'Produto '+serial,category:'TCG',stock:10,minimum:0,price:1000,cost:400,...extra});
  run('UPDATE stock_moves SET created_at=? WHERE product_id=?',at(-age),result.id);
  return result;
}
function sale(product,quantity,days,{status='closed',returned=0}={}) {
  const number=++cardSerial;
  const card=idOf(run('INSERT INTO cards(number,token) VALUES(?,?)',number,'card-'+number));
  const order=idOf(run(`INSERT INTO orders(card_id,status,user_id,opened_name,opened_at,ended_at) VALUES(?,?,1,'Administrador',?,?)`,card,status,at(days),at(days)));
  const item=idOf(run('INSERT INTO items(order_id,product_id,name,code,category,quantity,price,cost) VALUES(?,?,?,?,?,?,?,?)',order,product.id,product.name,product.code,product.category,quantity,product.price,product.cost));
  if (returned) {
    const refund=idOf(run("INSERT INTO returns(order_id,amount,reason,created_at,user_id,user_name) VALUES(?,?,'Devolução',?,1,'Administrador')",order,returned*product.price,at(0)));
    run('INSERT INTO return_items(return_id,item_id,quantity,amount,restock) VALUES(?,?,?,?,1)',refund,item,returned,returned*product.price);
  }
  return {order,item};
}
const rowFor=id=>analyzeStock(actor).rows.find(row=>row.id===id);

test('sem dados, o monitor não inventa produtos nem recomendações',()=>{
  const report=analyzeStock(actor);
  assert.equal(report.mode,'local');
  assert.equal(report.rows.length,0);
  assert.equal(report.summary.recent_units,0);
  assert.equal(report.summary.stagnant,0);
});

test('identifica produto parado e preserva produtos novos e saídas recentes',()=>{
  const old=product();
  const fresh=product({age:5});
  const moving=product();
  sale(moving,3,-1);
  assert.equal(rowFor(old.id).idle_days,60);
  assert.ok(rowFor(old.id).signals.some(signal=>signal.type==='stagnant'));
  assert.equal(rowFor(fresh.id).idle_days,5);
  assert.ok(!rowFor(fresh.id).signals.some(signal=>signal.type==='stagnant'));
  assert.equal(rowFor(moving.id).idle_days,1);
  assert.ok(!rowFor(moving.id).signals.some(signal=>signal.type==='stagnant'));
  const threshold=analyzeStock(actor,new URLSearchParams({idleDays:'90'}));
  assert.ok(!threshold.rows.find(row=>row.id===old.id).signals.some(signal=>signal.type==='stagnant'));
});

test('nova entrada depois de zerar reinicia a observação de estoque',()=>{
  const item=product({age:100});
  sale(item,10,-80);
  for (const [days,before,after,amount] of [[-6,10,0,-10],[-5,0,10,10]]) run(`INSERT INTO stock_moves(product_id,amount,before,after,reason,kind,user_id,user_name,created_at)
    VALUES(?,?,?,?,'Conferência','adjustment',1,'Administrador',?)`,item.id,amount,before,after,at(days));
  const row=rowFor(item.id);
  assert.equal(row.idle_days,5);
  assert.equal(row.stock_since,at(-5));
  assert.ok(!row.signals.some(signal=>signal.type==='stagnant'));
});

test('cálculo desconta devoluções e ignora comandas abertas, canceladas e estornadas',()=>{
  const item=product();
  sale(item,6,-2,{returned:2});
  sale(item,8,-1,{returned:8});
  sale(item,12,-35);
  sale(item,100,-3,{status:'cancelled'});
  sale(item,100,-4,{status:'refunded'});
  sale(item,2,-5,{status:'open'});
  const row=rowFor(item.id);
  assert.equal(row.recent_units,4);
  assert.equal(row.previous_units,12);
  assert.equal(row.last_sale,at(-2));
  assert.equal(row.change_percent,-67);
  assert.ok(row.signals.some(signal=>signal.type==='decline'));
});

test('estoque reservado não entra no capital parado nem nas unidades para oferta',()=>{
  const item=product({stock:10});
  sale(item,3,-1,{status:'open'});
  const row=rowFor(item.id);
  assert.equal(row.stock,10);
  assert.equal(row.reserved,3);
  assert.equal(row.available,7);
  assert.equal(row.cost_value,2800);
  const allReserved=product({stock:4});
  sale(allReserved,4,-1,{status:'open'});
  assert.ok(!rowFor(allReserved.id).signals.some(signal=>signal.type==='stagnant'));
  assert.equal(rowFor(allReserved.id).promotion,null);
});

test('produtos vencidos, sem validade obrigatória e inativos não recebem promoção',()=>{
  const expired=product({category:'Bebidas',expires_on:'2026-11-21'});
  const missing=product({category:'Bebidas',expires_on:'2027-01-01'});
  run('UPDATE products SET expires_on=NULL WHERE id=?',missing.id);
  const inactive=product({active:false});
  for (const item of [expired,missing]) {
    const row=rowFor(item.id);
    assert.ok(row.signals.some(signal=>signal.type==='blocked'));
    assert.equal(row.promotion,null);
    assert.ok(row.suggestions.every(tip=>!/combo|oferta|desconto/i.test(tip)));
  }
  assert.equal(rowFor(inactive.id).promotion,null);
  assert.ok(rowFor(inactive.id).suggestions.some(tip=>/inativo/.test(tip)));
});

test('cobertura usa janela de 30 dias e combos usam produtos de saída comprovada',()=>{
  const slow=product({name:'Carta parada',category:'Colecionáveis',stock:30});
  const popular=product({name:'Pacote popular',category:'Colecionáveis'});
  sale(slow,3,-20);
  sale(popular,12,-1);
  const row=rowFor(slow.id);
  assert.equal(row.coverage_days,300);
  assert.ok(row.signals.some(signal=>signal.type==='excess'));
  assert.ok(row.suggestions.some(tip=>tip.includes('Pacote popular') && tip.includes('12 unidades')));
  assert.ok(row.promotion.price>slow.cost);
  assert.ok(row.promotion.discount<=Math.floor(slow.price/10));
  const noCost=product({cost:null});
  assert.equal(rowFor(noCost.id).promotion,null);
  assert.ok(rowFor(noCost.id).suggestions.some(tip=>tip.includes('Cadastre o custo')));
});

test('ausência de movimentos não produz uma idade fictícia para o estoque',()=>{
  const item=product({stock:0});
  run('UPDATE products SET stock=10 WHERE id=?',item.id);
  const row=rowFor(item.id);
  assert.equal(row.idle_days,null);
  assert.equal(row.confidence,'insufficient');
  assert.ok(!row.signals.some(signal=>signal.type==='stagnant'));
  assert.ok(row.signals.some(signal=>signal.type==='history_missing'));
});

test('exige permissão de relatórios e valida o limite de dias',()=>{
  assert.throws(()=>analyzeStock({id:2,role:'operator',permissions:'{}'}),/permissão/);
  assert.throws(()=>analyzeStock(actor,new URLSearchParams({idleDays:'0'})),/Dias/);
  assert.throws(()=>analyzeStock(actor,new URLSearchParams({idleDays:'abc'})),/Dias/);
});

test('relatório funciona no processador de leitura e a interface escapa nomes de produtos',async()=>{
  const item=product({name:'<script>alert(1)</script>'});
  const result=require('../report-worker').execute('stock-insights',actor,'idleDays=30');
  const report=JSON.parse(result);
  assert.ok(report.rows.some(row=>row.id===item.id));
  assert.match(insightsCsv(report),/Dias sem saída/);
  assert.match(require('../report-worker').execute('stock-insights.csv',actor,''),/Produto/);
  const {stockInsightsView,stockInsightRows,stockInsightSummary}=await import('../views.js');
  const state={stockInsights:report,local:{insightSearch:item.code},me:{permissions:{reports:true,products:true}}};
  const html=stockInsightsView(state);
  assert.match(html,/Análise local, sem envio de dados externos/);
  assert.doesNotMatch(html,/<script>alert/);
  assert.match(html,/&lt;script&gt;/);
  assert.match(stockInsightSummary(state),/Ver análise e dicas/);
  state.local.insightSignal='blocked';
  assert.match(stockInsightRows(state),/Nenhum produto nesta seleção/);
  db.exec('PRAGMA foreign_key_check');
});
