const {randomUUID}=require('node:crypto');
const {dirname,join,resolve}=require('node:path');
const {setTimeout:delay}=require('node:timers/promises');
const {all,get,run,tx,sha,now,fail,audit,required,integer,findSession,file}=require('./db');
const ops=require('./operations');
const {storeUrl,parsePage,pageUrl,matchProductDetails}=require('./site-catalog');
const {createPageReader,downloadImage}=require('./site-browser');

const MAX_ROWS=10000,MAX_PAGES=200,MAX_BATCH=100;
function admin(actor) {if(actor?.role!=='admin')fail('A importação do site é exclusiva do administrador.',403);}
function existing(row) {
  const source=get('SELECT product_id FROM web_product_sources WHERE source_key=?',row.key);
  return source ? get(`${ops.catalog} WHERE p.id=?`,source.product_id) : get(`${ops.catalog} WHERE p.code=?`,row.code);
}
function fingerprint(row) {
  if(!row)return null;
  return sha(JSON.stringify(Object.fromEntries(['id','code','name','category','price','cost','stock','stock_value','minimum','active','expires_on','barcode','image_hash',
    'game','collection','collector_number','language','condition','rarity','foil','reserved'].map(key=>[key,row[key]]))));
}
function decorate(row) {
  const old=existing(row);
  return {...row,existing:old?{id:old.id,code:old.code,name:old.name,price:old.price,stock:old.stock,reserved:old.reserved,expires_on:old.expires_on}:null,
    baseline:fingerprint(old),applied:false};
}
function validateRow(row,edit={},category) {
  const name=required(edit.name ?? row.name,'Nome',120);
  const group=required(edit.category ?? row.category ?? category,'Categoria',80);
  const price=integer(edit.price ?? row.price,'Preço',0,100000000);
  const stock=integer(edit.stock ?? row.stock,'Estoque',0,1000000);
  const expires_on=ops.productExpiry(group,Object.hasOwn(edit,'expires_on')?edit.expires_on || null:row.existing?.expires_on || null);
  return {name,category:group,price,stock,expires_on};
}
function createController({readerFactory=createPageReader,imageLoader=downloadImage,notify=()=>{},directory,
  maxRows=MAX_ROWS,maxPages=MAX_PAGES,detailDelayMs=2000,readerOptions={}}={}) {
  const jobs=new Map();
  const profile=resolve(directory || join(file===':memory:'?'test-output':dirname(file),'site-import','browser-profile'));
  function publish(job,status,message) {
    const changed=job.status!==status || job.message!==message;
    job.status=status;job.message=message;job.updatedAt=Date.now();
    if(changed)notify(job.owner,job.id);
  }
  function current(job) {
    const actor=findSession(job.owner);
    if(!actor)fail('A sessão do administrador foi encerrada. Entre novamente.',401);
    if(actor.role!=='admin')fail('A sessão perdeu a permissão de administrador.',403);
    return actor;
  }
  function jobFor(actor,id) {
    admin(actor);
    const job=jobs.get(id);
    if(!job || job.owner!==actor.session_id)fail('Análise não encontrada nesta sessão. Analise o link novamente.',404);
    return job;
  }
  function summary(job,details=false) {
    return {id:job.id,url:job.url,status:job.status,message:job.message,title:job.title,pages:job.pages,total:job.rows.length,
      allPages:job.allPages,productDetails:job.productDetails,detailProgress:{...job.detailProgress},complete:job.complete,error:job.error,created:job.created,updated:job.updated,skipped:job.skipped,
      maxRows,maxPages,warnings:job.warnings,appliedKeys:[...job.applied],busy:job.busy,
      ...(details?{rows:job.rows.map(({baseline,...row})=>row)}:{})};
  }
  function create(actor,body) {
    admin(actor);
    let url;try {url=storeUrl(body.url).href;} catch(error){fail(error.message);}
    if([...jobs.values()].some(job=>job.running || ['queued','collecting','waiting'].includes(job.status)))fail('Já existe uma análise em andamento. Aguarde sua conclusão ou o término do cancelamento antes de iniciar outra.',409);
    if(jobs.size>=12) {
      const removable=[...jobs.values()].filter(job=>!job.busy && !job.running && !['queued','collecting','waiting'].includes(job.status)).sort((a,b)=>a.updatedAt-b.updatedAt);
      if(removable[0])jobs.delete(removable[0].id);
      else fail('Há muitas análises em andamento.',409);
    }
    const job={id:randomUUID(),url,owner:actor.session_id,status:'queued',message:'Preparando a leitura do catálogo.',
      title:'',pages:0,rows:[],warnings:[],allPages:body.allPages!==false,category:required(body.category || 'Produtos Liga','Categoria padrão',80),
      productDetails:body.productDetails!==false,detailProgress:{total:0,read:0,completed:0,failed:0},
      complete:false,error:null,created:0,updated:0,skipped:0,updatedAt:Date.now(),controller:new AbortController(),applied:new Set(),busy:false,running:false};
    jobs.set(job.id,job);
    audit(actor,'produto.site_analise','produto',null,null,{url:job.url,allPages:job.allPages,productDetails:job.productDetails},'Leitura de catálogo solicitada pelo administrador');
    return job;
  }
  function addRows(job,parsed) {
    const known=new Map(job.rows.map(row=>[row.key,row]));
    for(const candidate of parsed.rows) {
      const old=known.get(candidate.key);
      if(old) {
        if(old.price!==candidate.price || old.stock!==candidate.stock) {
          old.price=null;old.stock=null;old.warnings.push('Valores divergentes durante a leitura; confira preço e estoque.');
        }
      } else {
        if(job.rows.length>=maxRows)throw Error('A listagem ultrapassa '+maxRows+' produtos. Refine os filtros do link para importar todo o resultado.');
        const row=decorate(candidate);job.rows.push(row);known.set(row.key,row);
      }
    }
    job.title=parsed.title || job.title;
    job.warnings.push(...(parsed.warnings || []));
  }
  async function completeDetails(job,reader) {
    if(!job.productDetails)return;
    const groups=new Map();
    for(const row of job.rows)if(row.price==null || row.stock==null) {
      const url=storeUrl(row.url);url.searchParams.delete('page');url.searchParams.sort();
      const key=url.href,group=groups.get(key) || {url:row.url,rows:[]};group.rows.push(row);groups.set(key,group);
    }
    job.detailProgress.total=groups.size;
    for(const group of groups.values()) {
      current(job);job.controller.signal.throwIfAborted();
      const progress=job.detailProgress;
      publish(job,'collecting','Consultando produto '+(progress.read+1)+' de '+progress.total+': '+group.rows[0].name);
      let parsed,error;
      try {
        const html=await reader.read(group.url,{defaultCategory:job.category,productDetails:true});
        parsed=parsePage(html,group.url,{defaultCategory:job.category});
        if(parsed.challenge)throw Error('O site ainda exige verificação de acesso para este produto.');
      } catch(cause) {job.controller.signal.throwIfAborted();if(cause.code==='SITE_RATE_LIMIT')throw cause;error=cause.message;}
      current(job);job.controller.signal.throwIfAborted();
      for(const row of group.rows) {
        const detail=parsed && !error?matchProductDetails(row,parsed):null;
        if(detail) {
          if(row.price==null && detail.price!=null)row.price=detail.price;
          if(row.stock==null && detail.stock!=null)row.stock=detail.stock;
          if(!row.image && detail.image)row.image=detail.image;
          for(const field of ['language','condition','collection','foil'])if(row[field]==null && detail[field]!=null)row[field]=detail[field];
          row.warnings=row.warnings.filter(message=>!(row.price!=null && message.startsWith('Preço não identificado')) &&
            !(row.stock!=null && message.startsWith('Quantidade não identificada')));
        }
        if(row.price!=null && row.stock!=null)progress.completed++;
        else {
          progress.failed++;
          row.warnings.push(error?'Não foi possível completar a página do produto: '+error:
            detail?'A página individual não informou todos os valores; confira os campos pendentes.':
            'A página individual não identificou uma única versão correspondente; confira preço e estoque.');
        }
      }
      progress.read++;notify(job.owner,job.id);
      if(progress.read<progress.total)await delay(detailDelayMs,undefined,{signal:job.controller.signal});
    }
    if(job.detailProgress.failed)job.warnings.push(job.detailProgress.failed+' produto(s) ainda precisam de conferência manual de preço ou estoque.');
  }
  async function collect(job,detailsOnly=false) {
    let reader;
    try {
      reader=readerFactory({directory:profile,signal:job.controller.signal,...readerOptions,
        onWaiting:message=>publish(job,'waiting',message)});
      job.reader=reader;
      let page=job.allPages?1:Number(new URL(job.url).searchParams.get('page') || 1);
      if(!Number.isInteger(page) || page<1)page=1;
      const visited=new Set();
      const until=Date.now()+15*60*1000;
      while(!detailsOnly) {
        current(job);job.controller.signal.throwIfAborted();
        if(Date.now()>until)throw Error('A leitura atingiu o limite de tempo. Refine os filtros do link e tente novamente.');
        if(job.pages>=maxPages)throw Error('A listagem ultrapassa '+maxPages+' páginas. Refine os filtros do link.');
        publish(job,'collecting','Analisando a página '+page+' do link informado.');
        const url=pageUrl(job.url,page);
        const html=await reader.read(url,{defaultCategory:job.category,productDetails:new URL(url).searchParams.get('view')==='ecom/item'});
        current(job);job.controller.signal.throwIfAborted();
        const parsed=parsePage(html,url,{defaultCategory:job.category});
        if(parsed.challenge)throw Error('O site ainda exige verificação de acesso. Conclua-a no navegador ou use um arquivo HTML.');
        if(!parsed.rows.length)throw Error('Nenhum produto foi identificado nesta página. Confira o link ou use o HTML da listagem carregada.');
        const pageKey=sha(JSON.stringify(parsed.rows.map(row=>[row.key,row.price,row.stock])));
        if(visited.has(pageKey))throw Error('O site repetiu a mesma página. A análise foi interrompida para não importar um catálogo incompleto.');
        visited.add(pageKey);addRows(job,parsed);job.pages++;
        notify(job.owner,job.id);
        if(!job.allPages || !parsed.nextPage)break;
        page=parsed.nextPage;
        await delay(300,undefined,{signal:job.controller.signal});
      }
      await completeDetails(job,reader);
      job.complete=true;
      publish(job,'ready','Análise concluída. Confira os produtos e confirme a importação.');
    } catch(error) {
      const cancelled=job.controller.signal.aborted && job.controller.signal.reason?.name==='AbortError';
      job.error=cancelled?'Análise cancelada.':job.controller.signal.aborted?job.controller.signal.reason?.message || error.message:error.message;
      publish(job,cancelled?'cancelled':'error',job.error);
    } finally {try {await reader?.close();} catch {}delete job.reader;job.running=false;}
  }
  function launch(job,detailsOnly=false) {
    job.running=true;
    const timer=setTimeout(()=>job.controller.abort(Error('A análise atingiu quinze minutos. Refine os filtros do link e tente novamente.')),15*60*1000);
    timer.unref();
    job.promise=Promise.resolve().then(()=>collect(job,detailsOnly)).finally(()=>clearTimeout(timer));
  }
  function start(actor,body) {
    const job=create(actor,body);launch(job);
    return summary(job);
  }
  function fromHtml(actor,body) {
    const job=create(actor,{...body,allPages:false,productDetails:body.productDetails===true});
    try {
      const html=required(body.html,'HTML da página',1000000);
      const parsed=parsePage(html,job.url,{defaultCategory:job.category});
      if(parsed.challenge)fail('Este arquivo contém a verificação de acesso, não o catálogo. Salve o HTML depois que os produtos aparecerem.');
      if(!parsed.rows.length)fail('Nenhum produto reconhecido neste HTML. Envie o código da listagem de produtos carregada.');
      addRows(job,parsed);job.pages=1;
      if(parsed.nextPage)job.warnings.push('O arquivo contém apenas esta página. Para percorrer as demais páginas, use Analisar link.');
      if(job.productDetails && job.rows.some(row=>row.price==null || row.stock==null))launch(job,true);
      else {job.complete=true;publish(job,'ready','HTML analisado. Confira os produtos e confirme a importação.');}
      return summary(job,true);
    } catch(error){jobs.delete(job.id);throw error;}
  }
  function status(actor,id,details=false){return summary(jobFor(actor,id),details);}
  function cancel(actor,id) {
    const job=jobFor(actor,id);
    if(job.busy)fail('Aguarde a conclusão do lote de produtos em gravação.',409);
    job.controller.abort();
    publish(job,'cancelled','Análise cancelada.');
    return summary(job);
  }
  async function apply(actor,body,validateAccess=()=>{}) {
    const job=jobFor(actor,body.id);
    if(job.status!=='ready' || !job.complete || job.busy)fail('Conclua a análise antes de importar.',409);
    if(!['create','update'].includes(body.mode))fail('Escolha como tratar os produtos já cadastrados.');
    if(!Array.isArray(body.rows) || !body.rows.length || body.rows.length>MAX_BATCH)fail('Envie de 1 a '+MAX_BATCH+' produtos por lote.');
    const keys=new Set(),rows=new Map(job.rows.map(row=>[row.key,row]));
    const plan=[];
    for(const edit of body.rows) {
      if(!edit || typeof edit!=='object' || keys.has(edit.key))fail('A seleção contém um produto inválido ou repetido.');
      keys.add(edit.key);
      const row=rows.get(edit.key);
      if(!row)fail('Um produto da seleção não pertence a esta análise.');
      if(job.applied.has(row.key)){plan.push({row,skip:true});continue;}
      const old=existing(row);
      if(old && body.mode==='create'){plan.push({row,skip:true});continue;}
      if(fingerprint(old)!==row.baseline)fail(row.name+': o cadastro ou estoque mudou desde a análise. Analise novamente antes de atualizar.',409);
      plan.push({row,old,product:validateRow(row,edit,job.category)});
    }
    job.busy=true;
    const imageWarnings=[];
    try {
      if(body.images===true) {
        let cursor=0,totalBytes=0;
        await Promise.all(Array.from({length:Math.min(4,plan.length)},async()=>{
          while(cursor<plan.length) {
            const item=plan[cursor++];
            if(item.skip || !item.row.image)continue;
            current(job);job.controller.signal.throwIfAborted();
            try {
              const image=await imageLoader(item.row.image,{signal:job.controller.signal});
              if(typeof image!=='string' || image.length>1500000 || !/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(image))throw Error('Imagem inválida.');
              if(totalBytes+image.length>20*1024*1024)throw Error('Limite de fotos do lote atingido.');
              totalBytes+=image.length;item.image=image;
            } catch {imageWarnings.push({key:item.row.key,message:'A foto não pôde ser copiada; o produto foi importado sem alterar a foto existente.'});}
          }
        }));
      }
      actor=current(job);
      validateAccess(actor);
      job.controller.signal.throwIfAborted();
      const result=tx(()=>{
        let created=0,updated=0,skipped=0;
        const appliedKeys=[];
        for(const item of plan) {
          const {row}=item;
          if(item.skip){skipped++;appliedKeys.push(row.key);continue;}
          const old=existing(row);
          if(fingerprint(old)!==row.baseline)fail(row.name+': o estoque ou cadastro mudou. Nenhum produto deste lote foi gravado. Analise novamente.',409);
          if(old && item.product.stock<old.reserved)fail(row.name+': o estoque informado é inferior às reservas em comandas.',409);
          const product={...item.product,code:old?.code || row.code,cost:old?.cost ?? null,minimum:old?.minimum ?? 0,
            barcode:old?.barcode ?? null,active:old?!!old.active:true,reason:'Importação do site confirmada pelo administrador'};
          if(item.image)product.image=item.image;
          for(const field of ['game','collection','collector_number','language','condition','rarity','foil']) {
            if(row[field]!=null)product[field]=row[field];
          }
          const saved=ops.saveProduct(actor,product,old?.id);
          if(old && old.stock!==product.stock)ops.stockMove(actor,saved,product.stock-old.stock,'Importação do site confirmada','site_import');
          run(`INSERT INTO web_product_sources(source_key,product_id,source_url,imported_at) VALUES(?,?,?,?)
            ON CONFLICT(source_key) DO UPDATE SET product_id=excluded.product_id,source_url=excluded.source_url,imported_at=excluded.imported_at`,row.key,saved.id,row.url,now());
          if(old)updated++;else created++;
          appliedKeys.push(row.key);
        }
        audit(actor,'produto.importacao_site','produto',null,null,{url:job.url,created,updated,skipped,codes:plan.filter(item=>!item.skip).map(item=>item.old?.code || item.row.code)},'Importação revisada e confirmada');
        return {created,updated,skipped,appliedKeys,imageWarnings};
      });
      for(const key of result.appliedKeys)job.applied.add(key);
      job.created+=result.created;job.updated+=result.updated;job.skipped+=result.skipped;
      return result;
    } finally {job.busy=false;notify(job.owner,job.id);}
  }
  async function close() {
    for(const job of jobs.values())job.controller.abort();
    await Promise.allSettled([...jobs.values()].map(job=>job.promise || Promise.resolve()));
  }
  return {start,fromHtml,status,cancel,apply,close};
}
module.exports={createController,validateRow,fingerprint,MAX_BATCH};
