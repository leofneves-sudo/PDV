const {get,all,run,idOf,tx,integer,required,optional,now,fail,record,allow,audit,methods,sha,can}=require('./db');
const {currentShift,authorize,approveLog}=require('./cash');
const ops=require('./operations');
const {allocate,portion}=require('./amount');

const maxMoney=1_000_000_000_000;
function orderById(id) {
  return record(get(`${ops.orderQuery} WHERE o.id=?`,id),'Atendimento');
}
function request(actor,id,body,action,execute,requiredKey=false) {
  return tx(()=>{
    const key=body.request_id;
    if ((requiredKey || key!==undefined) && (typeof key!=='string' || !/^[a-zA-Z0-9_-]{12,100}$/.test(key))) fail('Identificador de operação inválido.');
    const fingerprint=key ? sha(JSON.stringify([action,body.payments,body.version,body.payment,body.reason,body.items,body.exchange_order])) : null;
    const saved=key && get('SELECT * FROM payment_requests WHERE order_id=? AND token=?',id,key);
    if (saved) {
      if (saved.user_id!==actor.id || saved.action!==action || saved.fingerprint!==fingerprint) fail('Identificador já usado em outra operação.',409);
      const order=orderById(id);
      return order.status==='open' ? ops.cardDetail(actor,order.card_id) : ops.orderDetail(actor,order);
    }
    const value=execute();
    if (key) run('INSERT INTO payment_requests(order_id,token,action,user_id,fingerprint) VALUES(?,?,?,?,?)',id,key,action,actor.id,fingerprint);
    return value;
  });
}
function validateVersion(order,version) {
  if (order.version!==version) fail('A comanda mudou. Confira o estado salvo antes de continuar.',409);
}
function appendPayments(actor,shift,order,list,total) {
  if (!Array.isArray(list) || list.length>20) fail('Informe os pagamentos.');
  const remaining=total-ops.booked(order.id);
  const entries=list.map(entry=>{
    if (!entry || !Object.hasOwn(methods,entry.method)) fail('Forma de pagamento inválida.');
    const amount=integer(entry.amount,'Parcela',1,remaining);
    const received=entry.method==='cash' ? integer(entry.received,'Valor entregue',amount,maxMoney) : null;
    return {method:entry.method,amount,received,change:received===null ? 0 : received-amount,
      payer:optional(entry.payer,'Pessoa',100),state:entry.method==='pix'?'pending':'confirmed'};
  });
  if (entries.reduce((sum,row)=>sum+row.amount,0)>remaining) fail('As parcelas ultrapassam o saldo restante.');
  for (const entry of entries) {
    if (entry.method==='store' && !order.customer_id) fail('Vincule um cliente para usar crédito da loja.');
    const time=now();
    const confirmed=entry.state==='confirmed';
    const id=idOf(run(`INSERT INTO payments(order_id,method,amount,received,change,state,shift_id,received_by,received_name,paid_at,confirmed_at,confirmed_by,payer,original_order_id,confirmed_name)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,order.id,entry.method,entry.amount,entry.received,entry.change,entry.state,shift.id,actor.id,actor.name,time,confirmed?time:null,confirmed?actor.id:null,entry.payer,order.id,confirmed?actor.name:null));
    if (entry.method==='store') ops.ledgerEntry(actor,order.customer_id,-entry.amount,'use','store','Pagamento do atendimento',order.id,null,{payment:id,shift:shift.id});
    audit(actor,'pagamento.registrado','pagamento',id,null,{...entry,order_id:order.id,shift_id:shift.id});
  }
}
function pay(actor,id,body,close=false) {
  allow(actor,'checkout');
  return request(actor,id,body,close?'checkout':'payment',()=>{
    const order=ops.openForEdit(actor,id);
    validateVersion(order,body.version);
    ops.assertOrderSaleable(id);
    const shift=currentShift(actor);
    const {subtotal,units}=ops.totals(id);
    const total=subtotal-order.discount;
    if (!units) fail('Adicione pelo menos um item.');
    const payments=body.payments ?? [];
    if (!close && (!Array.isArray(payments) || !payments.length)) fail('Informe pelo menos uma parcela.');
    appendPayments(actor,shift,order,payments,total);
    if (!close) {
      ops.bump(id);
      return ops.cardDetail(actor,order.card_id);
    }
    if (get("SELECT id FROM payments WHERE order_id=? AND state='pending'",id)) fail('Confirme ou cancele os PIX pendentes antes do fechamento.',409);
    if (ops.booked(id)!==total) fail('O saldo da comanda precisa estar quitado para fechar.',409);
    const products=new Map();
    for (const line of all('SELECT id,product_id,quantity FROM items WHERE order_id=? ORDER BY id',id)) {
      const lines=products.get(line.product_id) || [];
      lines.push(line);
      products.set(line.product_id,lines);
    }
    for (const [product,lines] of products) {
      const quantities=lines.map(line=>line.quantity);
      const count=quantities.reduce((sum,n)=>sum+n,0);
      const {cost}=ops.stockMove(actor,{id:product},-count,'Venda concluída','sale',id);
      if (cost!=null) {
        const costs=allocate(cost,quantities);
        lines.forEach((line,index)=>run('UPDATE items SET cost_total=? WHERE id=?',costs[index],line.id));
      }
    }
    run(`UPDATE orders SET status='closed',subtotal=?,total=?,ended_at=?,ended_by=?,ended_name=?,ended_session=?,closed_shift_id=?,version=version+1 WHERE id=?`,
      subtotal,total,now(),actor.id,actor.name,actor.session_id,shift.id,id);
    run('DELETE FROM scan_grants WHERE card_id=?',order.card_id);
    audit(actor,'comanda.fechada','comanda',id,{status:'open'},{status:'closed',total,subtotal,discount:order.discount,shift_id:shift.id});
    return ops.orderDetail(actor,orderById(id));
  },!close);
}
function originalPayment(id,orderId) {
  return record(get('SELECT * FROM payments WHERE id=? AND order_id=?',id,orderId),'Parcela');
}
function confirmPix(actor,id,body) {
  allow(actor,'checkout');
  actor=authorize(actor,body,'payment_confirm','comanda',id);
  return request(actor,id,body,'pix',()=>{
    const order=ops.openForEdit(actor,id);
    const payment=originalPayment(body.payment,id);
    if (payment.state==='confirmed' && payment.method==='pix') return ops.cardDetail(actor,order.card_id);
    if (payment.method!=='pix' || payment.state!=='pending') fail('Somente PIX pendente pode ser confirmado.',409);
    ops.assertOrderSaleable(id);
    const shift=currentShift(actor);
    const reason=required(body.reason,'Referência ou motivo da confirmação',400,3);
    run("UPDATE payments SET state='confirmed',shift_id=?,confirmed_at=?,confirmed_by=?,confirmed_name=? WHERE id=?",shift.id,now(),actor.id,actor.name,payment.id);
    approveLog(actor,'pagamento',payment.id,reason);
    audit(actor,'pix.confirmado_manualmente','pagamento',payment.id,{state:'pending',shift_id:payment.shift_id},{state:'confirmed',shift_id:shift.id},reason);
    ops.bump(id);
    return ops.cardDetail(actor,order.card_id);
  },true);
}
function reversePayment(actor,order,payment,amount,reason,shift,returnId=null) {
  const prior=get('SELECT COALESCE(SUM(amount),0) amount FROM payment_reversals WHERE payment_id=?',payment.id).amount;
  if (amount<=0 || prior+amount>payment.amount || !payment.confirmed_at) fail('O valor excede o disponível para devolver.',409);
  const id=idOf(run(`INSERT INTO payment_reversals(payment_id,return_id,order_id,shift_id,amount,user_id,user_name,created_at,reason)
    VALUES(?,?,?,?,?,?,?,?,?)`,payment.id,returnId,order.id,shift.id,amount,actor.id,actor.name,now(),reason));
  if (payment.method==='store') {
    const debit=get("SELECT * FROM ledger WHERE payment_id=? AND kind='use'",payment.id) ||
      get("SELECT * FROM ledger WHERE order_id=? AND kind='use' AND payment_id IS NULL",payment.original_order_id || order.id);
    if (!debit) fail('Não foi possível localizar o débito de crédito da loja.',409);
    ops.ledgerEntry(actor,debit.customer_id,amount,'use_reversal','store',reason,order.id,debit.id,
      {shift:shift.id,payment:payment.id,reversal:id,source:'return'});
  }
  audit(actor,'pagamento.estornado','pagamento',payment.id,{refunded:prior},{refunded:prior+amount,reversal_id:id,shift_id:shift.id,method:payment.method},reason);
}
function voidPayment(actor,id,body) {
  allow(actor,'operate');
  actor=authorize(actor,body,'refund','comanda',id);
  return request(actor,id,body,'void',()=>{
    const order=ops.openForEdit(actor,id);
    const payment=originalPayment(body.payment,id);
    if (payment.state==='void') fail('Esta parcela já foi cancelada.',409);
    const reason=required(body.reason,'Motivo',400,3);
    approveLog(actor,'pagamento',payment.id,reason);
    if (payment.state==='confirmed') reversePayment(actor,order,payment,payment.amount,reason,currentShift(actor));
    run("UPDATE payments SET state='void' WHERE id=?",payment.id);
    audit(actor,'pagamento.cancelado','pagamento',payment.id,{state:payment.state},{state:'void'},reason);
    ops.bump(id);
    return ops.cardDetail(actor,order.card_id);
  },true);
}
function cancel(actor,id,body) {
  allow(actor,'operate');
  return ops.cancel(authorize(actor,body,'cancel','comanda',id),id,body);
}
function returns(actor,id,body) {
  // A aprovação autoriza a operação específica, sem transformar a sessão do operador.
  const order=ops.historyOrder(actor,id);
  actor=authorize(actor,body,'refund','comanda',id);
  return request(actor,id,body,'return',()=>{
    const fresh=orderById(order.id);
    if (fresh.status!=='closed') fail('Somente uma venda concluída com saldo de devolução pode ser corrigida.',409);
    const reason=required(body.reason,'Motivo da devolução',400,3);
    const exchangeId=body.exchange_order==null?null:integer(body.exchange_order,'Atendimento da troca',1,Number.MAX_SAFE_INTEGER);
    if (exchangeId) {
      const exchange=ops.openForEdit(actor,exchangeId);
      if (exchange.customer_id && fresh.customer_id && exchange.customer_id!==fresh.customer_id) {
        fail('A troca precisa usar um atendimento do mesmo cliente.',409);
      }
      if (!exchange.customer_id && fresh.customer_id) {
        run('UPDATE orders SET customer_id=?,customer_name=?,version=version+1 WHERE id=?',fresh.customer_id,fresh.customer_name,exchange.id);
        audit(actor,'comanda.cliente','comanda',exchange.id,{customer_id:null},{customer_id:fresh.customer_id},reason);
      }
    }
    const originals=all(`SELECT i.*,COALESCE(SUM(r.quantity),0) returned,
      COALESCE(SUM(r.cost_allocated),0) assigned_cost,COUNT(r.item_id)-COUNT(r.cost_allocated) unknown_cost
      FROM items i LEFT JOIN return_items r ON r.item_id=i.id WHERE i.order_id=? GROUP BY i.id ORDER BY i.id`,id);
    const nets=allocate(fresh.discount,originals.map(line=>line.price*line.quantity))
      .map((discount,index)=>originals[index].quantity*originals[index].price-discount);
    const wanted=body.items===undefined ? originals.filter(item=>item.quantity>item.returned)
      .map(item=>({item:item.id,quantity:item.quantity-item.returned,restock:true})) : body.items;
    if (!Array.isArray(wanted) || !wanted.length || new Set(wanted.map(row=>row?.item)).size!==wanted.length) fail('Selecione os itens da devolução.');
    const rows=wanted.map(value=>{
      const index=originals.findIndex(line=>line.id===value?.item);
      if (index<0) fail('Item fora da venda original.');
      const line=originals[index];
      const quantity=integer(value.quantity,'Quantidade para devolução',1,line.quantity-line.returned);
      if (typeof value.restock!=='boolean') fail('Informe se o item retornará ao estoque.');
      const partial=n=>portion(nets[index],n,line.quantity);
      const cost=line.cost_total==null || line.unknown_cost ? null :
        portion(Math.max(0,line.cost_total-line.assigned_cost),quantity,line.quantity-line.returned);
      return {line,quantity,amount:partial(line.returned+quantity)-partial(line.returned),restock:value.restock,cost};
    });
    const amount=rows.reduce((sum,row)=>sum+row.amount,0);
    const originalsPayments=all(`SELECT p.*,p.amount-COALESCE((SELECT SUM(r.amount) FROM payment_reversals r WHERE r.payment_id=p.id),0) available
      FROM payments p WHERE p.order_id=? AND p.state='confirmed' ORDER BY p.id`,id);
    if (originalsPayments.reduce((sum,row)=>sum+row.available,0)<amount) fail('Os pagamentos disponíveis não cobrem a devolução.',409);
    const shift=currentShift(actor,amount>0);
    const returnId=idOf(run('INSERT INTO returns(order_id,amount,reason,created_at,user_id,user_name,approved_by,approved_name,exchange_order_id,shift_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
      id,amount,reason,now(),actor.id,actor.name,actor.approval?.id ?? null,actor.approval?.name ?? null,exchangeId,shift?.id ?? null));
    approveLog(actor,'devolucao',returnId,reason);
    for (const row of rows) {
      run('INSERT INTO return_items(return_id,item_id,quantity,amount,restock,cost_allocated,cost_restocked) VALUES(?,?,?,?,?,?,?)',
        returnId,row.line.id,row.quantity,row.amount,Number(row.restock),row.cost,row.restock?row.cost:null);
      if (row.restock) ops.stockMove(actor,{id:row.line.product_id},row.quantity,reason,'refund',id,{reference:returnId,value:row.cost,revalue:true});
    }
    const splits=allocate(amount,originalsPayments.map(row=>row.available));
    for (let index=0;index<splits.length;index++) {
      if (splits[index]) reversePayment(actor,fresh,originalsPayments[index],splits[index],reason,shift,returnId);
    }
    const remaining=originals.reduce((total,line)=>total+line.quantity-line.returned,0)-rows.reduce((total,row)=>total+row.quantity,0);
    if (!remaining) {
      run("UPDATE orders SET status='refunded',refunded_at=?,refunded_by=?,refunded_name=?,reason=?,version=version+1 WHERE id=?",
        now(),actor.id,actor.name,reason,id);
    } else ops.bump(id);
    audit(actor,remaining?'venda.devolucao_parcial':'venda.estornada','comanda',id,{status:'closed'},{status:remaining?'closed':'refunded',amount,return_id:returnId,exchange_order_id:exchangeId,shift_id:shift?.id ?? null,
      items:rows.map(row=>({item:row.line.id,quantity:row.quantity,restock:row.restock,cost:row.cost}))},reason);
    return ops.orderDetail(actor,orderById(id));
  });
}
function move(actor,id,body) {
  const mode=body.mode;
  if (!['transfer','split','merge'].includes(mode)) fail('Operação inválida.');
  allow(actor,mode==='merge'?'order_merge':'order_transfer');
  return tx(()=>{
    const source=ops.openForEdit(actor,id);
    validateVersion(source,body.version);
    const card=integer(body.target,'Cartão destino',1,Number.MAX_SAFE_INTEGER);
    if (source.card_id===card) fail('Selecione outro cartão.');
    let destination=ops.cardDetail(actor,card).order;
    if (mode==='split' && destination) fail('Use um cartão livre para dividir a comanda.',409);
    if (mode==='split') destination=ops.openOrder(actor,card).order;
    if (!destination) fail('Abra a comanda de destino.',409);
    if (mode!=='split') validateVersion(destination,body.targetVersion);
    const reason=required(body.reason,'Motivo',400,3);
    const sourceLines=all('SELECT * FROM items WHERE order_id=? ORDER BY id',id);
    const wanted=mode==='merge'?sourceLines.map(line=>({item:line.id,quantity:line.quantity})):body.items;
    if (!Array.isArray(wanted) || !wanted.length || new Set(wanted.map(row=>row?.item)).size!==wanted.length) fail('Selecione os itens.');
    const lines=wanted.map(row=>{
      const line=record(sourceLines.find(item=>item.id===row?.item),'Item');
      return {...line,moved:integer(row.quantity,'Quantidade transferida',1,line.quantity)};
    });
    const gross=lines.reduce((sum,line)=>sum+line.moved*line.price,0);
    const original=ops.totals(id).subtotal;
    const discount=original ? Number(BigInt(source.discount)*BigInt(gross)/BigInt(original)) : 0;
    if (mode!=='merge') ops.enforceBooked(id,original-gross-source.discount+discount);
    if (mode==='merge' && source.customer_id && destination.customer_id && source.customer_id!==destination.customer_id) {
      fail('A união exige o mesmo cliente ou um cartão sem cliente.',409);
    }
    if (destination.subtotal+gross>maxMoney) fail('O total da comanda de destino excede o limite suportado.');
    for (const line of lines) {
      run('INSERT INTO items(order_id,product_id,name,code,category,quantity,price,cost) VALUES(?,?,?,?,?,?,?,?)',
        destination.id,line.product_id,line.name,line.code,line.category,line.moved,line.price,line.cost);
      if (mode!=='merge') {
        if (line.moved===line.quantity) run('DELETE FROM items WHERE id=?',line.id);
        else run('UPDATE items SET quantity=quantity-? WHERE id=?',line.moved,line.id);
      }
    }
    const inherit=(mode==='merge'||mode==='split') && !destination.customer_id;
    run('UPDATE orders SET discount=discount+?,customer_id=?,customer_name=?,version=version+1 WHERE id=?',
      discount,inherit?source.customer_id:destination.customer_id,inherit?source.customer_name:destination.customer_name,destination.id);
    if (mode==='merge') {
      const paymentIds=all('SELECT id FROM payments WHERE order_id=?',id).map(row=>row.id);
      run('UPDATE payments SET order_id=? WHERE order_id=?',destination.id,id);
      run(`UPDATE orders SET status='cancelled',merged_into=?,subtotal=?,total=?,ended_at=?,ended_by=?,ended_name=?,ended_session=?,closed_shift_id=?,reason=?,version=version+1 WHERE id=?`,
        destination.id,original,original-source.discount,now(),actor.id,actor.name,actor.session_id,currentShift(actor,false)?.id ?? null,reason,id);
      run('DELETE FROM scan_grants WHERE card_id=?',source.card_id);
      audit(actor,'pagamento.transferido','comanda',destination.id,{order_id:id},{order_id:destination.id,payments:paymentIds},reason);
    } else {
      run('UPDATE orders SET discount=discount-?,version=version+1 WHERE id=?',discount,id);
    }
    audit(actor,`comanda.${mode}`,'comanda',id,{source:id,discount:source.discount},{destination:destination.id,discount,items:lines.map(line=>({id:line.id,product:line.product_id,quantity:line.moved,price:line.price}))},reason);
    return {source:mode==='merge'?null:ops.cardDetail(actor,source.card_id),destination:ops.cardDetail(actor,card)};
  });
}

module.exports={pay,confirmPix,voidPayment,cancel,returns,move,allocate};
