const {test}=require('node:test');
const assert=require('node:assert/strict');
process.env.PDV_DB=':memory:';
const {get,run,saveUser,session,sha,findSession}=require('../db');
const ops=require('../operations');
function login(username,role='operator',permissions={}) {
  const user=saveUser(null,{username,name:username,password:'teste-comandas-123',role,permissions});
  return findSession(sha(session(user)));
}
const till=login('caixa','admin');
const phone=login('celular');
const unrelated=login('outro');
const cards=ops.createCards(till,{start:61,count:3});
for (const card of cards.slice(0,2)) {
  ops.grantCard(till.session_id,card.id);
  ops.openOrder(till,card.id);
}

test('total da loja é igual em sessões diferentes sem conceder acesso a cartões não lidos',()=>{
  const counter=ops.openCards(unrelated);
  assert.equal(counter.total,2);
  assert.equal(counter.cards.length,0);
  assert.equal(ops.openCards(till).cards.length,2);
  assert.throws(()=>ops.cardDetail(unrelated,cards[0].id),/Leia o QR/);
});

test('celular pareado recupera comandas abertas antigas do caixa sem depender do navegador',()=>{
  run('INSERT INTO pairings(reader,terminal,name) VALUES(?,?,?)',phone.session_id,till.session_id,'Caixa');
  assert.equal(get('SELECT COUNT(*) n FROM scan_grants WHERE session_id=?',phone.session_id).n,0);
  const open=ops.openCards(phone);
  assert.equal(open.total,2);
  assert.equal(open.cards.length,2);
  assert.ok(ops.cardDetail(phone,cards[0].id).order);
  assert.ok(ops.cardDetail(phone,cards[1].id).order);
  assert.throws(()=>ops.cardDetail(phone,cards[2].id),/Leia o QR/);
  assert.equal(get('SELECT COUNT(*) n FROM scan_grants WHERE session_id=?',phone.session_id).n,0);
});

test('desvincular revoga o acesso herdado, mantendo as leituras próprias',()=>{
  ops.grantCard(phone.session_id,cards[1].id);
  run('DELETE FROM pairings WHERE reader=?',phone.session_id);
  assert.throws(()=>ops.cardDetail(phone,cards[0].id),/Leia o QR/);
  assert.ok(ops.cardDetail(phone,cards[1].id).order);
  assert.equal(ops.openCards(phone).cards.length,1);
});

test('par expirado não concede acesso e operador sem atendimento não consulta a lista',()=>{
  run('INSERT INTO pairings(reader,terminal,name) VALUES(?,?,?)',phone.session_id,till.session_id,'Caixa');
  run('UPDATE sessions SET expires=0 WHERE id=?',till.session_id);
  assert.throws(()=>ops.cardDetail(phone,cards[0].id),/Leia o QR/);
  assert.equal(ops.openCards(phone).cards.length,1);
  assert.throws(()=>ops.openCards({...unrelated,permissions:'{"operate":false}'}),/permissão/);
});

test('interface distingue a quantidade de comandas abertas da quantidade de itens',async()=>{
  const {mobilePosNavigation,openOrderNavigation}=await import('../views.js');
  const state={openCards:{total:2,cards:[]},card:{id:1,number:61,order:{items:[]}},local:{},scanned:new Map()};
  assert.match(mobilePosNavigation(state),/Comanda \(0 itens\)/);
  assert.match(openOrderNavigation(state),/Comandas abertas na loja:.*data-open-order-count>2</);
});
