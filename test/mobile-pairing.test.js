const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');

test('HTTP exige vínculo com o computador para usar o celular',{timeout:25000},async t=>{
  const cardToken='11111111-1111-4111-8111-111111111111';
  const seed=`const {run}=require('./db');run('INSERT INTO cards(number,token) VALUES(51,?)','${cardToken}');require('./server');`;
  const child=spawn(process.execPath,['-e',seed],{windowsHide:true,
    env:{...process.env,PDV_DB:':memory:',PDV_HOST:'127.0.0.1',PDV_PORT:'0',PDV_ORIGIN:'',PDV_TLS_CERT:'',PDV_TLS_KEY:'',PDV_BACKUP_MINUTES:'0'},
    stdio:['ignore','pipe','pipe']});
  const exited=once(child,'exit');
  const streams=[];
  let output='',errors='';
  child.stderr.on('data',chunk=>errors+=chunk);
  t.after(async()=>{
    for (const controller of streams) controller.abort();
    if (child.exitCode===null && child.signalCode===null) child.kill();
    await exited;
  });
  const url=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Servidor não iniciou: '+errors)),10000);
    child.stdout.on('data',chunk=>{
      output+=chunk;
      const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {clearTimeout(timer);resolve(match[0]);}
    });
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',()=>{clearTimeout(timer);reject(Error(errors));});
  });
  function client(headers={}) {
    let cookie='';
    return {
      async request(path,body,status=200) {
        const response=await fetch(url+'/api/'+path,{method:body===undefined?'GET':'POST',
          headers:{...headers,Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},
          ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});
        if (response.headers.get('set-cookie')) cookie=response.headers.get('set-cookie').split(';')[0];
        const data=await response.json();
        assert.equal(response.status,status,path+': '+JSON.stringify(data));
        return data;
      },
      async online() {
        const controller=new AbortController();
        streams.push(controller);
        const response=await fetch(url+'/api/events',{headers:{...headers,Cookie:cookie},signal:controller.signal});
        assert.equal(response.status,200);
        const reader=response.body.getReader();
        assert.match(Buffer.from((await reader.read()).value).toString(),/event: ready/);
      }
    };
  }
  const admin={username:'gerente',name:'Gerente',password:'teste-vinculo-123'};
  const operator={username:'atendente',name:'Atendente',password:'teste-celular-123',role:'operator',permissions:{checkout:false}};
  const till=client();
  await till.request('setup',admin);
  await till.request('users',operator);
  const phone=client({'X-Forwarded-For':'192.168.50.200'});
  await phone.request('login',operator);
  const product=await till.request('products',{code:'ACESS',name:'Acessório',category:'Acessórios',price:500,cost:200,stock:10,minimum:0});
  const card={id:1,number:51,token:cardToken};
  let order;
  await t.test('reconhece o acesso pela rede e o navegador móvel sem restringir o caixa local',async()=>{
    assert.equal((await till.request('session')).pairingRequired,false);
    assert.equal((await phone.request('session')).pairingRequired,true);
    assert.equal((await client({'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile'}).request('session')).pairingRequired,true);
    assert.equal((await client({'Sec-CH-UA-Mobile':'?1'}).request('session')).pairingRequired,true);
    assert.equal((await client({Forwarded:'for=192.168.50.200'}).request('session')).pairingRequired,true);
    assert.equal((await till.request('products')).length,1);
  });
  await t.test('sem vínculo bloqueia dados, relatórios, QR e alterações mesmo com leitura própria',async()=>{
    for (const path of ['products','open-cards','cards/1','cards/1/qr','dashboard','stock-insights.csv','inventory/expiry.csv']) {
      await phone.request(path,undefined,428);
    }
    await phone.request('scan',{code:'pdv:'+card.token,mode:'direct'},428);
    await phone.request('scan',{code:'pdv:'+card.token,mode:'paired'},428);
    await phone.request('cards/'+card.id+'/open',{},428);
    await phone.request('pairing/code',{name:'Código no celular'},403);
    await phone.request('pairing/revoke',{reason:'Tentativa no celular'},403);
    const mobileAdmin=client({'X-Forwarded-For':'192.168.50.201'});
    await mobileAdmin.request('login',admin);
    await mobileAdmin.request('products',undefined,428);
    await mobileAdmin.request('pairing/code',{name:'Administrador no celular'},403);
    assert.equal((await till.request('open-cards')).total,0);
    assert.equal((await till.request('products'))[0].stock,10);
  });
  await t.test('código do PC libera o acesso uma vez e leitura direta também é enviada ao caixa',async()=>{
    await till.online();
    await phone.online();
    await phone.request('pairing/link',{code:'000000'},409);
    const pair=await till.request('pairing/code',{name:'Caixa principal'});
    assert.equal((await phone.request('pairing/link',{code:pair.code})).reader.name,'Caixa principal');
    const secondPhone=client({'X-Forwarded-For':'192.168.50.202'});
    await secondPhone.request('login',operator);
    await secondPhone.request('pairing/link',{code:pair.code},409);
    assert.equal((await phone.request('products')).length,1);
    const scanned=await phone.request('scan',{code:'pdv:'+card.token,mode:'direct'});
    assert.equal(scanned.sent,true);
    assert.equal(scanned.terminal,'Caixa principal');
    assert.equal((await till.request('cards/'+card.id)).id,card.id);
    order=(await phone.request('cards/'+card.id+'/open',{})).order;
    await phone.request('orders/'+order.id+'/items',{product:product.id,action:'delta',delta:1});
    assert.equal((await till.request('cards/'+card.id)).order.items[0].quantity,1);
    assert.equal((await phone.request('session')).pairing.reader.name,'Caixa principal');
    await phone.request('pairing/code',{name:'Código no celular vinculado'},403);
  });
  await t.test('desvincular bloqueia as próprias leituras e impede novas inclusões',async()=>{
    await phone.request('pairing/unlink',{});
    await phone.request('cards/'+card.id,undefined,428);
    await phone.request('orders/'+order.id+'/items',{product:product.id,action:'delta',delta:1},428);
    assert.equal((await till.request('cards/'+card.id)).order.items[0].quantity,1);
    assert.equal((await phone.request('session')).pairing.reader,null);
  });
  await t.test('revogar no PC e encerrar a sessão do caixa invalidam o vínculo',async()=>{
    let pair=await till.request('pairing/code',{name:'Novo vínculo'});
    await phone.request('pairing/link',{code:pair.code});
    await till.request('pairing/revoke',{reason:'Teste de revogação'});
    await phone.request('open-cards',undefined,428);
    pair=await till.request('pairing/code',{name:'Antes de sair'});
    await phone.request('pairing/link',{code:pair.code});
    await till.request('logout',{});
    assert.equal((await phone.request('pairing')).reader,null);
    await phone.request('products',undefined,428);
    await phone.request('scan',{code:'pdv:'+card.token,mode:'direct'},428);
    await phone.request('logout',{});
  });
});
