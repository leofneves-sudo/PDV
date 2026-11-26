const {test,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const {setTimeout:delay}=require('node:timers/promises');
process.env.PDV_DB=':memory:';
const {get,all,run,saveUser,session,sha,findSession}=require('../db');
const ops=require('../operations');
const {DEFAULT_URL,parsePage}=require('../site-catalog');
const {createScheduler}=require('../site-sync');
const {createController}=require('../site-import');
const {createPageReader}=require('../site-browser');
const user=saveUser(null,{username:'sync_admin',name:'Administrador de teste',password:'senha-ficticia-sync',role:'admin'});
const actor=findSession(sha(session(user)));
const worker=saveUser(null,{username:'sync_operador',name:'Operador de teste',password:'senha-ficticia-sync',role:'operator',permissions:{products:true,stock:true,users:true}});
let serial=5000;
const timestamp=Date.parse('2026-11-25T12:00:00Z');
const picture='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
function rows(stock=10,price='R$ 15,00',id=++serial) {
  return parsePage(`<div class="card-item"><div class="card-img"><img src="https://repositorio.sbrauble.com/teste.png"></div>
    <div class="card-desc"><div class="title"><a href="/?view=ecom/item&card=${id}">Produto ${id}</a></div>
    <div class="qty"><span>${stock ?? ''}</span></div><div class="price"><span class="align-price">${price}</span></div></div></div>`,DEFAULT_URL).rows;
}
const snapshot=rows=>({status:'ready',complete:true,rows,warnings:[]});
function setup(t,{values=rows(),scan,imageLoader=async()=>picture}={}) {
  let time=timestamp;
  const importer={scan:scan || (async()=>snapshot(values))};
  const scheduler=createScheduler({importer,imageLoader,clock:()=>time,tickMs:10});
  t.after(()=>scheduler.close());
  const config=scheduler.save(actor,{name:'Acompanhamento '+serial,url:DEFAULT_URL+'&sync_test='+serial,category:'Cartas',interval_minutes:5,enabled:true,create_new:true});
  return {scheduler,config,values,advance:minutes=>time+=minutes*60000,
    product:()=>get('SELECT * FROM products WHERE code=?',values[0].code),
    source:()=>get('SELECT * FROM web_product_sources WHERE source_key=?',values[0].key),
    async again(){scheduler.request(actor,config.id);return scheduler.tick();}};
}
beforeEach(()=>{run('UPDATE site_sync_jobs SET enabled=0,deleted=1');run("UPDATE users SET active=1,role='admin' WHERE id=?",user.id);});

test('sincronização preserva vendas do PDV e aplica somente a diferença observada no site',async t=>{
  const f=setup(t);let result=await f.scheduler.tick();
  assert.equal(result.created,1);assert.equal(f.product().stock,10);assert.equal(f.source().last_stock,10);
  ops.stockMove(actor,f.product(),-2,'Venda local fictícia','sale');
  result=await f.again();assert.equal(f.product().stock,8);assert.equal(result.updated,0);
  f.values[0].stock=9;result=await f.again();assert.equal(f.product().stock,7);assert.equal(result.updated,1);
  assert.equal(f.source().last_stock,9);
  f.values[0].stock=12;f.values[0].price=9900;await f.again();
  assert.equal(f.product().stock,10);assert.equal(f.product().price,1500);
  await f.again();assert.equal(f.product().stock,10);
  assert.equal(get("SELECT COUNT(*) n FROM stock_moves WHERE product_id=? AND kind='site_sync'",f.product().id).n,2);
});

test('primeira leitura de cadastro antigo registra referência sem sobrescrever o estoque local',async t=>{
  const f=setup(t);
  const product=ops.saveProduct(actor,{code:f.values[0].code,name:'Cadastro local',category:'Cartas',price:2000,cost:700,stock:7,minimum:2,active:true});
  const result=await f.scheduler.tick();assert.equal(result.baselines,1);assert.equal(f.product().stock,7);
  f.values[0].stock=11;await f.again();assert.equal(f.product().stock,8);
  assert.equal(f.product().cost,700);assert.equal(f.product().minimum,2);assert.equal(f.product().price,2000);assert.equal(f.product().name,'Cadastro local');
  assert.equal(get('SELECT stock_value FROM products WHERE id=?',product.id).stock_value,5600);
});

test('links sobrepostos compartilham a referência e não aplicam a mesma baixa duas vezes',async t=>{
  const f=setup(t);await f.scheduler.tick();
  const second=f.scheduler.save(actor,{name:'Outro filtro',url:DEFAULT_URL+'&outro_filtro=1',category:'Cartas',interval_minutes:5,enabled:true,create_new:true});
  f.values[0].stock=8;await f.again();assert.equal(f.product().stock,8);
  f.scheduler.request(actor,second.id);await f.scheduler.tick();assert.equal(f.product().stock,8);
  assert.equal(get('SELECT COUNT(*) n FROM products WHERE code=?',f.values[0].code).n,1);
});

test('reservas e estoque negativo geram pendências, sem consumir a referência necessária para nova tentativa',async t=>{
  const f=setup(t);await f.scheduler.tick();
  const card=ops.createCards(actor,{start:++serial,count:1})[0];ops.grantCard(actor.session_id,card.id);
  const order=ops.openOrder(actor,card.id).order;ops.orderItem(actor,order.id,{product:f.product().id,action:'delta',delta:8});
  f.values[0].stock=7;let result=await f.again();assert.equal(result.conflicts,1);assert.equal(f.product().stock,10);assert.equal(f.source().last_stock,10);
  assert.match(result.issues[0].message,/reservas/);
  ops.cancel(actor,order.id,{reason:'Fim do teste de reserva'});await f.again();assert.equal(f.product().stock,7);
  ops.stockMove(actor,f.product(),-6,'Venda local fictícia','sale');
  f.values[0].stock=2;result=await f.again();assert.equal(f.product().stock,1);assert.equal(f.source().last_stock,7);assert.match(result.issues[0].message,/negativo/);
});

test('estoque zero explícito é aceito; erro, dado ausente ou produto desaparecido não zeram o PDV',async t=>{
  const f=setup(t);await f.scheduler.tick();
  f.values[0].stock=null;let result=await f.again();assert.equal(result.conflicts,1);assert.equal(f.product().stock,10);
  assert.equal(f.source().last_stock,10);
  f.values[0].stock=0;result=await f.again();assert.equal(result.updated,1);assert.equal(f.product().stock,0);
});

test('leitura incompleta e falhas HTTP mantêm os saldos e ficam no histórico',async t=>{
  const values=rows();let failRead=false,incomplete=false;
  const f=setup(t,{values,scan:async()=>{if(failRead)throw Error('HTTP 429 persistente');return incomplete?{status:'error',complete:false,rows:values}:snapshot(values);}});
  await f.scheduler.tick();failRead=true;let result=await f.again();assert.equal(result.status,'error');assert.equal(f.product().stock,10);
  failRead=false;incomplete=true;result=await f.again();assert.equal(result.status,'error');assert.equal(f.product().stock,10);
  assert.match(f.scheduler.list(actor).runs[0].message,/incompleta/);
});

test('pausar durante a consulta cancela a execução e impede gravações tardias',async t=>{
  let release,started;const reading=new Promise(resolve=>started=resolve),wait=new Promise(resolve=>release=resolve);
  const values=rows(),f=setup(t,{values,scan:async()=>{started();await wait;return snapshot(values);}});
  const pending=f.scheduler.tick();await reading;
  assert.equal(await f.scheduler.tick(),false);
  f.scheduler.save(actor,{id:f.config.id,enabled:false});release();await pending;
  assert.equal(f.product(),undefined);assert.equal(f.scheduler.list(actor).jobs[0].status,'paused');
  assert.equal(f.scheduler.list(actor).runs[0].status,'cancelled');
});

test('mudança do administrador ou da referência durante a leitura impede gravar resultado obsoleto',async t=>{
  let release,started;let block=false;
  const values=rows(),f=setup(t,{values,scan:async()=>{if(block){started();await new Promise(resolve=>release=resolve);}return snapshot(values);}});
  await f.scheduler.tick();block=true;values[0].stock=6;
  let reading=new Promise(resolve=>started=resolve);let pending=f.again();await reading;
  run('UPDATE web_product_sources SET observation_version=observation_version+1 WHERE source_key=?',values[0].key);release();
  let result=await pending;assert.equal(result.conflicts,1);assert.equal(f.product().stock,10);
  reading=new Promise(resolve=>started=resolve);pending=f.again();await reading;
  run("UPDATE users SET role='operator' WHERE id=?",user.id);release();result=await pending;
  assert.equal(result.status,'error');assert.equal(f.product().stock,10);
});

test('desativar cadastro de novos produtos e remover link preserva os produtos existentes',async t=>{
  const f=setup(t);f.scheduler.save(actor,{id:f.config.id,create_new:false});
  let result=await f.scheduler.tick();assert.equal(result.skipped,1);assert.equal(f.product(),undefined);
  f.scheduler.save(actor,{id:f.config.id,create_new:true});await f.scheduler.tick();const id=f.product().id;
  f.scheduler.remove(actor,f.config.id);assert.equal(f.scheduler.list(actor).jobs.length,0);assert.ok(get('SELECT id FROM products WHERE id=?',id));
});

test('scheduler continua após logout, respeita intervalo e persiste configurações e resultados',async t=>{
  const f=setup(t);run('DELETE FROM sessions WHERE user_id=?',user.id);
  const temporary=createScheduler({importer:{scan:async()=>snapshot(f.values)},clock:()=>timestamp});
  await temporary.tick();await temporary.close();assert.equal(f.product().stock,10);
  assert.equal(await f.scheduler.tick(),false);
  f.advance(5);f.values[0].stock=9;await f.scheduler.tick();assert.equal(f.product().stock,9);
  assert.equal(f.scheduler.list(actor).runs.length,2);
});

test('temporizador executa sozinho no intervalo e retoma consultas interrompidas no reinício',async t=>{
  let reads=0;const values=rows();
  const f=setup(t,{values,scan:async()=>{reads++;return snapshot(values);}});
  run("UPDATE site_sync_jobs SET status='running' WHERE id=?",f.config.id);
  run("INSERT INTO site_sync_runs(job_id,started_at,status) VALUES(?,?,'running')",f.config.id,new Date(timestamp).toISOString());
  f.scheduler.start();
  async function until(check){for(let attempt=0;attempt<100;attempt++){if(check())return;await delay(5);}throw Error('Temporizador não executou.');}
  await until(()=>f.product()?.stock===10);
  assert.equal(reads,1);
  assert.ok(f.scheduler.list(actor).runs.some(row=>row.status==='interrupted'));
  f.advance(4);await delay(30);assert.equal(reads,1);
  values[0].stock=9;f.advance(1);await until(()=>f.product()?.stock===9);assert.equal(reads,2);
});

test('movimentação local durante a consulta é considerada no saldo usado para a diferença do site',async t=>{
  let block=false,started,release;const values=rows();
  const f=setup(t,{values,scan:async()=>{if(block){started();await new Promise(resolve=>release=resolve);}return snapshot(values);}});
  await f.scheduler.tick();block=true;values[0].stock=9;
  const reading=new Promise(resolve=>started=resolve),pending=f.again();await reading;
  ops.stockMove(actor,f.product(),-2,'Venda realizada durante a consulta','sale');release();
  const result=await pending;assert.equal(result.updated,1);assert.equal(f.product().stock,7);
});

test('apenas administradores configuram o agente; URLs, duplicatas e intervalos são validados',t=>{
  const f=setup(t);
  assert.throws(()=>f.scheduler.list(worker),/administrador/);
  assert.throws(()=>f.scheduler.save(worker,{}),/administrador/);
  assert.throws(()=>f.scheduler.request(worker,f.config.id),/administrador/);
  assert.throws(()=>f.scheduler.remove(worker,f.config.id),/administrador/);
  assert.throws(()=>f.scheduler.save(actor,{id:f.config.id,interval_minutes:1}),/Intervalo/);
  assert.throws(()=>f.scheduler.save(actor,{id:f.config.id,url:'https://127.0.0.1/?view=ecom/itens'}),/HTTPS/);
  assert.throws(()=>f.scheduler.save(actor,{name:'Duplicado',url:f.config.url+'&page=3',enabled:true}),/já está cadastrado/);
});

test('cadastros novos inválidos são revertidos por produto, sem deixar movimentos ou auditorias parciais',async t=>{
  const values=rows();values.push(...rows(4));values[0].language='x'.repeat(90);
  const f=setup(t,{values});const result=await f.scheduler.tick();
  assert.equal(result.created,1);assert.equal(result.conflicts,1);assert.equal(f.product(),undefined);
  assert.equal(get('SELECT COUNT(*) n FROM products WHERE code=?',values[1].code).n,1);
  assert.equal(get('SELECT COUNT(*) n FROM web_product_sources WHERE source_key=?',values[0].key).n,0);
});

test('rotina em segundo plano recusa verificação de acesso sem abrir navegador',async()=>{
  const reader=createPageReader({interactive:false,downloadPage:async()=>({status:403,headers:{'content-type':'text/html'},body:Buffer.from('<title>Just a moment...</title>'),url:DEFAULT_URL})});
  await assert.rejects(reader.read(DEFAULT_URL),error=>error.code==='SITE_VERIFICATION_REQUIRED');await reader.close();
});

test('varredura reutiliza páginas individuais de produtos que saíram de uma listagem de disponíveis',async t=>{
  const values=rows(10);const visits=[];
  const importer=createController({detailDelayMs:0,readerFactory:()=>({async read(url){visits.push(url);
    if(new URL(url).searchParams.get('view')==='ecom/itens')return '<div class="cards"><table class="ecomresp-tab"></table></div>';
    return `<div class="nomes_cards"><div class="nome_pt_cards">${values[0].name}</div></div><div id="product--list"><div class="table-produtos"><div class="table-produtos-row">
      <div class="table-produtos-body-cell"><div class="title-mobile">Estoque</div>0 unid.</div><div class="table-produtos-body-cell"><div class="title-mobile">Preço</div>R$ 15,00</div></div></div></div>`;
  },async close(){}})});t.after(()=>importer.close());
  const result=await importer.scan(user,{url:DEFAULT_URL},{trackedRows:values});
  assert.equal(result.complete,true);assert.equal(result.rows.length,1);assert.equal(result.rows[0].stock,0);assert.equal(result.rows[0].key,values[0].key);
  assert.equal(visits.length,2);
});
