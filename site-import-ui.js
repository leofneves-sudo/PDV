import {h,btn,header,empty,lab,input,moneyInput,money,cents,decimal} from './ui.js';
import {needsExpiry} from './expiry.mjs';

const initial=()=>({url:'',category:'Produtos Liga',allPages:true,productDetails:true,id:null,job:null,rows:[],loaded:false,
  selected:new Set(),edits:new Map(),processed:new Set(),mode:'create',images:true,page:1,search:'',submitting:false,result:null,error:'',htmlFile:null});
const draft=state=>state.siteImport ||= initial();
const active=job=>['queued','collecting','waiting'].includes(job?.status);
const value=(d,row,key)=>Object.hasOwn(d.edits.get(row.key)||{},key)?d.edits.get(row.key)[key]:row[key];
function data(d,row) {
  const edit=d.edits.get(row.key)||{};
  let price=value(d,row,'price');
  if(Object.hasOwn(edit,'priceRaw'))price=cents(edit.priceRaw);
  const stock=Object.hasOwn(edit,'stockRaw')?Number(edit.stockRaw):row.stock;
  const stockMissing=Object.hasOwn(edit,'stockRaw')?edit.stockRaw.trim()==='':row.stock==null;
  const name=value(d,row,'name'),category=value(d,row,'category');
  if(!name?.trim() || name.length>120 || !category?.trim() || category.length>80)throw Error('Confira o nome e a categoria.');
  if(price==null || !Number.isSafeInteger(price) || price<0 || price>100000000)throw Error('Informe um preço de venda válido.');
  if(stockMissing || !Number.isSafeInteger(stock) || stock<0 || stock>1000000)throw Error('Informe a quantidade real em estoque.');
  if(needsExpiry(category) && !row.existing?.expires_on)throw Error('Cadastre a validade em Produtos e analise novamente para importar alimentação ou bebidas.');
  return {key:row.key,name,category,price,stock};
}
function eligible(d,row) {
  if(d.processed.has(row.key) || row.existing && d.mode==='create')return false;
  try {data(d,row);return true;}catch{return false;}
}
function filtered(d) {
  const search=d.search.trim().toLocaleLowerCase('pt-BR');
  return d.rows.filter(row=>!search || (row.name+' '+row.code+' '+row.category).toLocaleLowerCase('pt-BR').includes(search));
}
export async function load(ctx) {
  const d=draft(ctx.state);
  if(!d.url) {
    const config=await ctx.api('site-import/config');d.url=config.defaultUrl;
  }
  if(d.id) {
    let job;
    try {job=await ctx.api('site-import/status?id='+encodeURIComponent(d.id)+'&details='+(!d.loaded?'1':'0'));}
    catch(error) {
      if(error.status!==404)throw error;
      Object.assign(d,{id:null,loaded:false,rows:[],selected:new Set(),processed:new Set(),
        job:{status:'error',message:'A análise expirou ou o servidor foi reiniciado. Analise o link novamente.',pages:0,total:0,allPages:d.allPages}});
      return {};
    }
    d.job=job;
    for(const key of job.appliedKeys || []){d.processed.add(key);d.selected.delete(key);}
    if(job.rows && job.status==='ready' && !d.loaded) {
      d.rows=job.rows;d.loaded=true;
      for(const row of d.rows)if(eligible(d,row))d.selected.add(row.key);
    }
  }
  return {};
}
export function reset(state){state.siteImport=null;}
export function page(state) {
  const d=draft(state),job=d.job,busy=active(job)||d.submitting;
  const list=filtered(d),pages=Math.max(1,Math.ceil(list.length/50));d.page=Math.min(d.page,pages);
  const visible=list.slice((d.page-1)*50,d.page*50);
  return `${header('Importar produtos do site','Analise o link da sua loja na Liga e confira os dados antes de cadastrar no PDV.',btn('Sincronização automática','site-import-sync',{ico:'rotate'}))}
    <section class="panel site-import-panel"><form data-form="site-import-analyze" class="site-import-form">
      ${lab('Link da listagem ou do produto',input('url',d.url,'type="url" data-verbatim required maxlength="3000" placeholder="https://www.lastplacetcg.com.br/?view=ecom%2Fitens..."'),'span-two')}
      ${lab('Categoria padrão quando o site não informar',input('category',d.category,'data-verbatim required maxlength="80"'))}
      <label class="toggle-row"><input type="checkbox" name="allPages" ${d.allPages?'checked':''}> Percorrer todas as páginas desse filtro</label>
      <label class="toggle-row span-two"><input type="checkbox" name="productDetails" ${d.productDetails?'checked':''} ${busy?'disabled':''}> Buscar preço e estoque nas páginas dos produtos</label>
      <div class="site-import-actions span-two"><button class="btn primary" type="submit" ${busy?'disabled':''}>Analisar link</button>
        ${active(job)?btn('Cancelar análise','site-import-cancel',{cls:'outline'}):''}</div>
    </form><p class="site-import-note">O link mantém os filtros escolhidos no site. Os produtos com preço ou estoque em branco são consultados individualmente quando a opção acima está marcada. Se houver verificação de acesso, conclua-a na janela de navegador que será aberta no computador. Nenhum produto é cadastrado durante a análise.</p></section>
    <details class="panel site-import-panel report-details"><summary>Usar um arquivo HTML salvo da página</summary>
      <form data-form="site-import-html" class="site-import-form">
        ${lab('Arquivo HTML da listagem carregada',input('html','','type="file" accept=".html,.htm,text/html"'),'span-two')}
        ${d.htmlFile?`<p class="site-import-note span-two">Arquivo selecionado: ${h(d.htmlFile.name)}</p>`:''}
        <p class="site-import-note span-two">Use o HTML de uma página que já mostra os produtos. Este modo lê a listagem do arquivo e, se a opção acima estiver marcada, consulta os links individuais para completar preço e estoque. O link acima identifica a origem dos produtos.</p>
        <button class="btn outline" type="submit" ${busy?'disabled':''}>Analisar HTML</button>
      </form></details>
    ${job?`<section class="panel site-import-panel" aria-live="polite"><h2>Resultado da análise</h2>
      <p class="${job.status==='error'?'notice error':'notice'}">${h(job.message)}</p>
      <p class="site-import-note">${job.pages} página(s) lida(s) · ${job.total} produto(s) encontrado(s) · ${job.allPages?'Todas as páginas do filtro':'Somente a página informada'}.</p>
      ${job.detailProgress?.total?`<p class="site-import-note">Páginas de produtos: ${job.detailProgress.read} de ${job.detailProgress.total} consultada(s) · ${job.detailProgress.completed} produto(s) com preço e estoque completos.${job.detailProgress.failed?' '+job.detailProgress.failed+' com campos pendentes.':''}</p>`:''}
      ${job.warnings?.map(message=>`<p class="site-import-note">${h(message)}</p>`).join('') || ''}
    </section>`:''}
    ${d.error?`<div class="notice error" role="alert">${h(d.error)}</div>`:''}
    ${d.result?`<div class="notice" role="status">Importação: ${d.result.created} novo(s), ${d.result.updated} atualizado(s), ${d.result.skipped} ignorado(s).${d.result.imageWarnings?' '+d.result.imageWarnings+' foto(s) não puderam ser copiadas.':''}</div>`:''}
    ${d.loaded?`<section class="panel site-import-panel"><h2>Confira os produtos</h2>
      <div class="site-import-settings">
        <label class="toggle-row"><input type="checkbox" id="site-import-update" ${d.mode==='update'?'checked':''} ${d.submitting?'disabled':''}> Atualizar também os produtos já importados</label>
        <label class="toggle-row"><input type="checkbox" id="site-import-images" ${d.images?'checked':''} ${d.submitting?'disabled':''}> Copiar as fotos disponíveis</label>
      </div>
      <p class="site-import-note">${d.mode==='update'?'A atualização substitui preço, dados informados e quantidade pelo estoque revisado abaixo. Custos e códigos de barras existentes são preservados.':'Produtos já cadastrados são ignorados por padrão.'} A importação é pontual; vendas do PDV não alteram o site. Preencha preço ou quantidade que estiverem em branco. A seleção vale para todas as páginas; para importar só os resultados de uma busca, use Limpar seleção antes de selecionar esses resultados.</p>
      <div class="site-import-actions">
        ${btn('Selecionar todos os válidos','site-import-select-all',{attrs:d.submitting?'disabled':''})}
        ${btn('Limpar seleção','site-import-clear',{attrs:d.submitting?'disabled':''})}
        <label class="field site-import-search"><span>Buscar nesta análise</span><input id="site-import-search" type="search" data-verbatim value="${h(d.search)}" placeholder="Nome ou código"></label>
      </div>
      <div class="table-scroll"><table class="site-import-table"><thead><tr><th>Importar</th><th>Nome e origem</th><th>Categoria</th><th>Preço de venda</th><th>Estoque</th><th>Conferência</th></tr></thead>
        <tbody>${visible.map(row=>renderRow(d,row)).join('')}</tbody></table></div>
      <div class="site-import-actions site-import-footer">
        <span>${d.selected.size} selecionado(s) · página ${d.page} de ${pages}</span>
        ${btn('Anterior','site-import-page',{attrs:`data-page="${d.page-1}" ${d.page<=1?'disabled':''}`})}
        ${btn('Próxima','site-import-page',{attrs:`data-page="${d.page+1}" ${d.page>=pages?'disabled':''}`})}
        ${btn(d.submitting?'Importando…':'Importar selecionados','site-import-apply',{cls:'primary',attrs:!d.selected.size||d.submitting?'disabled':''})}
      </div></section>`:!job?empty('link','Informe o link da loja','A análise prepara uma prévia com nomes, preços, quantidades e fotos encontradas.'):''}`;
}
function renderRow(d,row) {
  const edit=d.edits.get(row.key)||{},done=d.processed.has(row.key),disabled=d.submitting||done;
  let issue='';try{data(d,row);}catch(error){issue=error.message;}
  const attr=(field)=>`data-import-key="${row.key}" data-import-field="${field}" ${disabled?'disabled':''}`;
  const price=Object.hasOwn(edit,'priceRaw')?edit.priceRaw:row.price==null?'':decimal(row.price);
  return `<tr><td><input type="checkbox" aria-label="Importar ${h(row.name)}" data-import-select="${row.key}" ${d.selected.has(row.key)?'checked':''} ${disabled?'disabled':''}></td>
    <td><input aria-label="Nome do produto" type="text" data-verbatim maxlength="120" id="si-name-${row.key}" value="${h(value(d,row,'name'))}" ${attr('name')}>
      <small>${h(row.existing?.code || row.code)}</small><a href="${h(row.url)}" target="_blank" rel="noopener noreferrer">Ver no site</a></td>
    <td><input aria-label="Categoria do produto" type="text" data-verbatim maxlength="80" id="si-category-${row.key}" value="${h(value(d,row,'category'))}" ${attr('category')}></td>
    <td><input aria-label="Preço de venda" data-money inputmode="decimal" id="si-price-${row.key}" value="${h(price)}" placeholder="Informe" ${attr('priceRaw')}></td>
    <td><input aria-label="Quantidade em estoque" type="number" inputmode="numeric" min="0" max="1000000" step="1" id="si-stock-${row.key}" value="${h(edit.stockRaw ?? row.stock ?? '')}" placeholder="Informe" ${attr('stockRaw')}></td>
    <td><strong>${done?'Processado':row.existing?'Já cadastrado':'Novo produto'}</strong>${row.existing?`<small>PDV: ${money(row.existing.price)} · ${row.existing.stock} em estoque</small>`:''}
      <small class="negative" data-import-issue="${row.key}" ${issue?'':'hidden'}>${h(issue)}</small>${row.warnings.filter(warning=>
        !(Object.hasOwn(edit,'priceRaw')&&warning.startsWith('Preço não identificado')) &&
        !(Object.hasOwn(edit,'stockRaw')&&warning.startsWith('Quantidade não identificada'))).map(warning=>`<small>${h(warning)}</small>`).join('')}
      ${[row.collection,row.language,row.condition,row.foil===true?'Foil':null].filter(Boolean).map(text=>`<small>${h(text)}</small>`).join('')}</td></tr>`;
}
const redraw=ctx=>{if(ctx.state.view==='site-import')ctx.render();};
export async function submit(ctx,form,name,fields) {
  const d=draft(ctx.state);d.error='';
  if(name==='site-import-analyze') {
    d.url=fields.url.trim();d.category=fields.category.trim();d.allPages=form.elements.allPages.checked;
    d.productDetails=form.elements.productDetails.checked;
    const job=await ctx.send('site-import/analyze',{url:d.url,category:d.category,allPages:d.allPages,productDetails:d.productDetails});
    Object.assign(d,{id:job.id,job,rows:[],loaded:false,selected:new Set(),edits:new Map(),processed:new Set(),result:null,page:1,htmlFile:null});
    return ctx.reload();
  }
  if(name==='site-import-html') {
    const file=form.elements.html.files[0] || d.htmlFile;
    if(!file || file.size>1000000)throw Error('Selecione um arquivo HTML de até 1 MB.');
    const job=await ctx.send('site-import/html',{url:d.url,category:d.category,productDetails:d.productDetails,html:await file.text()});
    Object.assign(d,{id:job.id,job,rows:[],loaded:false,selected:new Set(),edits:new Map(),processed:new Set(),result:null,page:1,htmlFile:null});
    return ctx.reload();
  }
}
export async function act(ctx,action,element) {
  const d=draft(ctx.state);
  if(action==='site-import-sync')return ctx.navigate('site-sync');
  if(d.submitting)return;
  if(action==='site-import-cancel') {d.job=await ctx.send('site-import/cancel',{id:d.id});return ctx.reload();}
  if(action==='site-import-select-all'){for(const row of filtered(d))if(eligible(d,row))d.selected.add(row.key);return redraw(ctx);}
  if(action==='site-import-clear'){d.selected.clear();return redraw(ctx);}
  if(action==='site-import-page'){d.page=Math.max(1,Number(element.dataset.page)||1);return redraw(ctx);}
  if(action!=='site-import-apply')return;
  const selection=d.rows.filter(row=>d.selected.has(row.key));
  if(!selection.length)throw Error('Selecione pelo menos um produto.');
  const payload=selection.map(row=>{try{return data(d,row);}catch(error){throw Error(row.name+': '+error.message);}});
  const session=ctx.state.me.started_at;
  d.submitting=true;d.error='';d.result={created:0,updated:0,skipped:0,imageWarnings:0};redraw(ctx);
  try {
    for(let offset=0;offset<payload.length;offset+=100) {
      if(ctx.state.me?.started_at!==session)throw Error('A sessão mudou. Entre novamente para continuar.');
      const result=await ctx.send('site-import/apply',{id:d.id,mode:d.mode,images:d.images,rows:payload.slice(offset,offset+100)});
      for(const key of result.appliedKeys){d.selected.delete(key);d.processed.add(key);}
      for(const key of ['created','updated','skipped'])d.result[key]+=result[key];
      d.result.imageWarnings+=result.imageWarnings.length;
      redraw(ctx);
    }
    ctx.toast('Importação concluída. Os produtos estão disponíveis em Produtos.');
  } catch(error){d.error=error.message;throw error;}
  finally {d.submitting=false;redraw(ctx);}
}
export function inputChanged(ctx,field) {
  const d=draft(ctx.state);
  if(field.id==='site-import-search'){d.search=field.value;d.page=1;redraw(ctx);return;}
  if(field.closest('form[data-form="site-import-analyze"]')) {
    if(field.name==='url')d.url=field.value;
    if(field.name==='category')d.category=field.value;
  }
  const key=field.dataset.importKey,kind=field.dataset.importField;
  if(key && kind) {
    const edit=d.edits.get(key)||{};edit[kind]=field.value;d.edits.set(key,edit);
    const row=d.rows.find(row=>row.key===key),notice=field.closest('tr')?.querySelector('[data-import-issue]');
    if(row && notice) {
      let issue='';try{data(d,row);}catch(error){issue=error.message;}
      notice.textContent=issue;notice.hidden=!issue;
    }
  }
}
export function changed(ctx,field) {
  const d=draft(ctx.state);
  if(field.id==='site-import-update'){d.mode=field.checked?'update':'create';d.selected.clear();redraw(ctx);}
  else if(field.id==='site-import-images')d.images=field.checked;
  else if(field.name==='html' && field.form?.dataset.form==='site-import-html')d.htmlFile=field.files[0] || null;
  else if(field.name==='allPages' && field.form?.dataset.form==='site-import-analyze')d.allPages=field.checked;
  else if(field.name==='productDetails' && field.form?.dataset.form==='site-import-analyze')d.productDetails=field.checked;
  else if(field.dataset.importSelect) {
    if(field.checked)d.selected.add(field.dataset.importSelect);else d.selected.delete(field.dataset.importSelect);
    redraw(ctx);
  } else if(field.dataset.importKey) inputChanged(ctx,field);
}
