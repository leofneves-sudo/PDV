const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('node:http');
const {once}=require('node:events');
const fs=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join,resolve}=require('node:path');
const {CatalogBrowser,browserExecutable}=require('../site-browser');
const {DEFAULT_URL,parsePage}=require('../site-catalog');

test('navegador de importação lê uma página controlada em perfil separado e fecha só sua própria janela',{timeout:25000},async t=>{
  try {browserExecutable();}catch{t.skip('Navegador Chromium não instalado.');return;}
  const directory=await fs.mkdtemp(join(tmpdir(),'pdv-catalog-test-'));
  const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(req.url==='/product'?
    '<html><div class="nomes_cards"><div class="nome_pt_cards">Produto dinâmico</div></div><div id="product--list"></div><script>setTimeout(()=>{document.getElementById("product--list").innerHTML=\'<div class="table-produtos"><div class="table-produtos-row"><div class="table-produtos-body-cell"><div class="title-mobile">Estoque</div>4 unid.</div><div class="table-produtos-body-cell"><div class="title-mobile">Preço</div>R$ 17,90</div></div></div>\'},100)</script></html>':
    '<html><title>Catálogo controlado</title><div class="card-item"><div class="card-desc"><div class="title"><a href="https://www.lastplacetcg.com.br/?view=ecom/item&card=42">Carta via navegador</a></div><div class="qty"><span>2</span></div><div class="price"><span class="align-price">R$ 10,00</span></div></div></div></html>');});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const controller=new AbortController();
  const reader=new CatalogBrowser({directory,signal:controller.signal,headless:true,allowTestUrl:true});
  try {
    const html=await reader.read('http://127.0.0.1:'+server.address().port,{sourceUrl:DEFAULT_URL});
    const parsed=parsePage(html,DEFAULT_URL);
    assert.equal(parsed.rows.length,1);assert.equal(parsed.rows[0].name,'Carta via navegador');assert.equal(parsed.rows[0].price,1000);
    const sourceUrl='https://www.lastplacetcg.com.br/?view=ecom/item&refid=produto-dinamico';
    const product=await reader.read('http://127.0.0.1:'+server.address().port+'/product',{sourceUrl,productDetails:true});
    const details=parsePage(product,sourceUrl);
    assert.equal(details.rows[0].price,1790);assert.equal(details.rows[0].stock,4);
  } finally {
    await reader.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    if(!resolve(directory).startsWith(resolve(tmpdir())+require('node:path').sep+'pdv-catalog-test-'))throw Error('Diretório de teste inesperado.');
    await fs.rm(directory,{recursive:true,force:true,maxRetries:15,retryDelay:150});
  }
});
