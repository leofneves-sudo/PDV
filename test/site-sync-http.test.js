const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {setTimeout:delay}=require('node:timers/promises');
const {DEFAULT_URL}=require('../site-catalog');
test('HTTP agenda consultas, altera estoque por diferenças e protege configuração e execução',{timeout:20000},async t=>{
  const seed=`const browser=require('./site-browser');browser.createPageReader=()=>({async read(url){
    const target=new URL(url);if(target.searchParams.get('fixture_error'))throw Error('HTTP 403 de teste');
    return '<div class="card-item"><div class="card-desc"><div class="title"><a href="/?view=ecom/item&card=77111">Produto da rotina</a></div><div class="qty"><span>'+(target.searchParams.get('fixture_stock') || '10')+'</span></div><div class="price"><span class="align-price">R$ 20,00</span></div></div></div>';
  },async close(){}});require('./server');`;
  const child=spawn(process.execPath,['-e',seed],{windowsHide:true,env:{...process.env,PDV_DB:':memory:',PDV_HOST:'127.0.0.1',PDV_PORT:'0',PDV_ORIGIN:'',PDV_TLS_CERT:'',PDV_TLS_KEY:'',PDV_BACKUP_MINUTES:'0'},stdio:['ignore','pipe','pipe']});
  const exited=once(child,'exit');let output='',errors='';child.stderr.on('data',chunk=>errors+=chunk);
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await exited;});
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(errors)),10000);child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});child.once('error',reject);});
  function client(){let cookie='';const request=async(path,body,status=200,headers={})=>{
    const response=await fetch(url+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});
    if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
    const data=await response.json();assert.equal(response.status,status,path+': '+JSON.stringify(data));return data;
  };return request;}
  const admin=client(),operator=client(),anonymous=client();
  await anonymous('site-sync/list',undefined,401);
  await admin('setup',{username:'admin',name:'Administrador',password:'teste-sync-http-123'});
  await admin('users',{username:'operador',name:'Operador',password:'teste-sync-http-123',role:'operator',permissions:{products:true,stock:true,users:true}});
  await operator('login',{username:'operador',password:'teste-sync-http-123'});
  for(const [path,body] of [['site-sync/list',undefined],['site-sync/save',{}],['site-sync/run',{id:1}],['site-sync/remove',{id:1}]])await operator(path,body,403);
  await admin('site-sync/list',undefined,428,{'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile'});
  await admin('site-sync/save',{name:'Inválido',url:'https://localhost/?view=ecom/itens',interval_minutes:30},400);
  const asset=await fetch(url+'/site-sync-ui.js');assert.equal(asset.status,200);
  const config=await admin('site-sync/save',{name:'Link de teste',url:DEFAULT_URL,category:'Cartas',interval_minutes:5,enabled:false,create_new:true});
  assert.equal((await admin('products')).length,0);
  await admin('site-sync/save',{id:config.id,enabled:true});
  async function waitFor(predicate) {for(let i=0;i<150;i++){const state=await admin('site-sync/list');if(predicate(state))return state;await delay(30);}throw Error('Consulta não terminou.');}
  let state=await waitFor(data=>data.runs.some(row=>row.status==='success'));
  const product=(await admin('products'))[0];assert.equal(product.stock,10);assert.equal(state.runs[0].created,1);
  await admin('products/'+product.id+'/stock',{delta:-2,reason:'Venda local simulada',request_id:'ajuste-local-sync-http-01'});
  await admin('site-sync/save',{id:config.id,url:DEFAULT_URL+'&fixture_stock=9'});
  state=await waitFor(data=>data.runs[0]?.status==='success' && data.runs[0]?.updated===1);
  assert.equal((await admin('products'))[0].stock,7);
  await admin('site-sync/save',{id:config.id,url:DEFAULT_URL+'&fixture_error=1'});
  await waitFor(data=>data.runs[0]?.status==='error');assert.equal((await admin('products'))[0].stock,7);
  await admin('site-sync/save',{id:config.id,enabled:false});
  await admin('site-sync/run',{id:config.id},409);
  await admin('site-sync/remove',{id:config.id});
  assert.equal((await admin('site-sync/list')).jobs.length,0);assert.equal((await admin('products'))[0].stock,7);
});
