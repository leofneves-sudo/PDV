const {Worker}=require('node:worker_threads');
const {join,resolve}=require('node:path');
const {Problem}=require('./db');
const paths=new Set(['history','filters','dashboard','management','dashboard.csv','history.csv','management.csv','stock-insights','stock-insights.csv']);

function createPool(file) {
  const workers=new Set(), queue=[];
  let closed=false;
  const reject=(job,message)=>job?.reject(new Problem(503,message));
  function drain() {
    for (const slot of workers) {
      if (slot.job || !queue.length) continue;
      slot.job=queue.shift();
      slot.worker.postMessage(slot.job.request);
    }
  }
  function spawn() {
    const worker=new Worker(join(__dirname,'report-worker.js'),{
      env:{...process.env,PDV_DB:resolve(file),PDV_REPORT_READER:'1'}
    });
    const slot={worker,job:null};
    workers.add(slot);
    worker.on('message',response=>{
      const job=slot.job;
      slot.job=null;
      if (response.status) job?.reject(new Problem(response.status,response.message));
      else job?.resolve(response.data);
      drain();
    });
    worker.on('error',error=>console.error('Processador de relatórios:',error.message));
    worker.on('exit',()=>{
      reject(slot.job,'A consulta do relatório foi interrompida. Tente novamente.');
      workers.delete(slot);
      if (!workers.size) {
        for (const job of queue.splice(0)) reject(job,'Relatórios indisponíveis momentaneamente. Tente novamente.');
      }
    });
  }
  function query(path,actor,query) {
    const {id,name,role,permissions,session_id}=actor;
    const request={path,actor:{id,name,role,permissions,session_id},query:query.toString()};
    if (closed) return Promise.reject(new Problem(503,'Servidor encerrando.'));
    if (file===':memory:') return Promise.resolve().then(()=>require('./report-worker').execute(path,actor,request.query));
    if (queue.length>=24) return Promise.reject(new Problem(503,'Há muitos relatórios em consulta. Tente novamente.'));
    while (workers.size<2) spawn();
    return new Promise((resolve,reject)=>{
      queue.push({request,resolve,reject});
      drain();
    });
  }
  return {query,close(){
    closed=true;
    for (const job of queue.splice(0)) reject(job,'Servidor encerrando.');
    for (const slot of workers) {
      reject(slot.job,'Servidor encerrando.');
      slot.job=null;
      slot.worker.terminate();
    }
  }};
}
module.exports={paths,createPool};
