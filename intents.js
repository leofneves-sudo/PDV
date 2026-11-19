const {get,run,tx,fail,sha,now}=require('./db');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value==='object') {
    return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  }
  return value;
}
function perform(actor,operation,body,action) {
  const {request_id:token,approval,...intent}=body;
  if (typeof token!=='string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(token)) fail('Informe uma chave de operação válida.');
  const fingerprint=sha(JSON.stringify(canonical(intent)));
  return tx(()=>{
    const saved=get('SELECT * FROM operation_intents WHERE token=?',token);
    if (saved) {
      if (saved.user_id!==actor.id || saved.operation!==operation || saved.fingerprint!==fingerprint) {
        fail('Esta chave já foi usada com outra operação ou conteúdo.',409);
      }
      return {value:JSON.parse(saved.response),changed:false};
    }
    const value=action();
    run('INSERT INTO operation_intents(token,user_id,operation,fingerprint,response,created_at) VALUES(?,?,?,?,?,?)',
      token,actor.id,operation,fingerprint,JSON.stringify(value),now());
    return {value,changed:true};
  });
}
module.exports={perform};
