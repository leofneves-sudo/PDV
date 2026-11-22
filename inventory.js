const {all,get,run,idOf,tx,record,integer,required,optional,now,fail,can,allow,audit,sha}=require('./db');
const {authorize,approveLog}=require('./cash');
const ops=require('./operations');

function suppliers(actor) {
  allow(actor,'suppliers');
  return all('SELECT * FROM suppliers ORDER BY name COLLATE NOCASE');
}
function saveSupplier(actor,body,id) {
  allow(actor,'suppliers');
  return tx(()=>{
    const old=id?record(get('SELECT * FROM suppliers WHERE id=?',id),'Fornecedor'):null;
    const row={name:required(body.name,'Nome',120),document:optional(body.document,'CPF/CNPJ',30),
      contact:optional(body.contact,'Contato',120),notes:optional(body.notes,'Observações',1000),active:Number(body.active!==false)};
    if (id) run('UPDATE suppliers SET name=?,document=?,contact=?,notes=?,active=? WHERE id=?',...Object.values(row),id);
    else id=idOf(run('INSERT INTO suppliers(name,document,contact,notes,active) VALUES(?,?,?,?,?)',...Object.values(row)));
    audit(actor,id&&old?'fornecedor.alterado':'fornecedor.criado','fornecedor',id,old,row);
    return {...row,id};
  });
}
function recordReceipt(actor,body,source) {
  const product=record(get('SELECT id,name,category,expires_on,stock,active FROM products WHERE id=?',body.product),'Produto');
  if (!product.active) fail('Selecione um produto ativo.');
  ops.assertSaleable(product);
  const quantity=integer(body.quantity,'Quantidade',1,1000000);
  const unitCost=integer(body.cost,'Custo unitário');
  const total=integer(quantity*unitCost,'Custo total',0,Number.MAX_SAFE_INTEGER);
  const {reason,customer=null,supplier=null,previous=null}=source;
  if (customer && !total) fail('Informe o custo da compra de cartas.');
  const id=idOf(run(`INSERT INTO merchandise(supplier_id,customer_id,product_id,quantity,unit_cost,created_at,reason,user_id,user_name)
    VALUES(?,?,?,?,?,?,?,?,?)`,supplier,customer,product.id,quantity,unitCost,now(),reason,actor.id,actor.name));
  if (customer) {
    const entry=ops.ledgerEntry(actor,customer,total,'deposit','card_purchase',reason,null,previous,{source:'card_purchase'});
    run('UPDATE merchandise SET ledger_id=? WHERE id=?',entry.id,id);
  }
  approveLog(actor,'entrada_mercadoria',id,reason);
  ops.stockMove(actor,product,quantity,reason,'purchase',null,{value:total,reference:id,supplier,revalue:true});
  audit(actor,'mercadoria.recebida','entrada_mercadoria',id,null,{product_id:product.id,quantity,unitCost,supplier_id:supplier,customer_id:customer},reason);
  return get('SELECT * FROM merchandise WHERE id=?',id);
}
function receive(actor,body) {
  allow(actor,'suppliers');
  const trade=body.customer!=null;
  if (trade) actor=authorize(actor,body,'credit_grant','entrada_mercadoria');
  return tx(()=>{
    const reason=required(body.reason,'Motivo ou referência da entrada',400,3);
    const customer=trade ? record(get('SELECT id FROM customers WHERE id=? AND active=1',body.customer),'Cliente ativo').id : null;
    const supplier=!trade ? record(get('SELECT id FROM suppliers WHERE id=? AND active=1',body.supplier),'Fornecedor ativo').id : null;
    return recordReceipt(actor,body,{reason,customer,supplier});
  });
}
function correctTrade(actor,id,body) {
  allow(actor,'suppliers');
  actor=authorize(actor,body,'credit_correct','entrada_mercadoria',id);
  return tx(()=>{
    if (!['reverse','replace'].includes(body.mode)) fail('Selecione o tipo de correção.');
    const original=record(get('SELECT * FROM merchandise WHERE id=? AND ledger_id IS NOT NULL AND customer_id IS NOT NULL',id),'Compra de cartas');
    if (get('SELECT id FROM merchandise_corrections WHERE original_id=?',id)) fail('Esta compra já foi corrigida.',409);
    const ledger=record(get("SELECT * FROM ledger WHERE id=? AND kind='deposit' AND source='card_purchase'",original.ledger_id),'Crédito da compra');
    const value=original.quantity*original.unit_cost;
    if (ledger.amount!==value || ledger.customer_id!==original.customer_id) fail('O crédito original diverge da compra. Confira os registros.',409);
    const oldReversal=get("SELECT * FROM ledger WHERE original_id=? AND kind='deposit_reversal'",ledger.id);
    if (oldReversal && oldReversal.amount!==-value) fail('O estorno anterior diverge da compra. Confira os registros.',409);
    const product=record(get(`${ops.catalog} WHERE p.id=?`,original.product_id),'Produto');
    if (product.stock-product.reserved<original.quantity) fail('O estoque livre é insuficiente para reverter a compra.',409);
    const reason=required(body.reason,'Motivo',400,3);
    ops.stockMove(actor,product,-original.quantity,reason,'purchase_reversal',null,{removeValue:value,reference:id,revalue:true});
    const replacement=body.mode==='replace' ? recordReceipt(actor,body,{reason,customer:original.customer_id,previous:ledger.id}) : null;
    const reversal=oldReversal || ops.ledgerEntry(actor,original.customer_id,-value,'deposit_reversal','card_purchase',
      reason,null,ledger.id,{source:'card_purchase'});
    const correction=idOf(run(`INSERT INTO merchandise_corrections(original_id,replacement_id,ledger_reversal_id,reason,user_id,user_name,approved_by,created_at)
      VALUES(?,?,?,?,?,?,?,?)`,id,replacement?.id ?? null,reversal.id,reason,actor.id,actor.name,actor.approval?.id ?? null,now()));
    approveLog(actor,'entrada_mercadoria',id,reason);
    audit(actor,'compra_cartas.corrigida','entrada_mercadoria',id,{product_id:product.id,quantity:original.quantity,credit:value},
      {correction_id:correction,replacement_id:replacement?.id ?? null,reversal_id:reversal.id,previous_reversal:!!oldReversal},reason);
    return get('SELECT * FROM merchandise_corrections WHERE id=?',correction);
  });
}
function count(actor,body) {
  if (!can(actor,'stock')) {
    allow(actor,'operate');
    actor=authorize(actor,body,'stock','produto',body.product);
  }
  return tx(()=>{
    const product=record(get(`${ops.catalog} WHERE p.id=?`,body.product),'Produto');
    if (body.expected!==product.stock) fail('O estoque mudou durante a conferência. Atualize a ficha.',409);
    const counted=integer(body.counted,'Quantidade contada',0,1000000000);
    if (counted<product.reserved) fail('A contagem é inferior às reservas em aberto.',409);
    const reason=required(body.reason,'Motivo',400,3);
    const id=idOf(run('INSERT INTO stock_counts(product_id,expected,counted,reason,user_id,user_name,created_at) VALUES(?,?,?,?,?,?,?)',
      product.id,product.stock,counted,reason,actor.id,actor.name,now()));
    approveLog(actor,'conferencia_estoque',id,reason);
    if (counted!==product.stock) ops.stockMove(actor,product,counted-product.stock,reason,'count',null,{reference:id});
    audit(actor,'estoque.conferido','conferencia_estoque',id,{stock:product.stock},{product_id:product.id,stock:counted},reason);
    return {id,counted};
  });
}
function breakpack(actor,body) {
  allow(actor,'stock');
  return tx(()=>{
    const source=record(get(`${ops.catalog} WHERE p.id=?`,body.source),'Produto de origem');
    const target=record(get(`${ops.catalog} WHERE p.id=?`,body.target),'Produto de destino');
    if (source.id===target.id || !source.active || !target.active) fail('Escolha dois produtos ativos diferentes.');
    ops.assertSaleable(source);
    ops.assertSaleable(target);
    if (source.expires_on!==target.expires_on) fail('Para desmembrar produtos com validade, use a mesma data na origem e no destino.');
    const consumed=integer(body.consumed,'Unidades consumidas',1,1000000);
    const per=integer(body.per,'Unidades por embalagem',1,1000000);
    const produced=integer(consumed*per,'Unidades resultantes',1,1000000000);
    if (source.stock-source.reserved<consumed) fail('O estoque disponível da origem é insuficiente.',409);
    if (source.stock_value==null || (target.stock && target.stock_value==null)) fail('Cadastre o custo antes de desmembrar.');
    const value=Number(BigInt(source.stock_value)*BigInt(consumed)/BigInt(source.stock));
    const reason=required(body.reason,'Motivo',400,3);
    const id=idOf(run(`INSERT INTO breakpacks(source,destination,consumed,produced,cost,reason,user_id,user_name,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`,source.id,target.id,consumed,produced,value,reason,actor.id,actor.name,now()));
    ops.stockMove(actor,source,-consumed,reason,'breakpack_out',null,{reference:id,revalue:true});
    ops.stockMove(actor,target,produced,reason,'breakpack_in',null,{reference:id,value,revalue:true});
    audit(actor,'estoque.desmembrado','desmembramento',id,{source:source.id,stock:source.stock},{destination:target.id,consumed,produced,value},reason);
    return get('SELECT * FROM breakpacks WHERE id=?',id);
  });
}
function history(actor,id) {
  allow(actor,'suppliers');
  const rows=all(`SELECT m.*,p.name product_name,s.name supplier_name,c.name customer_name,
    correction.id correction_id,correction.replacement_id,previous.original_id,
    EXISTS(SELECT id FROM ledger l WHERE l.original_id=m.ledger_id AND l.kind='deposit_reversal') credit_reversed
    FROM merchandise m JOIN products p ON p.id=m.product_id LEFT JOIN suppliers s ON s.id=m.supplier_id
    LEFT JOIN customers c ON c.id=m.customer_id
    LEFT JOIN merchandise_corrections correction ON correction.original_id=m.id
    LEFT JOIN merchandise_corrections previous ON previous.replacement_id=m.id
    ${id?'WHERE m.id=?':'ORDER BY m.id DESC LIMIT 150'}`,...(id?[id]:[]));
  return id?record(rows[0],'Compra'):rows;
}
function favorite(actor,id,body) {
  allow(actor,'operate');
  return tx(()=>{
    record(get('SELECT id FROM products WHERE id=? AND active=1',id),'Produto ativo');
    const before=!!get('SELECT product_id FROM favorites WHERE user_id=? AND product_id=?',actor.id,id);
    const active=body.active===true;
    if (active) run('INSERT OR IGNORE INTO favorites(user_id,product_id) VALUES(?,?)',actor.id,id);
    else run('DELETE FROM favorites WHERE user_id=? AND product_id=?',actor.id,id);
    if (active!==before) audit(actor,'produto.favorito','produto',id,{favorite:before},{favorite:active});
    return {id,active};
  });
}
function expiryLoss(actor,id,body) {
  if (!can(actor,'stock')) {
    allow(actor,'operate');
    actor=authorize(actor,body,'stock','produto',id);
  }
  return tx(()=>{
    const product=record(get(`${ops.catalog} WHERE p.id=?`,id),'Produto');
    if (product.stock!==body.expected_stock || product.expires_on!==body.expected_expiry) fail('O estoque ou a validade mudou. Atualize a ficha antes de registrar a perda.',409);
    if (!product.expires_on && !ops.productView(product,actor).expiry.blocked) fail('Este produto não tem controle de validade.');
    const quantity=integer(body.quantity,'Quantidade perdida',1,product.stock);
    if (quantity>product.stock-product.reserved) fail('Há unidades reservadas. Remova os itens das comandas antes de registrar a perda.',409);
    const reason=required(body.reason,'Motivo da perda',400,3);
    approveLog(actor,'produto',id,reason);
    ops.stockMove(actor,product,-quantity,reason,'expiry_loss',null);
    audit(actor,'estoque.perda_validade','produto',id,{stock:product.stock,expires_on:product.expires_on},
      {stock:product.stock-quantity,quantity,expires_on:product.expires_on},reason);
    return ops.productView(get(`${ops.catalog} WHERE p.id=?`,id),actor);
  });
}
function expiryCsv(actor) {
  if (!can(actor,'stock')) allow(actor,'products');
  const rows=[['Código','Produto','Categoria','Validade','Situação','Dias para vencer','Estoque','Reservado','Livre','Custo do estoque (R$)']];
  for (const product of ops.products(actor).filter(row=>row.stock>0 && row.expiry.status!=='none').sort((a,b)=>(a.expires_on || '').localeCompare(b.expires_on || ''))) {
    rows.push([product.code,product.name,product.category,product.expires_on || '',product.expiry.label,product.expiry.days,
      product.stock,product.reserved,product.available,product.stock_value==null?'':(product.stock_value/100).toFixed(2).replace('.',',')]);
  }
  return rows.map(row=>row.map(value=>'"'+String(value ?? '').replace(/^[=+@\-]/,"'$&").replaceAll('"','""')+'"').join(';')).join('\r\n');
}

function parseCsv(text) {
  if (typeof text!=='string' || text.length>750000) fail('O CSV deve ter até 750 KB.');
  text=text.replace(/^\uFEFF/,'');
  const delimiter=text.split(/\r?\n/,1)[0].includes(';')?';':',';
  const rows=[];
  let row=[],value='',quoted=false,closed=false;
  for (let index=0;index<=text.length;index++) {
    const char=text[index] ?? '\n';
    if (quoted) {
      if (char==='"' && text[index+1]==='"') {value+='"';index++;}
      else if (char==='"') {quoted=false;closed=true;}
      else value+=char;
      continue;
    }
    if (char===delimiter || char==='\r' || char==='\n') {
      row.push(value.trim());
      value='';closed=false;
      if (char!==delimiter) {
        if (char==='\r' && text[index+1]==='\n') index++;
        if (row.some(Boolean)) rows.push(row);
        row=[];
      }
    } else if (char==='"' && !value && !closed) quoted=true;
    else if (char==='"' || closed && char!==' ') fail('Aspas inválidas no CSV.');
    else value+=char;
  }
  if (quoted) fail('Há um campo entre aspas sem fechamento no CSV.');
  if (rows.length<2 || rows.length>1001) fail('Inclua de 1 a 1000 produtos no CSV.');
  return rows;
}
function csvInt(value,label) {
  if (!/^\d+$/.test(value || '')) fail(`${label} deve ser um inteiro não negativo.`);
  return integer(Number(value),label,0,1000000);
}
function csvMoney(value,label) {
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(value || '')) fail(`${label} deve ter até duas casas decimais.`);
  const [left,right='']=value.split(/[.,]/);
  return integer(Number(left)*100+Number(right.padEnd(2,'0')),label);
}
function importPlan(actor,body) {
  allow(actor,'products');
  allow(actor,'stock');
  if (!['create','update','both'].includes(body.mode)) fail('Modo de importação inválido.');
  const [header,...rows]=parseCsv(body.csv);
  const columns=header.map(value=>value.normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase());
  const fields=['codigo','nome','categoria','preco','estoque'];
  if (new Set(columns).size!==columns.length || fields.some(name=>!columns.includes(name))) fail('Cabeçalho inválido. Use codigo, nome, categoria, preco e estoque.');
  const codeCounts=new Map(),barcodeCounts=new Map();
  for (const row of rows) {
    const code=row[columns.indexOf('codigo')]?.toUpperCase();
    const barcode=row[columns.indexOf('codigo_barras')];
    codeCounts.set(code,(codeCounts.get(code)||0)+1);
    if (barcode) barcodeCounts.set(barcode,(barcodeCounts.get(barcode)||0)+1);
  }
  const plan=[],errors=[];
  for (let index=0;index<rows.length;index++) {
    try {
      const row=rows[index];
      if (row.length!==columns.length) fail('Quantidade de colunas diferente do cabeçalho.');
      const data=Object.fromEntries(columns.map((column,i)=>[column,row[i]]));
      const code=required(data.codigo,'Código',45).toUpperCase();
      const barcode=optional(data.codigo_barras,'Código de barras',60);
      if (codeCounts.get(code)>1 || barcode && barcodeCounts.get(barcode)>1) fail('Código duplicado no arquivo.');
      const old=get(`${ops.catalog} WHERE p.code=?`,code);
      if (old && body.mode==='create' || !old && body.mode==='update') fail(old?'Produto já cadastrado.':'Produto não cadastrado.');
      if (barcode && get('SELECT id FROM products WHERE barcode=? AND id<>?',barcode,old?.id ?? 0)) fail('Código de barras já cadastrado.');
      const stock=csvInt(data.estoque,'Estoque');
      if (old && stock<old.reserved) fail('O estoque fica abaixo das reservas.');
      const product={
        code,name:required(data.nome,'Nome',120),category:required(data.categoria,'Categoria',80),price:csvMoney(data.preco,'Preço'),
        stock,minimum:data.minimo ? csvInt(data.minimo,'Mínimo'):old?.minimum ?? 0,
        cost:data.custo?csvMoney(data.custo,'Custo'):old?.cost ?? null,
        barcode:columns.includes('codigo_barras')?barcode:old?.barcode ?? null,active:old?!!old.active:true,
        reason:'Importação CSV'
      };
      product.expires_on=ops.productExpiry(product.category,columns.includes('validade')?data.validade:old?.expires_on);
      plan.push({line:index+2,old,product});
    } catch (error) {
      if (!error.status) throw error;
      errors.push({line:index+2,error:error.message});
    }
  }
  const fingerprint=sha(JSON.stringify([body.mode,body.csv,plan,errors]));
  return {plan,errors,fingerprint};
}
function previewImport(actor,body) {
  return tx(()=>{
    const {plan,errors,fingerprint}=importPlan(actor,body);
    return {errors,fingerprint,rows:plan.map(({line,old,product})=>({line,action:old?'update':'create',code:product.code,name:product.name,oldStock:old?.stock ?? null,stock:product.stock,price:product.price}))};
  });
}
function applyImport(actor,body) {
  return tx(()=>{
    const {plan,errors,fingerprint}=importPlan(actor,body);
    if (errors.length || fingerprint!==body.fingerprint) fail('A prévia mudou ou há erros. Revise o arquivo antes de importar.',409);
    for (const row of plan) {
      const result=ops.saveProduct(actor,row.product,row.old?.id);
      if (row.old && row.old.stock!==row.product.stock) ops.stockMove(actor,result,row.product.stock-row.old.stock,'Importação CSV','csv');
    }
    audit(actor,'produto.importacao_csv','produto',null,null,{mode:body.mode,codes:plan.map(row=>row.product.code)},'Importação validada');
    return {applied:plan.length};
  });
}
module.exports={suppliers,saveSupplier,receive,correctTrade,count,breakpack,history,favorite,previewImport,applyImport,expiryLoss,expiryCsv};
