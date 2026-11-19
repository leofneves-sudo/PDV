import {h,icon,btn,empty,lab,input,textarea,select,moneyInput,money,num,dt,cardNumber,badge,normalize} from './ui.js';
import {permissionsFor} from './views.js';

const reason = (label='Motivo',attrs='required minlength="3"') => lab(label,textarea('reason','',`rows="2" maxlength="400" ${attrs}`),'span-two');
const numberInput = (name,value='',attrs='') => input(name,value,'inputmode="numeric" type="number" step="1" '+attrs);
const activeField = active => lab('Status',select('active',[['yes','Ativo'],['no','Inativo']],active?'yes':'no'));
const identity = id => id ? `<input type="hidden" name="id" value="${id}">` : '';
const submit = (label='Salvar',kind='primary') => `<button class="btn ${kind}" type="submit">${h(label)}</button>`;
const close = () => btn('Voltar','close-modal');
export const form = (name,body,action=submit(),footer=close()) =>
  `<form data-form="${name}"><div class="dialog-body"><div class="form-grid">${body}</div><div class="form-error" role="alert" hidden></div></div>
    <div class="dialog-actions">${footer}${action}</div></form>`;
export const body = (content,actions='') => `<div class="dialog-body">${content}</div>${actions?`<div class="dialog-actions">${actions}</div>`:''}`;
export function adminConfirm() {
  return `<details class="approval-fields span-two"><summary>Autorização do administrador</summary><div class="form-grid">
    ${lab('Usuário do administrador',input('approvalUser','','autocomplete="off" maxlength="40"'))}
    ${lab('Senha do administrador',input('approvalPassword','','type="password" autocomplete="off" maxlength="128"'))}
  </div></details>`;
}
export function approvalFrom(fields) {
  return fields.approvalUser || fields.approvalPassword ? {username:fields.approvalUser,password:fields.approvalPassword} : undefined;
}
export function productForm(product,state) {
  const p=product || {};
  return form('product',identity(p.id)+
    lab('Nome',input('name',p.name,'required maxlength="120" autofocus'),'span-two')+
    lab('Código interno',input('code',p.code,'required maxlength="45"'))+
    lab('Código de barras',input('barcode',p.barcode,'data-verbatim maxlength="60"'))+
    lab('Categoria',input('category',p.category,'required maxlength="80" list="existing-categories"')+
      `<datalist id="existing-categories">${[...new Set(state.products.map(item=>item.category))].map(name=>`<option value="${h(name)}"></option>`).join('')}</datalist>`)+
    activeField(p.active ?? true)+
    lab('Preço de venda',moneyInput('price',p.price,'required'))+lab('Custo (opcional)',moneyInput('cost',p.cost))+
    (!p.id && permissionsFor(state,'stock') ? lab('Estoque inicial',numberInput('stock',0,'min="0" max="1000000" required')):'')+
    lab('Estoque mínimo',numberInput('minimum',p.minimum ?? 0,'min="0" max="1000000" required'))+
    `<details class="approval-fields span-two"><summary>Variação TCG</summary><div class="form-grid">${[
       ['game','Jogo'],['collection','Coleção'],['collector_number','Número'],['language','Idioma'],['condition','Condição'],['rarity','Raridade']
     ].map(([key,label])=>lab(label,input(key,p[key],'maxlength="80"'))).join('')}
     ${lab('Acabamento',select('foil',[['foil','Foil'],['normal','Normal']],p.foil==null?'':p.foil?'foil':'normal','Sem classificação'))}</div></details>`+
    lab('Imagem (opcional)',input('image','','type="file" accept="image/png,image/jpeg,image/webp,image/gif"'),'span-two')+
    (p.image?'<label class="toggle-row span-two"><input type="checkbox" name="removeImage"> Remover imagem atual</label>':'')+
    (p.id?reason('Motivo (obrigatório para preço, custo ou status)',''):''));
}
export function stockForm(product) {
  return form('stock',identity(product.id)+
    `<p class="dialog-note span-two">Estoque físico de ${num(product.stock)} un. · ${num(product.reserved)} un. reservadas.</p>`+
    lab('Movimento',select('direction',[['in','Entrada'],['out','Saída']],'in'))+
    lab('Quantidade',numberInput('quantity','','required min="1" max="1000000" autofocus'))+reason()+adminConfirm(),submit('Registrar movimento'));
}
export function movementsView(rows,counts=[]) {
  const movements=rows.length?`<div class="table-scroll"><table><thead><tr><th>Data</th><th>Variação</th><th>Antes / depois</th><th>Responsável e motivo</th></tr></thead><tbody>
    ${rows.map(row=>`<tr><td>${dt(row.created_at)}</td><td>${row.amount>0?'+':''}${num(row.amount)}</td><td>${num(row.before)} / ${num(row.after)}</td><td><strong>${h(row.user_name)}</strong><small>${h(row.reason)}</small></td></tr>`).join('')}</tbody></table></div>`:empty('box','Nenhuma movimentação');
  const records=counts.length?`<h3>Conferências físicas</h3><div class="mini-list">${counts.map(row=>`<div>
    <span><strong>${dt(row.created_at)} · ${h(row.user_name)}</strong><small>${h(row.reason)}</small></span>
    <b>Registrado: ${num(row.expected)} · Contado: ${num(row.counted)}</b></div>`).join('')}</div>`:'';
  return body(movements+records,close());
}
export function customerForm(customer) {
  const c=customer || {};
  return form('customer',identity(c.id)+lab('Nome',input('name',c.name,'required maxlength="120" autofocus'),'span-two')+
    lab('Telefone',input('phone',c.phone,'type="tel" required maxlength="32"'))+
    lab('CPF/CNPJ (opcional)',input('document',c.document,'inputmode="numeric" maxlength="30"'))+
    lab('E-mail (opcional)',input('email',c.email,'type="email" maxlength="160"'))+
    lab('Nascimento (opcional)',input('birthday',c.birthday,'type="date"'))+
    lab('Observações',textarea('notes',c.notes,'rows="3" maxlength="2000"'),'span-two')+
    (c.id?activeField(c.active):'')+(c.id?reason('Motivo, em caso de alteração de status',''):''));
}
const sourceLabels={funded:'Compra de saldo',bonus:'Bonificação',adjustment:'Ajuste autorizado',card_purchase:'Compra de cartas',return:'Devolução',spend:'Uso de saldo'};
const ledgerLabels={deposit:'Recarga',use:'Pagamento',deposit_reversal:'Estorno de recarga',use_reversal:'Crédito devolvido'};
export function customerDetailView(customer,state) {
  const cfg=state.config;
  const can=key=>permissionsFor(state,key);
  const entries=customer.ledger || [];
  const reversed=new Set(entries.filter(row=>row.kind==='deposit_reversal').map(row=>row.original_id));
  return body(`<div class="customer-summary"><div><span>Total gasto líquido</span><strong>${money(customer.spent)}</strong><small>Compras: ${money(customer.grossSpent)} · Devoluções: ${money(customer.returnedSpent)}</small></div>
    <div><span>Compras</span><strong>${num(customer.count)}</strong></div><div><span>Última compra</span><strong>${dt(customer.last,false)}</strong></div>
    <div class="credit-summary"><span>Crédito disponível</span><strong>${money(customer.balance)}</strong></div></div>
    <p class="customer-info">${h(customer.phone)}${customer.email?' · '+h(customer.email):''}${customer.document?' · '+h(customer.document):''}${customer.birthday?' · '+h(customer.birthday.split('-').reverse().join('/')):''} ${badge(customer.active?'closed':'neutral',customer.active?'Ativo':'Inativo')}</p>
    ${customer.notes?`<p class="dialog-note">${h(customer.notes)}</p>`:''}
    <h3>Compras e comandas</h3>
    ${customer.purchases.length?`<div class="mini-list">${customer.purchases.map(row=>`<div><span><strong>#${row.id} · Cartão #${cardNumber(row.number)}</strong><small>${dt(row.ended_at)} · ${h(row.ended_name)}</small></span><b>${row.net==null?'—':money(row.net)}${row.returned?`<small>Devolvido ${money(row.returned)}</small>`:''}</b>${badge(row.status)}
    ${can(['history_all','history_own'])?btn('Ver','order-detail',{attrs:`data-id="${row.id}"`}):''}</div>`).join('')}</div>`:'<p class="muted">Nenhum atendimento disponível no seu histórico.</p>'}
    ${customer.ledger?`<h3>Extrato de créditos</h3>
    ${entries.length?`<div class="mini-list">${entries.map(row=>`<div><span><strong>${row.kind==='deposit' && row.original_id?'Recarga corrigida':ledgerLabels[row.kind]} #${row.id}${row.original_id?' · ref. #'+row.original_id:''}</strong>
      <small>${dt(row.created_at)} · ${h(row.user_name)} · ${h(sourceLabels[row.source])}${cfg.origins[row.origin]?' · '+h(cfg.origins[row.origin]):''}</small><small>${h(row.reason)}</small></span>
      <b class="${row.amount>0?'positive':'negative'}">${row.amount>0?'+ ':''}${money(row.amount)}</b>
      ${row.kind==='deposit'&&row.source==='card_purchase'&&row.merchandise_id&&can('suppliers')?
        btn('Ver compra','ext-trade-detail',{attrs:`data-id="${row.merchandise_id}"`}):''}
      ${row.kind==='deposit'&&row.source!=='card_purchase'&&!reversed.has(row.id)?`${can('credit_correct')&&row.source==='funded'?btn('Corrigir','credit-correct',{attrs:`data-id="${row.id}"`}):''}
        ${can('credit_reverse')?btn('Estornar','credit-reverse',{attrs:`data-id="${row.id}" data-customer="${customer.id}"`}):''}`:''}</div>`).join('')}</div>`:'<p class="muted">Nenhuma movimentação de crédito.</p>'}`:''}`,
    `${close()}${can('customers')?btn('Editar','customer-edit',{ico:'pencil',attrs:`data-id="${customer.id}"`}):''}
    ${can('customer_read')&&customer.active?btn('Adicionar crédito','credit-add',{ico:'plus',cls:'primary',attrs:`data-id="${customer.id}"`}):''}`);
}
export function depositForm(customer,cfg) {
  return form('deposit',identity(customer.id)+lab('Valor',moneyInput('amount',null,'required autofocus'))+
    lab('Origem do crédito',select('source',[['funded','Compra de saldo'],['bonus','Bonificação'],['adjustment','Ajuste autorizado']],'funded',null,'id="deposit-source"'))+
    lab('Forma de recebimento',select('origin',Object.entries(cfg.origins),'','Selecione','id="deposit-origin" required'))+reason()+adminConfirm(),
  submit('Registrar recarga'));
}
export function correctCreditForm(entry,cfg) {
  return form('credit-correct',identity(entry.id)+lab('Valor correto',moneyInput('amount',entry.amount,'required autofocus'))+
    lab('Forma correta de recebimento',select('origin',Object.entries(cfg.origins),entry.origin,null,'required'))+
    '<p class="dialog-note span-two">A recarga original será estornada e substituída por um lançamento vinculado no extrato.</p>'+
    reason('Motivo da correção'),submit('Registrar correção'));
}
export function userForm(user,cfg) {
  const row=user || {role:'operator',active:true,permissions:cfg.defaults};
  return form('user',identity(row.id)+lab('Nome',input('name',row.name,'required maxlength="120" autofocus'))+
    lab('Usuário',input('username',row.username,'required minlength="3" maxlength="40" autocomplete="off"'))+
    lab('Perfil',select('role',[['operator','Operador'],['admin','Administrador']],row.role,null,'id="user-role"'))+activeField(row.active)+
    lab('Limite de desconto por comanda',moneyInput('discount_limit',row.discount_limit || 0,'required'))+
    lab(row.id?'Nova senha (opcional)':'Senha',input('password','','type="password" autocomplete="new-password" minlength="10" maxlength="128" '+(row.id?'':'required')),'span-two')+
    `<fieldset class="permission-grid span-two" id="permissions-field" ${row.role==='admin'?'hidden':''}><legend>Permissões do operador</legend>
    ${Object.entries(cfg.permissions).map(([key,label])=>`<label class="toggle-row"><input type="checkbox" name="allow-${key}" ${row.permissions[key]?'checked':''}>${h(label)}</label>`).join('')}</fieldset>`);
}
export function cardsForm() {
  return form('card-create',lab('Primeiro número',numberInput('start','','required min="1" max="999999" autofocus'))+
    lab('Quantidade',numberInput('count',1,'required min="1" max="100"')),submit('Criar cartões'));
}
export function terminalForm(pairing,code=null) {
  return form('terminal',lab('Nome do caixa',input('name',code?.name || 'Caixa 1','required maxlength="60" minlength="2" autofocus'),'span-two')+
    `<p class="dialog-note span-two">No celular, abra o leitor e informe o código. Ele dura dois minutos e pode ser usado uma vez.</p>
    ${code?`<div class="pair-code span-two"><span>Código de pareamento</span><strong>${h(code.code)}</strong><small id="pair-expiry"></small></div>`:''}
    ${pairing.readers.length?`<div class="span-two active-readers"><strong>Leitores vinculados</strong><p>${pairing.readers.map(row=>`${h(row.name)} (${row.count})`).join(' · ')}</p>${btn('Desvincular todos','revoke-readers',{ico:'x'})}</div>`:''}`,submit(code?'Gerar outro código':'Gerar código'));
}
export function readerForm() {
  return form('pair-reader',lab('Código do caixa',input('code','','required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000" autofocus'),'span-two'),submit('Vincular celular'));
}
export function pickerRows(state,term) {
  const key=normalize(term);
  return state.customers.filter(customer=>customer.active && [customer.name,customer.phone,customer.document].some(value=>normalize(value).includes(key)))
    .map(customer=>`<button type="button" class="customer-choice" data-action="pick-customer" data-id="${customer.id}"><span><strong>${h(customer.name)}</strong><small>${h(customer.phone)}</small></span><b>${money(customer.balance)}</b></button>`).join('') || '<p class="muted">Nenhum cliente ativo encontrado.</p>';
}
export function orderCustomer(state) {
  return body(`${lab('Buscar cliente',input('customer','', 'id="customer-picker" placeholder="Nome, telefone ou documento" autofocus'))}
    <div class="customer-choices" id="customer-choices">${pickerRows(state,'')}</div>`,
    `${close()}${state.card.order.customer_id?btn('Desvincular cliente','pick-customer'):''}
    ${permissionsFor(state,'customer_create')?btn('Cadastrar cliente','customer-edit',{ico:'plus',cls:'primary',attrs:'data-in-order="true"'}):''}`);
}
export function itemForm(mode,item,state) {
  const actions = {price:'Salvar preço',quantity:'Salvar quantidade',minus:'Reduzir quantidade',remove:'Remover item'};
  const edit = mode==='price' ? lab('Novo preço unitário',moneyInput('value',item.price,'required autofocus'),'span-two') :
    mode==='quantity'?lab('Nova quantidade',numberInput('value',item.quantity,
      `min="${permissionsFor(state,'item_remove')?0:permissionsFor(state,'item_reduce')?1:item.quantity}" max="100000" required autofocus`),'span-two'):'';
  return form('item',identity(item.id)+`<input type="hidden" name="mode" value="${mode}"><p class="dialog-note span-two">${h(item.name)} · ${num(item.quantity)} un. · ${money(item.price)} por unidade</p>`+
    edit+reason(mode==='quantity'?'Motivo (obrigatório para remover)':'Motivo',mode==='quantity'?'':'required minlength="3"'),submit(actions[mode],mode==='remove'?'danger-btn':'primary'));
}
export function discountForm(order) {
  return form('discount',lab('Valor do desconto',moneyInput('value',order.discount,'required autofocus'),'span-two')+reason()+adminConfirm(),submit('Aplicar desconto'));
}
export function confirmation(name,text,id,action,hidden='') {
  return form(name,identity(id)+hidden+`<p class="dialog-note span-two">${h(text)}</p>`+reason()+(name==='cancel-order'?adminConfirm():''),submit(action,'danger-btn'));
}
export function paymentView(order,cfg) {
  const open=order.total-order.confirmed-order.pending;
  const states={pending:'Aguardando confirmação',confirmed:'Confirmado',void:'Cancelado'};
  return `<form data-form="checkout"><div class="dialog-body">
    <div class="payment-hero"><span>Total da comanda #${cardNumber(order.number)}</span><strong>${money(order.total)}</strong></div>
    ${order.payments.length?`<h3>Parcelas registradas</h3><div class="mini-list">
      ${order.payments.map(payment=>`<div><span><strong>${h(cfg.methods[payment.method])} · ${states[payment.state]}</strong>
        <small>${h(payment.payer || 'Sem nome')}${payment.shift_id?' · Turno #'+payment.shift_id:''}${payment.method==='cash'?' · Troco '+money(payment.change):''}</small></span><b>${money(payment.amount)}</b>
        ${payment.state==='pending'?btn('Confirmar PIX','ext-payment-pix',{attrs:`data-id="${payment.id}"`}):''}
        ${payment.state==='void'?'':btn('Cancelar parcela','ext-payment-void',{attrs:`data-id="${payment.id}"`})}</div>`).join('')}</div>`:''}
    ${open>0 ? `<div class="payment-inputs">
      ${lab('Pessoa que paga esta parcela (opcional)',input('payer','','maxlength="100" placeholder="Ex. Ana"'))}
      <details class="approval-fields"><summary>Dividir o saldo entre pessoas</summary><div class="form-grid">
        ${lab('Quantidade de pessoas',numberInput('people',2,'min="2" max="99"'))}
        ${lab('Valor por pessoa',`<output id="share-value">${money(Math.floor(open/2))}</output>`)}
      </div></details>
      <p class="dialog-note">Registre os valores já recebidos. Para PIX, confirme no extrato antes de concluir.</p>
      ${Object.entries(cfg.methods).map(([key,name])=>`<div class="payment-row">
        <div class="payment-label"><span class="small-icon">${icon(key==='cash'?'wallet':key==='store'?'ticket':'credit',20)}</span><span><strong>${h(name)}</strong>
        ${key==='pix'?'<small>Confirmação manual</small>':''}
        ${key==='store'?`<small>${order.customer_id?`Saldo: ${money(order.balance)}`:'Vincule um cliente para usar'}</small>`:''}</span></div>
        ${lab('Parcela',moneyInput(key,null,`data-payment="${key}" ${key==='store'&&!order.balance?'disabled':''}`))}
        ${btn(key==='store'?'Usar saldo':'Restante','fill-payment',{attrs:`data-method="${key}" ${key==='store'&&!order.balance?'disabled':''}`})}
      </div>`).join('')}
      ${lab('Valor entregue em dinheiro',moneyInput('received',null,'id="cash-received" disabled'),'cash-received')}</div>`:''}
    <div class="payment-summary"><div><span>Confirmado</span><strong id="payments-value">${money(order.confirmed)}</strong></div>
      <div><span>Saldo restante</span><strong id="payments-remaining">${money(order.total-order.confirmed)}</strong><small id="payments-pending"></small></div>
      <div class="change-box"><span>Troco em dinheiro</span><strong id="cash-change">${money(0)}</strong></div></div>
    <div class="form-error" role="alert" hidden></div></div><div class="dialog-actions">${close()}
      ${open>0?'<button class="btn outline" type="submit" id="register-payment" value="partial" disabled>Registrar parcela</button>':''}
      <button class="btn primary" type="submit" id="confirm-checkout" value="close" disabled>${icon('check',19)} Fechar comanda</button></div></form>`;
}
function orderData(order,cfg,print=false) {
  return `<div class="${print?'receipt-print':'order-detail'}">
    ${print?'<h2>Balcão PDV</h2><p>Comprovante não fiscal</p>':badge(order.status)}
    <p><strong>Atendimento #${order.id} · Cartão #${cardNumber(order.number)}</strong></p>
    <div class="detail-meta"><span>Abertura <strong>${dt(order.opened_at)} · ${h(order.opened_name)}</strong></span>
    <span>Encerramento <strong>${dt(order.ended_at)} · ${h(order.ended_name)}</strong></span>
    ${order.customer_name ? `<span>Cliente <strong>${h(order.customer_name)}</strong></span>`:''}
    ${order.refunded_at ? `<span>Estorno <strong>${dt(order.refunded_at)}${order.refunded_name?' · '+h(order.refunded_name):''}</strong></span>`:''}</div>
    <div class="table-scroll"><table><thead><tr><th>Item</th><th>Qtd.</th><th>Unitário</th><th>Subtotal</th></tr></thead><tbody>
      ${order.items.map(item=>`<tr><td>${h(item.name)}</td><td>${num(item.quantity)}</td><td>${money(item.price)}</td><td>${money(item.subtotal)}</td></tr>`).join('')}</tbody></table></div>
    <div class="receipt-totals"><div><span>Subtotal</span><b>${money(order.subtotal)}</b></div><div><span>Desconto</span><b>${money(order.discount)}</b></div>
    <div class="grand"><span>Total</span><b>${money(order.total)}</b></div>
    ${order.payments.filter(payment=>print?payment.state==='confirmed':true).map(payment=>`<div><span>${h(cfg.methods[payment.method])}${payment.payer?' · '+h(payment.payer):''}${!print&&payment.state==='void'?' · Cancelado':''}</span><b>${money(payment.amount)}</b></div>
      ${payment.method==='cash'?`<div><span>Dinheiro recebido</span><b>${money(payment.received)}</b></div><div class="change-line"><span>Troco</span><b>${money(payment.change)}</b></div>`:''}`).join('')}</div>
    ${!print&&order.returns?.length?`<h3>Devoluções</h3><div class="mini-list">
      ${order.returns.map(entry=>`<div><span><strong>#${entry.id} · ${money(entry.amount)}</strong><small>${dt(entry.created_at)} · ${h(entry.user_name)}${entry.approved_name?' · Aprovado por '+h(entry.approved_name):''}</small><small>${h(entry.reason)}</small>
      <small>${entry.items.map(line=>`${line.quantity} × ${h(order.items.find(item=>item.id===line.item_id)?.name)} · ${line.restock?'reposto':'sem reposição'}`).join(' / ')}</small>
      <small>${entry.payments.map(p=>`${h(cfg.methods[p.method])} ${money(p.amount)}`).join(' · ')}</small>
      ${entry.exchange_order_id?`<small>Atendimento da troca #${entry.exchange_order_id}</small>`:''}</span></div>`).join('')}</div>`:''}
    ${order.merged_into?`<p>Unida ao atendimento #${order.merged_into}.</p>
      ${order.transferredPayments?.map(p=>`<p>${h(cfg.methods[p.method])} · ${money(p.amount)} · Transferido para #${p.order_id}</p>`).join('') || ''}`:''}
    ${order.notes?`<p><strong>Observações</strong> ${h(order.notes)}</p>`:''}${order.reason?`<p><strong>Motivo</strong> ${h(order.reason)}</p>`:''}</div>`;
}
export function orderDetailView(order,state) {
  const print=order.status==='closed';
  return body(orderData(order,state.config),
    `${close()}${print&&permissionsFor(state,['history_own','history_all'])?btn('Registrar devolução','ext-refund',{cls:'danger',attrs:`data-id="${order.id}"`}):''}
    ${print?btn('Imprimir comprovante','receipt-print',{ico:'printer',cls:'primary'}):''}`);
}
export const receipt = (order,cfg) => orderData(order,cfg,true);
export function auditDetail(row) {
  function render(value) {
    if (!value) return '—';
    try {return h(JSON.stringify(JSON.parse(value),null,2));}
    catch {return h(value);}
  }
  return body(`<div class="detail-meta"><span>Data e hora <strong>${dt(row.created_at)}</strong></span><span>Responsável <strong>${h(row.user_name)}</strong></span>
    ${row.approved_name?`<span>Aprovador <strong>${h(row.approved_name)}</strong></span>`:''}
    <span>Ação <strong>${h(row.action)}</strong></span><span>Registro <strong>${h(row.entity)} ${row.entity_id?'#'+row.entity_id:''}</strong></span></div>
    ${row.reason?`<p class="dialog-note">${h(row.reason)}</p>`:''}
    <div class="audit-json"><div><h3>Antes</h3><pre>${render(row.before)}</pre></div><div><h3>Depois</h3><pre>${render(row.after)}</pre></div></div>`,close());
}
