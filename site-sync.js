const {all,get,run,tx,idOf,now,fail,required,integer,audit}=require('./db');
const ops=require('./operations');
const {storeUrl}=require('./site-catalog');
const {existing}=require('./site-import');
const {downloadImage}=require('./site-browser');

function admin(actor){if(actor?.role!=='admin')fail('A sincronização do site é exclusiva do administrador.',403);}
const canonical=value=>{const url=storeUrl(value);url.searchParams.delete('page');url.searchParams.sort();return url.href;};
const editable=job=>({name:job.name,url:job.url,category:job.category,interval_minutes:job.interval_minutes,enabled:!!job.enabled,create_new:!!job.create_new});
function createScheduler({importer,notify=()=>{},imageLoader=downloadImage,clock=()=>Date.now(),tickMs=15000}={}) {
  if(!importer?.scan)throw Error('Leitor de catálogo não configurado.');
  let active=null,timer=null,closing=false;
  const interactiveRequests=new Set();
  const wake=()=>{if(timer && !closing)queueMicrotask(()=>tick().catch(error=>console.error('Sincronização do site:',error.message)));};
  const stamp=()=>new Date(clock()).toISOString();
  const owner=id=>get("SELECT * FROM users WHERE id=? AND active=1 AND role='admin'",id);
  const jobById=id=>{const job=get('SELECT * FROM site_sync_jobs WHERE id=? AND deleted=0',integer(id,'Link',1));if(!job)fail('Link de sincronização não encontrado.',404);return job;};
  function list(actor) {
    admin(actor);
    const jobs=all('SELECT * FROM site_sync_jobs WHERE deleted=0 ORDER BY id DESC').map(job=>({...job,enabled:!!job.enabled,create_new:!!job.create_new}));
    const runs=all(`SELECT r.*,j.name job_name FROM site_sync_runs r JOIN site_sync_jobs j ON j.id=r.job_id WHERE j.deleted=0 ORDER BY r.id DESC LIMIT 20`)
      .map(({report,...row})=>({...row,report:JSON.parse(report)}));
    return {jobs,runs,running:active?.id ?? null};
  }
  function save(actor,body) {
    admin(actor);
    const old=body.id?jobById(body.id):null;
    if(!old && get('SELECT COUNT(*) n FROM site_sync_jobs WHERE deleted=0').n>=20)fail('Cadastre no máximo 20 links de sincronização.');
    let url;try{url=canonical(body.url ?? old?.url);}catch(error){fail(error.message);}
    if(get('SELECT id FROM site_sync_jobs WHERE url=? AND deleted=0 AND id<>?',url,old?.id || 0))fail('Este link já está cadastrado para sincronização.',409);
    const values={name:required(body.name ?? old?.name,'Nome do link',100),url,category:required(body.category ?? old?.category ?? 'Produtos Liga','Categoria',80),
      interval_minutes:integer(body.interval_minutes ?? old?.interval_minutes ?? 30,'Intervalo em minutos',5,1440),
      enabled:body.enabled===undefined?!!old?.enabled:body.enabled===true,create_new:body.create_new===undefined?old?!!old.create_new:true:body.create_new===true};
    if(old && active?.id===old.id)active.controller.abort(Error('A configuração do link foi alterada.'));
    const id=tx(()=>{
      let id=old?.id;
      if(old) {
        run(`UPDATE site_sync_jobs SET name=?,url=?,category=?,interval_minutes=?,enabled=?,create_new=?,owner_id=?,revision=revision+1,
          updated_at=?,next_run=?,status=?,message=? WHERE id=?`,values.name,url,values.category,values.interval_minutes,Number(values.enabled),Number(values.create_new),actor.id,
          stamp(),values.enabled?stamp():null,values.enabled?'queued':'paused',values.enabled?'Aguardando a próxima consulta.':'Sincronização pausada.',id);
        if(old.url!==url)run('DELETE FROM site_sync_members WHERE job_id=?',id);
      } else id=idOf(run(`INSERT INTO site_sync_jobs(name,url,category,interval_minutes,enabled,create_new,owner_id,created_at,updated_at,next_run,status,message)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,values.name,url,values.category,values.interval_minutes,Number(values.enabled),Number(values.create_new),actor.id,stamp(),stamp(),
        values.enabled?stamp():null,values.enabled?'queued':'paused',values.enabled?'Aguardando a primeira consulta.':'Sincronização pausada.'));
      audit(actor,old?'site_sync.alterado':'site_sync.criado','site_sync',id,old && editable(old),values,'Configuração da sincronização automática do estoque');
      return id;
    });
    interactiveRequests.delete(id);notify(false);wake();return {...jobById(id),enabled:values.enabled,create_new:values.create_new};
  }
  function remove(actor,id) {
    admin(actor);const job=jobById(id);
    if(active?.id===id)active.controller.abort(Error('O link foi removido.'));
    run("UPDATE site_sync_jobs SET deleted=1,enabled=0,revision=revision+1,status='paused',next_run=NULL,updated_at=? WHERE id=?",stamp(),id);
    interactiveRequests.delete(id);audit(actor,'site_sync.removido','site_sync',id,editable(job),null,'Remoção do agendamento; produtos preservados');notify(false);
    return {removed:true};
  }
  function request(actor,id,{interactive=false}={}) {
    admin(actor);const job=jobById(id);
    if(!job.enabled)fail('Ative o link antes de solicitar uma consulta.',409);
    if(active?.id===id)fail('Este link já está sendo consultado.',409);
    if(interactive===true)interactiveRequests.add(id);
    run("UPDATE site_sync_jobs SET next_run=?,status='queued',message='Consulta solicitada; aguardando o leitor disponível.' WHERE id=?",stamp(),id);
    audit(actor,'site_sync.solicitado','site_sync',id,null,{interactive:interactive===true},'Consulta solicitada pelo administrador');notify(false);
    wake();return {queued:true};
  }
  function tracked(job) {
    return all(`SELECT s.source_key key,s.source_url url,p.code,p.name,p.category,p.language,p.condition,p.collection,p.foil
      FROM site_sync_members m JOIN web_product_sources s ON s.source_key=m.source_key JOIN products p ON p.id=s.product_id WHERE m.job_id=?`,job.id)
      .map(row=>({...row,foil:row.foil==null?null:!!row.foil}));
  }
  function assertCurrent(job,signal) {
    signal.throwIfAborted();
    const current=get('SELECT * FROM site_sync_jobs WHERE id=?',job.id);
    if(!current || !current.enabled || current.deleted || current.revision!==job.revision)throw Error('O agendamento foi alterado ou pausado.');
    const actor=owner(job.owner_id);if(!actor)throw Error('O administrador responsável está inativo ou perdeu o perfil de administrador.');
    return actor;
  }
  async function apply(job,snapshot,versions,signal) {
    const plans=[];const result={total:snapshot.rows.length,created:0,updated:0,baselines:0,skipped:0,conflicts:0,issues:[],changes:[]};
    const issue=(row,message)=>{result.conflicts++;if(result.issues.length<100)result.issues.push({name:String(row.name).slice(0,120),message:String(message).slice(0,800)});};
    for(const row of snapshot.rows) {
      assertCurrent(job,signal);
      const product=existing(row);
      let image;
      if(!product && job.create_new && row.price!=null && row.stock!=null && row.image) {
        try {image=await imageLoader(row.image,{signal});}catch {if(result.issues.length<100)result.issues.push({name:row.name,message:'Foto indisponível; os dados do produto serão mantidos.'});}
      }
      plans.push({row,image});
    }
    const actor=assertCurrent(job,signal);
    tx(()=>{
      for(const {row,image} of plans) {
        assertCurrent(job,signal);run('SAVEPOINT site_sync_item');
        try {
          let product=existing(row);
          const source=get('SELECT * FROM web_product_sources WHERE source_key=?',row.key);
          if((source?.observation_version ?? 0)!==(versions.get(row.key) ?? 0))throw Error('A origem foi atualizada durante a leitura. Aguarde a próxima consulta.');
          if(!product && !job.create_new){result.skipped++;run('RELEASE site_sync_item');continue;}
          if(row.stock==null)throw Error(row.warnings?.at(-1) || 'O site não informou um estoque inequívoco; o saldo do PDV foi preservado.');
          integer(row.stock,'Estoque do site',0,1000000);
          let created=false,updated=false,baseline=false,change;
          if(!product) {
            const body={code:row.code,name:row.name,category:row.category || job.category,price:integer(row.price,'Preço do produto novo'),stock:row.stock,cost:null,minimum:0,active:true};
            if(image)body.image=image;
            for(const field of ['game','collection','collector_number','language','condition','rarity','foil'])if(row[field]!=null)body[field]=row[field];
            product=ops.saveProduct(actor,body);created=true;
            change={name:product.name,kind:'created',before:0,after:product.stock,site_before:null,site_after:row.stock};
          } else {
            product=get(`${ops.catalog} WHERE p.id=?`,product.id);
            if(!product.active)throw Error('Produto inativo no PDV; a rotina não altera nem reativa esse cadastro.');
            if(source?.last_stock==null)baseline=true;
            else {
              const delta=row.stock-source.last_stock,target=product.stock+delta;
              if(target<0)throw Error('A mudança do site deixaria o estoque negativo. Confira as vendas e o saldo físico.');
              if(target<product.reserved)throw Error('A mudança do site deixaria o estoque abaixo das reservas em comandas.');
              if(delta>0)ops.assertSaleable(product);
              if(delta) {
                ops.stockMove(actor,product,delta,'Sincronização automática do site: '+job.name,'site_sync',null,{reference:job.id});updated=true;
                change={name:product.name,kind:'updated',before:product.stock,after:target,site_before:source.last_stock,site_after:row.stock};
              }
            }
          }
          run(`INSERT INTO web_product_sources(source_key,product_id,source_url,imported_at,last_stock,observed_at,observation_version) VALUES(?,?,?,?,?,?,1)
            ON CONFLICT(source_key) DO UPDATE SET last_stock=excluded.last_stock,observed_at=excluded.observed_at,observation_version=web_product_sources.observation_version+1`,
            row.key,product.id,row.url,now(),row.stock,stamp());
          run('INSERT OR IGNORE INTO site_sync_members(job_id,source_key) VALUES(?,?)',job.id,row.key);
          run('RELEASE site_sync_item');
          if(created)result.created++;else if(updated)result.updated++;else if(baseline)result.baselines++;else result.skipped++;
          if(change && result.changes.length<100)result.changes.push(change);
        } catch(error) {run('ROLLBACK TO site_sync_item');run('RELEASE site_sync_item');issue(row,error.message);}
      }
      audit(actor,'site_sync.executado','site_sync',job.id,null,{total:result.total,created:result.created,updated:result.updated,baselines:result.baselines,skipped:result.skipped,conflicts:result.conflicts},'Sincronização por diferenças do site; movimentos locais preservados');
    });
    return {...result,warnings:snapshot.warnings};
  }
  async function execute(job,interactive) {
    const controller=new AbortController();
    const execution={id:job.id,controller,promise:null};active=execution;
    const deadline=setTimeout(()=>controller.abort(Error('A sincronização atingiu o limite de vinte minutos. Refine o link.')),20*60*1000);deadline.unref();
    const started=stamp(),runId=idOf(run("INSERT INTO site_sync_runs(job_id,started_at,status) VALUES(?,?,'running')",job.id,started));
    run("UPDATE site_sync_jobs SET status='running',last_started=?,message='Preparando a consulta automática.' WHERE id=?",started,job.id);notify(false);
    const work=async()=>{
      let result,status,message;
      try {
        const actor=assertCurrent(job,controller.signal);
        const versions=new Map(all('SELECT source_key,observation_version FROM web_product_sources').map(row=>[row.source_key,row.observation_version]));
        const snapshot=await importer.scan(actor,{url:job.url,category:job.category},{signal:controller.signal,trackedRows:tracked(job),interactive,
          onProgress:progress=>{
            const current=get('SELECT revision,enabled FROM site_sync_jobs WHERE id=?',job.id);
            if(current?.revision===job.revision && current.enabled){run('UPDATE site_sync_jobs SET message=? WHERE id=?',progress.message,job.id);notify(false);}
          }});
        if(snapshot.status!=='ready' || !snapshot.complete)throw Error('A leitura do site está incompleta. O estoque foi preservado.');
        result=await apply(job,snapshot,versions,controller.signal);
        status=result.conflicts || result.warnings?.length?'warning':'success';
        message=`${result.created} novo(s), ${result.updated} estoque(s) atualizado(s), ${result.baselines} base(s) registrada(s), ${result.conflicts} pendência(s).`;
      } catch(error) {
        status=closing?'interrupted':controller.signal.aborted?'cancelled':error.status===409?'deferred':'error';message=error.message;
      } finally {clearTimeout(deadline);}
      const finished=stamp();
      tx(()=>{
        run(`UPDATE site_sync_runs SET finished_at=?,status=?,message=?,total=?,created=?,updated=?,baselines=?,skipped=?,conflicts=?,report=? WHERE id=?`,
          finished,status,message,result?.total || 0,result?.created || 0,result?.updated || 0,result?.baselines || 0,result?.skipped || 0,result?.conflicts || 0,JSON.stringify(result || {}),runId);
        const current=get('SELECT * FROM site_sync_jobs WHERE id=?',job.id);
        if(current && current.revision===job.revision && current.enabled && !current.deleted) {
          const wait=status==='deferred'?60000:job.interval_minutes*60000;
          run('UPDATE site_sync_jobs SET status=?,message=?,last_finished=?,next_run=? WHERE id=?',status,message,finished,new Date(clock()+wait).toISOString(),job.id);
        }
      });
      if(!result)audit(owner(job.owner_id),'site_sync.'+status,'site_sync',job.id,null,{run:runId},message);
      notify(!!(result?.created || result?.updated));
      return {status,message,...result};
    };
    execution.promise=work().finally(()=>{if(active===execution)active=null;});
    return execution.promise;
  }
  async function tick() {
    if(closing || active)return false;
    const job=get('SELECT * FROM site_sync_jobs WHERE enabled=1 AND deleted=0 AND next_run<=? ORDER BY next_run,id LIMIT 1',stamp());
    if(!job)return false;
    const interactive=interactiveRequests.delete(job.id);
    return execute(job,interactive);
  }
  function start() {
    if(timer || closing)return;
    tx(()=>{
      run("UPDATE site_sync_runs SET status='interrupted',finished_at=?,message='Servidor reiniciado durante a consulta; uma nova leitura será feita.' WHERE status='running'",stamp());
      run("UPDATE site_sync_jobs SET status='interrupted',next_run=?,message='Retomando após reinício do servidor.' WHERE status='running' AND enabled=1 AND deleted=0",stamp());
    });
    timer=setInterval(()=>{tick().catch(error=>console.error('Sincronização do site:',error.message));},tickMs);timer.unref();
    tick().catch(error=>console.error('Sincronização do site:',error.message));
  }
  async function close() {
    closing=true;clearInterval(timer);timer=null;
    active?.controller.abort(Error('Servidor encerrado durante a consulta.'));await active?.promise;
  }
  return {list,save,remove,request,tick,start,close};
}
module.exports={createScheduler};
