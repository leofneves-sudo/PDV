const cheerio=require('cheerio');
const {createHash}=require('node:crypto');

const STORE_HOSTS=new Set(['www.lastplacetcg.com.br','lastplacetcg.com.br']);
const IMAGE_HOSTS=new Set([...STORE_HOSTS,'repositorio.sbrauble.com','repositorio.ligamagic.com.br']);
const DEFAULT_URL='https://www.lastplacetcg.com.br/?view=ecom%2Fitens&page=1&id=26240&cat=300055&ultimas=&txt_filtro_multiestoque=&txt_order=1&fCondicao=&txt_limit=120&txt_estoque=1&btFiltrar=Filtrar';
const hash=value=>createHash('sha256').update(value).digest('hex');
const text=value=>String(value ?? '').replace(/\s+/g,' ').trim();

function storeUrl(value) {
  let url;
  try {url=new URL(String(value));} catch {throw Error('Informe um link HTTPS válido da Last Place TCG.');}
  if(url.protocol!=='https:' || !STORE_HOSTS.has(url.hostname) || url.port && url.port!=='443' || url.username || url.password) {
    throw Error('Use somente links HTTPS de www.lastplacetcg.com.br.');
  }
  if(url.pathname!=='/' || !['ecom/itens','ecom/item'].includes(url.searchParams.get('view'))) {
    throw Error('Use o link da listagem ou de um produto da loja da Liga.');
  }
  for(const key of url.searchParams.keys()) {
    if(/^(?:token|password|senha|auth|session|sid|api_key)$/i.test(key)) throw Error('Use um link público do catálogo, sem dados de autenticação.');
  }
  url.hash='';
  return url;
}
function imageUrl(value,base) {
  if(!value) return null;
  try {
    const url=new URL(value,base);
    return url.protocol==='https:' && IMAGE_HOSTS.has(url.hostname) && !url.username && !url.password && !url.port ? url.href : null;
  } catch {return null;}
}
function money(value,decimal=false) {
  if(typeof value==='number') return Number.isFinite(value) && value>=0 && value<=1000000 ? Math.round(value*100) : null;
  let raw=text(value).replace(/R\$\s*/gi,'');
  if(!raw || !/^[\d.,]+$/.test(raw)) return null;
  if(raw.includes(',')) raw=raw.replace(/\./g,'').replace(',','.');
  else if(!decimal && /^\d{1,3}(?:\.\d{3})+$/.test(raw)) raw=raw.replace(/\./g,'');
  if(!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const result=Math.round(Number(raw)*100);
  return Number.isSafeInteger(result) && result<=100000000 ? result : null;
}
function quantity(value) {
  const raw=text(value).replace(/\s*(?:unid(?:ades)?\.?|un\.?|em estoque)\s*$/i,'').trim();
  return /^\d+$/.test(raw) && Number(raw)<=1000000 ? Number(raw) : null;
}
function productUrl(value,base) {
  try {
    const url=storeUrl(new URL(value,base).href);
    return url.searchParams.get('view')==='ecom/item' ? url : null;
  } catch {return null;}
}
function identity(url,sku,variant={}) {
  const key=new URL(url);
  key.hostname='www.lastplacetcg.com.br';
  for(const name of ['page','utm_source','utm_medium','utm_campaign','fbclid','gclid']) key.searchParams.delete(name);
  key.searchParams.sort();
  const sourceKey=hash(JSON.stringify([key.href,sku || '',variant]));
  return {key:sourceKey,code:'LIGA-'+sourceKey.slice(0,20).toUpperCase()};
}
const normalize=value=>text(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
function sameProduct(expected,actual) {
  const source=productUrl(expected,expected),target=productUrl(actual,expected);
  if(!source || !target)return false;
  const identifiers=['refid','card','produto','product','item','id'];
  const supplied=identifiers.filter(key=>source.searchParams.has(key));
  if(!supplied.length)return false;
  for(const key of supplied)if(JSON.stringify(source.searchParams.getAll(key))!==JSON.stringify(target.searchParams.getAll(key)))return false;
  if(source.searchParams.has('tcg') && source.searchParams.get('tcg')!==target.searchParams.get('tcg'))return false;
  return true;
}
function detailRows($,url) {
  const rows=[];
  const name=$('.nomes_cards .nome_pt_cards,.nomes_cards .nome_en_cards,.nomes_cards h1').map((_,element)=>text($(element).text())).get().find(Boolean) || '';
  const image=$('.imagem_produtos img,.imagem_cards img,#imagemScroll img').first();
  $('#product--list .table-produtos').each((_,table)=>{
    const headers=$(table).find('.table-produtos-header-cell').map((_,cell)=>normalize($(cell).text())).get();
    $(table).find('.table-produtos-row').each((_,element)=>{
      const root=$(element),values={};
      root.children('.table-produtos-body-cell').each((index,element)=>{
        const cell=$(element),label=normalize(cell.find('.title-mobile').first().text()) || headers[index];
        const clean=cell.clone();clean.find('.title-mobile,.tooltip,del,s,.old-price,.price-old,script,style').remove();
        const value=text(clean.text());
        if(label==='idioma')values.language=text(cell.find('img[alt]').first().attr('alt') || cell.find('img[title]').first().attr('title') || value);
        else if(label==='condicao')values.condition=value;
        else if(label==='edicao'||label==='colecao')values.collection=value;
        else if(label==='estoque')values.stock=quantity(value);
        else if(label==='preco')values.price=money(value);
      });
      const variant=Object.fromEntries(['language','condition','collection'].filter(key=>values[key]).map(key=>[key,values[key]]));
      const foil=root.attr('data-foil');if(foil==='1'||foil==='true')variant.foil=true;else if(foil==='0'||foil==='false')variant.foil=false;
      rows.push({name,url:url.href,price:values.price ?? null,stock:values.stock ?? null,variant,
        sku:root.attr('data-sku') || /(?:txt_qty_|bt_comprar_)(\d+)/.exec(root.find('input.product--qty,button.product--btn').first().attr('id') || '')?.[1],
        image:image.attr('data-src') || image.attr('data-original') || image.attr('src')});
    });
  });
  return rows;
}
function matchProductDetails(row,parsed) {
  if(parsed.challenge)throw Error('O site ainda exige verificação de acesso para este produto.');
  const fields=['language','condition','collection','foil'];
  const matches=parsed.rows.filter(candidate=>sameProduct(row.url,candidate.url) && fields.every(field=>
    row[field]==null || row[field]==='' || candidate[field]!=null && normalize(candidate[field])===normalize(row[field])));
  if(matches.length!==1)return null;
  return matches[0];
}
function parsePage(html,urlValue,{defaultCategory='Produtos Liga'}={}) {
  const url=storeUrl(urlValue);
  if(typeof html!=='string' || Buffer.byteLength(html)>8*1024*1024) throw Error('O HTML excede o tamanho permitido.');
  const $=cheerio.load(html);
  if(/just a moment|verifying you are human|attention required/i.test($('title').text()) || $('#challenge-running,#challenge-form').length) {
    return {challenge:true,rows:[],nextPage:null,title:text($('title').text())};
  }
  const rows=[],warnings=[],seen=new Map();
  const title=text($('title').text());
  function add(candidate) {
    const target=productUrl(candidate.url,url);
    const name=text(candidate.name);
    if(!target || !name) return;
    if(url.searchParams.get('view')==='ecom/item' && !sameProduct(url.href,target.href))return;
    const variant=Object.fromEntries(Object.entries(candidate.variant || {}).filter(([,value])=>value!=null && value!==''));
    const ident=identity(target,candidate.sku,candidate.identityVariant || variant);
    const row={...ident,name,category:text(candidate.category)||defaultCategory,price:candidate.price,stock:candidate.stock,
      url:target.href,image:imageUrl(candidate.image,url),...variant,warnings:[]};
    if(name.length>120) row.warnings.push('Nome maior que 120 caracteres; ajuste antes de importar.');
    if(row.price==null) row.warnings.push('Preço não identificado; informe o valor de venda.');
    if(row.stock==null) row.warnings.push('Quantidade não identificada; informe o estoque real.');
    const previous=seen.get(row.key);
    if(previous) {
      if(previous.price!==row.price || previous.stock!==row.stock) {
        previous.price=null;previous.stock=null;
        previous.warnings.push('Há valores diferentes para este produto na página; confira preço e quantidade.');
      }
      return;
    }
    seen.set(row.key,row);rows.push(row);
  }
  const details=url.searchParams.get('view')==='ecom/item'?detailRows($,url):[];
  for(const candidate of details)add(details.length===1?{...candidate,sku:undefined,identityVariant:{}}:candidate);
  if(!details.length)$('.card-item').each((_,element)=>{
    const root=$(element);
    if(root.closest('.related-products,.recommended-products').length) return;
    const anchor=root.find('.card-desc .title a').first();
    const priceNode=root.find('.card-desc .price .align-price').first().clone();
    priceNode.find('del,s,.old-price,.price-old').remove();
    const matches=text(priceNode.text()).match(/R\$\s*[\d.]+(?:,\d{1,2})?/g) || [];
    const rawPrice=root.attr('data-price');
    const variant={};
    for(const [field,selector] of [['language','.language,.idioma'],['condition','.condition,.qualidade'],['collection','.edition,.edicao']]) {
      const value=text(root.find(selector).first().text());
      if(value) variant[field]=value;
    }
    const foil=root.attr('data-foil');
    if(foil==='1' || foil==='true') variant.foil=true;
    if(foil==='0' || foil==='false') variant.foil=false;
    add({name:anchor.text(),url:anchor.attr('href'),sku:root.attr('data-sku'),variant,
      category:root.attr('data-category'),
      price:rawPrice!=null?money(rawPrice,true):matches.length===1?money(matches[0]):money(priceNode.text()),
      stock:quantity(root.attr('data-stock') ?? root.find('.card-desc .qty span').first().text()),
      image:root.find('.card-img img').first().attr('data-src') || root.find('.card-img img').first().attr('data-original') || root.find('.card-img img').first().attr('src')});
  });
  if(!rows.length) {
    $('[itemtype*="schema.org/Product"],.product-item,[data-product-id]').each((_,element)=>{
      const root=$(element);
      const anchor=root.find('a[itemprop="url"],.product-name a,.product-title a,a[href*="ecom/item"]').first();
      add({name:root.find('[itemprop="name"],.product-name,.product-title').first().text(),url:anchor.attr('href') || root.attr('data-url'),
        sku:root.attr('data-sku') || root.attr('data-product-id'),
        price:money(root.find('[itemprop="price"]').attr('content') ?? root.attr('data-price'),true),
        stock:quantity(root.attr('data-stock') ?? root.find('[itemprop="inventoryLevel"]').attr('content')),
        category:root.find('[itemprop="category"]').text(),image:root.find('img').first().attr('data-src') || root.find('img').first().attr('src')});
    });
  }
  if(!rows.length) {
    $('script[type="application/ld+json"]').each((_,element)=>{
      let data;try {data=JSON.parse($(element).text());} catch {return;}
      function visit(node) {
        if(!node || typeof node!=='object') return;
        if(Array.isArray(node)){node.forEach(visit);return;}
        const types=[node['@type']].flat();
        if(types.includes('Product')) {
          const offers=[node.offers].flat().filter(Boolean);
          const offer=offers.length===1?offers[0]:{};
          add({name:node.name,url:node.url || offer.url || (url.searchParams.get('view')==='ecom/item'?url.href:null),sku:node.sku,category:node.category,
            price:money(offer.price,true),stock:quantity(offer.inventoryLevel?.value ?? node.inventoryLevel?.value),
            image:Array.isArray(node.image)?node.image[0]:typeof node.image==='object'?node.image?.url:node.image});
        }
        if(node['@graph'])visit(node['@graph']);
        if(node.itemListElement)for(const item of node.itemListElement)visit(item.item || item);
      }
      visit(data);
    });
  }
  const current=Number(url.searchParams.get('page') || 1);
  const pages=[];
  $('a.ecomresp-paginacao,.pagination a,a[rel="next"]').each((_,element)=>{
    try {
      const next=storeUrl(new URL($(element).attr('href'),url).href);
      const number=Number(next.searchParams.get('page'));
      if(Number.isInteger(number) && number>current && number<=100000) pages.push(number);
    } catch {}
  });
  const nextPage=pages.length ? current+1 : null;
  if(!rows.length)warnings.push('Nenhum produto reconhecido no HTML. Confira se a página terminou de carregar e se o link é de um catálogo da Liga.');
  return {challenge:false,rows,nextPage,title,warnings};
}
function pageUrl(original,page) {
  const url=storeUrl(original);url.searchParams.set('page',String(page));return url.href;
}
function sameListing(expected,actual) {
  const source=storeUrl(expected),target=storeUrl(actual);
  if(source.searchParams.get('view')!==target.searchParams.get('view'))return false;
  if(source.searchParams.get('view')==='ecom/item')return sameProduct(source.href,target.href);
  if(Number(source.searchParams.get('page') || 1)!==Number(target.searchParams.get('page') || 1))return false;
  for(const key of new Set(source.searchParams.keys())) {
    if(key==='txt_order' || key==='txt_limit' || !/^(?:cat$|tcg$|txt_|f[A-Z]|comdesconto$|ultimas$)/.test(key))continue;
    const values=source.searchParams.getAll(key).filter(Boolean).sort();
    if(values.length && JSON.stringify(values)!==JSON.stringify(target.searchParams.getAll(key).filter(Boolean).sort()))return false;
  }
  return true;
}
module.exports={DEFAULT_URL,STORE_HOSTS,IMAGE_HOSTS,storeUrl,imageUrl,money,quantity,parsePage,pageUrl,sameListing,sameProduct,matchProductDetails};
