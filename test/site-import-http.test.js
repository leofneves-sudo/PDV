const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {DEFAULT_URL}=require('../site-catalog');
const html=`<html><head><title>Loja de teste</title></head><body><div class="card-item"><div class="card-desc">
  <div class="title"><a href="/?view=ecom/item&amp;tcg=2&amp;card=17">Produto de teste</a></div>
  <div class="qty"><span>5</span></div><div class="price"><span class="align-price">R$ 25,50</span></div></div></div></body></html>`;
test('HTTP protege a importação, aceita HTML e cadastra produtos selecionados sem duplicar',{timeout:20000},async t=>{
  const child=spawn(process.execPath,['server.js'],{windowsHide:true,env:{...process.env,PDV_DB:':memory:',PDV_HOST:'127.0.0.1',PDV_PORT:'0',PDV_ORIGIN:'',PDV_TLS_CERT:'',PDV_TLS_KEY:'',PDV_BACKUP_MINUTES:'0'},stdio:['ignore','pipe','pipe']});
  const exited=once(child,'exit');let output='',errors='';child.stderr.on('data',chunk=>errors+=chunk);
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await exited;});
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Servidor não iniciou: '+errors)),10000);child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});child.once('error',reject);});
  function client(){let cookie='';return async(path,body,status=200)=>{
    const response=await fetch(url+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});
    if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
    const data=await response.json();assert.equal(response.status,status,path+': '+JSON.stringify(data));return data;
  };}
  const admin=client(),operator=client(),anonymous=client();
  await anonymous('site-import/config',undefined,401);
  await admin('setup',{username:'admin',name:'Administrador',password:'teste-importacao-http'});
  await admin('users',{username:'operador',name:'Operador',password:'teste-importacao-http',role:'operator',permissions:{products:true,stock:true,users:true}});
  await operator('login',{username:'operador',password:'teste-importacao-http'});
  for(const [path,body] of [['site-import/config',undefined],['site-import/html',{url:DEFAULT_URL,html}],['site-import/analyze',{url:DEFAULT_URL}],['site-import/apply',{}]])await operator(path,body,403);
  await admin('site-import/analyze',{url:'https://localhost/?view=ecom/itens'},400);
  const config=await admin('site-import/config');assert.equal(config.defaultUrl,DEFAULT_URL);
  const asset=await fetch(url+'/site-import-ui.js');assert.equal(asset.status,200);assert.match(asset.headers.get('content-type'),/javascript/);
  const preview=await admin('site-import/html',{url:DEFAULT_URL,html});
  assert.equal(preview.status,'ready');assert.equal(preview.rows.length,1);
  assert.equal((await admin('products')).length,0);
  await operator('site-import/status?id='+preview.id,undefined,403);
  const status=await admin('site-import/status?id='+preview.id+'&details=1');assert.equal(status.rows[0].stock,5);
  const result=await admin('site-import/apply',{id:preview.id,mode:'create',images:false,rows:[{key:preview.rows[0].key}]});
  assert.equal(result.created,1);
  const [product]=await admin('products');assert.equal(product.name,'Produto de teste');assert.equal(product.stock,5);assert.equal(product.price,2550);
  const next=await admin('site-import/html',{url:DEFAULT_URL,html});assert.equal(next.rows[0].existing.id,product.id);
  const repeat=await admin('site-import/apply',{id:next.id,mode:'create',rows:[{key:next.rows[0].key}]});assert.equal(repeat.skipped,1);
  assert.equal((await admin('products')).length,1);
});
