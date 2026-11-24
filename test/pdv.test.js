const {test} = require('node:test');
const assert = require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {randomUUID}=require('node:crypto');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {join} = require('node:path');
const {mkdtemp,rm,readFile} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {resolveObjectURL} = require('node:buffer');
const {runInNewContext} = require('node:vm');
const {PNG} = require('pngjs');

async function launch(db,extra={}) {
  const child=spawn(process.execPath,['server.js'],{
    env:{...process.env,PDV_DB:db,PDV_HOST:'127.0.0.1',PDV_PORT:'0',PDV_ORIGIN:'',PDV_TLS_CERT:'',PDV_TLS_KEY:'',PDV_BACKUP_MINUTES:'0',PDV_TIMEZONE:'America/Sao_Paulo',...extra},
    stdio:['ignore','pipe','pipe']
  });
  let stderr='';
  const exited=once(child,'exit');
  child.stderr.on('data',chunk=>stderr+=chunk);
  const url=await new Promise((resolve,reject)=>{
    child.stdout.on('data',chunk=>{
      const match=String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) resolve(match[0]);
    });
    child.once('error',reject);
    child.once('exit',code=>reject(new Error(`Servidor encerrou com código ${code}. ${stderr}`)));
  });
  return {url,async stop(){
    if (child.exitCode!==null || child.signalCode!==null) return;
    child.kill('SIGTERM');
    await exited;
  }};
}

function client(url) {
  let cookie='';
  async function raw(path,body) {
    const protectedPath=/^(?:cash\/open|shifts\/\d+\/(?:close|move)|customers\/\d+\/deposit|ledger\/\d+\/(?:correct|reverse)|merchandise(?:\/\d+\/correct)?|products\/\d+\/stock|inventory\/breakpack)$/.test(path);
    if (body!==undefined && protectedPath && !Object.hasOwn(body,'request_id')) body={...body,request_id:randomUUID()};
    const response=await fetch(url+'/api/'+path,{
      method:body===undefined?'GET':'POST',
      headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})
    });
    const setCookie=response.headers.get('set-cookie');
    if (setCookie) cookie=setCookie.split(';')[0];
    return response;
  }
  async function request(path,body,expected=200) {
    const response=await raw(path,body);
    const data=await response.json();
    assert.equal(response.status,expected,`${path} retornou ${JSON.stringify(data)}`);
    return data;
  }
  async function events() {
    const abort=new AbortController();
    const response=await fetch(url+'/api/events',{headers:{Cookie:cookie},signal:abort.signal});
    assert.equal(response.status,200);
    const history=[];
    let pending='';
    let waiter=null;
    const receiver=(async()=>{
      for await (const buffer of response.body) {
        pending+=Buffer.from(buffer).toString('utf8');
        const frames=pending.split('\n\n');
        pending=frames.pop();
        for (const frame of frames) {
          const [,name,data]=frame.match(/^event: (.+)\ndata: (.+)$/) || [];
          if (!name) continue;
          history.push({name,data:JSON.parse(data)});
          if (waiter) waiter();
        }
      }
    })();
    receiver.catch(()=>{});
    function until(name,timeout=1500) {
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{
          waiter=null;
          reject(new Error('Evento não recebido: '+name));
        },timeout);
        const check=()=>{
          const index=history.findIndex(row=>row.name===name);
          if (index<0) return;
          clearTimeout(timer);
          waiter=null;
          resolve(history.splice(index,1)[0].data);
        };
        waiter=check;
        check();
      });
    }
    await until('ready');
    return {until,history,close:()=>abort.abort()};
  }
  return {raw,request,events};
}

// Executa o mesmo decodificador da câmera sobre os pixels do QR impresso.
async function decodeQR(buffer) {
  const entry=await readFile('node_modules/qr-scanner/qr-scanner-worker.min.js','utf8');
  let result;
  const self={postMessage:message=>{result=message.data;}};
  class TestWorker {
    constructor(url) {this.source=resolveObjectURL(url).text();}
  }
  const source=entry.replace('export const createWorker','const createWorker');
  const worker=runInNewContext(source+'\ncreateWorker();',{Worker:TestWorker,URL,Blob});
  runInNewContext(await worker.source,{self});
  const png=PNG.sync.read(buffer);
  self.onmessage({data:{id:1,type:'decode',data:{
    width:png.width,height:png.height,data:new Uint8ClampedArray(png.data)
  }}});
  return result;
}

test('HTTP, QR, concorrência, pagamentos, permissões e persistência', {timeout:25000}, async t=>{
  const path=await mkdtemp(join(tmpdir(),'balcao-test-'));
  const database=join(path,'pdv.sqlite');
  const server=await launch(database);
  const streams=[];
  t.after(async()=>{
    for (const stream of streams) stream.close();
    await server.stop();
    await rm(path,{force:true,recursive:true});
  });
  const admin=client(server.url);
  const mobile=client(server.url);
  const other=client(server.url);
  const credentials={username:'gerente',password:'gerente-teste-14'};
  const operator={username:'operador',password:'operador-teste-14'};
  const setup=await admin.request('session');
  const [views,modals]=await Promise.all([import('../views.js'),import('../modals.js')]);
  assert.equal(setup.setup,true);
  assert.match(views.auth(setup),/Criar administrador/);
  for (const path of ['/', '/app.css', '/app.js', '/updates.js', '/modals.js', '/scanner.js', '/qr-scanner-worker.min.js']) {
    const response=await fetch(server.url+path);
    assert.equal(response.status,200,path);
    assert.ok((await response.text()).length>100,path);
  }
  const bootstrap=await admin.request('setup',{...credentials,name:'Gerente de Teste'});
  assert.equal(bootstrap.user.role,'admin');
  assert.ok(bootstrap.user.started_at);
  const adminId=bootstrap.user.id;
  await mobile.request('login',{username:credentials.username,password:'senha-incorreta'},401);
  const staff=await admin.request('users',{...operator,name:'Operador de Teste',role:'operator'});
  await mobile.request('login',operator);
  await other.request('login',credentials);
  const secondRegister=await admin.request('cash/registers',{name:'Caixa 2'});
  await admin.request('cash/open',{register:1,opening:10000});
  await mobile.request('cash/open',{register:secondRegister.id,opening:0});
  const terminal=await admin.events(), unrelated=await other.events(), reader=await mobile.events();
  streams.push(terminal,unrelated,reader);
  const productPng=PNG.sync.write(new PNG({width:2,height:2}));
  const product=await admin.request('products',{
    name:'Peça de teste',code:'TESTE',barcode:'123456789',category:'Teste',price:10000,cost:4500,stock:4,minimum:1,
    image:'data:image/png;base64,'+productPng.toString('base64')
  });
  assert.match(product.image,/^\/api\/products\/\d+\/image\?v=/);
  const servedImage=await mobile.raw(product.image.slice('/api/'.length));
  assert.deepEqual(Buffer.from(await servedImage.arrayBuffer()),productPng);
  assert.equal((await mobile.request('products'))[0].cost,undefined);
  await mobile.request('products',{name:'Proibido'},403);
  const customer=await mobile.request('customers',{name:'Cliente de Teste',phone:'11 99999-1111'});
  await mobile.request(`customers/${customer.id}/deposit`,{amount:100,origin:'cash',reason:'Proibido'},403);
  const topup=await admin.request(`customers/${customer.id}/deposit`,{amount:5000,origin:'pix',reason:'Recarga de teste'});
  assert.equal((await admin.request('dashboard')).indicators.sales,0);
  assert.equal((await admin.request('dashboard')).indicators.deposits,5000);
  const [card,second]=await admin.request('cards',{start:42,count:2});
  await admin.request('cards',{start:43,count:2},409);
  await mobile.request('cards',undefined,403);
  const image=await admin.raw(`cards/${card.id}/qr`);
  assert.equal(image.headers.get('content-type'),'image/png');
  const code=await decodeQR(Buffer.from(await image.arrayBuffer()));
  assert.match(code,/^pdv:[a-f\d-]{36}$/);
  const secondCode=await decodeQR(Buffer.from(await (await admin.raw(`cards/${second.id}/qr`)).arrayBuffer()));
  assert.notEqual(code,secondCode);
  await client(server.url).request('scan',{code,mode:'direct'},401);
  await mobile.request(`cards/${card.id}`,undefined,403);
  await mobile.request('scan',{code:'https://example.com',mode:'direct'},400);
  const pairing=await admin.request('pairing/code',{name:'Caixa de teste'});
  await mobile.request('pairing/link',{code:'000000'},409);
  assert.ok(!terminal.history.some(event=>event.name==='paired'));
  assert.equal((await mobile.request('pairing/link',{code:pairing.code})).reader.name,'Caixa de teste');
  assert.equal((await terminal.until('paired')).readerName,staff.name);
  assert.ok(!unrelated.history.some(event=>event.name==='paired'));
  assert.ok(!reader.history.some(event=>event.name==='paired'));
  await other.request('pairing/link',{code:pairing.code},409);
  await assert.rejects(terminal.until('paired',100),/Evento não recebido/);
  const started=performance.now();
  const pairedScan=await mobile.request('scan',{code,mode:'paired'});
  assert.equal(pairedScan.sent,true);
  assert.equal(pairedScan.card.id,card.id);
  assert.equal((await terminal.until('card')).id,card.id);
  assert.ok(performance.now()-started<1000,'a entrega ao caixa na rede local deve levar menos de 1s');
  assert.ok(!unrelated.history.some(event=>event.name==='card'));
  assert.ok(!reader.history.some(event=>event.name==='card'));
  assert.equal((await mobile.request(`cards/${card.id}`)).number,card.number);
  await mobile.request(`cards/${second.id}`,undefined,403);
  const opened=(await admin.request(`cards/${card.id}/open`,{})).order;
  assert.equal((await mobile.request(`cards/${card.id}`)).order.id,opened.id);
  assert.equal((await mobile.request('scan',{code,mode:'direct'})).order.id,opened.id);
  assert.equal((await mobile.request(`cards/${card.id}/open`,{})).order.id,opened.id);

  function item(client,order,body,expected) {return client.request(`orders/${order}/items`,body,expected);}
  function update(client,order,body,expected) {return client.request(`orders/${order}/update`,body,expected);}
  function pay(client,order,payments,expected) {
    return client.request(`orders/${order.id}/checkout`,{version:order.version,payments},expected);
  }
  terminal.history.splice(0);
  const nextChange=terminal.until('change');
  const two=(await item(mobile,opened.id,{action:'delta',product:product.id,delta:2})).order;
  await nextChange;
  assert.equal((await admin.request(`cards/${card.id}`)).order.total,20000);
  await item(mobile,opened.id,{action:'delta',item:two.items[0].id,delta:-1,expectedQuantity:2});
  await item(mobile,opened.id,{action:'delta',item:two.items[0].id,delta:-1,expectedQuantity:2},409);
  assert.equal((await admin.request(`cards/${card.id}`)).order.total,10000);
  const linked=(await update(admin,opened.id,{field:'customer',value:customer.id})).order;
  await update(mobile,opened.id,{field:'discount',value:100,reason:'Proibido'},403);
  await item(mobile,opened.id,{action:'price',item:linked.items[0].id,price:1,reason:'Proibido'},403);
  await item(mobile,opened.id,{action:'remove',item:linked.items[0].id,reason:'Proibido'},403);
  await mobile.request(`orders/${opened.id}/cancel`,{reason:'Proibido'},403);
  const noted=(await update(mobile,opened.id,{field:'notes',previous:'',value:'Observação salva'})).order;
  await update(admin,opened.id,{field:'notes',previous:'',value:'Tentativa desatualizada'},409);
  assert.equal((await admin.request(`cards/${card.id}`)).order.notes,'Observação salva');
  await pay(admin,linked,[{method:'cash',amount:10000,received:12000}],409);
  await pay(admin,noted,[{method:'store',amount:6000},{method:'debit',amount:4000}],409);
  assert.equal((await admin.request(`customers/${customer.id}`)).balance,5000);
  assert.equal((await admin.request('products'))[0].reserved,1);

  const payments=[{method:'store',amount:3000},{method:'cash',amount:5000,received:8000},{method:'debit',amount:2000}];
  const concurrent=await Promise.all([admin.raw(`orders/${opened.id}/checkout`,{version:noted.version,payments}),
    mobile.raw(`orders/${opened.id}/checkout`,{version:noted.version,payments})]);
  assert.deepEqual(concurrent.map(response=>response.status).sort(),[200,409]);
  const done=await concurrent.find(response=>response.ok).json();
  assert.equal(done.payments.find(payment=>payment.method==='cash').change,3000);
  assert.equal(done.payments.find(payment=>payment.method==='debit').change,0);
  const winner=done.ended_by===staff.id?mobile:admin;
  const otherCloser=winner===mobile?admin:mobile;
  assert.equal((await winner.request(`orders/${done.id}/receipt`)).id,done.id);
  await otherCloser.request(`orders/${done.id}/receipt`,undefined,404);
  assert.match(modals.receipt(done,setup),/Comprovante não fiscal/);
  assert.match(modals.receipt(done,setup),/Troco/);
  assert.equal((await admin.request(`customers/${customer.id}`)).balance,2000);
  assert.equal((await admin.request('products'))[0].stock,3);
  await admin.request(`cards/${card.id}`,undefined,403);
  await pay(admin,noted,payments,409);
  assert.equal((await mobile.request('history')).rows.length,done.ended_by===staff.id?1:0);
  const oldShift=(await mobile.request('cash')).current;
  await mobile.request(`shifts/${oldShift.id}/close`,{counted:oldShift.summary.expected});
  await mobile.request('cash/open',{register:secondRegister.id,opening:0});
  const newShift=client(server.url);
  await newShift.request('login',operator);
  await newShift.request(`orders/${done.id}`,undefined,403);
  const customerInNewShift=await newShift.request(`customers/${customer.id}`);
  assert.equal(customerInNewShift.balance,2000);
  assert.equal(customerInNewShift.purchases.length,0);
  assert.equal(customerInNewShift.ledger,null);
  await mobile.request('dashboard',undefined,403);
  await mobile.request(`orders/${done.id}/refund`,{reason:'Sem permissão'},403);
  await mobile.request(`users/${staff.id}`,{...staff,permissions:{refund:true}},403);

  // Comandas concorrentes compartilham a disponibilidade de estoque.
  const reopened=await admin.request('scan',{code,mode:'direct'});
  assert.equal(reopened.order,null);
  const first=(await admin.request(`cards/${card.id}/open`,{})).order;
  assert.notEqual(first.id,done.id);
  await other.request('scan',{code:secondCode,mode:'direct'});
  const competing=(await other.request(`cards/${second.id}/open`,{})).order;
  await item(other,competing.id,{action:'delta',product:product.id,delta:3});
  await item(admin,first.id,{action:'delta',product:product.id,delta:1},409);
  await admin.request(`products/${product.id}/stock`,{delta:-1,reason:'Tentativa de invadir reservas'},409);
  await other.request(`orders/${competing.id}/cancel`,{reason:'Cancelamento de teste'});
  assert.equal((await admin.request('products'))[0].reserved,0);
  const {image:storedImage,...storedProduct}=product;
  const repriced=await admin.request(`products/${product.id}`,{...storedProduct,price:2000,reason:'Nova tabela de preços'});
  assert.equal(repriced.image,storedImage);
  await item(admin,first.id,{action:'delta',product:product.id,delta:1});
  const onlyCredit=(await update(admin,first.id,{field:'customer',value:customer.id})).order;
  const spent=await pay(admin,onlyCredit,[{method:'store',amount:2000}]);
  assert.equal(spent.total,2000);
  assert.equal((await admin.request(`customers/${customer.id}`)).balance,0);
  await admin.request(`ledger/${topup.id}/reverse`,{reason:'Saldo insuficiente'},409);
  const snapshot=await admin.request(`orders/${opened.id}`);
  assert.equal(snapshot.items[0].price,10000);
  const dashboard=await admin.request('dashboard');
  assert.equal(dashboard.indicators.sales,12000);
  assert.equal(dashboard.indicators.orders,2);
  assert.equal(dashboard.indicators.deposits,5000);
  assert.equal(dashboard.indicators.used,5000);
  assert.equal(dashboard.indicators.cancellations,1);
  assert.equal(dashboard.products[0].count,2);
  assert.equal(dashboard.timeline.reduce((sum,row)=>sum+row.amount,0),12000);
  assert.equal(dashboard.payments.reduce((sum,row)=>sum+row.amount,0),12000);
  const filters=await admin.request('filters');
  assert.match(views.dashboard({me:bootstrap.user,report:dashboard,filters,config:setup,
    dashboardFilter:{period:'today'},donutMode:'count'}),/Evolução das vendas/);
  assert.equal((await admin.request('dashboard?method=debit')).indicators.sales,10000);
  assert.equal((await admin.request('dashboard?category=Teste')).indicators.sales,12000);
  assert.ok((await (await admin.raw('dashboard.csv')).text()).includes('Vendas concluídas'));
  assert.ok((await (await admin.raw('history.csv')).text()).includes('Cliente de Teste'));
  await admin.request(`orders/${opened.id}/refund`,{reason:'Cliente devolveu o item'});
  await admin.request(`orders/${opened.id}/refund`,{reason:'Tentativa duplicada'},409);
  assert.equal((await admin.request(`customers/${customer.id}`)).balance,3000);
  await admin.request(`orders/${first.id}/refund`,{reason:'Segunda devolução'});
  await admin.request(`ledger/${topup.id}/reverse`,{reason:'Recarga devolvida'});
  assert.equal((await admin.request(`customers/${customer.id}`)).balance,0);
  assert.equal((await admin.request('products'))[0].stock,4);
  const after=await admin.request('dashboard');
  assert.equal(after.indicators.sales,0);
  assert.equal(after.indicators.refunds,2);
  assert.equal(after.indicators.depositReversals,5000);
  const secondCustomer=await admin.request('customers',{name:'Cliente de correção',phone:'11988881111'});
  const original=await admin.request(`customers/${secondCustomer.id}/deposit`,{amount:2000,origin:'cash',reason:'Correção posterior'});
  await mobile.request(`ledger/${original.id}/correct`,{amount:1000,origin:'pix',reason:'Sem permissão'},403);
  const fixed=await admin.request(`ledger/${original.id}/correct`,{amount:1000,origin:'pix',reason:'Forma e valor corrigidos'});
  assert.equal(fixed.correction.original_id,original.id);
  assert.equal(fixed.reversed.original_id,original.id);
  assert.equal((await admin.request(`customers/${secondCustomer.id}`)).balance,1000);
  await admin.request(`ledger/${original.id}/reverse`,{reason:'Operação duplicada'},409);
  const logs=(await admin.request('audit?q=estornada')).rows.concat((await admin.request('audit?q=pagamento.registrado')).rows);
  assert.ok(logs.some(row=>row.action==='venda.estornada'));
  assert.ok(logs.some(row=>row.action==='pagamento.registrado'));
  assert.ok((await admin.request('audit?q=auth.falha')).rows.length);
  assert.ok(!JSON.stringify(logs).includes(credentials.password));
  assert.ok((await admin.request(`products/${product.id}/movements`)).some(row=>row.kind==='refund'));
  await admin.request('pairing/revoke',{reason:'Encerramento de teste'});
  await mobile.request('scan',{code,mode:'paired'},409);

  // O mesmo catálogo, histórico e estoque devem sobreviver a reiniciar o processo.
  for (const stream of streams) stream.close();
  await server.stop();
  const restarted=await launch(database);
  try {
    const restored=client(restarted.url);
    await restored.request('login',credentials);
    assert.equal((await restored.request('history?status=refunded')).total,2);
    assert.equal((await restored.request(`customers/${customer.id}`)).ledger.length,6);
    assert.equal((await restored.request('products'))[0].stock,4);
    assert.equal((await restored.request('users'))[0].id,adminId);
    await restored.request('logout',{});
    await restored.request('products',undefined,401);
  } finally {
    await restarted.stop();
  }
});

test('turnos, PIX, parcelas, transferências, devolução, estoque, importação e recuperação',{timeout:25000},async t=>{
  const {randomUUID}=require('node:crypto');
  const {mkdir}=require('node:fs/promises');
  const {execFileSync}=require('node:child_process');
  const root=await mkdtemp(join(tmpdir(),'balcao-new-'));
  const external=join(root,'externo');
  await mkdir(external);
  const server=await launch(join(root,'pdv.sqlite'),{PDV_BACKUP_EXTERNAL_DIR:external});
  t.after(async()=>{await server.stop(); await rm(root,{force:true,recursive:true});});
  const adm=client(server.url),employee=client(server.url);
  const manager={username:'admin',password:'admin-validate-123'};
  const worker={username:'funcionario',password:'operador-teste-123'};
  const byId=(prefix,id,action)=>`${prefix}/${id}${action?'/'+action:''}`;
  const add=(user,order,product,delta=1)=>user.request(byId('orders',order.id,'items'),{action:'delta',product:product.id,delta});
  const parcel=(user,order,payments,expected=200,key=randomUUID())=>user.request(byId('orders',order.id,'payments'),{version:order.version,payments,request_id:key},expected);
  const close=(user,order,payments=[],expected=200)=>user.request(byId('orders',order.id,'checkout'),{version:order.version,payments,request_id:randomUUID()},expected);
  const fetchCard=(user,card)=>user.request(byId('cards',card.id));
  const movement=(shift,body)=>employee.request(byId('shifts',shift.id,'move'),body);
  const cfg=await adm.request('session');
  const boot=await adm.request('setup',{...manager,name:'Admin teste'});
  const user=await adm.request('users',{...worker,name:'Operador do turno',role:'operator',permissions:{scan_number:true}});
  await employee.request('login',worker);
  const shift1=await employee.request('cash/open',{register:1,opening:10000});
  const product=await adm.request('products',{code:'A',name:'Carta',category:'TCG',price:1000,cost:300,stock:20,minimum:2,game:'Teste',foil:true});
  const customer=await adm.request('customers',{name:'Cliente',phone:'123'});
  const cards=await adm.request('cards',{start:101,count:7});
  async function grant(user,card) {return user.request('scan/number',{number:card.number,reason:'Leitor em manutenção'});}
  async function open(user,card) {
    await grant(user,card);
    return (await user.request(byId('cards',card.id,'open'),{})).order;
  }
  async function link(user,order) {
    return (await user.request(byId('orders',order.id,'update'),{field:'customer',value:customer.id})).order;
  }
  await employee.request(byId('customers',customer.id,'deposit'),{source:'funded',origin:'cash',amount:2000,reason:'Compra de saldo',approval:manager});
  let order=await link(employee,await open(employee,cards[0]));
  order=(await add(employee,order,product,3)).order;
  const key=randomUUID();
  const mix=[{method:'cash',amount:1500,received:2000,payer:'Ana'},{method:'store',amount:500,payer:'Bia'}];
  const partial=(await parcel(employee,order,mix,200,key)).order;
  assert.equal(partial.confirmed,2000);
  assert.equal(partial.payments[0].change,500);
  assert.equal((await parcel(employee,order,mix,200,key)).order.payments.length,2);
  await close(employee,partial,[],409);
  const target=await open(employee,cards[1]);
  await employee.request(byId('orders',order.id,'move'),{mode:'transfer',target:cards[1].id,targetVersion:target.version,
    version:partial.version,items:[{item:partial.items[0].id,quantity:2}],reason:'Ultrapassa o saldo'},409);
  const moved=await employee.request(byId('orders',order.id,'move'),{mode:'transfer',target:cards[1].id,targetVersion:target.version,
    version:partial.version,items:[{item:partial.items[0].id,quantity:1}],reason:'Parte sem pagamento'});
  assert.equal(moved.source.order.confirmed,2000);
  assert.equal(moved.destination.order.total,1000);
  const pix=(await parcel(employee,moved.destination.order,[{method:'pix',amount:1000,payer:'Carlos'}])).order;
  assert.equal(pix.pending,1000);
  await close(employee,pix,[],409);
  await movement(shift1,{kind:'supply',amount:400,reason:'Troco inicial extra'});
  await movement(shift1,{kind:'withdrawal',amount:900,reason:'Retirada segura'});
  const old=await employee.request(byId('shifts',shift1.id));
  assert.equal(old.summary.expected,13000);
  assert.equal(old.summary.loads[0].added,2000);
  const ending=await employee.request(byId('shifts',shift1.id,'close'),{counted:12900,reason:'Faltaram cem centavos'});
  assert.equal(ending.difference,-100);
  const shift2=await employee.request('cash/open',{register:1,opening:1000});
  assert.notEqual(shift1.id,shift2.id);
  const pixBody={payment:pix.payments[0].id,request_id:randomUUID(),reason:'Extrato conferido'};
  await employee.request(byId('orders',pix.id,'pix'),pixBody,403);
  const confirmed=(await employee.request(byId('orders',pix.id,'pix'),{...pixBody,approval:manager})).order;
  assert.equal(confirmed.payments[0].shift_id,shift2.id);
  const pixSale=await close(employee,confirmed);
  assert.equal(pixSale.closed_shift_id,shift2.id);
  const paid=await close(employee,moved.source.order);
  assert.ok(paid.payments.every(payment=>payment.shift_id===shift1.id));
  const exchange=await open(employee,cards[6]);
  const exchangeItems=(await add(employee,exchange,product,1)).order;
  const discount={field:'discount',value:50,reason:'Desconto de troca'};
  await employee.request(byId('orders',exchange.id,'update'),discount,403);
  assert.equal((await employee.request(byId('orders',exchange.id,'update'),{...discount,approval:manager})).order.version,exchangeItems.version+1);
  const returnBody={items:[{item:paid.items[0].id,quantity:1,restock:false}],exchange_order:exchange.id,request_id:randomUUID(),reason:'Devolução parcial'};
  await employee.request(byId('orders',paid.id,'refund'),returnBody,403);
  const returned=await employee.request(byId('orders',paid.id,'refund'),{...returnBody,approval:manager});
  assert.equal(returned.total,2000);
  assert.equal(returned.returns[0].amount,1000);
  assert.equal(returned.returns[0].payments.find(row=>row.method==='store').amount,250);
  assert.equal(returned.returns[0].approved_by,boot.user.id);
  assert.equal(returned.returns[0].user_id,user.id);
  assert.equal(returned.returns[0].exchange_order_id,exchange.id);
  assert.equal((await fetchCard(employee,cards[6])).order.customer_id,customer.id);
  await employee.request(byId('orders',paid.id,'refund'),{...returnBody,approval:manager});
  assert.equal((await adm.request(byId('customers',customer.id))).balance,1750);
  assert.equal((await adm.request('products'))[0].stock,17);
  assert.equal((await adm.request('dashboard')).indicators.sales,2000);
  assert.equal((await adm.request(byId('shifts',shift2.id))).summary.expected,250);
  await adm.request(byId('shifts',shift1.id,'move'),{kind:'adjustment',amount:100,reason:'Correção posterior'});
  const corrected=await adm.request(byId('shifts',shift1.id));
  assert.equal(corrected.difference,-100);
  assert.equal(corrected.summary.expected,13100);

  await adm.request('cash/open',{register:(await adm.request('cash/registers',{name:'Caixa de apoio'})).id,opening:0});
  const first=await link(employee,await open(employee,cards[2]));
  const second=await link(adm,await open(adm,cards[3]));
  const firstItems=(await add(employee,first,product,2)).order;
  const secondItems=(await add(adm,second,product,2)).order;
  const competitors=await Promise.all([employee.raw(byId('orders',first.id,'payments'),{version:firstItems.version,
    payments:[{method:'store',amount:1500}],request_id:randomUUID()}),adm.raw(byId('orders',second.id,'payments'),{version:secondItems.version,
    payments:[{method:'store',amount:1500}],request_id:randomUUID()})]);
  assert.deepEqual(competitors.map(response=>response.status).sort(),[200,409]);
  await grant(adm,cards[2]);
  const currentFirst=(await fetchCard(adm,cards[2])).order;
  const currentSecond=(await fetchCard(adm,cards[3])).order;
  const merged=await adm.request(byId('orders',first.id,'move'),{mode:'merge',version:currentFirst.version,target:cards[3].id,
    targetVersion:currentSecond.version,reason:'Cliente pediu união'});
  assert.equal(merged.destination.order.confirmed,1500);
  assert.equal(merged.destination.order.total,4000);
  assert.equal((await adm.request(byId('orders',first.id))).merged_into,second.id);
  await grant(adm,cards[4]);
  const divided=await adm.request(byId('orders',second.id,'move'),{mode:'split',version:merged.destination.order.version,
    target:cards[4].id,items:[{item:merged.destination.order.items[0].id,quantity:1}],reason:'Divisão solicitada'});
  assert.equal(divided.destination.order.total,1000);
  assert.equal(divided.source.order.confirmed,1500);
  const cashierApproval={...manager,password:'senha-incorreta'};
  await employee.request(byId('products',product.id,'stock'),{delta:1,reason:'Ajuste solicitado',approval:cashierApproval},403);
  await employee.request(byId('products',product.id,'stock'),{delta:1,reason:'Ajuste solicitado',approval:manager});
  assert.equal((await employee.request('session')).user.role,'operator');
  await employee.request('management',undefined,403);

  const supplier=await adm.request('suppliers',{name:'Distribuidor'});
  const box=await adm.request('products',{code:'BOX',name:'Caixa',category:'TCG',price:2900,minimum:0,stock:0});
  const booster=await adm.request('products',{code:'B',name:'Booster',category:'TCG',price:700,minimum:0,stock:0});
  await adm.request('merchandise',{product:box.id,supplier:supplier.id,quantity:1,cost:1001,reason:'Nota de compra'});
  await adm.request('inventory/breakpack',{source:box.id,target:booster.id,consumed:1,per:3,reason:'Abrir caixa'});
  const catalog=await adm.request('products');
  assert.equal(catalog.find(row=>row.id===box.id).stock_value,0);
  assert.equal(catalog.find(row=>row.id===booster.id).stock_value,1001);
  assert.equal(catalog.find(row=>row.id===booster.id).stock,3);
  await adm.request('inventory/count',{product:booster.id,expected:3,counted:2,reason:'Contagem física'});
  await adm.request('merchandise',{product:booster.id,customer:customer.id,quantity:1,cost:120,reason:'Compra de carta em crédito'});
  const report=await adm.request('management');
  assert.equal(report.indicators.funded,2000);
  assert.equal(report.indicators.granted,120);
  assert.equal(report.indicators.receipts,2500);
  assert.equal(report.indicators.difference,-100);
  const receipt=report.receipts.find(row=>row.entity==='payment' && row.method==='pix');
  assert.equal(receipt.shift_id,shift2.id);
  await adm.request('reconcile',{entity:receipt.entity,id:receipt.id,reviewed:true,reason:'Identificador do extrato'});
  assert.equal((await adm.request('management')).receipts.find(row=>row.entity==='payment' && row.id===receipt.id).review.reviewed,1);
  const clientViews=await import('../updates.js');
  assert.match(clientViews.managementPage({management:report,me:boot.user,config:cfg,filters:await adm.request('filters')}),/Produtos parados/);
  assert.match(clientViews.cashPage({cash:await adm.request('cash'),me:boot.user,config:cfg}),/Dinheiro esperado/);

  const invalid=await adm.request('import/preview',{mode:'create',csv:'codigo;nome;categoria;preco;estoque\nX;Um;TCG;2;1\nX;Dois;TCG;2;1'});
  assert.equal(invalid.errors.length,2);
  const csv='codigo;nome;categoria;preco;estoque\nX;"Carta; especial";TCG;2,35;3';
  const preview=await adm.request('import/preview',{mode:'create',csv});
  assert.equal(preview.rows[0].price,235);
  assert.equal((await adm.request('import/apply',{mode:'create',csv,fingerprint:preview.fingerprint})).applied,1);
  await adm.request('import/apply',{mode:'create',csv,fingerprint:preview.fingerprint},409);
  const oldQr=await decodeQR(Buffer.from(await (await adm.raw(byId('cards',cards[5].id,'qr'))).arrayBuffer()));
  await adm.request(byId('cards',cards[5].id,'block'),{reason:'Cartão perdido'});
  await adm.request('scan',{mode:'direct',code:oldQr},409);
  await adm.request(byId('cards',cards[5].id,'replace'),{reason:'Novo cartão'});
  await adm.request('scan',{mode:'direct',code:oldQr},404);
  await grant(adm,cards[5]);

  const backup=await adm.request('backups',{});
  assert.equal(backup.error,null);
  assert.ok(backup.lastSuccessful && backup.lastExternal);
  const restored=join(root,'restored.sqlite');
  execFileSync(process.execPath,['scripts/restore.cjs',join(external,backup.file),restored]);
  const recovered=await launch(restored);
  try {
    const login=client(recovered.url);
    await login.request('login',manager);
    assert.equal((await login.request('dashboard')).indicators.sales,2000);
    assert.equal((await login.request(byId('orders',paid.id))).returns[0].amount,1000);
    assert.equal((await grant(login,cards[3])).order.confirmed,1500);
    assert.equal((await login.request('products')).find(row=>row.code==='X').stock,3);
    const audit=(await login.request('audit?q=comanda.desconto')).rows;
    assert.equal(audit[0].approved_by,boot.user.id);
  } finally {await recovered.stop();}
});

test('intenções idempotentes, cancelamento após login e compra de cartas corrigida',{timeout:25000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'balcao-intent-'));
  const database=join(root,'pdv.sqlite');
  const server=await launch(database);
  t.after(async()=>{await server.stop(); await rm(root,{force:true,recursive:true});});
  const admin=client(server.url), operator=client(server.url), relogin=client(server.url);
  const adm={username:'administrador',password:'admin-teste-123456'};
  const emp={username:'operadora',password:'operadora-teste-123456'};
  await admin.request('setup',{...adm,name:'Administrador'});
  await admin.request('users',{...emp,name:'Operadora',role:'operator',permissions:{scan_number:true}});
  await operator.request('login',emp);
  const second=(await admin.request('cash/registers',{name:'Caixa admin'})).id;
  const adminShift=await admin.request('cash/open',{register:second,opening:0});
  const shift=await operator.request('cash/open',{register:1,opening:200});
  const customer=await admin.request('customers',{name:'Cliente teste',phone:'9999'});
  const product=await admin.request('products',{code:'CAR',name:'Carta',category:'TCG',price:500,stock:0,minimum:0});
  const supplier=await admin.request('suppliers',{name:'Distribuidor'});
  async function replay(client,path,body,changed) {
    const intent={...body,request_id:randomUUID()};
    const [first,second]=await Promise.all([client.request(path,intent),client.request(path,intent)]);
    assert.deepEqual(first,second);
    const reordered=Object.fromEntries(Object.entries(intent).reverse());
    assert.deepEqual(await client.request(path,reordered),first);
    await client.request(path,{...intent,...changed},409);
    return {first,intent};
  }
  await admin.request(`customers/${customer.id}/deposit`,{amount:1200,origin:'cash',reason:'Recebido',request_id:null},400);
  const deposit=await replay(admin,`customers/${customer.id}/deposit`,{amount:1200,origin:'cash',reason:'Recebido'},{amount:1210});
  assert.equal((await admin.request(`customers/${customer.id}`)).balance,1200);
  await operator.request(`customers/${customer.id}/deposit`,deposit.intent,409);
  await replay(admin,'merchandise',{product:product.id,supplier:supplier.id,quantity:4,cost:210,reason:'Fornecedor'},{cost:220});
  const trade=await replay(admin,'merchandise',{product:product.id,customer:customer.id,quantity:2,cost:250,reason:'Compra teste'},{quantity:3});
  assert.equal((await admin.request('products'))[0].stock,6);
  assert.equal((await admin.request(`customers/${customer.id}`)).balance,1700);
  await admin.request(`ledger/${trade.first.ledger_id}/reverse`,{reason:'Estorno isolado'},409);
  const correction=await replay(admin,`merchandise/${trade.first.id}/correct`,{
    mode:'replace',product:product.id,quantity:1,cost:240,reason:'Corrigir quantidade'
  },{cost:245});
  assert.ok(correction.first.replacement_id);
  const fixed=await admin.request('products');
  assert.equal(fixed[0].stock,5);
  assert.equal(fixed[0].stock_value,1080);
  const credit=await admin.request(`customers/${customer.id}`);
  assert.equal(credit.balance,1440);
  assert.equal(credit.ledger.find(row=>row.id===correction.first.ledger_reversal_id).original_id,trade.first.ledger_id);
  assert.equal((await admin.request(`merchandise/${correction.first.replacement_id}`)).original_id,trade.first.id);
  await admin.request(`merchandise/${trade.first.id}/correct`,{mode:'reverse',reason:'Tentativa duplicada'},409);
  const legacyTrade=await admin.request('merchandise',{product:product.id,customer:customer.id,quantity:1,cost:123,reason:'Compra antiga'});
  const db=new DatabaseSync(database);
  try {
    db.prepare(`INSERT INTO ledger(customer_id,amount,kind,origin,reason,original_id,user_id,user_name,created_at,source)
      SELECT customer_id,-amount,'deposit_reversal',origin,'Estorno legado',id,user_id,user_name,created_at,source FROM ledger WHERE id=?`).run(legacyTrade.ledger_id);
  } finally {db.close();}
  const legacyCorrection=await admin.request(`merchandise/${legacyTrade.id}/correct`,{mode:'reverse',reason:'Reconciliar o legado'});
  assert.equal((await admin.request(`customers/${customer.id}`)).ledger.filter(row=>row.original_id===legacyTrade.ledger_id).length,1);
  assert.equal((await admin.request('products'))[0].stock_value,1080);
  assert.ok(legacyCorrection.ledger_reversal_id);

  const movePath=`shifts/${shift.id}/move`;
  const move=await replay(operator,movePath,{kind:'supply',amount:300,reason:'Troco no caixa'},{kind:'withdrawal'});
  const [card]=await admin.request('cards',{start:301,count:1});
  await operator.request('scan/number',{number:card.number,reason:'Leitura manual'});
  const order=(await operator.request(`cards/${card.id}/open`,{})).order;
  await operator.request(`orders/${order.id}/items`,{action:'delta',product:product.id,delta:1});
  const cancelled=await operator.request(`orders/${order.id}/cancel`,{reason:'Cliente desistiu',approval:adm});
  assert.equal(cancelled.closed_shift_id,shift.id);
  await operator.request('logout',{});
  await relogin.request('login',emp);
  assert.equal((await relogin.request(`orders/${order.id}`)).status,'cancelled');
  const filtered=await relogin.request(`history?product=${product.id}&register=1&shift=${shift.id}&status=cancelled`);
  assert.equal(filtered.total,1);
  assert.equal((await relogin.request(`history?register=${second}`)).total,0);
  assert.equal((await relogin.request(`shifts/${shift.id}`)).summary.expected,500);
  await relogin.request(`shifts/${shift.id}/close`,{counted:500});
  assert.deepEqual(await relogin.request(movePath,move.intent),move.first);
  assert.equal((await relogin.request(`shifts/${shift.id}`)).summary.movements.length,1);
  assert.equal((await admin.request(`shifts/${adminShift.id}`)).summary.loads[0].added,1200);
  const masks=new DatabaseSync(database,{readOnly:true});
  try {
    const rows=masks.prepare('SELECT fingerprint,response FROM operation_intents').all();
    assert.ok(rows.length>=10);
    assert.ok(!JSON.stringify(rows).includes(adm.password));
  } finally {masks.close();}
});

test('custo baixado com centavos, restituição e três datas de relatório',{timeout:25000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'balcao-cost-'));
  const database=join(root,'pdv.sqlite');
  const server=await launch(database);
  t.after(async()=>{await server.stop(); await rm(root,{force:true,recursive:true});});
  const operator=client(server.url);
  await operator.request('setup',{username:'admin',password:'admin-teste-123456',name:'Admin'});
  const shift=await operator.request('cash/open',{register:1,opening:0});
  const box=await operator.request('products',{code:'BOX',name:'Caixa',category:'TCG',price:1500,stock:1,cost:1001,minimum:0});
  const unit=await operator.request('products',{code:'UN',name:'Unidade',category:'TCG',price:500,stock:0,minimum:0});
  await operator.request('inventory/breakpack',{source:box.id,target:unit.id,consumed:1,per:3,reason:'Desmembramento'});
  const customer=await operator.request('customers',{name:'Júlia',phone:'12345'});
  const [card]=await operator.request('cards',{start:401,count:1});
  await operator.request('scan/number',{number:card.number,reason:'Leitura manual'});
  const initial=(await operator.request(`cards/${card.id}/open`,{})).order;
  await operator.request(`orders/${initial.id}/update`,{field:'customer',value:customer.id});
  const ordered=(await operator.request(`orders/${initial.id}/items`,{action:'delta',product:unit.id,delta:3})).order;
  const order=await operator.request(`orders/${initial.id}/checkout`,{version:ordered.version,payments:[{method:'debit',amount:1500}]});
  assert.equal(order.items[0].cost_total,1001);
  const originalDate=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',dateStyle:'short'}).format(new Date(order.ended_at));
  const originalPeriod=`period=custom&start=${originalDate}&end=${originalDate}`;
  const tomorrow=new Date(Date.parse(originalDate+'T16:00:00.000Z')+86400000).toISOString();
  const nextPeriod=`period=custom&start=${tomorrow.slice(0,10)}&end=${tomorrow.slice(0,10)}`;
  assert.equal((await operator.request('dashboard?'+originalPeriod)).indicators.profit,499);
  const refund=(restock)=>operator.request(`orders/${order.id}/refund`,{
    request_id:randomUUID(),items:[{item:order.items[0].id,quantity:1,restock}],reason:'Conferência de devolução'
  });
  const partial=await refund(true);
  assert.equal(partial.returns[0].items[0].cost_restocked,333);
  const snapshot=new DatabaseSync(database);
  try {
    snapshot.prepare('UPDATE returns SET created_at=? WHERE id=?').run(tomorrow,partial.returns[0].id);
    snapshot.prepare('UPDATE payment_reversals SET created_at=? WHERE return_id=?').run(tomorrow,partial.returns[0].id);
  } finally {snapshot.close();}
  const first=await operator.request(`dashboard?${originalPeriod}&product=${unit.id}&register=1&shift=${shift.id}`);
  assert.equal(first.indicators.grossSales,1500);
  assert.equal(first.indicators.netSales,1000);
  assert.equal(first.indicators.refundValue,0);
  assert.equal(first.indicators.profit,332);
  const returns=await operator.request(`dashboard?${nextPeriod}&product=${unit.id}&register=1&shift=${shift.id}`);
  assert.equal(returns.indicators.grossSales,0);
  assert.equal(returns.indicators.netSales,0);
  assert.equal(returns.indicators.refundValue,500);
  const spending=await operator.request(`customers/${customer.id}`);
  assert.equal(spending.grossSpent,1500);
  assert.equal(spending.returnedSpent,500);
  assert.equal(spending.spent,1000);
  assert.equal(spending.purchases[0].net,1000);
  assert.equal((await operator.request('history?q=julia&product='+unit.id)).total,1);
  const lost=await refund(false);
  assert.equal(lost.returns[1].items[0].cost_allocated,334);
  assert.equal(lost.returns[1].items[0].cost_restocked,null);
  const final=await refund(true);
  assert.equal(final.returns[2].items[0].cost_restocked,334);
  assert.equal(final.status,'refunded');
  assert.equal((await operator.request('products')).find(row=>row.id===unit.id).stock_value,667);
  const historical=await operator.request('dashboard?'+originalPeriod);
  assert.equal(historical.indicators.netSales,0);
  assert.equal(historical.indicators.grossSales,1500);
  assert.equal(historical.indicators.profit,-334);
  const ledgerReport=await operator.request(`management?${nextPeriod}&product=${unit.id}&register=1&shift=${shift.id}`);
  assert.equal(ledgerReport.indicators.refundValue,500);
  assert.equal(ledgerReport.receiptsCount,1);
  assert.equal((await operator.request(`history?product=${unit.id}&shift=${shift.id}&register=1&status=sales`)).rows[0].returned,1500);
});

test('20 mil vendas e mil produtos com relatórios e leitura QR em paralelo',{timeout:45000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'balcao-load-'));
  const database=join(root,'pdv.sqlite');
  const server=await launch(database);
  let terminal;
  t.after(async()=>{terminal?.close();await server.stop();await rm(root,{force:true,recursive:true});});
  const admin=client(server.url), phone=client(server.url);
  const login={username:'admin',password:'teste-1234567'};
  const clerk={username:'leitor',password:'leitor-1234567'};
  await admin.request('setup',{...login,name:'Admin'});
  await admin.request('users',{...clerk,name:'Leitor',role:'operator'});
  await phone.request('login',clerk);
  const till=await admin.request('cash/open',{register:1,opening:0});
  const [saleCard,readCard]=await admin.request('cards',{start:10,count:2});
  const storage=new DatabaseSync(database);
  try {
    const products=storage.prepare(`INSERT INTO products(id,code,name,category,price,cost,stock,minimum,stock_value) VALUES(?,?,?,'TCG',1000,333,30,1,9990)`);
    const sales=storage.prepare(`INSERT INTO orders(id,card_id,status,user_id,opened_name,opened_at,customer_name,subtotal,total,ended_at,ended_by,ended_name,closed_shift_id)
      VALUES(?,?,'closed',1,'Admin',?,'José',1000,1000,?,1,'Admin',?)`);
    const items=storage.prepare(`INSERT INTO items(order_id,product_id,name,code,category,quantity,price,cost,cost_total)
      VALUES(?,?,?,?,'TCG',1,1000,333,333)`);
    const payments=storage.prepare(`INSERT INTO payments(order_id,method,amount,state,shift_id,received_by,received_name,paid_at,confirmed_at,confirmed_by,original_order_id,confirmed_name)
      VALUES(?,'debit',1000,'confirmed',?,1,'Admin',?,?,1,?,'Admin')`);
    storage.exec('BEGIN IMMEDIATE');
    for (let id=1;id<=1000;id++) products.run(id,'SKU'+id,'Produto '+id);
    for (let id=1;id<=20000;id++) {
      const stamp=new Date(Date.UTC(2026,5,1,12,0,0)+id*1000).toISOString();
      const product=(id-1)%1000+1;
      sales.run(id,saleCard.id,stamp,stamp,till.id);
      items.run(id,product,'Produto '+product,'SKU'+product);
      payments.run(id,till.id,stamp,stamp,id);
    }
    storage.exec('COMMIT');
  } finally {storage.close();}
  terminal=await admin.events();
  const pairing=await admin.request('pairing/code',{name:'Caixa de carga'});
  await phone.request('pairing/link',{code:pairing.code});
  const image=await admin.raw(`cards/${readCard.id}/qr`);
  const qr=await decodeQR(Buffer.from(await image.arrayBuffer()));
  const dates='period=custom&start=2026-06-01&end=2026-06-02';
  const paths=[`dashboard?${dates}`,`management?${dates}`,'history?q=jose&register=1','history.csv?start=2026-06-01&end=2026-06-02','stock-insights','stock-insights.csv'];
  await admin.request('filters');
  const endedReports=new Set();
  const loadAt=performance.now();
  const jobs=paths.map(async path=>{
    const response=await admin.raw(path);
    assert.equal(response.status,200);
    const value=path.split('?')[0].endsWith('.csv')?await response.text():await response.json();
    endedReports.add(path);
    return value;
  });
  const pending=Promise.all(jobs);
  pending.catch(()=>{});
  await new Promise(resolve=>setTimeout(resolve,15));
  assert.ok(endedReports.size<paths.length,'o teste deve sobrepor relatório e leitura');
  const at=performance.now();
  await phone.request('scan',{code:qr,mode:'paired'});
  assert.equal((await terminal.until('card')).id,readCard.id);
  await admin.request(`cards/${readCard.id}`);
  const latency=performance.now()-at;
  assert.ok(latency<1000,`leitura com relatório demorou ${latency.toFixed(1)} ms`);
  const [dashboard,management,history,csv,insights,insightsCsv]=await pending;
  assert.equal(dashboard.indicators.grossOrders,20000);
  assert.equal(dashboard.indicators.grossSales,20_000_000);
  assert.equal(dashboard.indicators.profit,13_340_000);
  assert.equal(dashboard.products.length,1000);
  assert.equal(management.receiptsCount,20000);
  assert.equal(management.receipts.length,100);
  assert.equal(history.total,20000);
  assert.equal(history.rows.length,50);
  assert.equal(csv.split('\r\n').length,20001);
  assert.equal(insights.mode,'local');
  assert.equal(insights.rows.length,1000);
  assert.ok(insights.rows.every(row=>row.stock===30 && row.available===30));
  assert.equal(insightsCsv.split('\r\n').length,1001);
  assert.equal((await admin.request(`history?product=1&register=1&shift=${till.id}`)).total,20);
  t.diagnostic(`QR pareado com consulta à comanda: ${latency.toFixed(1)} ms. ${paths.length} relatórios concorrentes: ${(performance.now()-loadAt).toFixed(1)} ms.`);
});

test('o navegador retoma a intenção após perder a resposta e abre Atendimento para o operador',async t=>{
  const {protectedSend}=await import('../updates.js');
  const {initialView}=await import('../views.js');
  const storage=new Map();
  const previous=globalThis.sessionStorage;
  globalThis.sessionStorage={
    getItem:key=>storage.get(key) ?? null,
    setItem:(key,value)=>storage.set(key,value),
    removeItem:key=>storage.delete(key)
  };
  t.after(()=>{
    if (previous===undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage=previous;
  });
  const operator={id:5,role:'operator',permissions:{operate:true,cashier:true}};
  assert.equal(initialView(operator,''),'pos');
  assert.equal(initialView(operator,'#leitor'),'scanner');
  assert.equal(initialView({role:'admin',permissions:{reports:true}},''),'dashboard');
  const requests=[];
  const ctx={state:{me:operator},async send(path,body) {
    requests.push({path,body});
    if (requests.length===1) throw Error('Resposta perdida');
    return {ok:true};
  }};
  const path='customers/7/deposit';
  const payload={amount:600,reason:'Recarga paga'};
  await assert.rejects(protectedSend(ctx,path,{...payload,approval:{password:'senha temporária'}},{}),/Resposta perdida/);
  assert.equal(storage.size,1);
  assert.ok(!JSON.stringify([...storage]).includes('senha temporária'));
  await protectedSend(ctx,path,{reason:payload.reason,amount:payload.amount},{});
  assert.equal(requests[0].body.request_id,requests[1].body.request_id);
  assert.equal(storage.size,0);
  await protectedSend(ctx,path,payload,{});
  assert.notEqual(requests[1].body.request_id,requests[2].body.request_id);
});

test('ajuste de estoque e desmembramento são gravados uma vez por intenção',{timeout:25000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'balcao-stock-intent-'));
  const database=join(root,'pdv.sqlite');
  const server=await launch(database);
  t.after(async()=>{await server.stop(); await rm(root,{force:true,recursive:true});});
  const admin=client(server.url),operator=client(server.url);
  const credentials={username:'admin',password:'admin-estoque-123'};
  const employee={username:'operador',password:'operador-estoque-123'};
  const {user:manager}=await admin.request('setup',{...credentials,name:'Administrador'});
  const clerk=await admin.request('users',{...employee,name:'Operador',role:'operator'});
  await operator.request('login',employee);

  const item=await admin.request('products',{code:'MANUAL',name:'Item manual',category:'Teste',price:500,cost:200,stock:10,minimum:0});
  const stockPath=`products/${item.id}/stock`;
  const adjustment={request_id:randomUUID(),delta:2,reason:'Reposição manual'};
  const snapshot=async()=>{
    const rows=await admin.request('products');
    return Object.fromEntries(rows.map(row=>[row.code,{stock:row.stock,value:row.stock_value}]));
  };
  const audits=action=>admin.request('audit?q='+action);

  await operator.request(stockPath,{...adjustment,request_id:null},400);
  await operator.request(stockPath,adjustment,403);
  await operator.request(stockPath,{...adjustment,approval:{...credentials,password:'credencial-incorreta'}},403);
  assert.equal((await snapshot()).MANUAL.stock,10);
  assert.ok((await audits('aprovacao.recusada')).rows.some(row=>row.user_id===clerk.id && row.entity_id===item.id));
  const updated=await operator.request(stockPath,{...adjustment,approval:credentials});
  assert.equal(updated.stock,12);
  assert.deepEqual(await operator.request(stockPath,adjustment),updated);
  await operator.request(stockPath,{...adjustment,delta:3},409);
  await admin.request(stockPath,adjustment,409);
  assert.equal((await snapshot()).MANUAL.stock,12);
  const approvals=(await audits('aprovacao.concedida')).rows.filter(row=>row.entity_id===item.id && row.user_id===clerk.id);
  assert.equal(approvals.length,1);
  assert.equal(approvals[0].approved_by,manager.id);
  const manualMoves=()=>admin.request(`products/${item.id}/movements`);
  assert.equal((await manualMoves()).filter(row=>row.kind==='adjustment').length,1);
  assert.equal((await operator.request(stockPath,{...adjustment,request_id:randomUUID(),approval:credentials})).stock,14);
  assert.equal((await manualMoves()).filter(row=>row.kind==='adjustment').length,2);

  const box=await admin.request('products',{code:'CX',name:'Caixa',category:'Teste',price:2000,cost:1001,stock:3,minimum:0});
  const unit=await admin.request('products',{code:'UN',name:'Unidade',category:'Teste',price:700,stock:0,minimum:0});
  const packPath='inventory/breakpack';
  const pack={request_id:randomUUID(),source:box.id,target:unit.id,consumed:1,per:3,reason:'Abrir caixa'};
  await admin.request(packPath,{...pack,request_id:null},400);
  await operator.request(packPath,{...pack,approval:credentials},403);
  assert.deepEqual((await snapshot()).CX,{stock:3,value:3003});
  const [packed,replayed]=await Promise.all([admin.request(packPath,pack),admin.request(packPath,pack)]);
  assert.deepEqual(packed,replayed);
  await admin.request(packPath,{...pack,per:4},409);
  assert.deepEqual((await snapshot()).CX,{stock:2,value:2002});
  assert.deepEqual((await snapshot()).UN,{stock:3,value:1001});
  assert.equal((await audits('estoque.desmembrado')).total,1);
  const another=await admin.request(packPath,{...pack,request_id:randomUUID()});
  assert.notEqual(packed.id,another.id);
  assert.deepEqual((await snapshot()).CX,{stock:1,value:1001});
  assert.deepEqual((await snapshot()).UN,{stock:6,value:2002});

  // Força a falha na gravação da chave após os lançamentos da operação.
  const db=new DatabaseSync(database);
  try {
    db.exec(`CREATE TRIGGER deny_intent_for_test BEFORE INSERT ON operation_intents
      WHEN NEW.token IN ('rollback-stock-test','rollback-breakpack-test')
      BEGIN SELECT RAISE(ABORT,'simulação de falha ao gravar a chave'); END;`);
    await operator.request(stockPath,{...adjustment,request_id:'rollback-stock-test',approval:credentials},500);
    await admin.request(packPath,{...pack,request_id:'rollback-breakpack-test'},500);
    const saved=await snapshot();
    assert.deepEqual(saved.MANUAL,{stock:14,value:2800});
    assert.deepEqual(saved.CX,{stock:1,value:1001});
    assert.deepEqual(saved.UN,{stock:6,value:2002});
    assert.equal((await manualMoves()).filter(row=>row.kind==='adjustment').length,2);
    assert.equal((await audits('estoque.desmembrado')).total,2);
    assert.equal((await audits('aprovacao.concedida')).total,2);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM breakpacks').get().n,2);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM operation_intents WHERE token LIKE 'rollback-%'").get().n,0);
  } finally {db.close();}
});

test('campos descritivos em maiúsculas e valores contábeis mantêm os centavos',async()=>{
  const {input,textarea,search,moneyInput,cents,decimal,money,uppercaseField,editMoneyField,formatMoneyField}=await import('../ui.js');
  assert.match(input('name','João'),/data-uppercase/);
  assert.match(textarea('notes','Observação'),/data-uppercase/);
  assert.match(search('pos-search','','Buscar produto'),/data-uppercase/);
  for (const attrs of ['type="password"','type="email"','type="number"','type="date"','data-verbatim','inputmode="numeric"']) {
    assert.doesNotMatch(input('field','aB',attrs),/data-uppercase/);
  }
  function field(value,attribute,position=value.length) {
    return {value,selectionStart:position,selectionEnd:position,selectionDirection:'none',
      hasAttribute:name=>name===attribute,setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}};
  }
  const name=field('josé da silva','data-uppercase',4);
  uppercaseField(name);
  assert.deepEqual([name.value,name.selectionStart],['JOSÉ DA SILVA',4]);
  const text=field('aßb','data-uppercase',2);
  uppercaseField(text);
  assert.deepEqual([text.value,text.selectionStart],['ASSB',3]);
  const password=field('AbC123',null);
  uppercaseField(password);
  assert.equal(password.value,'AbC123');

  assert.match(moneyInput('price',123456),/R\$<\/span><input name="price" value="1\.234,56" data-money/);
  assert.doesNotMatch(moneyInput('price',123456),/data-uppercase/);
  assert.equal(cents(decimal(123456)),123456);
  assert.equal(cents('R$\u00a01.234,56'),123456);
  assert.equal(cents('1234.56'),123456);
  assert.equal(cents('25'),2500);
  assert.equal(cents(',5'),50);
  assert.equal(cents('1.234'),123400);
  assert.throws(()=>cents('12,345'),/valor válido/);
  assert.throws(()=>cents('R$ inválido'),/valor válido/);
  assert.match(money(-123456),/^\(R\$\s1\.234,56\)$/);
  const amount=field('1.234,56','data-money',4);
  editMoneyField(amount);
  assert.deepEqual([amount.value,amount.selectionStart],['1234,56',3]);
  amount.value='1234,5';
  formatMoneyField(amount);
  assert.equal(amount.value,'1.234,50');
  assert.equal(cents(amount.value),123450);
  amount.value='';
  formatMoneyField(amount);
  assert.equal(amount.value,'');
});
