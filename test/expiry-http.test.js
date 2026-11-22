const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {randomUUID}=require('node:crypto');
const {storeDay}=require('../expiry.mjs');

test('HTTP publica regra de validade, exporta estoque e baixa perdas uma única vez',{timeout:15000},async()=>{
  const child=spawn(process.execPath,['server.js'],{
    env:{...process.env,PDV_DB:':memory:',PDV_HOST:'127.0.0.1',PDV_PORT:'0',PDV_TIMEZONE:'America/Sao_Paulo',PDV_ORIGIN:'',PDV_TLS_CERT:'',PDV_TLS_KEY:'',PDV_BACKUP_MINUTES:'0'},
    stdio:['ignore','pipe','pipe']
  });
  const exited=once(child,'exit');
  let output='',errors='';
  child.stderr.on('data',data=>errors+=data);
  try {
    const url=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Servidor não iniciou: '+errors)),5000);
      child.stdout.on('data',chunk=>{
        output+=chunk;
        const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) {clearTimeout(timer);resolve(match[0]);}
      });
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('exit',()=>{clearTimeout(timer);reject(Error(errors));});
    });
    let cookie='';
    const request=async(path,body)=>{
      const response=await fetch(url+'/api/'+path,{method:body===undefined?'GET':'POST',
        headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(4000)});
      if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
      return response;
    };
    assert.equal((await request('inventory/expiry.csv')).status,401);
    assert.equal((await request('stock-insights')).status,401);
    assert.equal((await request('setup',{username:'admin',name:'Administrador de teste',password:'expiry-test-1234'})).status,200);
    const yesterday=new Date(storeDay()+'T00:00:00Z');
    yesterday.setUTCDate(yesterday.getUTCDate()-1);
    const expires_on=yesterday.toISOString().slice(0,10);
    const created=await request('products',{code:'SUCO',name:'Suco vencido',category:'Bebidas',expires_on,price:500,cost:100,stock:10,minimum:0});
    assert.equal(created.status,200);
    const product=await created.json();
    assert.equal(product.expiry.status,'expired');
    const asset=await fetch(url+'/expiry.mjs');
    assert.equal(asset.status,200);
    assert.match(asset.headers.get('content-type'),/javascript/);
    const body={request_id:randomUUID(),quantity:4,expected_stock:10,expected_expiry:expires_on,reason:'Descarte por vencimento'};
    for(let index=0;index<2;index++){
      const response=await request(`products/${product.id}/expiry-loss`,body);
      assert.equal(response.status,200,await response.clone().text());
      assert.equal((await response.json()).stock,6);
    }
    const moves=await (await request(`products/${product.id}/movements`)).json();
    assert.equal(moves.filter(row=>row.kind==='expiry_loss').length,1);
    const csv=await request('inventory/expiry.csv');
    assert.equal(csv.status,200);
    assert.match(csv.headers.get('content-type'),/text\/csv/);
    assert.match(await csv.text(),/Suco vencido/);
    const analysis=await request('stock-insights?idleDays=30');
    assert.equal(analysis.status,200);
    const report=await analysis.json();
    assert.equal(report.mode,'local');
    assert.ok(report.rows.some(row=>row.id===product.id && row.expiry.blocked));
    assert.equal((await request('stock-insights.csv')).status,200);
  } finally {
    if (child.exitCode===null && child.signalCode===null) child.kill();
    await exited;
  }
});
