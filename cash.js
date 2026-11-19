const {db,Problem,get,all,run,idOf,tx,record,integer,required,now,fail,can,allow,audit,checkPassword}=require('./db');

const attempts=new Map();
function authorize(actor,body,permission,entity,id=null,force=false) {
  if (!force && can(actor,permission)) return actor;
  const credentials=body.approval;
  if (!credentials?.username || !credentials?.password) fail('Esta ação precisa de aprovação do administrador.',403);
  const moment=Date.now();
  const previous=attempts.get(actor.id);
  const count=(previous?.until>moment?previous.count:0)+1;
  if (count>6) fail('Muitas tentativas de aprovação. Aguarde alguns minutos.',429);
  attempts.set(actor.id,{count,until:previous?.until>moment?previous.until:moment+300000});
  const admin=get("SELECT * FROM users WHERE username=? AND active=1 AND role='admin'",String(credentials.username).trim().toLowerCase().slice(0,40));
  const valid=checkPassword(credentials.password,admin?.password);
  if (!admin || !valid) {
    const save=()=>audit(actor,'aprovacao.recusada',entity,id,null,{permission});
    const error=new Problem(403,'Usuário ou senha do administrador inválidos.');
    if (db.isTransaction) error.afterRollback=save;
    else save();
    throw error;
  }
  attempts.delete(actor.id);
  return {...actor,approval:{id:admin.id,name:admin.name,permission}};
}
function approveLog(actor,entity,id,reason) {
  if (actor.approval) audit(actor,'aprovacao.concedida',entity,id,null,{permission:actor.approval.permission},reason);
}
function register(actor,body) {
  allow(actor,'cash_manage');
  const name=required(body.name,'Nome do caixa',60,2);
  return tx(()=>{
    if (get('SELECT id FROM registers WHERE name=?',name)) fail('Já existe um caixa com este nome.',409);
    const id=idOf(run('INSERT INTO registers(name) VALUES(?)',name));
    audit(actor,'caixa.criado','caixa',id,null,{name});
    return {id,name};
  });
}
function currentShift(actor,mandatory=true) {
  const shift=get(`SELECT s.*,r.name register_name FROM shifts s JOIN registers r ON r.id=s.register_id
    WHERE s.opened_by=? AND s.closed_at IS NULL`,actor.id);
  if (!shift && mandatory) fail('Abra seu turno em Caixa antes de registrar recebimentos ou devoluções.',409);
  return shift;
}
function shiftSummary(shift) {
  const receipts=all(`SELECT method,SUM(amount) amount,SUM(COALESCE(received,0)) received,SUM(change) change
    FROM payments WHERE shift_id=? AND (state='confirmed' OR state='void' AND confirmed_at IS NOT NULL) GROUP BY method`,shift.id);
  const loads=all(`SELECT origin method,SUM(CASE WHEN kind='deposit' THEN amount ELSE 0 END) added,
    SUM(CASE WHEN kind='deposit_reversal' THEN -amount ELSE 0 END) reversed FROM ledger
    WHERE shift_id=? AND source='funded' AND kind IN ('deposit','deposit_reversal') GROUP BY origin`,shift.id);
  const refunds=all(`SELECT p.method,SUM(r.amount) amount FROM payment_reversals r JOIN payments p ON p.id=r.payment_id
    WHERE r.shift_id=? GROUP BY p.method`,shift.id);
  const movements=all('SELECT * FROM cash_moves WHERE shift_id=? ORDER BY id',shift.id);
  const cash=receipts.find(row=>row.method==='cash');
  const cashLoads=loads.find(row=>row.method==='cash');
  const cashRefunds=refunds.find(row=>row.method==='cash')?.amount || 0;
  const expected=shift.opening+(cash?.received || 0)-(cash?.change || 0)+(cashLoads?.added || 0)-(cashLoads?.reversed || 0)
    -cashRefunds+movements.reduce((sum,row)=>sum+row.amount,0);
  return {receipts,loads,refunds,movements,expected};
}
function shiftDetails(actor,id) {
  allow(actor,'cashier');
  const shift=record(get('SELECT s.*,r.name register_name FROM shifts s JOIN registers r ON r.id=s.register_id WHERE s.id=?',id),'Turno');
  if (shift.opened_by!==actor.id) allow(actor,'cash_manage');
  const {closing_summary,...data}=shift;
  return {...data,summary:shiftSummary(shift),atClosing:closing_summary && JSON.parse(closing_summary)};
}
function cashOverview(actor) {
  allow(actor,'cashier');
  const registers=all(`SELECT r.*,s.id shift_id,s.opened_name FROM registers r LEFT JOIN shifts s ON s.register_id=r.id AND s.closed_at IS NULL ORDER BY r.name`);
  const history=all(`SELECT s.id,s.opened_at,s.closed_at,s.opened_name,s.expected,s.counted,s.difference,r.name register_name
    FROM shifts s JOIN registers r ON r.id=s.register_id WHERE (?=1 OR s.opened_by=?) ORDER BY s.id DESC LIMIT 150`,Number(can(actor,'cash_manage')),actor.id);
  const shift=currentShift(actor,false);
  return {registers,history,current:shift ? shiftDetails(actor,shift.id) : null};
}
function openShift(actor,body) {
  allow(actor,'cashier');
  return tx(()=>{
    const id=integer(body.register,'Caixa',1,Number.MAX_SAFE_INTEGER);
    record(get('SELECT id FROM registers WHERE id=?',id),'Caixa');
    if (currentShift(actor,false) || get('SELECT id FROM shifts WHERE register_id=? AND closed_at IS NULL',id)) {
      fail('O caixa ou o operador já tem um turno aberto.',409);
    }
    const opening=integer(body.opening,'Fundo inicial');
    const shift=idOf(run('INSERT INTO shifts(register_id,opened_by,opened_name,opened_at,opening) VALUES(?,?,?,?,?)',id,actor.id,actor.name,now(),opening));
    audit(actor,'turno.aberto','turno',shift,null,{register_id:id,opening});
    return shiftDetails(actor,shift);
  });
}
function closeShift(actor,id,body) {
  return tx(()=>{
    const shift=shiftDetails(actor,id);
    if (shift.closed_at) fail('Este turno já foi fechado.',409);
    const counted=integer(body.counted,'Valor contado',0,1_000_000_000_000);
    const summary=shift.summary;
    const reason=summary.expected!==counted ? required(body.reason,'Motivo da diferença',400,3) : null;
    run(`UPDATE shifts SET closed_by=?,closed_name=?,closed_at=?,counted=?,expected=?,difference=?,closing_summary=?,reason=? WHERE id=?`,
      actor.id,actor.name,now(),counted,summary.expected,counted-summary.expected,JSON.stringify(summary),reason,id);
    audit(actor,'turno.fechado','turno',id,{opening:shift.opening},{expected:summary.expected,counted,difference:counted-summary.expected},reason);
    return shiftDetails(actor,id);
  });
}
function cashMove(actor,id,body) {
  return tx(()=>{
    const shift=shiftDetails(actor,id);
    const kind=body.kind;
    if (!['supply','withdrawal','adjustment'].includes(kind)) fail('Movimento inválido.');
    if (kind==='adjustment') allow(actor,'cash_manage');
    if (Boolean(shift.closed_at)!==(kind==='adjustment')) fail('Use ajuste para corrigir um turno já fechado.',409);
    const amount=integer(body.amount,'Valor',kind==='adjustment'?-100_000_000:1);
    if (!amount) fail('Informe um valor diferente de zero.');
    const signed=kind==='withdrawal'?-amount:amount;
    if (kind==='withdrawal' && shift.summary.expected<amount) fail('A sangria excede o dinheiro esperado no caixa.',409);
    const reason=required(body.reason,'Motivo',400,3);
    const move=idOf(run('INSERT INTO cash_moves(shift_id,kind,amount,reason,user_id,user_name,created_at) VALUES(?,?,?,?,?,?,?)',
      id,kind,signed,reason,actor.id,actor.name,now()));
    audit(actor,`caixa.${kind}`,'movimento_caixa',move,{expected:shift.summary.expected},{shift_id:id,amount:signed,expected:shift.summary.expected+signed},reason);
    return get('SELECT * FROM cash_moves WHERE id=?',move);
  });
}

module.exports={authorize,approveLog,register,currentShift,shiftSummary,shiftDetails,cashOverview,openShift,closeShift,cashMove};
