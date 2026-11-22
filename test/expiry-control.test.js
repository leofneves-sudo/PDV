const {test}=require('node:test');
const assert=require('node:assert/strict');
process.env.PDV_DB=':memory:';
process.env.PDV_TIMEZONE='America/Sao_Paulo';
const {get,all,run,saveUser,session,sha,findSession,randomUUID}=require('../db');
const ops=require('../operations');
const cash=require('../cash');
const finance=require('../finance');
const inventory=require('../inventory');
const intents=require('../intents');
const {expiryInfo,storeDay}=require('../expiry.mjs');
const admin=saveUser(null,{username:'admin',name:'Admin',password:'admin-test-1234',role:'admin'});
const actor=findSession(sha(session(admin)));
cash.openShift(actor,{register:1,opening:0});
let code=0;
function product(expires_on,extra={}) {
  return ops.saveProduct(actor,{code:'P'+(++code),name:'Produto '+code,category:'Bebidas',price:500,cost:100,stock:10,minimum:0,expires_on,...extra});
}
function order() {
  const card=ops.createCards(actor,{start:100+(++code),count:1})[0];
  ops.grantCard(actor.session_id,card.id);
  return ops.openOrder(actor,card.id).order;
}
const now='2026-11-22T15:00:00Z';
function fixed(t) {t.mock.method(Date,'now',()=>Date.parse(now));}

test('faixas de validade usam dias de calendário e o fuso da loja',()=>{
  for (const [date,status,days] of [['2026-11-21','expired',-1],['2026-11-22','today',0],['2026-11-23','critical',1],['2026-11-29','critical',7],['2026-11-30','warning',8],['2026-12-22','warning',30],['2026-12-23','valid',31]]) {
    const info=expiryInfo({category:'Bebidas',expires_on:date},'2026-11-22');
    assert.equal(info.status,status);
    assert.equal(info.days,days);
    assert.equal(info.blocked,days<0);
  }
  assert.equal(expiryInfo({category:'Alimentação'},'2026-11-22').blocked,true);
  assert.equal(expiryInfo({category:'TCG'},'2026-11-22').blocked,false);
  assert.equal(storeDay('2026-11-23T02:59:59Z','America/Sao_Paulo'),'2026-11-22');
  assert.equal(storeDay('2026-11-23T03:00:00Z','America/Sao_Paulo'),'2026-11-23');
});

test('API bloqueia produto vencido e cadastro antigo sem validade; permite o dia da validade',t=>{
  fixed(t);
  const expired=product('2026-11-21');
  const current=product('2026-11-22');
  const legacy=product('2027-01-01');
  run('UPDATE products SET expires_on=NULL WHERE id=?',legacy.id);
  const tab=order();
  for (const id of [expired.id,legacy.id]) {
    assert.throws(()=>ops.orderItem(actor,tab.id,{action:'delta',product:id,delta:1}),/validade|vencido/i);
  }
  const updated=ops.orderItem(actor,tab.id,{action:'delta',product:current.id,delta:1});
  assert.equal(updated.order.items.length,1);
  assert.equal(updated.order.sale_blocks.length,0);
});

test('virada do dia impede aumentos, pagamentos, PIX e fechamento sem impedir remoções',t=>{
  fixed(t);
  const item=product('2026-11-22');
  let tab=order();
  tab=ops.orderItem(actor,tab.id,{action:'delta',product:item.id,delta:1}).order;
  tab=finance.pay(actor,tab.id,{version:tab.version,payments:[{method:'pix',amount:500}],request_id:randomUUID()}).order;
  t.mock.method(Date,'now',()=>Date.parse('2026-11-23T15:00:00Z'));
  assert.throws(()=>ops.orderItem(actor,tab.id,{action:'delta',product:item.id,delta:1}),/vencido/i);
  assert.throws(()=>finance.pay(actor,tab.id,{version:tab.version,payments:[{method:'cash',amount:500,received:500}],request_id:randomUUID()},true),/Venda bloqueada/);
  assert.throws(()=>finance.pay(actor,tab.id,{version:tab.version,payments:[{method:'cash',amount:500,received:500}],request_id:randomUUID()}),/Venda bloqueada/);
  const pix=tab.payments[0];
  assert.throws(()=>finance.confirmPix(actor,tab.id,{payment:pix.id,reason:'Conferido no banco',request_id:randomUUID()}),/Venda bloqueada/);
  assert.equal(get('SELECT state FROM payments WHERE id=?',pix.id).state,'pending');
  assert.equal(get('SELECT stock FROM products WHERE id=?',item.id).stock,10);
  const blocked=ops.orderDetail(actor,get(`${ops.orderQuery} WHERE o.id=?`,tab.id));
  assert.equal(blocked.sale_blocks.length,1);
  finance.voidPayment(actor,tab.id,{payment:pix.id,reason:'Produto venceu',request_id:randomUUID()});
  ops.orderItem(actor,tab.id,{action:'remove',item:tab.items[0].id,reason:'Produto venceu'});
  assert.equal(get('SELECT COUNT(*) n FROM items WHERE order_id=?',tab.id).n,0);
});

test('perda respeita reservas, controla concorrência e exige motivo e permissão',t=>{
  fixed(t);
  const item=product('2026-11-22');
  const tab=order();
  ops.orderItem(actor,tab.id,{action:'delta',product:item.id,delta:3});
  const body={quantity:8,expected_stock:10,expected_expiry:'2026-11-22',reason:'Separado para descarte'};
  assert.throws(()=>inventory.expiryLoss(actor,item.id,body),/reservadas/);
  assert.throws(()=>inventory.expiryLoss(actor,item.id,{...body,quantity:1,reason:''}),/Motivo/);
  assert.throws(()=>inventory.expiryLoss(actor,item.id,{...body,quantity:1,expected_stock:9}),/mudou/);
  const operator={...actor,role:'operator',permissions:JSON.stringify({operate:true,stock:false})};
  assert.throws(()=>inventory.expiryLoss(operator,item.id,{...body,quantity:1}),/aprovação/);
  assert.equal(get('SELECT stock FROM products WHERE id=?',item.id).stock,10);
  assert.throws(()=>ops.saveProduct(actor,{...item,expires_on:'2027-01-01',reason:'Corrigir data'},item.id),/reservas/);
});

test('produto pode ser vendido até o fim da validade e o histórico não muda depois',t=>{
  fixed(t);
  const item=product('2026-11-22');
  let tab=order();
  tab=ops.orderItem(actor,tab.id,{action:'delta',product:item.id,delta:2}).order;
  const sale=finance.pay(actor,tab.id,{version:tab.version,payments:[{method:'cash',amount:1000,received:1000}],request_id:randomUUID()},true);
  assert.equal(sale.status,'closed');
  assert.equal(get('SELECT stock FROM products WHERE id=?',item.id).stock,8);
  assert.equal(sale.items[0].cost_total,200);
  t.mock.method(Date,'now',()=>Date.parse('2026-11-23T15:00:00Z'));
  const history=ops.orderDetail(actor,get(`${ops.orderQuery} WHERE o.id=?`,tab.id));
  assert.equal(history.sale_blocks.length,0);
  assert.equal(history.total,1000);
});

test('desmembramento preserva o bloqueio e a data de validade do produto de origem',t=>{
  fixed(t);
  const expired=product('2026-11-21');
  const current=product('2026-11-30');
  const later=product('2026-12-31',{stock:0});
  const noExpiry=product(null,{stock:0,category:'TCG'});
  const sameExpiry=product('2026-11-30',{stock:0});
  const split=(source,target)=>inventory.breakpack(actor,{source:source.id,target:target.id,consumed:1,per:6,reason:'Abrir embalagem'});
  assert.throws(()=>split(expired,current),/vencido/i);
  assert.throws(()=>split(current,expired),/vencido/i);
  assert.throws(()=>split(current,later),/validade/i);
  assert.throws(()=>split(current,noExpiry),/validade/i);
  assert.equal(get('SELECT stock FROM products WHERE id=?',expired.id).stock,10);
  assert.equal(get('SELECT stock FROM products WHERE id=?',later.id).stock,0);
  split(current,sameExpiry);
  assert.equal(get('SELECT stock FROM products WHERE id=?',current.id).stock,9);
  assert.equal(get('SELECT stock FROM products WHERE id=?',sameExpiry.id).stock,6);
  assert.equal(get('SELECT expires_on FROM products WHERE id=?',sameExpiry.id).expires_on,'2026-11-30');
});

test('baixa por validade é idempotente e registra custo, responsável e motivo',t=>{
  fixed(t);
  const item=product('2026-11-20');
  const body={request_id:randomUUID(),quantity:4,expected_stock:10,expected_expiry:'2026-11-20',reason:'Descarte por vencimento'};
  const operation=`products/${item.id}/expiry-loss`;
  const execute=()=>inventory.expiryLoss(actor,item.id,body);
  assert.equal(intents.perform(actor,operation,body,execute).changed,true);
  assert.equal(intents.perform(actor,operation,body,execute).changed,false);
  const saved=get('SELECT stock,stock_value FROM products WHERE id=?',item.id);
  assert.equal(saved.stock,6);
  assert.equal(saved.stock_value,600);
  const moves=all("SELECT * FROM stock_moves WHERE product_id=? AND kind='expiry_loss'",item.id);
  assert.equal(moves.length,1);
  assert.equal(moves[0].user_id,actor.id);
  assert.equal(moves[0].reason,body.reason);
  assert.equal(moves[0].value_before-moves[0].value_after,400);
  assert.ok(get("SELECT id FROM audit WHERE entity_id=? AND action='estoque.perda_validade'",item.id));
  assert.throws(()=>inventory.expiryLoss(actor,item.id,{...body,expected_expiry:'2026-11-21',expected_stock:6}),/mudou/);
});

test('mudança de validade com saldo exige motivo e gera auditoria',t=>{
  fixed(t);
  const item=product('2026-11-22');
  assert.throws(()=>ops.saveProduct(actor,{...item,expires_on:'2026-11-30'},item.id),/Motivo/);
  ops.saveProduct(actor,{...item,expires_on:'2026-11-30',reason:'Correção conforme rótulo'},item.id);
  const audit=get("SELECT * FROM audit WHERE entity_id=? AND action='produto.alterado' ORDER BY id DESC",item.id);
  assert.equal(JSON.parse(audit.before).expires_on,'2026-11-22');
  assert.equal(JSON.parse(audit.after).expires_on,'2026-11-30');
});

test('relatório e interface incluem estoque inativo e bloqueiam o catálogo vencido',async t=>{
  fixed(t);
  const expired=product('2026-11-21',{name:'Suco vencido',active:false});
  const soon=product('2026-11-25',{name:'Lanche próximo'});
  const {productsView,productRows,productGrid}=await import('../views.js');
  const state={config:{timezone:'America/Sao_Paulo'},me:{permissions:{products:true,stock:true,operate:true}},products:ops.products(actor),favorites:[],local:{}};
  assert.match(productsView(state),/Controle de validade/);
  assert.match(productsView(state),/Vencidos/);
  state.local.expiryFilter='expired';
  const rows=productRows(state);
  assert.match(rows,/Suco vencido/);
  assert.doesNotMatch(rows,/Lanche próximo/);
  assert.match(inventory.expiryCsv(actor),/Suco vencido/);
  const available={...expired,active:true};
  const grid=productGrid({...state,products:[available],card:{order:{id:1}}});
  assert.match(grid,/data-action="add-item"[^>]*disabled/);
  assert.match(grid,/Vencido há/);
  assert.equal(ops.products(actor).find(row=>row.id===soon.id).expiry.status,'critical');
});
