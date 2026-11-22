const {get,all,run,idOf,tx,fail,record,integer,required,optional,now,sha,randomUUID,methods,origins,can,allow,audit,findSession} = require('./db');

const {authorize,approveLog,currentShift}=require('./cash');
const {portion}=require('./amount');
const {needsExpiry,expiryInfo,storeDay}=require('./expiry.mjs');
const today=()=>storeDay(Date.now(),process.env.PDV_TIMEZONE || 'America/Sao_Paulo');
const catalog = `SELECT p.id,p.code,p.barcode,p.name,p.category,p.expires_on,p.price,p.cost,p.stock,p.minimum,p.image_hash,p.active,p.stock_value,p.game,p.collection,p.collector_number,p.language,p.condition,p.rarity,p.foil,COALESCE((SELECT SUM(i.quantity) FROM items i JOIN orders o ON o.id=i.order_id
  WHERE i.product_id=p.id AND o.status='open'),0) reserved FROM products p`;
function productView(product,actor) {
  const {image_hash,...fields}=product;
  const data = {...fields,image:image_hash ? `/api/products/${product.id}/image?v=${image_hash}` : null,
    available:product.stock-product.reserved,expiry:expiryInfo(product,today())};
  if (!can(actor,'products') && !can(actor,'stock') && !can(actor,'suppliers')) {delete data.cost;delete data.stock_value;}
  return data;
}
function products(actor) {
  const manage = can(actor,'products') || can(actor,'stock');
  if (!manage && !can(actor,'operate') && !can(actor,'suppliers')) fail('Seu perfil não tem acesso ao catálogo.',403);
  return all(`${catalog} ${manage ? '' : 'WHERE p.active=1'} ORDER BY p.name COLLATE NOCASE`)
    .map(product => productView(product,actor));
}
function productImage(actor,id) {
  const manage=can(actor,'products') || can(actor,'stock');
  if (!manage) allow(actor,'operate');
  return record(get('SELECT image,image_hash FROM products WHERE id=? AND image IS NOT NULL AND (?=1 OR active=1)',id,Number(manage)),'Imagem');
}
function assertSaleable(product) {
  const expiry=expiryInfo(product,today());
  if (expiry.blocked) fail(`${product.name}: ${expiry.reason}`,409);
}
function orderSaleBlocks(id) {
  return all(`SELECT DISTINCT p.id,p.name,p.category,p.expires_on FROM items i JOIN products p ON p.id=i.product_id WHERE i.order_id=?`,id)
    .map(product=>({...product,expiry:expiryInfo(product,today())})).filter(product=>product.expiry.blocked);
}
function assertOrderSaleable(id) {
  const blocked=orderSaleBlocks(id);
  if (blocked.length) fail(`Venda bloqueada: ${blocked.map(product=>product.name).join(', ')}. Remova os produtos vencidos ou regularize as validades ausentes.`,409);
}
function stockMove(actor,product,amount,reason,kind,order=null,details={}) {
  if (kind==='sale') assertSaleable(record(get('SELECT name,category,expires_on FROM products WHERE id=?',product.id),'Produto'));
  const current=record(get('SELECT stock,cost,stock_value FROM products WHERE id=?',product.id),'Produto');
  const next=integer(current.stock+amount,'Estoque após movimentação',0,1_000_000_000);
  const before=current.stock_value;
  const outgoing=amount<0;
  const consumed=outgoing && before!=null ?
    (Object.hasOwn(details,'removeValue')?details.removeValue:portion(before,-amount,current.stock)):null;
  if (Object.hasOwn(details,'removeValue') &&
      (before==null || consumed>before || !next && consumed!==before)) {
    fail('O custo atual do estoque não permite reverter esta entrada. Confira as movimentações antes de corrigir.',409);
  }
  const incoming=Object.hasOwn(details,'value') ? details.value : current.cost==null ? null : current.cost*amount;
  let after=outgoing ? before==null?null:before-consumed :
    incoming==null || before==null && current.stock ? null : (before || 0)+incoming;
  if (!next) after=0;
  if (after!=null) integer(after,'Valor de estoque',0,Number.MAX_SAFE_INTEGER);
  const nextCost=details.revalue && next && after!=null ? Math.round(after/next) : current.cost;
  run('UPDATE products SET stock=?,stock_value=?,cost=? WHERE id=?',next,after,nextCost,product.id);
  const move={product_id:product.id,amount,before:current.stock,after:next,reason,kind,order_id:order,value_before:before,value_after:after,reference_id:details.reference ?? null,supplier_id:details.supplier ?? null};
  const id=idOf(run(`INSERT INTO stock_moves(product_id,amount,before,after,reason,kind,order_id,user_id,user_name,created_at,value_before,value_after,reference_id,supplier_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,product.id,amount,current.stock,next,reason,kind,order,actor.id,actor.name,now(),before,after,move.reference_id,move.supplier_id));
  audit(actor,'estoque.movimentado','movimento_estoque',id,{stock:current.stock,stock_value:before},{...move,stock:next},reason);
  return {id,cost:consumed,after};
}
function imageValue(value) {
  const image = optional(value,'Imagem',1_500_000);
  if (image && !/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(image)) fail('Use uma imagem PNG, JPEG, WebP ou GIF.');
  return image;
}
function productExpiry(category,value) {
  const required=needsExpiry(category);
  if (!value) {
    if (required) fail('Informe a data de validade para produtos de alimentação ou bebidas.');
    return null;
  }
  return dateValue(value,'Data de validade');
}
function saveProduct(actor,body,id) {
  allow(actor,'products');
  return tx(() => {
    const old = id ? record(get('SELECT * FROM products WHERE id=?',id),'Produto') : null;
    const code = required(body.code,'Código interno',45).toUpperCase();
    const barcode = optional(body.barcode,'Código de barras',60);
    if (get('SELECT id FROM products WHERE code=? AND id<>?',code,id || 0)) fail('Código interno já utilizado.',409);
    if (barcode && get('SELECT id FROM products WHERE barcode=? AND id<>?',barcode,id || 0)) fail('Código de barras já utilizado.',409);
    const name = required(body.name,'Nome',120);
    const category = required(body.category,'Categoria',80);
    const expiresOn = productExpiry(category,Object.hasOwn(body,'expires_on') ? body.expires_on : old?.expires_on);
    const price = integer(body.price,'Preço');
    const cost = body.cost == null ? null : integer(body.cost,'Custo');
    const minimum = integer(body.minimum,'Estoque mínimo',0,1_000_000);
    const active = body.active === false ? 0 : 1;
    const image = Object.hasOwn(body,'image') ? imageValue(body.image) : old?.image ?? null;
    const imageHash=image ? sha(image).slice(0,24) : null;
    if (old && old.stock>0 && old.expires_on!==expiresOn && get(`SELECT i.id FROM items i JOIN orders o ON o.id=i.order_id WHERE i.product_id=? AND o.status='open' LIMIT 1`,id)) fail('Remova as reservas antes de alterar a validade.',409);
    const reason = old && (old.price !== price || old.cost !== cost || old.active !== active || old.stock>0 && (old.expires_on!==expiresOn || needsExpiry(old.category)!==needsExpiry(category)))
      ? required(body.reason,'Motivo da alteração de preço, custo, status ou validade',400,3) : null;
    if (old) {
      run('UPDATE products SET code=?,barcode=?,name=?,category=?,expires_on=?,price=?,cost=?,minimum=?,active=?,image=?,image_hash=? WHERE id=?',
        code,barcode,name,category,expiresOn,price,cost,minimum,active,image,imageHash,id);
    } else {
      const initial = integer(body.stock ?? 0,'Estoque inicial',0,1_000_000);
      if (initial > 0) allow(actor,'stock');
      id = idOf(run(`INSERT INTO products(code,barcode,name,category,expires_on,price,cost,stock,minimum,active,image,image_hash)
        VALUES(?,?,?,?,?,?,?,0,?,?,?,?)`,code,barcode,name,category,expiresOn,price,cost,minimum,active,image,imageHash));
      if (initial) stockMove(actor,{id,stock:0},initial,'Saldo inicial do cadastro','initial');
    }
    if (old && old.cost!==cost) run('UPDATE products SET stock_value=? WHERE id=?',cost==null?null:cost*old.stock,id);
    const variant=['game','collection','collector_number','language','condition','rarity'].map(key=>
      Object.hasOwn(body,key)?optional(body[key],'Variação',80):old?.[key] ?? null);
    const foil=Object.hasOwn(body,'foil') ? body.foil==null?null:Number(body.foil===true) : old?.foil ?? null;
    run('UPDATE products SET game=?,collection=?,collector_number=?,language=?,condition=?,rarity=?,foil=? WHERE id=?',...variant,foil,id);
    const saved = get(`${catalog} WHERE p.id=?`,id);
    const compact = ({image,image_hash,...product}) => ({...product,image:!!image_hash});
    audit(actor,old ? 'produto.alterado' : 'produto.criado','produto',id,old && compact(old),compact(saved),reason);
    return productView(saved,actor);
  });
}
function adjustStock(actor,id,body) {
  if (!can(actor,'stock')) {
    allow(actor,'operate');
    actor=authorize(actor,body,'stock','produto',id);
  }
  return tx(() => {
    const product = record(get(`${catalog} WHERE p.id=?`,id),'Produto');
    const delta = integer(body.delta,'Quantidade',-1_000_000,1_000_000);
    if (!delta) fail('Informe uma quantidade diferente de zero.');
    if (delta>0) assertSaleable(product);
    if (product.stock+delta < product.reserved) fail('A movimentação deixaria o estoque abaixo das reservas.',409);
    const reason=required(body.reason,'Motivo',400,3);
    approveLog(actor,'produto',id,reason);
    stockMove(actor,product,delta,reason,'adjustment');
    return productView(get(`${catalog} WHERE p.id=?`,id),actor);
  });
}

const customerCatalog = `SELECT c.*,COALESCE((SELECT SUM(l.amount) FROM ledger l WHERE l.customer_id=c.id),0) balance FROM customers c`;
function customers(actor) {
  allow(actor,'customer_read');
  return all(`${customerCatalog} ORDER BY c.name COLLATE NOCASE`);
}
function balance(id) {
  return get('SELECT COALESCE(SUM(amount),0) n FROM ledger WHERE customer_id=?',id).n;
}
function dateValue(value,label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) fail(`${label} inválida.`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(+date) || date.toISOString().slice(0,10) !== value) fail(`${label} inválida.`);
  return value;
}
function saveCustomer(actor,body,id) {
  allow(actor,id ? 'customers' : 'customer_create');
  return tx(() => {
    const old = id ? record(get('SELECT * FROM customers WHERE id=?',id),'Cliente') : null;
    const name = required(body.name,'Nome',120);
    const phone = required(body.phone,'Telefone',32);
    const document = optional(body.document,'CPF/CNPJ',30);
    const email = optional(body.email,'E-mail',160);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('E-mail inválido.');
    const birthday = body.birthday ? dateValue(body.birthday,'Data de nascimento') : null;
    const notes = optional(body.notes,'Observações',2000);
    const active = id && body.active === false ? 0 : 1;
    if (old) {
      run('UPDATE customers SET name=?,phone=?,document=?,email=?,birthday=?,notes=?,active=? WHERE id=?',
        name,phone,document,email,birthday,notes,active,id);
    } else {
      id = idOf(run(`INSERT INTO customers(name,phone,document,email,birthday,notes,active,created_at,created_by)
        VALUES(?,?,?,?,?,?,?,?,?)`,name,phone,document,email,birthday,notes,active,now(),actor.id));
    }
    const saved = get(`${customerCatalog} WHERE c.id=?`,id);
    audit(actor,old ? 'cliente.alterado' : 'cliente.criado','cliente',id,old,saved,
      old && active !== old.active ? (optional(body.reason,'Motivo',400) || (active ? 'Reativação do cadastro' : 'Inativação do cadastro')) : null);
    return saved;
  });
}
function recentShift(actor) {
  return get('SELECT id FROM shifts WHERE opened_by=? ORDER BY id DESC LIMIT 1',actor.id)?.id ?? null;
}
function ownsOrder(actor,order,shift=recentShift(actor)) {
  if (order.closed_shift_id) return order.closed_shift_id===shift;
  return order.ended_session===actor.session_id || (order.status==='cancelled' && order.ended_by===actor.id);
}
function customerDetail(actor,id) {
  allow(actor,'customer_read');
  const customer=record(get(`${customerCatalog} WHERE c.id=?`,id),'Cliente');
  const orders=all(`SELECT o.id,c.number,o.ended_at,o.total,o.status,o.ended_name,o.ended_by,o.ended_session,o.closed_shift_id,
    CASE WHEN o.status='refunded' THEN o.total ELSE COALESCE((SELECT SUM(amount) FROM returns r WHERE r.order_id=o.id),0) END returned
    FROM orders o JOIN cards c ON c.id=o.card_id WHERE o.customer_id=? AND o.status IN ('closed','refunded','cancelled')
    ORDER BY o.ended_at DESC,o.id DESC`,id);
  const sales=orders.filter(order=>['closed','refunded'].includes(order.status));
  const completed=sales.filter(order=>order.status==='closed');
  const grossSpent=sales.reduce((sum,order)=>sum+order.total,0);
  const returnedSpent=sales.reduce((sum,order)=>sum+order.returned,0);
  const recent=recentShift(actor);
  const purchases=orders.filter(order=>can(actor,'history_all') || can(actor,'history_own') && ownsOrder(actor,order,recent))
    .map(({ended_session,closed_shift_id,...order})=>({...order,net:order.status==='cancelled'?null:order.total-order.returned}));
  const canReadLedger=['credit_statement','credit_reverse','credit_correct'].some(key=>can(actor,key));
  return {...customer,purchases,count:completed.length,grossSpent,returnedSpent,spent:grossSpent-returnedSpent,
    last:completed[0]?.ended_at,ledger:canReadLedger ? all(`SELECT l.*,m.id merchandise_id FROM ledger l
      LEFT JOIN merchandise m ON m.ledger_id=l.id WHERE l.customer_id=? ORDER BY l.id DESC`,id) : null};
}
function ledgerEntry(actor,customer,amount,kind,origin,reason,order=null,original=null,meta={}) {
  const previous = balance(customer);
  if (previous+amount < 0) fail('Saldo de crédito insuficiente.',409);
  const created_at = now();
  const id = idOf(run(`INSERT INTO ledger(customer_id,amount,kind,origin,reason,order_id,original_id,user_id,user_name,created_at,source,shift_id,payment_id,payment_reversal_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,customer,amount,kind,origin,reason,order,original,actor.id,actor.name,created_at,meta.source || (kind==='use'?'spend':kind==='use_reversal'?'return':'funded'),meta.shift ?? null,meta.payment ?? null,meta.reversal ?? null));
  audit(actor,`credito.${kind}`,'credito',id,{balance:previous},
    {customer_id:customer,amount,balance:previous+amount,origin,order_id:order,original_id:original,source:meta.source,shift_id:meta.shift,payment_id:meta.payment,payment_reversal_id:meta.reversal},reason);
  return get('SELECT * FROM ledger WHERE id=?',id);
}
function deposit(actor,id,body) {
  const source=body.source || 'funded';
  if (!['funded','bonus','adjustment'].includes(source)) fail('Origem de crédito inválida.');
  allow(actor,'customer_read');
  actor=authorize(actor,body,source==='funded'?'credit':'credit_grant','cliente',id);
  return tx(() => {
    const customer = record(get('SELECT * FROM customers WHERE id=?',id),'Cliente');
    if (!customer.active) fail('Este cliente está inativo.',409);
    if (source==='funded' && !Object.hasOwn(origins,body.origin)) fail('Informe a forma de recebimento.');
    const shift=source==='funded'?currentShift(actor).id:null;
    const reason=required(body.reason,'Motivo',400,3);
    approveLog(actor,'cliente',id,reason);
    return ledgerEntry(actor,id,integer(body.amount,'Valor do crédito',1),'deposit',source==='funded'?body.origin:source,reason,null,null,{source,shift});
  });
}
function originalDeposit(id) {
  const entry=record(get("SELECT * FROM ledger WHERE id=? AND kind='deposit'",id),'Recarga');
  if (get("SELECT id FROM ledger WHERE original_id=? AND kind='deposit_reversal'",id)) fail('Esta recarga já foi estornada ou corrigida.',409);
  return entry;
}
function reverseDeposit(actor,id,body) {
  allow(actor,'credit_reverse');
  return tx(() => {
    const entry=originalDeposit(id);
    if (entry.source==='card_purchase' || get('SELECT id FROM merchandise WHERE ledger_id=?',id)) {
      fail('Corrija a compra de cartas em Compras e fornecedores para tratar crédito e estoque juntos.',409);
    }
    const shift=entry.source==='funded' ? currentShift(actor).id : null;
    return ledgerEntry(actor,entry.customer_id,-entry.amount,'deposit_reversal',entry.origin,
      required(body.reason,'Motivo do estorno',400,3),null,id,{source:entry.source,shift});
  });
}
function correctDeposit(actor,id,body) {
  allow(actor,'credit_correct');
  return tx(()=>{
    const entry=originalDeposit(id);
    if (entry.source!=='funded') fail('Estorne o lançamento e registre a origem correta.');
    const shift=currentShift(actor).id;
    const amount=integer(body.amount,'Valor correto',1);
    if (!Object.hasOwn(origins,body.origin)) fail('Informe a origem correta do crédito.');
    const reason=required(body.reason,'Motivo da correção',400,3);
    if (amount===entry.amount && entry.origin===body.origin) fail('Altere o valor ou a origem da recarga.');
    const correction=ledgerEntry(actor,entry.customer_id,amount,'deposit',body.origin,reason,null,id,{shift});
    const reversed=ledgerEntry(actor,entry.customer_id,-entry.amount,'deposit_reversal',entry.origin,reason,null,id,{shift});
    return {correction,reversed};
  });
}
function createCards(actor,body) {
  allow(actor,'cards');
  const number = integer(body.start,'Primeiro número',1,999999);
  const count = integer(body.count,'Quantidade de cartões',1,100);
  if (number+count-1 > 999999) fail('O último número excede 999999.');
  return tx(() => {
    if (get('SELECT id FROM cards WHERE number BETWEEN ? AND ?',number,number+count-1)) fail('Um dos números do lote já está em uso.',409);
    const out = [];
    for (let cursor=number; cursor<number+count; cursor++) {
      const id = idOf(run('INSERT INTO cards(number,token) VALUES(?,?)',cursor,randomUUID()));
      audit(actor,'cartao.criado','cartao',id,null,{number:cursor});
      out.push({id,number:cursor});
    }
    return out;
  });
}
function changeCard(actor,id,body) {
  allow(actor,'cards');
  return tx(() => {
    const card = record(get('SELECT id,number,active FROM cards WHERE id=?',id),'Cartão');
    if (typeof body.active !== 'boolean') fail('Informe o status do cartão.');
    if (!body.active && get("SELECT id FROM orders WHERE card_id=? AND status='open'",id)) fail('Encerre a comanda aberta antes de inativar o cartão.',409);
    run('UPDATE cards SET active=? WHERE id=?',Number(body.active),id);
    if (!body.active) run('DELETE FROM scan_grants WHERE card_id=?',id);
    audit(actor,'cartao.status','cartao',id,{active:!!card.active},{active:body.active},required(body.reason,'Motivo',400,3));
    return {id,active:body.active};
  });
}
function cardList(actor) {
  allow(actor,'cards');
  return all(`SELECT c.id,c.number,c.active,c.blocked,o.id order_id FROM cards c
    LEFT JOIN orders o ON o.card_id=c.id AND o.status='open' ORDER BY c.number`);
}
function cardFromCode(code) {
  if (typeof code !== 'string' || !/^pdv:[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(code.trim())) fail('Este QR Code não é um cartão do PDV.');
  const card = get('SELECT id,number,active,blocked FROM cards WHERE token=?',code.trim().slice(4).toLowerCase());
  if (!card) fail('Cartão não cadastrado neste PDV.',404);
  if (!card.active || card.blocked) fail('Cartão inativo ou bloqueado.',409);
  return card;
}
function grantCard(session,card) {
  run('INSERT OR IGNORE INTO scan_grants(session_id,card_id) VALUES(?,?)',session,card);
}
function cardSessions(actor) {
  const peers=all('SELECT terminal id FROM pairings WHERE reader=? UNION SELECT reader id FROM pairings WHERE terminal=?',actor.session_id,actor.session_id);
  return [actor.session_id,...peers.map(row=>findSession(row.id)).filter(user=>user && can(user,'operate')).map(user=>user.session_id)];
}
function openCards(actor) {
  allow(actor,'operate');
  const sessions=cardSessions(actor);
  const cards=all(`SELECT DISTINCT c.id,c.number,o.id order_id FROM orders o JOIN cards c ON c.id=o.card_id
    JOIN scan_grants g ON g.card_id=c.id WHERE o.status='open' AND c.active=1 AND c.blocked=0
    AND g.session_id IN (${sessions.map(()=>'?').join(',')}) ORDER BY o.id DESC`,...sessions);
  return {total:get("SELECT COUNT(*) n FROM orders WHERE status='open'").n,cards};
}
function authorizedCard(actor,id) {
  allow(actor,'operate');
  const sessions=cardSessions(actor);
  const card = get(`SELECT c.id,c.number FROM cards c JOIN scan_grants g ON g.card_id=c.id
    WHERE c.id=? AND c.active=1 AND c.blocked=0 AND g.session_id IN (${sessions.map(()=>'?').join(',')})
    AND (g.session_id=? OR EXISTS(SELECT 1 FROM orders o WHERE o.card_id=c.id AND o.status='open'))`,id,...sessions,actor.session_id);
  if (!card) fail('Leia o QR Code do cartão para acessar a comanda.',403);
  return card;
}
const orderQuery = `SELECT o.*,c.number FROM orders o JOIN cards c ON c.id=o.card_id`;
function totals(id) {
  return get('SELECT COALESCE(SUM(quantity*price),0) subtotal,COALESCE(SUM(quantity),0) units FROM items WHERE order_id=?',id);
}
function orderDetail(actor,order) {
  const costsVisible=can(actor,'products') || can(actor,'reports');
  const lines = all('SELECT * FROM items WHERE order_id=? ORDER BY id',order.id).map(item => {
    const line = {...item,subtotal:item.quantity*item.price};
    if (!costsVisible) {
      delete line.cost;
      delete line.cost_total;
    }
    return line;
  });
  const info = totals(order.id);
  const {ended_session, ...data} = order;
  const payments=all('SELECT * FROM payments WHERE order_id=? ORDER BY id',order.id);
  const confirmed=payments.filter(p=>p.state==='confirmed').reduce((sum,p)=>sum+p.amount,0);
  const pending=payments.filter(p=>p.state==='pending').reduce((sum,p)=>sum+p.amount,0);
  const returns=order.status==='open'?[]:all('SELECT * FROM returns WHERE order_id=? ORDER BY id',order.id).map(entry=>({...entry,items:all(costsVisible?'SELECT * FROM return_items WHERE return_id=?':
    'SELECT return_id,item_id,quantity,amount,restock FROM return_items WHERE return_id=?',entry.id),payments:all(`SELECT r.*,p.method FROM payment_reversals r JOIN payments p ON p.id=r.payment_id WHERE r.return_id=?`,entry.id)}));
  const transferredPayments=order.merged_into?all('SELECT id,order_id,method,amount,shift_id FROM payments WHERE original_order_id=? AND order_id<>?',order.id,order.id):[];
  return {...data,items:lines,confirmed,pending,returns,transferredPayments,sale_blocks:order.status==='open'?orderSaleBlocks(order.id):[],subtotal:order.subtotal ?? info.subtotal,units:info.units,
    total:order.total ?? Math.max(0,info.subtotal-order.discount),
    balance:order.status === 'open' && order.customer_id ? balance(order.customer_id) : 0,
    payments};
}
function cardDetail(actor,id) {
  const card = authorizedCard(actor,id);
  const order = get(`${orderQuery} WHERE o.card_id=? AND o.status='open'`,id);
  return {...card,order:order ? orderDetail(actor,order) : null};
}
function openOrder(actor,id) {
  return tx(() => {
    authorizedCard(actor,id);
    const existing = get("SELECT id FROM orders WHERE card_id=? AND status='open'",id);
    if (!existing) {
      const order = idOf(run('INSERT INTO orders(card_id,user_id,opened_name,opened_at) VALUES(?,?,?,?)',id,actor.id,actor.name,now()));
      audit(actor,'comanda.aberta','comanda',order,null,{card_id:id,operator:actor.name});
    }
    return cardDetail(actor,id);
  });
}
function openForEdit(actor,id) {
  const order = record(get(`${orderQuery} WHERE o.id=?`,id),'Atendimento');
  if (order.status !== 'open') fail('Este atendimento já foi encerrado.',409);
  authorizedCard(actor,order.card_id);
  return order;
}
function bump(id) {
  run('UPDATE orders SET version=version+1 WHERE id=?',id);
}
function booked(id) {
  return get("SELECT COALESCE(SUM(amount),0) amount FROM payments WHERE order_id=? AND state<>'void'",id).amount;
}
function enforceBooked(id,total) {
  if (booked(id)>total) fail('O novo total ficaria abaixo dos pagamentos já registrados.',409);
}
function orderItem(actor,id,body) {
  return tx(() => {
    const order = openForEdit(actor,id);
    const old = body.item ? record(get('SELECT * FROM items WHERE id=? AND order_id=?',integer(body.item,'Item',1,Number.MAX_SAFE_INTEGER),id),'Item') : null;
    const product = record(get(`${catalog} WHERE p.id=?`,old?.product_id ?? integer(body.product,'Produto',1,Number.MAX_SAFE_INTEGER)),'Produto');
    let item = old;
    let reason = null;
    let action = 'item.quantidade';
    if (body.action === 'price') {
      allow(actor,'item_price');
      if (!old) fail('Selecione um item.');
      reason = required(body.reason,'Motivo da alteração de preço',400,3);
      run('UPDATE items SET price=? WHERE id=?',integer(body.price,'Preço'),item.id);
      action = 'item.preco';
    } else if (body.action === 'delta' || body.action === 'remove') {
      const delta = body.action === 'delta' ? integer(body.delta,'Quantidade',-100000,100000) : -(old?.quantity || 0);
      if (!delta) fail('Informe uma alteração de quantidade.');
      if (!item) item = get(`SELECT * FROM items WHERE order_id=? AND product_id=? AND price=? 
        AND name=? AND category=? AND code=? AND cost IS ? ORDER BY id LIMIT 1`,
        id,product.id,product.price,product.name,product.category,product.code,product.cost);
      if (body.expectedQuantity!==undefined && item?.quantity!==body.expectedQuantity) {
        fail('A quantidade foi alterada em outro dispositivo. Abra o item novamente.',409);
      }
      const quantity = (item?.quantity || 0)+delta;
      integer(quantity,'Quantidade final',0,100000);
      if (delta < 0) {
        if (!item) fail('Selecione um item.');
        if (!quantity || !can(actor,'item_reduce')) allow(actor,'item_remove');
        reason = !quantity ? required(body.reason,'Motivo da remoção',400,3) :
          optional(body.reason,'Motivo da redução',400) || 'Redução de quantidade no atendimento';
      } else {
        assertSaleable(product);
        if (!product.active || product.stock-product.reserved < delta) fail(product.active ? 'Estoque disponível insuficiente.' : 'Produto inativo.',409);
      }
      if (!quantity) {
        run('DELETE FROM items WHERE id=?',item.id);
        action = 'item.removido';
      } else if (item) {
        run('UPDATE items SET quantity=? WHERE id=?',quantity,item.id);
      } else {
        item = {id:idOf(run(`INSERT INTO items(order_id,product_id,name,code,category,quantity,price,cost)
          VALUES(?,?,?,?,?,?,?,?)`,id,product.id,product.name,product.code,product.category,quantity,product.price,product.cost))};
        action = 'item.adicionado';
      }
    } else fail('Ação de item inválida.');
    const {subtotal} = totals(id);
    if (subtotal > 1_000_000_000_000) fail('O total da comanda excede o limite suportado.');
    if (order.discount > subtotal) fail('Reduza o desconto antes de alterar este item.',409);
    enforceBooked(id,subtotal-order.discount);
    audit(actor,action,'comanda',id,old ?? (action === 'item.quantidade' ? item : null),
      get('SELECT * FROM items WHERE id=?',item.id) ?? null,reason);
    bump(id);
    return cardDetail(actor,order.card_id);
  });
}
function updateOrder(actor,id,body) {
  if (body.field==='discount' && (actor.role!=='admin' && (!can(actor,'discount') || body.value>(actor.discount_limit || 0)))) {
    allow(actor,'operate');
    actor=authorize(actor,body,'discount','comanda',id,true);
  }
  return tx(() => {
    const order = openForEdit(actor,id);
    if (body.field === 'notes') {
      if (typeof body.previous !== 'string' || body.previous !== order.notes) fail('As observações foram alteradas em outro dispositivo. Confira o texto salvo e tente novamente.',409);
      if (typeof body.value!=='string' || body.value.length>2000) fail('Observações devem ter até 2000 caracteres.');
      const notes=body.value;
      run('UPDATE orders SET notes=? WHERE id=?',notes,id);
      audit(actor,'comanda.observacoes','comanda',id,{notes:order.notes},{notes});
    } else if (body.field === 'customer') {
      allow(actor,'customer_read');
      const customer = body.value == null ? null :
        record(get('SELECT id,name FROM customers WHERE id=? AND active=1',integer(body.value,'Cliente',1,Number.MAX_SAFE_INTEGER)),'Cliente ativo');
      if (order.customer_id!==(customer?.id ?? null) &&
          get("SELECT id FROM payments WHERE order_id=? AND method='store' AND state='confirmed'",id)) {
        fail('Há crédito da loja aplicado. Estorne a parcela para trocar o cliente.',409);
      }
      run('UPDATE orders SET customer_id=?,customer_name=? WHERE id=?',customer?.id ?? null,customer?.name ?? null,id);
      audit(actor,'comanda.cliente','comanda',id,{customer_id:order.customer_id},{customer_id:customer?.id ?? null});
    } else if (body.field === 'discount') {
      allow(actor,'discount');
      const reason = required(body.reason,'Motivo do desconto',400,3);
      const amount = integer(body.value,'Desconto',0,totals(id).subtotal);
      enforceBooked(id,totals(id).subtotal-amount);
      approveLog(actor,'comanda',id,reason);
      run('UPDATE orders SET discount=? WHERE id=?',amount,id);
      audit(actor,'comanda.desconto','comanda',id,{discount:order.discount},{discount:amount},reason);
    } else fail('Campo da comanda inválido.');
    bump(id);
    return cardDetail(actor,order.card_id);
  });
}
function cancel(actor,id,body) {
  allow(actor,'cancel');
  return tx(() => {
    const order = openForEdit(actor,id);
    const reason = required(body.reason,'Motivo do cancelamento',400,3);
    const {subtotal} = totals(id);
    const shift=currentShift(actor,false)?.id ?? null;
    if (booked(id)) fail('Estorne as parcelas antes de cancelar a comanda.',409);
    approveLog(actor,'comanda',id,reason);
    run(`UPDATE orders SET status='cancelled',subtotal=?,total=?,reason=?,ended_at=?,ended_by=?,ended_name=?,
      ended_session=?,closed_shift_id=?,version=version+1 WHERE id=?`,subtotal,subtotal-order.discount,reason,now(),actor.id,actor.name,actor.session_id,shift,id);
    run('DELETE FROM scan_grants WHERE card_id=?',order.card_id);
    audit(actor,'comanda.cancelada','comanda',id,{status:'open'},{status:'cancelled',card_id:order.card_id,shift_id:shift},reason);
    return orderDetail(actor,get(`${orderQuery} WHERE o.id=?`,id));
  });
}
function historyOrder(actor,id) {
  if (!can(actor,'history_all')) allow(actor,'history_own');
  const order = record(get(`${orderQuery} WHERE o.id=? AND o.status<>'open'`,id),'Atendimento');
  if (!can(actor,'history_all') && !ownsOrder(actor,order)) fail('Atendimento de outro turno.',403);
  return order;
}
module.exports = {products,productImage,saveProduct,productExpiry,assertSaleable,assertOrderSaleable,adjustStock,customers,customerDetail,saveCustomer,deposit,reverseDeposit,correctDeposit,
  dateValue,createCards,changeCard,cardList,cardFromCode,grantCard,cardDetail,openCards,openOrder,orderItem,updateOrder,
  cancel,historyOrder,recentShift,orderDetail,orderQuery,stockMove,ledgerEntry,balance,catalog,productView,openForEdit,totals,bump,booked,enforceBooked};
