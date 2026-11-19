const {get,all,run,tx,integer,required,record,randomUUID,allow,audit,fail}=require('./db');
const ops=require('./operations');

function manualScan(actor,body) {
  allow(actor,'operate');
  allow(actor,'scan_number');
  return tx(()=>{
    const number=integer(body.number,'Número do cartão',1,999999);
    const reason=required(body.reason,'Motivo da abertura excepcional',400,3);
    const card=record(get('SELECT id FROM cards WHERE number=? AND active=1 AND blocked=0',number),'Cartão disponível');
    ops.grantCard(actor.session_id,card.id);
    audit(actor,'cartao.acesso_numero','cartao',card.id,null,{number},reason);
    return ops.cardDetail(actor,card.id);
  });
}
function cardSecurity(actor,id,body,replace) {
  allow(actor,'cards');
  return tx(()=>{
    const card=record(get('SELECT id,number,active,blocked FROM cards WHERE id=?',id),'Cartão');
    const reason=required(body.reason,'Motivo',400,3);
    if (replace) run('UPDATE cards SET token=?,active=1,blocked=0 WHERE id=?',randomUUID(),id);
    else run('UPDATE cards SET blocked=1 WHERE id=?',id);
    run('DELETE FROM scan_grants WHERE card_id=?',id);
    audit(actor,replace?'cartao.qr_substituido':'cartao.bloqueado','cartao',id,card,{active:replace?1:card.active,blocked:!replace},reason);
    return {id,blocked:!replace};
  });
}
function reconcile(actor,body) {
  allow(actor,'reconcile');
  return tx(()=>{
    const tables={payment:'payments',ledger:'ledger',reversal:'payment_reversals'};
    if (!Object.hasOwn(tables,body.entity) || typeof body.reviewed!=='boolean') fail('Registro inválido.');
    const id=integer(body.id,'Registro',1,Number.MAX_SAFE_INTEGER);
    const item=record(get(`SELECT * FROM ${tables[body.entity]} WHERE id=?`,id),'Recebimento');
    if (body.entity==='payment' && !item.confirmed_at || body.entity==='ledger' && (item.source!=='funded' || !['deposit','deposit_reversal'].includes(item.kind))) fail('Selecione um recebimento efetivo.');
    const reason=required(body.reason,'Referência ou motivo da conferência',400,3);
    const previous=get('SELECT reviewed FROM reconciliations WHERE entity=? AND entity_id=? ORDER BY id DESC LIMIT 1',body.entity,id);
    run('INSERT INTO reconciliations(entity,entity_id,reviewed,reason,user_id,user_name,created_at) VALUES(?,?,?,?,?,?,?)',
      body.entity,id,Number(body.reviewed),reason,actor.id,actor.name,new Date().toISOString());
    audit(actor,'recebimento.conferido',body.entity,id,previous,{reviewed:body.reviewed},reason);
    return {id,reviewed:body.reviewed};
  });
}
module.exports={manualScan,cardSecurity,reconcile};
