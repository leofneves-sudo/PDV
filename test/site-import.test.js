const {test}=require('node:test');
const assert=require('node:assert/strict');
const {setTimeout:delay}=require('node:timers/promises');
process.env.PDV_DB=':memory:';
const {all,get,run,saveUser,session,sha,findSession}=require('../db');
const ops=require('../operations');
const {DEFAULT_URL,parsePage,storeUrl,pageUrl,imageUrl,sameListing,sameProduct,matchProductDetails}=require('../site-catalog');
const {publicAddress,createPageReader,retryAfterMs}=require('../site-browser');
const {createController:controllerFactory}=require('../site-import');
const createController=options=>controllerFactory({detailDelayMs:0,...options});
function login(username,role='admin',permissions={}) {
  const user=saveUser(null,{username,name:username,password:'senha-ficticia-importacao',role,permissions});
  return findSession(sha(session(user)));
}
const actor=login('importador');
const operator=login('operador_importacao','operator',{products:true,stock:true,users:true});
const other=login('outro_admin');
function card({id=101,name='Carta de teste',price='R$ 19,90',stock='3',extra='',attrs=''}={}) {
  return `<article class="card-item" ${attrs}><div class="card-img"><a href="./?view=ecom/item&amp;tcg=2&amp;card=${id}"><img src="//repositorio.sbrauble.com/carta.jpg"></a></div>
    <div class="card-desc"><div class="title"><a href="./?view=ecom/item&amp;tcg=2&amp;card=${id}">${name}</a></div>
    <div class="qty"><span>${stock}</span>unid.</div><div class="price"><span class="align-price">${price}</span></div>${extra}</div></article>`;
}
const html=content=>`<!doctype html><html><head><title>Catálogo de teste</title></head><body>${content}</body></html>`;
const detailUrl=id=>'https://www.lastplacetcg.com.br/?view=ecom/item&tcg=2&card='+id;
function detail({name='Carta de teste',offers=[{price:'R$ 19,90',stock:'3',language:'Chinês',condition:'Lacrado'}],extra=''}={}) {
  return html(`<div class="bloco_produtos"><div class="nomes_cards"><div class="nome_pt_cards">${name}</div></div>
    <div class="imagem_produtos"><img src="https://repositorio.sbrauble.com/produto.jpg"></div><p>Contém 15 boosters com 4 cartas.</p>
    <div id="product--list"><div class="table-produtos"><div class="table-produtos-header">
    ${['Idioma','Condição','Estoque','Preço',''].map(label=>`<div class="table-produtos-header-cell">${label}</div>`).join('')}</div><div class="table-produtos-body">
    ${offers.map((offer,index)=>`<div class="table-produtos-row">
      <div class="table-produtos-body-cell"><div class="title-mobile">Idioma</div><img alt="${offer.language || ''}"><div class="tooltip">${offer.language || ''}</div></div>
      <div class="table-produtos-body-cell"><div class="title-mobile">Condição</div><div>${offer.condition || ''}</div></div>
      <div class="table-produtos-body-cell"><div class="title-mobile">Estoque</div><div>${offer.stock} unid.</div></div>
      <div class="table-produtos-body-cell"><div class="title-mobile">Preço</div><div>${offer.price}</div></div>
      <div class="table-produtos-body-cell"><input class="product--qty" id="txt_qty_${90000+index}" value="1" max="999"></div>
    </div>`).join('')}</div></div></div></div>${extra}`);
}
async function ready(controller,id,user=actor) {
  for(let i=0;i<300;i++) {
    const job=controller.status(user,id,true);
    if(['ready','error','cancelled'].includes(job.status))return job;
    await delay(5);
  }
  throw Error('A análise de teste não terminou.');
}

test('leitura da Liga extrai preço em centavos, quantidade e foto sem executar HTML',()=>{
  const parsed=parsePage(html(card({name:'Raio &amp; Trovão',price:'R$ 1.234,56',stock:'12'})),DEFAULT_URL);
  assert.equal(parsed.rows.length,1);
  assert.equal(parsed.rows[0].name,'Raio & Trovão');
  assert.equal(parsed.rows[0].price,123456);
  assert.equal(parsed.rows[0].stock,12);
  assert.match(parsed.rows[0].image,/^https:\/\/repositorio\.sbrauble\.com\//);
  assert.match(parsed.rows[0].code,/^LIGA-[A-F0-9]{20}$/);
});
test('dados ausentes ficam pendentes; cópias do mesmo produto não duplicam o estoque',()=>{
  const parsed=parsePage(html(card()+card()+card({id:102,price:'',stock:''})),DEFAULT_URL);
  assert.equal(parsed.rows.length,2);
  assert.equal(parsed.rows[0].stock,3);
  assert.equal(parsed.rows[1].price,null);
  assert.equal(parsed.rows[1].stock,null);
  assert.equal(parsed.rows[1].warnings.length,2);
  const ambiguous=parsePage(html(card()+card({price:'R$ 25,00'})),DEFAULT_URL);
  assert.equal(ambiguous.rows.length,1);
  assert.equal(ambiguous.rows[0].price,null);
});
test('paginação preserva todos os filtros do link e não segue outra categoria',()=>{
  const parsed=parsePage(html(card()+'<a class="ecomresp-paginacao" href="/?view=ecom/itens&page=2&cat=OUTRA">2</a>'),DEFAULT_URL);
  assert.equal(parsed.nextPage,2);
  const next=new URL(pageUrl(DEFAULT_URL,parsed.nextPage));
  assert.equal(next.searchParams.get('cat'),'300055');
  assert.equal(next.searchParams.get('txt_limit'),'120');
  assert.equal(next.searchParams.get('page'),'2');
  assert.equal(next.searchParams.get('id'),'26240');
  assert.equal(sameListing(DEFAULT_URL,DEFAULT_URL),true);
  assert.equal(sameListing(DEFAULT_URL,DEFAULT_URL.replace('cat=300055','cat=999')),false);
  assert.equal(sameListing(DEFAULT_URL,pageUrl(DEFAULT_URL,2)),false);
});
test('todas as páginas começa na primeira mesmo quando o link aponta para uma página posterior',async()=>{
  const visits=[];
  const controller=createController({readerFactory:()=>({async read(url){visits.push(new URL(url).searchParams.get('page'));return html(card({id:1901}));},async close(){}})});
  const job=controller.start(actor,{url:pageUrl(DEFAULT_URL,3),allPages:true});
  const result=await ready(controller,job.id);
  assert.equal(result.status,'ready');assert.deepEqual(visits,['1']);
  await controller.close();
});
test('links externos, redes internas, credenciais e imagens não permitidas são rejeitados',()=>{
  for(const url of ['http://www.lastplacetcg.com.br/?view=ecom/itens','https://localhost/?view=ecom/itens',
    'https://www.lastplacetcg.com.br.evil.example/?view=ecom/itens','https://nome:senha@www.lastplacetcg.com.br/?view=ecom/itens',
    'https://www.lastplacetcg.com.br/?view=admin','https://www.lastplacetcg.com.br:8443/?view=ecom/itens'])assert.throws(()=>storeUrl(url));
  for(const address of ['127.0.0.1','10.0.0.1','172.16.1.1','192.168.1.1','169.254.169.254','::1','fc00::1','::ffff:127.0.0.1'])assert.equal(publicAddress(address),false);
  assert.equal(publicAddress('104.21.12.34'),true);
  assert.equal(imageUrl('http://repositorio.sbrauble.com/carta.jpg',DEFAULT_URL),null);
  assert.equal(imageUrl('https://127.0.0.1/foto',DEFAULT_URL),null);
  assert.equal(imageUrl(undefined,DEFAULT_URL),null);
});
test('verificação de acesso não vira produto nem prévia de importação',()=>{
  assert.equal(parsePage('<title>Just a moment...</title><form id="challenge-form"></form>',DEFAULT_URL).challenge,true);
  const controller=createController();
  assert.throws(()=>controller.fromHtml(actor,{url:DEFAULT_URL,html:'<title>Just a moment...</title>'}),/verificação/);
  assert.equal(get('SELECT COUNT(*) n FROM products').n,0);
});
test('análise percorre páginas sem cadastrar e só os selecionados são importados',async()=>{
  const visits=[];let closed=false;
  const controller=createController({readerFactory:()=>({async read(url){visits.push(url);return html(card({id:visits.length===1?201:202})+(visits.length===1?'<a class="ecomresp-paginacao" href="/?view=ecom/itens&page=2">2</a>':''));},async close(){closed=true;}})});
  const job=controller.start(actor,{url:DEFAULT_URL});
  assert.equal(get('SELECT COUNT(*) n FROM products').n,0);
  const preview=await ready(controller,job.id);
  assert.equal(preview.status,'ready');assert.equal(preview.pages,2);assert.equal(preview.rows.length,2);assert.ok(closed);
  assert.equal(new URL(visits[1]).searchParams.get('cat'),'300055');
  const result=await controller.apply(actor,{id:job.id,mode:'create',images:false,rows:[{key:preview.rows[0].key}]});
  assert.equal(result.created,1);assert.equal(get('SELECT COUNT(*) n FROM products').n,1);
  const product=get('SELECT * FROM products WHERE code=?',preview.rows[0].code);
  assert.equal(product.stock,3);assert.equal(product.price,1990);assert.equal(product.cost,null);
  const retry=await controller.apply(actor,{id:job.id,mode:'create',rows:[{key:preview.rows[0].key}]});
  assert.equal(retry.skipped,1);assert.equal(get('SELECT COUNT(*) n FROM products').n,1);
  await controller.close();
});
test('reimportação reconhece a origem e atualiza somente quando solicitado',async()=>{
  const controller=createController();
  const preview=controller.fromHtml(actor,{url:DEFAULT_URL,html:html(card({id:201,price:'R$ 29,90',stock:'7'}))});
  assert.ok(preview.rows[0].existing);
  const before=get('SELECT * FROM products WHERE code=?',preview.rows[0].code);
  const result=await controller.apply(actor,{id:preview.id,mode:'create',rows:[{key:preview.rows[0].key}]});
  assert.equal(result.skipped,1);assert.equal(get('SELECT stock FROM products WHERE id=?',before.id).stock,3);
  const update=controller.fromHtml(actor,{url:DEFAULT_URL,html:html(card({id:201,price:'R$ 29,90',stock:'7'}))});
  const updated=await controller.apply(actor,{id:update.id,mode:'update',rows:[{key:update.rows[0].key}]});
  assert.equal(updated.updated,1);
  const after=get('SELECT * FROM products WHERE id=?',before.id);
  assert.equal(after.stock,7);assert.equal(after.price,2990);
  assert.equal(get('SELECT COUNT(*) n FROM web_product_sources').n,1);
  assert.equal(get('SELECT COUNT(*) n FROM products').n,1);
});
test('uma linha inválida impede a gravação inteira do lote e pode ser corrigida na prévia',async()=>{
  const controller=createController();
  const preview=controller.fromHtml(actor,{url:DEFAULT_URL,html:html(card({id:301})+card({id:302,price:'',stock:''}))});
  const count=get('SELECT COUNT(*) n FROM products').n;
  await assert.rejects(controller.apply(actor,{id:preview.id,mode:'create',rows:preview.rows.map(row=>({key:row.key}))}),/Preço/);
  assert.equal(get('SELECT COUNT(*) n FROM products').n,count);
  const result=await controller.apply(actor,{id:preview.id,mode:'create',rows:[{key:preview.rows[1].key,price:1500,stock:4}]});
  assert.equal(result.created,1);assert.equal(get('SELECT stock FROM products WHERE code=?',preview.rows[1].code).stock,4);
});
test('alimentos e bebidas exigem validade também na importação',async()=>{
  const controller=createController();
  const preview=controller.fromHtml(actor,{url:DEFAULT_URL,category:'Bebidas',html:html(card({id:701,name:'Suco de teste'}))});
  await assert.rejects(controller.apply(actor,{id:preview.id,mode:'create',rows:[{key:preview.rows[0].key}]}),/validade/);
  const imported=await controller.apply(actor,{id:preview.id,mode:'create',rows:[{key:preview.rows[0].key,expires_on:'2030-12-31'}]});
  assert.equal(imported.created,1);
  assert.equal(get('SELECT expires_on FROM products WHERE code=?',preview.rows[0].code).expires_on,'2030-12-31');
  const update=controller.fromHtml(actor,{url:DEFAULT_URL,category:'Bebidas',html:html(card({id:701,name:'Suco de teste',price:'R$ 25,00',stock:'5'}))});
  assert.equal(update.rows[0].existing.expires_on,'2030-12-31');
  const updated=await controller.apply(actor,{id:update.id,mode:'update',rows:[{key:update.rows[0].key}]});
  assert.equal(updated.updated,1);
  const product=get('SELECT * FROM products WHERE code=?',preview.rows[0].code);
  assert.equal(product.expires_on,'2030-12-31');assert.equal(product.price,2500);assert.equal(product.stock,5);
});
test('o vínculo do dispositivo é revalidado antes da gravação após baixar as fotos',async()=>{
  const controller=createController({imageLoader:async()=> 'data:image/png;base64,aGVsbG8='});
  const preview=controller.fromHtml(actor,{url:DEFAULT_URL,html:html(card({id:702}))});
  await assert.rejects(controller.apply(actor,{id:preview.id,mode:'create',images:true,rows:[{key:preview.rows[0].key}]},()=>{throw Error('Vínculo revogado');}),/Vínculo revogado/);
  assert.equal(get('SELECT COUNT(*) n FROM products WHERE code=?',preview.rows[0].code).n,0);
});
test('estoque alterado durante o download das fotos não é sobrescrito',async()=>{
  let release,started;
  const downloading=new Promise(resolve=>started=resolve);
  const controller=createController({imageLoader:async()=>{started();await new Promise(resolve=>release=resolve);return 'data:image/png;base64,aGVsbG8=';}});
  const preview=controller.fromHtml(actor,{url:DEFAULT_URL,html:html(card({id:201,stock:'5',price:'R$ 30,00'}))});
  const product=get('SELECT id FROM products WHERE code=?',preview.rows[0].code);
  const pending=controller.apply(actor,{id:preview.id,mode:'update',images:true,rows:[{key:preview.rows[0].key}]});
  await downloading;
  ops.adjustStock(actor,product.id,{delta:2,reason:'Entrada durante análise'});
  release();
  await assert.rejects(pending,/estoque ou cadastro mudou/);
  assert.equal(get('SELECT stock FROM products WHERE id=?',product.id).stock,9);
  assert.equal(get('SELECT price FROM products WHERE id=?',product.id).price,2990);
});
test('atualização de estoque respeita reservas em comandas',async()=>{
  const product=get("SELECT * FROM products WHERE code=(SELECT code FROM products WHERE price=2990 LIMIT 1)");
  const card=ops.createCards(actor,{start:801,count:1})[0];ops.grantCard(actor.session_id,card.id);
  const order=ops.openOrder(actor,card.id).order;ops.orderItem(actor,order.id,{product:product.id,action:'delta',delta:2});
  const controller=createController();
  const preview=controller.fromHtml(actor,{url:DEFAULT_URL,html:html(cardFixture())});
  function cardFixture(){return cardHtml();}
  function cardHtml(){return `<div class="card-item"><div class="card-desc"><div class="title"><a href="./?view=ecom/item&amp;tcg=2&amp;card=201">Carta de teste</a></div><div class="qty"><span>1</span></div><div class="price"><span class="align-price">R$ 29,90</span></div></div></div>`;}
  await assert.rejects(controller.apply(actor,{id:preview.id,mode:'update',rows:[{key:preview.rows[0].key}]}),/inferior às reservas/);
  assert.equal(get('SELECT stock FROM products WHERE id=?',product.id).stock,9);
  ops.cancel(actor,order.id,{reason:'Fim do teste de reservas'});
});
test('apenas administrador pode analisar, consultar e aplicar, e a prévia pertence à sessão',async()=>{
  const controller=createController();
  assert.throws(()=>controller.start(operator,{url:DEFAULT_URL}),/exclusiva do administrador/);
  const preview=controller.fromHtml(actor,{url:DEFAULT_URL,html:html(card({id:999}))});
  assert.throws(()=>controller.status(operator,preview.id,true),/exclusiva/);
  assert.throws(()=>controller.status(other,preview.id,true),/não encontrada/);
  await assert.rejects(controller.apply(other,{id:preview.id,mode:'create',rows:[{key:preview.rows[0].key}]}),/não encontrada/);
  await assert.rejects(controller.apply(actor,{id:preview.id,mode:'create',rows:[{key:'inventado'}]}),/não pertence/);
});
test('páginas repetidas e limites de leitura impedem declarar um catálogo parcial como completo',async()=>{
  const controller=createController({readerFactory:()=>({async read(){return html(card({id:501})+'<a class="ecomresp-paginacao" href="/?view=ecom/itens&page=99">99</a>');},async close(){}})});
  const job=controller.start(actor,{url:DEFAULT_URL});const result=await ready(controller,job.id);
  assert.equal(result.status,'error');assert.equal(result.complete,false);
  await assert.rejects(controller.apply(actor,{id:job.id,mode:'create',rows:result.rows.map(row=>({key:row.key}))}),/Conclua a análise/);
  await controller.close();
});
test('cancelar a análise fecha o leitor e não cadastra os produtos',async()=>{
  const before=get('SELECT COUNT(*) n FROM products').n;
  let closed=false;
  const controller=createController({readerFactory:({signal})=>({async read(){await delay(10000,undefined,{signal});return html(card({id:2001}));},async close(){closed=true;}})});
  const job=controller.start(actor,{url:DEFAULT_URL});
  await delay(10);controller.cancel(actor,job.id);await controller.close();
  assert.ok(closed);assert.equal(controller.status(actor,job.id).status,'cancelled');
  assert.equal(get('SELECT COUNT(*) n FROM products').n,before);
});

test('página individual da Liga lê preço e estoque da tabela, sem usar a quantidade de compra ou recomendações',()=>{
  const parsed=parsePage(detail({offers:[{price:'<del>R$ 899,90</del> R$ 749,90',stock:'12',language:'Chinês',condition:'Lacrado'}],extra:card({id:99999,price:'R$ 1,00',stock:'99'})}),detailUrl(3001));
  assert.equal(parsed.rows.length,1);
  assert.equal(parsed.rows[0].price,74990);assert.equal(parsed.rows[0].stock,12);
  assert.equal(parsed.rows[0].language,'Chinês');assert.equal(parsed.rows[0].condition,'Lacrado');
  const listed=parsePage(html(card({id:3001,price:'',stock:''})),DEFAULT_URL).rows[0];
  assert.equal(parsed.rows[0].key,listed.key);
  assert.equal(matchProductDetails(listed,parsed).price,74990);
  const zero=parsePage(detail({offers:[{price:'R$ 0,00',stock:'0'}]}),detailUrl(3001));
  assert.equal(zero.rows[0].price,0);assert.equal(zero.rows[0].stock,0);
  const unrelated=parsePage(html(card({id:99999})),detailUrl(3001));
  assert.equal(unrelated.rows.length,0);
});

test('páginas individuais conferem a identidade e a versão antes de preencher os valores',()=>{
  const parsed=parsePage(detail({offers:[{price:'R$ 10,00',stock:'2',language:'Inglês',condition:'NM'},
    {price:'R$ 25,00',stock:'4',language:'Português',condition:'SP'}]}),detailUrl(3002));
  const row=parsePage(html(card({id:3002,price:'',stock:''})),DEFAULT_URL).rows[0];
  assert.equal(parsed.rows.length,2);assert.equal(matchProductDetails(row,parsed),null);
  assert.equal(matchProductDetails({...row,language:'Português',condition:'SP'},parsed).stock,4);
  assert.equal(matchProductDetails({...row,url:detailUrl(3003)},parsed),null);
  const first='https://www.lastplacetcg.com.br/?view=ecom/item&refid=produto-A';
  assert.equal(sameListing(first,first.replace('produto-A','produto-B')),false);
  assert.equal(sameProduct(first,first.replace('www.','')),true);
  assert.equal(sameProduct(detailUrl(3002),detailUrl(3002).replace('tcg=2','tcg=1')),false);
});

test('análise visita só os produtos com campos ausentes, preenche automaticamente e preserva códigos e valores conhecidos',async()=>{
  const visits=[];
  const controller=createController({readerFactory:()=>({async read(url){
    visits.push(url);const target=new URL(url);
    if(target.searchParams.get('view')==='ecom/itens')return html(card({id:3101,price:'',stock:''})+card({id:3102,price:'R$ 40,00',stock:''})+card({id:3103}));
    return detail({offers:[{price:'R$ 749,90',stock:target.searchParams.get('card')==='3101'?'1':'6',language:'Chinês',condition:'Lacrado'}]});
  },async close(){}})});
  const listed=parsePage(html(card({id:3101,price:'',stock:''})),DEFAULT_URL).rows[0];
  const preview=await ready(controller,controller.start(actor,{url:DEFAULT_URL}).id);
  assert.equal(preview.status,'ready');assert.equal(preview.pages,1);assert.equal(visits.length,3);
  assert.deepEqual(preview.detailProgress,{total:2,read:2,completed:2,failed:0});
  assert.equal(preview.rows[0].price,74990);assert.equal(preview.rows[0].stock,1);assert.deepEqual(preview.rows[0].warnings,[]);
  assert.equal(preview.rows[0].key,listed.key);assert.equal(preview.rows[0].code,listed.code);
  assert.equal(preview.rows[1].price,4000);assert.equal(preview.rows[1].stock,6);
  assert.equal(get('SELECT COUNT(*) n FROM products WHERE code=?',listed.code).n,0);
  const result=await controller.apply(actor,{id:preview.id,mode:'create',rows:[{key:listed.key}]});
  assert.equal(result.created,1);
  assert.equal(get('SELECT stock FROM products WHERE code=?',listed.code).stock,1);
  await controller.close();
});

test('a mesma página individual é lida uma vez e cada versão recebe seu estoque correspondente',async()=>{
  let reads=0;
  const listing=html(card({id:3201,price:'',stock:'',extra:'<span class="language">Inglês</span><span class="condition">NM</span>'})+
    card({id:3201,price:'',stock:'',extra:'<span class="language">Português</span><span class="condition">SP</span>'}));
  const controller=createController({readerFactory:()=>({async read(url){
    if(new URL(url).searchParams.get('view')==='ecom/itens')return listing;
    reads++;return detail({offers:[{price:'R$ 10,00',stock:'2',language:'Inglês',condition:'NM'},{price:'R$ 25,00',stock:'4',language:'Português',condition:'SP'}]});
  },async close(){}})});
  const preview=await ready(controller,controller.start(actor,{url:DEFAULT_URL}).id);
  assert.equal(preview.status,'ready');assert.equal(reads,1);
  assert.deepEqual(preview.rows.map(row=>[row.price,row.stock]),[[1000,2],[2500,4]]);
  assert.deepEqual(preview.detailProgress,{total:1,read:1,completed:2,failed:0});
  await controller.close();
});

test('erro em um produto não impede consultar os demais e valores ambíguos continuam pendentes',async()=>{
  const controller=createController({readerFactory:()=>({async read(url){
    const target=new URL(url),id=target.searchParams.get('card');
    if(target.searchParams.get('view')==='ecom/itens')return html(card({id:3301,price:'',stock:''})+card({id:3302,price:'',stock:''})+card({id:3303,price:'',stock:''}));
    if(id==='3301')throw Error('HTTP 404');
    return detail({offers:id==='3302'?[{price:'R$ 10,00',stock:'2',language:'Inglês'},{price:'R$ 20,00',stock:'5',language:'Português'}]:[{price:'R$ 0,00',stock:'0'}]});
  },async close(){}})});
  const preview=await ready(controller,controller.start(actor,{url:DEFAULT_URL}).id);
  assert.equal(preview.status,'ready');assert.equal(preview.complete,true);
  assert.deepEqual(preview.detailProgress,{total:3,read:3,completed:1,failed:2});
  assert.equal(preview.rows[0].stock,null);assert.match(preview.rows[0].warnings.join(' '),/404/);
  assert.equal(preview.rows[1].price,null);assert.match(preview.rows[1].warnings.join(' '),/única versão/);
  assert.equal(preview.rows[2].price,0);assert.equal(preview.rows[2].stock,0);
  await controller.close();
});

test('HTML enviado pode consultar os links individuais e a opção desmarcada mantém a leitura offline',async()=>{
  let reads=0;
  const controller=createController({readerFactory:()=>({async read(){reads++;return detail({offers:[{price:'R$ 8,50',stock:'7'}]});},async close(){}})});
  const source=html(card({id:3401,price:'',stock:''}));
  const offline=controller.fromHtml(actor,{url:DEFAULT_URL,html:source});
  assert.equal(offline.status,'ready');assert.equal(reads,0);assert.equal(offline.rows[0].price,null);
  const job=controller.fromHtml(actor,{url:DEFAULT_URL,html:source,productDetails:true});
  assert.equal(job.complete,false);
  await assert.rejects(controller.apply(actor,{id:job.id,mode:'create',rows:[{key:offline.rows[0].key}]}),/Conclua/);
  const preview=await ready(controller,job.id);
  assert.equal(preview.status,'ready');assert.equal(preview.rows[0].price,850);assert.equal(preview.rows[0].stock,7);assert.equal(reads,1);
  await controller.close();
});

test('consulta individual pode ser desativada na análise do link',async()=>{
  let reads=0;
  const controller=createController({readerFactory:()=>({async read(){reads++;return html(card({id:3501,price:'',stock:''}));},async close(){}})});
  const preview=await ready(controller,controller.start(actor,{url:DEFAULT_URL,productDetails:false}).id);
  assert.equal(preview.status,'ready');assert.equal(reads,1);assert.equal(preview.rows[0].price,null);
  await controller.close();
});

test('cancelar durante a consulta individual interrompe a leitura e fecha o navegador sem cadastrar',async()=>{
  let started,closed=false;const reading=new Promise(resolve=>started=resolve);
  const controller=createController({readerFactory:({signal})=>({async read(url){
    if(new URL(url).searchParams.get('view')==='ecom/itens')return html(card({id:3601,price:'',stock:''}));
    started();await delay(10000,undefined,{signal});return detail();
  },async close(){closed=true;}})});
  const job=controller.start(actor,{url:DEFAULT_URL});await reading;controller.cancel(actor,job.id);await controller.close();
  const preview=controller.status(actor,job.id,true);
  assert.equal(preview.status,'cancelled');assert.equal(preview.complete,false);assert.equal(closed,true);
  assert.equal(get('SELECT COUNT(*) n FROM products WHERE code=?',preview.rows[0].code).n,0);
});

test('limite de acessos respeita Retry-After e retoma a leitura sem abrir outro navegador',async()=>{
  const pauses=[],messages=[];let requests=0;
  const reader=createPageReader({downloadPage:async()=>++requests===1?{status:429,headers:{'retry-after':'12'}}:
    {status:200,headers:{'content-type':'text/html; charset=utf-8'},body:Buffer.from(detail()),url:detailUrl(3701)},
    wait:async milliseconds=>pauses.push(milliseconds),onWaiting:message=>messages.push(message)});
  const result=await reader.read(detailUrl(3701),{productDetails:true});
  assert.equal(parsePage(result,detailUrl(3701)).rows[0].stock,3);
  assert.equal(requests,2);assert.deepEqual(pauses,[12000]);assert.match(messages[0],/retomar.*automaticamente/);
  assert.equal(retryAfterMs(undefined),60000);
  assert.equal(retryAfterMs('Wed, 25 Nov 2026 02:00:10 GMT',Date.parse('Wed, 25 Nov 2026 02:00:00 GMT')),10000);
  await reader.close();
});

test('limite de acessos persistente interrompe a análise sem declarar um catálogo parcial como completo',async()=>{
  let requests=0;
  const reader=createPageReader({downloadPage:async()=>{requests++;return {status:429,headers:{'retry-after':'1'}};},wait:async()=>{}});
  await assert.rejects(reader.read(detailUrl(3702),{productDetails:true}),error=>error.code==='SITE_RATE_LIMIT');
  assert.equal(requests,3);await reader.close();
  const controller=createController({readerFactory:()=>({async read(url){
    if(new URL(url).searchParams.get('view')==='ecom/itens')return html(card({id:3702,price:'',stock:''}));
    throw Object.assign(Error('Limite de acessos persistente'),{code:'SITE_RATE_LIMIT'});
  },async close(){}})});
  const preview=await ready(controller,controller.start(actor,{url:DEFAULT_URL}).id);
  assert.equal(preview.status,'error');assert.equal(preview.complete,false);
  await controller.close();
});
