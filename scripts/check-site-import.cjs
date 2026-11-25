const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const fs=require('node:fs');
const {join,resolve}=require('node:path');
const {chromium}=require('playwright-core');
const {browserExecutable}=require('../site-browser');
const {DEFAULT_URL}=require('../site-catalog');
const output=resolve('test-output/site-import');
fs.mkdirSync(output,{recursive:true});
function item(id,name,price='R$ 12,50',stock='2') {
  return `<div class="card-item"><div class="card-img"><img src="https://repositorio.sbrauble.com/carta.png"></div><div class="card-desc"><div class="title"><a href="/?view=ecom/item&amp;tcg=2&amp;card=${id}">${name}</a></div><div class="qty"><span>${stock}</span></div><div class="price"><span class="align-price">${price}</span></div></div></div>`;
}
const first='<html><title>Catálogo controlado</title>'+item(11,'Carta Alfa')+item(12,'Carta com detalhes','','')+item(15,'Carta pendente','','')+'<a class="ecomresp-paginacao" href="/?view=ecom/itens&page=2">2</a></html>';
const second='<html><title>Catálogo controlado</title>'+item(13,'Carta Beta','R$ 20,00','4')+'</html>';
const individual='<html><div class="nomes_cards"><div class="nome_pt_cards">Carta com detalhes</div></div><div id="product--list"><div class="table-produtos"><div class="table-produtos-row">'+
  '<div class="table-produtos-body-cell"><div class="title-mobile">Estoque</div><div>6 unid.</div></div>'+
  '<div class="table-produtos-body-cell"><div class="title-mobile">Preço</div><div>R$ 8,75</div></div>'+
  '<div class="table-produtos-body-cell"><input class="product--qty" id="txt_qty_9000" value="1" max="6"></div></div></div></div></html>';
const uploaded='<html><title>HTML de teste</title><script>window.__siteImportInjected=true</script>'+item(14,'Carta Delta &amp; teste','R$ 5,50','7')+'</html>';
const fixturePath=join(output,'catalogo-exemplo.html');fs.writeFileSync(fixturePath,uploaded);
async function launch() {
  const seed=`const browser=require('./site-browser');
    browser.createPageReader=()=>({async read(url){const target=new URL(url);await new Promise(resolve=>setTimeout(resolve,220));if(target.searchParams.get('view')==='ecom/item')return target.searchParams.get('card')==='12'?${JSON.stringify(individual)}:'<html><title>Produto sem informação</title></html>';const page=Number(target.searchParams.get('page'));if(target.searchParams.get('cat')!=='300055')throw Error('Filtros alterados');return page===1?${JSON.stringify(first)}:${JSON.stringify(second)};},async close(){}});
    browser.downloadImage=async()=> 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
    require('./server');`;
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
  const server=await launch();let browser;
  const checks=[],pageErrors=[];
  try {
    browser=await chromium.launch({executablePath:browserExecutable(),headless:true});
    const context=await browser.newContext({viewport:{width:1366,height:900},locale:'pt-BR'});
    await api(context,server.url,'setup',{username:'admin',name:'Administrador',password:'teste-import-site-123'});
    await api(context,server.url,'users',{username:'operador',name:'Operador',password:'teste-import-site-123',role:'operator',permissions:{products:true,stock:true}});
    const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>pageErrors.push(error.message));
    await page.goto(server.url);
    await page.getByRole('button',{name:'Importar do site',exact:true}).click();
    await page.getByRole('button',{name:'Analisar link',exact:true}).waitFor();
    assert.equal(await page.getByLabel('Link da listagem ou do produto',{exact:true}).inputValue(),DEFAULT_URL);
    assert.equal(await page.getByLabel('Buscar preço e estoque nas páginas dos produtos',{exact:true}).isChecked(),true);
    await page.getByLabel('Categoria padrão quando o site não informar',{exact:true}).fill('Cartas');
    await page.getByRole('button',{name:'Analisar link',exact:true}).click();
    await page.locator('[data-import-select]').first().waitFor();
    assert.equal(await page.locator('[data-import-select]').count(),4);
    assert.equal(await page.locator('[data-import-select]:checked').count(),3);
    assert.equal((await api(context,server.url,'products')).length,0);
    assert.match(await page.locator('#main').textContent(),/2 página\(s\) lida\(s\).*4 produto\(s\)/);
    checks.push('Menu do administrador analisa todas as páginas mantendo o filtro e não cadastra durante a prévia.');
    const completed=page.locator('tbody tr').filter({has:page.locator('input[value="Carta com detalhes"]')});
    assert.equal(await completed.locator('[data-import-field="priceRaw"]').inputValue(),'8,75');
    assert.equal(await completed.locator('[data-import-field="stockRaw"]').inputValue(),'6');
    assert.match(await page.locator('#main').textContent(),/Páginas de produtos: 2 de 2 consultada\(s\).*1 produto\(s\) com preço e estoque completos/);
    checks.push('Páginas individuais completam automaticamente preço e estoque antes da seleção, com progresso visível.');
    await page.screenshot({path:join(output,'importar-site-previa.png')});
    for(const width of [320,390,768,1366]) {
      await page.setViewportSize({width,height:900});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Rolagem horizontal fora da tabela em '+width);
      if(width===390)await page.screenshot({path:join(output,'importar-site-celular.png')});
    }
    checks.push('Prévia cabe em 320, 390, 768 e 1366 px, com rolagem restrita à tabela.');
    const missing=page.locator('tbody tr').filter({has:page.locator('input[value="Carta pendente"]')});
    await missing.locator('[data-import-field="priceRaw"]').fill('11,25');
    await missing.locator('[data-import-field="stockRaw"]').fill('3');
    await page.getByRole('button',{name:'Selecionar todos os válidos',exact:true}).click();
    assert.equal(await page.locator('[data-import-select]:checked').count(),4);
    await page.getByRole('button',{name:'Importar selecionados',exact:true}).click();
    await page.getByText(/Importação: 4 novo/).waitFor();
    const products=await api(context,server.url,'products');
    assert.equal(products.length,4);
    const automatic=products.find(row=>row.name==='Carta com detalhes');assert.equal(automatic.price,875);assert.equal(automatic.stock,6);
    const corrected=products.find(row=>row.name==='Carta pendente');assert.equal(corrected.price,1125);assert.equal(corrected.stock,3);
    assert.ok(products.every(row=>row.category==='Cartas'&&row.image));
    checks.push('Correções de preço e estoque são usadas no cadastro; fotos, categoria e produtos ficam disponíveis no PDV.');
    await page.getByRole('button',{name:'Analisar link',exact:true}).click();
    await page.getByText('Já cadastrado',{exact:true}).first().waitFor();
    assert.equal(await page.locator('[data-import-select]:checked').count(),0);
    assert.equal((await api(context,server.url,'products')).length,4);
    checks.push('Reanalisar reconhece os produtos existentes e não seleciona duplicatas automaticamente.');
    await page.locator('summary').filter({hasText:'Usar um arquivo HTML salvo da página'}).click();
    await page.getByLabel('Arquivo HTML da listagem carregada',{exact:true}).setInputFiles(fixturePath);
    await api(context,server.url,'customers',{name:'Cliente de teste de HTML',phone:'1100000000'});
    await page.getByText('Arquivo selecionado: catalogo-exemplo.html',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Analisar HTML',exact:true}).click();
    await page.locator('input[value="Carta Delta & teste"]').waitFor();
    assert.equal(await page.evaluate(()=>window.__siteImportInjected),undefined);
    await page.getByRole('button',{name:'Importar selecionados',exact:true}).click();
    await page.getByText(/Importação: 1 novo/).waitFor();
    assert.equal((await api(context,server.url,'products')).length,5);
    await page.getByRole('button',{name:'Produtos',exact:true}).click();
    await page.getByText('Carta Delta & teste',{exact:true}).waitFor();
    checks.push('Arquivo HTML é analisado sem executar scripts e os produtos importados aparecem no cadastro de Produtos.');
    const worker=await browser.newContext({viewport:{width:390,height:844},locale:'pt-BR'});
    await api(worker,server.url,'login',{username:'operador',password:'teste-import-site-123'});
    const operator=await worker.newPage();operator.on('pageerror',error=>pageErrors.push(error.message));
    await operator.goto(server.url);await operator.locator('#pos-workspace').waitFor();
    assert.equal(await operator.getByRole('button',{name:'Importar do site',exact:true}).count(),0);
    await api(worker,server.url,'site-import/html',{url:DEFAULT_URL,html:uploaded},403);
    checks.push('Operador não vê o menu e não consegue importar pela API mesmo com permissões de produtos e estoque.');
    assert.deepEqual(pageErrors,[]);
    fs.writeFileSync(join(output,'resultado.json'),JSON.stringify({checks,pageErrors},null,2));
    for(const check of checks)console.log('OK '+check);
  } finally {if(browser)await browser.close();await server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
