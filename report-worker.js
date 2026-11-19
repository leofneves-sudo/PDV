const {parentPort}=require('node:worker_threads');
const {db}=require('./db');
const reports=require('./reports');
const management=require('./management');

function execute(path,actor,rawQuery) {
  const query=new URLSearchParams(rawQuery);
  db.exec('BEGIN');
  try {
    let result;
    switch (path) {
      case 'history': result=reports.history(actor,query); break;
      case 'filters': result=reports.filters(actor); break;
      case 'dashboard': result=reports.dashboard(actor,query); break;
      case 'management': result=management.management(actor,query); break;
      case 'dashboard.csv': result=reports.dashboardCsv(reports.dashboard(actor,query)); break;
      case 'history.csv': result=reports.historyCsv(actor,query); break;
      case 'management.csv': result=management.managementCsv(management.management(actor,query,true)); break;
      default: throw Error('Consulta de relatório desconhecida.');
    }
    db.exec('COMMIT');
    return path.endsWith('.csv')?result:JSON.stringify(result);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
if (parentPort) {
  parentPort.on('message',({path,actor,query})=>{
    try {
      parentPort.postMessage({data:execute(path,actor,query)});
    } catch (error) {
      if (!error.status) console.error(error);
      parentPort.postMessage({status:error.status || 500,message:error.status?error.message:'Falha ao consultar o relatório.'});
    }
  });
}
module.exports={execute};
