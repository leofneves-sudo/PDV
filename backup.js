const {DatabaseSync}=require('node:sqlite');
const {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,copyFileSync,constants}=require('node:fs');
const {resolve,dirname,basename,join}=require('node:path');
const {randomUUID}=require('node:crypto');

function verify(path) {
  const db=new DatabaseSync(path,{readOnly:true});
  try {
    const integrity=db.prepare('PRAGMA integrity_check').all();
    if (integrity.length!==1 || integrity[0].integrity_check!=='ok' || db.prepare('PRAGMA foreign_key_check').get()) {
      throw Error('O banco não passou pela verificação de integridade.');
    }
  } finally {db.close();}
}
function snapshot(db,directory,label='pdv') {
  mkdirSync(directory,{recursive:true,mode:0o700});
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const file=join(directory,`${label}-${stamp}-${randomUUID().slice(0,6)}.sqlite`);
  const temporary=file+'.tmp';
  db.prepare('VACUUM INTO ?').run(temporary);
  verify(temporary);
  renameSync(temporary,file);
  return file;
}
function controller(db,file) {
  if (file===':memory:') return {status:()=>({interval:0}),start:()=>{},run:()=>{throw Error('Banco em memória.');}};
  const directory=resolve(process.env.PDV_BACKUP_DIR || join(dirname(file),'backups'));
  const external=process.env.PDV_BACKUP_EXTERNAL_DIR ? resolve(process.env.PDV_BACKUP_EXTERNAL_DIR) : null;
  const interval=Number(process.env.PDV_BACKUP_MINUTES ?? 60);
  if (!Number.isInteger(interval) || interval<0 || interval>10080) throw Error('PDV_BACKUP_MINUTES deve estar entre 0 e 10080.');
  if (external===directory) throw Error('O destino externo deve ser diferente da pasta local.');
  const manifest=join(directory,'status.json');
  let state={};
  if (existsSync(manifest)) {
    try {state=JSON.parse(readFileSync(manifest,'utf8'));} catch {}
  }
  const status=()=>({...state,interval,externalConfigured:!!external});
  function run() {
    const at=new Date().toISOString();
    state={...state,lastAttempt:at,error:null};
    try {
      const path=snapshot(db,directory);
      state={...state,lastLocal:at,file:basename(path)};
      if (external) {
        // O destino já deve existir. Assim, um volume desmontado não vira pasta local.
        if (!existsSync(external)) throw Error('Destino externo indisponível.');
        const target=join(external,basename(path));
        copyFileSync(path,target+'.tmp',constants.COPYFILE_EXCL);
        verify(target+'.tmp');
        renameSync(target+'.tmp',target);
        state.lastExternal=at;
      }
      state.lastSuccessful=at;
    } catch (error) {
      state.error=error.message;
    }
    mkdirSync(directory,{recursive:true,mode:0o700});
    writeFileSync(manifest+'.tmp',JSON.stringify(state,null,2));
    renameSync(manifest+'.tmp',manifest);
    return status();
  }
  return {status,run,start(onAttempt){
    if (!interval) return;
    const delay=interval*60000;
    const tick=()=>{
      try {
        const elapsed=Date.now()-(Date.parse(state.lastAttempt) || 0);
        if (elapsed>=delay) {
          const result=run();
          onAttempt?.(result);
        }
      } catch (error) {
        state.error=error.message;
        console.error('Backup do PDV:',error.message);
      }
      const next=delay-(Date.now()-(Date.parse(state.lastAttempt) || Date.now()));
      setTimeout(tick,Math.max(1000,Math.min(delay,next))).unref();
    };
    setImmediate(tick);
  }};
}
module.exports={snapshot,verify,controller};
