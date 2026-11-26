const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {setTimeout:delay}=require('node:timers/promises');
const fs=require('node:fs');
const {resolve,join}=require('node:path');
const {chromium}=require('playwright-core');
const {browserExecutable}=require('../site-browser');
const {DEFAULT_URL}=require('../site-catalog');
const output=resolve('test-output/site-sync');fs.mkdirSync(output,{recursive:true});
async function launch() {
  const seed=`const browser=require('./site-browser');browser.createPageReader=()=>({async read(url){await new Promise(resolve=>setTimeout(resolve,400));const target=new URL(url);
    return '<div class="card-item"><div class="card-desc"><div class="title"><a href="/?view=ecom/item&card=88871">Produto acompanhado</a></div><div class="qty"><span>'+(target.searchParams.get('fixture_stock') || '10')+'</span></div><div class="price"><span class="align-price">R$ 20,00</span></div></div></div>';
  },async close(){}});require('./server');`;
  const child=spawn(process.execPath,['-e',seed],{windowsHide:true,env:{...process.env,PDV_DB:':memory:',PDV_HOST:'127.0.0.1',PDV_PORT:'0',PDV_ORIGIN:'',PDV_TLS_CERT:'',PDV_TLS_KEY:'',PDV_BACKUP_MINUTES:'0'},stdio:['ignore','pipe','pipe']});
  const exited=once(child,'exit');let log='',errors='';child.stderr.on('data',chunk=>errors+=chunk);
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Servidor não iniciou: '+errors)),10000);child.stdout.on('data',chunk=>{log+=chunk;const match=log.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});child.once('error',reject);});
  return {url,async close(){if(child.exitCode===null&&child.signalCode===null)child.kill();await exited;}};
}
async function api(context,url,path,data,status=200) {
  const response=await context.request[data===undefined?'get':'post'](url+'/api/'+path,data===undefined?{}:{data});
  const body=await response.json();assert.equal(response.status(),status,JSON.stringify(body));return body;
}
(async()=>{
  const server=await launch();let browser;const checks=[],pageErrors=[];
  try {
    browser=await chromium.launch({executablePath:browserExecutable(),headless:true});
    const context=await browser.newContext({viewport:{width:1366,height:1000},locale:'pt-BR'});
    await api(context,server.url,'setup',{username:'admin',name:'Administrador',password:'teste-sync-interface-123'});
    await api(context,server.url,'users',{username:'operador',name:'Operador',password:'teste-sync-interface-123',role:'operator',permissions:{products:true,stock:true}});
    const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>pageErrors.push(error.message));
    await page.goto(server.url);await page.getByRole('button',{name:'Importar do site',exact:true}).click();
    await page.getByRole('button',{name:'Sincronização automática',exact:true}).click();
    await page.getByLabel('Nome do acompanhamento',{exact:true}).waitFor();
    assert.equal(await page.getByLabel('Link para acompanhar',{exact:true}).inputValue(),DEFAULT_URL);
    assert.equal(await page.getByLabel('Intervalo em minutos',{exact:true}).inputValue(),'30');
    await page.getByLabel('Nome do acompanhamento',{exact:true}).fill('Selados & acessórios');
    await page.getByLabel('Intervalo em minutos',{exact:true}).fill('5');
    await page.getByRole('button',{name:'Salvar acompanhamento',exact:true}).click();
    const card=page.locator('.site-sync-job').first();await card.locator('.site-sync-status.success').waitFor();
    let products=await api(context,server.url,'products');assert.equal(products[0].stock,10);
    const id=products[0].id;
    checks.push('Menu do administrador salva links e intervalo, executa a primeira consulta e registra o histórico.');
    await page.screenshot({path:join(output,'sincronizacao-computador.png')});
    for(const width of [320,390,768,1366]) {
      await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Rolagem fora das tabelas em '+width);
      if(width===390)await page.screenshot({path:join(output,'sincronizacao-celular.png')});
    }
    checks.push('Configuração, links e histórico funcionam em 320, 390, 768 e 1366 px.');
    await api(context,server.url,'products/'+id+'/stock',{delta:-2,reason:'Venda local de teste',request_id:'venda-local-teste-sync-123'});
    await card.getByRole('button',{name:'Editar',exact:true}).click();
    await page.getByLabel('Link para acompanhar',{exact:true}).fill(DEFAULT_URL+'&fixture_stock=9');
    await page.getByRole('button',{name:'Salvar alterações',exact:true}).click();
    for(let attempt=0;attempt<100;attempt++){products=await api(context,server.url,'products');if(products[0].stock===7)break;await delay(50);}
    assert.equal(products[0].stock,7);
    const history=await api(context,server.url,'site-sync/list');
    assert.equal(history.runs[0].report.changes[0].before,8);assert.equal(history.runs[0].report.changes[0].after,7);
    checks.push('Nova consulta aplica a diferença do site sobre o saldo atual, preservando a baixa de venda do PDV.');
    await card.getByRole('button',{name:'Pausar',exact:true}).click();await card.locator('.site-sync-status.paused').waitFor();
    assert.equal(await card.getByRole('button',{name:'Verificar agora',exact:true}).isDisabled(),true);
    await page.getByLabel('Nome do acompanhamento',{exact:true}).fill('Rascunho preservado');
    await api(context,server.url,'customers',{name:'Cliente fictício para atualização',phone:'1100000000'});
    await delay(350);assert.equal(await page.getByLabel('Nome do acompanhamento',{exact:true}).inputValue(),'Rascunho preservado');
    checks.push('Pausa impede consultas; atualizações recebidas preservam os campos em edição.');
    await card.getByRole('button',{name:'Remover link',exact:true}).click();
    await page.getByText('Nenhum link acompanhado',{exact:true}).waitFor();
    assert.equal((await api(context,server.url,'products'))[0].stock,7);
    checks.push('Remover acompanhamento mantém produtos e estoque.');
    const operator=await browser.newContext({viewport:{width:390,height:844}});
    await api(operator,server.url,'login',{username:'operador',password:'teste-sync-interface-123'});
    const worker=await operator.newPage();await worker.goto(server.url);await worker.locator('#pos-workspace').waitFor();
    assert.equal(await worker.getByRole('button',{name:'Sincronização do site',exact:true}).count(),0);
    await api(operator,server.url,'site-sync/list',undefined,403);
    checks.push('Operador não acessa a configuração da sincronização.');
    assert.deepEqual(pageErrors,[]);fs.writeFileSync(join(output,'resultado.json'),JSON.stringify({checks,pageErrors},null,2));
    for(const check of checks)console.log('OK '+check);
  } finally {if(browser)await browser.close();await server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
