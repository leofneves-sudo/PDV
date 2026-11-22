import {h,btn,icon,header,empty,lab,input,select,dt,money,num,moneyInput,cents,cardNumber,humanDay} from './ui.js';
import * as modals from './modals.js';
import {dashboardFilters} from './views.js';

const qty=(name,value='',attrs='required min="0"')=>input(name,value,'type="number" inputmode="numeric" step="1" '+attrs);
const field=(label,name,rows,value=null,placeholder='Selecione')=>lab(label,select(name,rows,value,placeholder,'required'));
const reason=(label='Motivo',attrs='required minlength="3"')=>lab(label,input('reason','',attrs+' maxlength="400"'),'span-two');
const hidden=(name,value)=>`<input type="hidden" name="${name}" value="${h(value)}">`;
const action=(label,key,data={},ico='',cls='')=>btn(label,'ext-'+key,{ico,cls,attrs:Object.entries(data).map(([name,value])=>`data-${name}="${h(value)}"`).join(' ')});
const confirm=(label,cls='primary')=>`<button class="btn ${cls}" type="submit">${h(label)}</button>`;
const form=(name,fields,label='Salvar')=>modals.form('ext-'+name,fields,confirm(label));
const text=value=>h(value ?? '—');
const can=(state,key)=>!!state.me.permissions[key];
const tr=(...cells)=>`<tr>${cells.map(value=>`<td>${value}</td>`).join('')}</tr>`;
const table=(headers,rows,title='Nenhum registro')=>rows.length ?
  `<div class="table-scroll"><table><thead><tr>${headers.map(name=>`<th scope="col">${h(name)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`:
  empty('clipboard',title);
const panel=(name,content,buttons='')=>`<section class="panel"><div class="panel-heading"><h2>${h(name)}</h2>${buttons?'<div class="head-actions">'+buttons+'</div>':''}</div>${content}</section>`;
const details=(name,content)=>`<details class="panel report-details"><summary>${h(name)}</summary>${content}</details>`;
const moneyMetric=(label,value,note='')=>`<article class="metric"><div class="metric-top">${h(label)}</div><strong>${money(value)}</strong>${note?`<div class="metric-detail">${h(note)}</div>`:''}</article>`;
const method=(cfg,value)=>text(cfg.methods[value] || cfg.origins[value] || value);

function shiftSummary(shift,state) {
  const s=shift.summary, cfg=state.config;
  const names={supply:'Suprimento',withdrawal:'Sangria',adjustment:'Ajuste posterior'};
  return `<div class="metric-grid ext-metrics">
      ${moneyMetric('Fundo inicial',shift.opening)}
      ${moneyMetric('Dinheiro esperado',s.expected)}
      ${shift.closed_at?moneyMetric('Valor contado',shift.counted)+moneyMetric('Diferença no fechamento',shift.difference):''}
    </div>${shift.closed_at?`<p class="dialog-note">No fechamento, o valor esperado era ${money(shift.expected)}. ${text(shift.reason || '')}</p>`:''}
    <div class="dashboard-detail">
      ${panel('Parcelas de atendimento',table(['Forma','Valor','Entregue','Troco'],s.receipts.map(row=>tr(method(cfg,row.method),money(row.amount),row.method==='cash'?money(row.received):'—',row.method==='cash'?money(row.change):'—'))))}
      ${panel('Cargas de créditos',table(['Forma','Recebido','Estornado'],s.loads.map(row=>tr(method(cfg,row.method),money(row.added),money(row.reversed)))))}
      ${panel('Devoluções',table(['Forma','Valor'],s.refunds.map(row=>tr(method(cfg,row.method),money(row.amount)))))}
      ${panel('Movimentos em espécie',table(['Tipo','Valor','Operador','Motivo'],s.movements.map(row=>tr(names[row.kind],money(row.amount),text(row.user_name),text(row.reason)))))}
    </div>`;
}
export function cashPage(state) {
  const data=state.cash, current=data.current;
  return `${header('Caixa e turnos','Controle entradas, conferência e fechamento em espécie.',
    (!current?action('Abrir turno','shift-open',{},'plus','primary'):'')+(can(state,'cash_manage')?action('Cadastrar caixa','register',{},'terminal'):''))}
    ${current?panel(`${current.register_name} · Turno #${current.id}`,shiftSummary(current,state),
      action('Suprimento','cash-move',{id:current.id,kind:'supply'},'plus')+
      action('Sangria','cash-move',{id:current.id,kind:'withdrawal'},'minus')+
      action('Fechar turno','shift-close',{id:current.id},'lock','primary')):
      '<div class="notice ext-space">Abra um turno para registrar pagamentos, cargas de crédito e devoluções.</div>'}
    ${panel('Turnos registrados',table(['Caixa e turno','Operador','Abertura','Fechamento','Diferença',''],data.history.map(row=>tr(
      `${text(row.register_name)} · #${row.id}`,text(row.opened_name),dt(row.opened_at),dt(row.closed_at),row.closed_at?money(row.difference):'Aberto',
      action('Detalhes','shift-detail',{id:row.id})))))}`;
}
export function suppliesPage(state) {
  const product=(row)=>`${text(row.product_name)}<small>${row.supplier_name?text(row.supplier_name):'Compra de '+text(row.customer_name)}</small>`;
  return `${header('Compras e fornecedores','Registre entradas de mercadoria e compras de cartas com crédito.',
    action('Entrada de fornecedor','receive',{},'plus','primary')+
    (can(state,'customer_read')?action('Comprar cartas do cliente','trade',{},'wallet'):'')+action('Novo fornecedor','supplier',{},'plus'))}
    <div class="dashboard-detail">
      ${panel('Fornecedores',table(['Fornecedor','Contato','Status',''],state.suppliers.map(row=>tr(text(row.name),text(row.contact),row.active?'Ativo':'Inativo',action('Editar','supplier',{id:row.id})))))}
      ${panel('Entradas registradas',table(['Produto','Qtd.','Custo un.','Data','Referência','Ações'],state.merchandise.map(row=>tr(
        product(row),num(row.quantity),money(row.unit_cost),dt(row.created_at),text(row.reason),
        row.customer_id?action(row.correction_id?'Ver correção':'Ver compra','trade-detail',{id:row.id}):''))))}
    </div>`;
}
export function backupsPage(state) {
  const b=state.backups;
  return `${header('Backups','Verifique as cópias e a possibilidade de recuperação.',action('Gerar backup agora','backup',{},'export','primary'))}
    ${b.error?`<div class="notice error ext-space" role="alert">${text(b.error)}</div>`:''}
    ${panel('Estado dos backups',`<div class="dialog-body detail-meta">
      <span>Último bem-sucedido <strong>${dt(b.lastSuccessful)}</strong></span><span>Última cópia local <strong>${dt(b.lastLocal)}</strong></span>
      <span>Última cópia externa <strong>${b.externalConfigured?dt(b.lastExternal):'Destino externo pendente de configuração'}</strong></span>
      <span>Frequência <strong>${b.interval?`${b.interval} min`:'Automático desativado'}</strong></span><span>Arquivo local <strong>${text(b.file)}</strong></span>
    </div>`)}`;
}
export function managementPage(state) {
  const r=state.management,v=r.indicators,cfg=state.config;
  const paymentRows=r.receipts.map(row=>tr(dt(row.at),`${text(row.label)} #${row.id}${row.order_id?`<small>Atendimento #${row.order_id}</small>`:''}`,
    method(cfg,row.method),money(row.amount),row.shift_id?`#${row.shift_id}`:'Legado',text(row.actor),
    row.review?.reviewed?`Conferido <small>${text(row.review.user_name)} · ${text(row.review.reason)}</small>`:'A conferir',
    r.canReconcile?action(row.review?.reviewed?'Reabrir':'Conferir','reconcile',{id:row.id,entity:row.entity,reviewed:row.review?.reviewed?'no':'yes'}):''));
  return `${header('Conferência gerencial','Acompanhe recebimentos, caixa, créditos e reposição.',
    btn('Voltar à visão geral','navigate',{attrs:'data-view="dashboard"'})+action('Exportar CSV','management-export',{},'export','primary'))}
    ${dashboardFilters(state)}
    <div class="period-caption">${icon('calendar',17)} ${humanDay(r.period.start)} a ${humanDay(r.period.end)}</div>
    <div class="metric-grid ext-space">
      ${moneyMetric('Vendas brutas do período',v.grossSales)}
      ${moneyMetric('Devoluções pela data da ocorrência',v.refundValue)}
      ${moneyMetric('Líquido atualizado das vendas originais',v.netSales)}
      ${moneyMetric('Recebimentos de atendimentos',v.receipts,`Período anterior: ${money(v.previousReceipts)}`)}
      ${moneyMetric('Fluxo financeiro líquido',v.netFinancial,'Inclui cargas e devoluções')}
      ${moneyMetric('Dinheiro esperado em caixas abertos',v.cashExpected)}
      ${moneyMetric('Diferenças de fechamento',v.difference)}
      ${moneyMetric('Cargas de créditos',v.funded)}
      ${moneyMetric('Créditos sem recebimento',v.granted)}
      ${moneyMetric('Utilização de créditos',v.used)}
    </div>
    ${r.total>r.pageSize?`<div class="pagination ext-space"><span>Página ${r.page} de ${Math.ceil(r.total/r.pageSize)} · Listas de recebimentos, créditos e operações</span>
      ${r.page>1?action('Anterior','management-page',{page:r.page-1}):''}
      ${r.page*r.pageSize<r.total?action('Próxima','management-page',{page:r.page+1}):''}</div>`:''}
    ${details(`Recebimentos, devoluções e conferência (${num(r.receiptsCount)})`,table(['Data','Registro','Forma','Valor','Turno','Operador','Conferência',''],paymentRows))}
    ${details('Caixas e diferenças',table(['Caixa','Turno','Operador','Fechamento','Esperado','Contado','Diferença'],r.shifts.map(row=>tr(text(row.register_name),`#${row.id}`,text(row.opened_name),dt(row.closed_at),money(row.closed_at?row.expected:row.currentExpected),row.closed_at?money(row.counted):'—',row.closed_at?money(row.difference):'—'))))}
    ${details('Movimentações de créditos',table(['Data','Registro','Cliente','Origem','Valor','Operador'],r.credit.map(row=>tr(dt(row.created_at),`#${row.id}`,`#${row.customer_id}`,text(row.label),money(row.amount),text(row.user_name)))))}
    ${details('Curva ABC por faturamento',table(['Produto','Classe','Vendas','Acumulado'],r.abc.map(row=>tr(text(row.name),row.band,money(row.amount),`${row.share.toFixed(1)}%`))))}
    <form data-form="ext-stock-days" class="filter-strip ext-space">${lab('Dias usados para produtos parados e reposição',qty('days',r.stockDays,'required min="1" max="730"'))}${confirm('Aplicar')}</form>
    ${details('Produtos parados e sugestão de reposição',table(['Produto','Disponível','Vendas no intervalo','Última venda','Repor'],[...r.stock].sort((a,b)=>b.suggested-a.suggested).map(row=>tr(
      `${text(row.name)}<small>${text(row.code)}${row.units?'':' · Sem venda no intervalo'}</small>`,num(row.available),num(row.units),dt(row.last),num(row.suggested)))))}
    ${details('Descontos e cancelamentos por operador',table(['Operador','Descontos líquidos','Cancelamentos'],r.operators.map(row=>tr(text(row.name),money(row.discounts),num(row.cancellations)))))}
    ${details('Registros de descontos e cancelamentos',table(['Data','Atendimento','Operador','Aprovador','Ação','Motivo'],r.audits.map(row=>tr(dt(row.created_at),`#${row.entity_id}`,text(row.user_name),text(row.approved_name),row.action==='comanda.desconto'?'Desconto':'Cancelamento',text(row.reason)))))}`;
}

export function refundForm(order,state) {
  const counts=new Map();
  for (const entry of order.returns || []) for (const line of entry.items) counts.set(line.item_id,(counts.get(line.item_id)||0)+line.quantity);
  const exchange=[...state.scanned.values()].filter(card=>card.order && (!order.customer_id || !card.order.customer_id || card.order.customer_id===order.customer_id));
  return form('refund',`<p class="dialog-note span-two">As parcelas devolvidas seguem as formas da venda original. Dinheiro, PIX e cartões devem ser devolvidos pelo meio usado na venda.</p>
    ${order.items.filter(line=>line.quantity>(counts.get(line.id)||0)).map(line=>{
      const left=line.quantity-(counts.get(line.id)||0);
      return `<div class="ext-line span-two"><strong>${text(line.name)}<small>Disponível para devolver: ${left}</small></strong>
        ${lab('Quantidade',qty('item-'+line.id,0,`min="0" max="${left}"`))}
        <label class="toggle-row"><input type="checkbox" name="restock-${line.id}"> Volta ao estoque</label></div>`;
    }).join('')}`+
    (exchange.length?lab('Atendimento da troca (opcional)',select('exchange',exchange.map(card=>[card.order.id,`#${cardNumber(card.number)} · ${card.order.customer_name || 'Sem cliente'}`]),null,'Apenas devolver'),'span-two'):'')+
    reason()+modals.adminConfirm(),'Registrar devolução');
}
function transferForm(state,order,mode) {
  const cards=[...state.scanned.values()].filter(card=>card.id!==order.card_id && (mode==='split'?!card.order:!!card.order));
  if (!cards.length) return modals.body('<p>Leia o QR de outro cartão antes de continuar. Para dividir, use um cartão livre. Para transferir ou unir, abra o atendimento no cartão de destino.</p>',btn('Voltar','close-modal'));
  return form('transfer',hidden('mode',mode)+field('Cartão de destino','target',cards.map(card=>[card.id,`#${cardNumber(card.number)} · ${card.order?.customer_name || (card.order?'Sem cliente':'Livre')}`]))+
    '<p class="dialog-note span-two">Na transferência e na divisão, os valores já registrados ficam no cartão de origem. A união leva as parcelas inteiras ao destino.</p>'+
    (mode==='merge'?'':order.items.map(line=>lab(line.name,qty('item-'+line.id,0,`min="0" max="${line.quantity}"`))).join(''))+reason(),'Confirmar operação');
}
const titles={transfer:'Transferir itens',split:'Dividir comanda',merge:'Unir comandas'};
function selectedItems(order,fields) {
  return order.items.map(row=>({item:row.id,quantity:Number(fields['item-'+row.id] || 0),restock:fields['restock-'+row.id]==='on'})).filter(row=>row.quantity>0);
}
function requestId(context,body) {
  const {approval,...intent}=body;
  const fingerprint=JSON.stringify(intent);
  if (context.requestFingerprint!==fingerprint) {
    context.requestFingerprint=fingerprint;
    context.requestId=Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
  }
  return context.requestId;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
async function localFingerprint(raw) {
  const bytes=new TextEncoder().encode(raw);
  if (crypto.subtle) {
    const hash=await crypto.subtle.digest('SHA-256',bytes);
    return Array.from(new Uint8Array(hash),n=>n.toString(16).padStart(2,'0')).join('');
  }
  // O índice local identifica a tentativa. O servidor sempre verifica o SHA-256 dos dados.
  let hash=0x6c62272e07bb014262b821756295c58dn;
  const prime=0x1000000000000000000013bn, mask=(1n<<128n)-1n;
  for (const byte of bytes) hash=((hash^BigInt(byte))*prime)&mask;
  return hash.toString(16).padStart(32,'0');
}
export async function protectedSend(ctx,path,body,context) {
  const user=ctx.state.me.id;
  const {approval,...payload}=body;
  const fingerprint=await localFingerprint(JSON.stringify(canonical(payload)));
  if (ctx.state.me?.id!==user) throw Error('A sessão mudou. Confira os registros antes de continuar.');
  const key=`pdv.intent.${user}.${path}.${fingerprint}`;
  const token=context.protectedIntent?.key===key ? context.protectedIntent.token : sessionStorage.getItem(key) ||
    Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
  context.protectedIntent={key,token};
  sessionStorage.setItem(key,token);
  const result=await ctx.send(path,{...body,request_id:token});
  if (sessionStorage.getItem(key)===token) sessionStorage.removeItem(key);
  return result;
}
export {requestId};
export async function act(ctx,key,element) {
  const {state,show,api,close,reload,send,toast,order:orderShown}=ctx;
  const id=Number(element.dataset.id)||null;
  const order=state.card?.order;
  const product=state.products.find(row=>row.id===id);
  switch (key) {
    case 'register': return show('Cadastrar caixa',form('register',lab('Nome',input('name','','required minlength="2" maxlength="60" autofocus'),'span-two')));
    case 'shift-open':
      return show('Abrir turno',form('shift-open',field('Caixa','register',state.cash.registers.filter(row=>!row.shift_id).map(row=>[row.id,row.name]))+
        lab('Fundo inicial',moneyInput('opening',0,'required')), 'Abrir turno'));
    case 'shift-detail': {
      const shift=await api('shifts/'+id);
      const buttons=btn('Voltar','close-modal')+(shift.closed_at&&can(state,'cash_manage')?action('Registrar ajuste','cash-move',{id,kind:'adjustment'}):
        !shift.closed_at?action('Fechar turno','shift-close',{id},'lock','primary'):'');
      return show(`${shift.register_name} · Turno #${shift.id}`,modals.body(shiftSummary(shift,state),buttons),{wide:true});
    }
    case 'shift-close': {
      const shift=await api('shifts/'+id);
      return show('Fechar turno',form('shift-close',hidden('id',id)+`<p class="dialog-note span-two">Esperado em caixa: ${money(shift.summary.expected)}. As comandas abertas podem continuar no próximo turno.</p>`+
        lab('Total contado em dinheiro',moneyInput('counted',null,'required'))+reason('Motivo, se houver diferença',''),'Confirmar fechamento'),{shift});
    }
    case 'cash-move': {
      const kind=element.dataset.kind;
      return show({supply:'Suprimento',withdrawal:'Sangria',adjustment:'Ajuste posterior'}[kind],
        form('cash-move',hidden('id',id)+hidden('kind',kind)+lab('Valor',moneyInput('amount',null,'required'))+(kind==='adjustment'?field('Efeito','direction',[['in','Aumentar esperado'],['out','Diminuir esperado']],'in',null):'')+reason(),'Registrar movimento'));
    }
    case 'supplier': {
      const supplier=state.suppliers.find(row=>row.id===id) || {};
      return show(id?'Editar fornecedor':'Cadastrar fornecedor',form('supplier',hidden('id',id || '')+
        lab('Nome',input('name',supplier.name,'required maxlength="120" autofocus'),'span-two')+
        lab('CPF/CNPJ',input('document',supplier.document,'maxlength="30"'))+lab('Contato',input('contact',supplier.contact,'maxlength="120"'))+
        lab('Observações',input('notes',supplier.notes,'maxlength="1000"'),'span-two')+
        field('Status','active',[['yes','Ativo'],['no','Inativo']],supplier.active===0?'no':'yes',null)));
    }
    case 'receive':
    case 'trade': {
      const trade=key==='trade';
      const customers=trade?await api('customers'):[];
      const products=state.products.filter(row=>row.active).map(row=>[row.id,`${row.name} · ${row.code}`]);
      const source=trade?field('Cliente','customer',customers.filter(row=>row.active).map(row=>[row.id,row.name])):
        field('Fornecedor','supplier',state.suppliers.filter(row=>row.active).map(row=>[row.id,row.name]));
      return show(trade?'Comprar cartas com crédito':'Entrada de mercadoria',form('receive',source+
        field('Produto','product',products)+lab('Quantidade',qty('quantity',1,'required min="1"'))+lab('Custo unitário',moneyInput('cost',null,'required'))+
        reason('Motivo ou referência')+(trade?modals.adminConfirm():''),'Registrar entrada'));
    }
    case 'trade-detail': {
      const trade=await api('merchandise/'+id);
      return show('Compra de cartas #'+id,modals.body(`<div class="detail-meta">
        <span>Cliente <strong>${text(trade.customer_name)}</strong></span><span>Produto <strong>${text(trade.product_name)}</strong></span>
        <span>Quantidade <strong>${num(trade.quantity)}</strong></span><span>Crédito original <strong>${money(trade.quantity*trade.unit_cost)}</strong></span>
        <span>Referência <strong>${text(trade.reason)}</strong></span></div>
        ${trade.correction_id?`<p>Correção #${trade.correction_id}${trade.replacement_id?' · Nova compra #'+trade.replacement_id:''}</p>`:''}
        ${trade.original_id?`<p>Substitui a compra #${trade.original_id}.</p>`:''}
        ${trade.credit_reversed&&!trade.correction_id?'<p class="notice">Há um estorno anterior do crédito. A correção fará a conferência e o ajuste do estoque.</p>':''}`,
        btn('Voltar','close-modal')+(trade.correction_id?'':action('Estornar compra','trade-correct',{id,mode:'reverse'})+
          action('Corrigir compra','trade-correct',{id,mode:'replace'},'pencil','primary'))));
    }
    case 'trade-correct': {
      const mode=element.dataset.mode, trade=await api('merchandise/'+id);
      const products=mode==='replace'?await api('products'):[];
      return show(mode==='replace'?'Corrigir compra de cartas':'Estornar compra de cartas',form('trade-correct',
        hidden('id',id)+hidden('mode',mode)+`<p class="dialog-note span-two">${text(trade.product_name)} · ${num(trade.quantity)} unidades · ${money(trade.quantity*trade.unit_cost)} em crédito. A correção trata estoque e extrato juntos.</p>`+
        (mode==='replace'?field('Produto correto','product',products.filter(row=>row.active).map(row=>[row.id,`${row.code} · ${row.name}`]),trade.product_id)+
          lab('Quantidade correta',qty('quantity',trade.quantity,'required min="1"'))+lab('Custo unitário correto',moneyInput('cost',trade.unit_cost,'required')):'')+
        reason()+modals.adminConfirm(),'Confirmar correção'),{trade});
    }
    case 'count':
      return show('Conferência física',form('count',hidden('id',id)+
        `<p class="dialog-note span-two">${text(product.name)} · Estoque registrado de ${product.stock} · ${product.reserved} reservadas</p>`+
        lab('Total físico contado',qty('counted',product.stock))+reason()+modals.adminConfirm(),'Salvar contagem'),{product});
    case 'breakpack':
      return show('Desmembrar produto',form('breakpack',`<p class="dialog-note span-two">Produtos com validade precisam estar dentro do prazo e ter a mesma data na origem e no destino.</p>`+field('Produto consumido','source',state.products.filter(row=>row.active).map(row=>[row.id,row.name]),id)+
        field('Produto gerado','target',state.products.filter(row=>row.active).map(row=>[row.id,row.name]))+
        lab('Embalagens consumidas',qty('consumed',1,'required min="1"'))+lab('Unidades por embalagem',qty('per','','required min="1"'))+
        reason(),'Registrar desmembramento'));
    case 'import':
      return show('Importar produtos e estoque',form('import',`<p class="dialog-note span-two">Colunas obrigatórias: codigo, nome, categoria, preco, estoque. Opcionais: codigo_barras, custo, minimo, validade. Para alimentação e bebidas, informe validade no formato AAAA-MM-DD. Use vírgula ou ponto e vírgula como separador.</p>`+
        field('Modo','mode',[['create','Criar'],['update','Atualizar'],['both','Criar e atualizar']],'both',null)+
        lab('Arquivo CSV',input('csv','','type="file" accept=".csv,text/csv" required'),'span-two'),'Ver prévia'));
    case 'favorite': {
      const next=!state.favorites.includes(id);
      await send(`products/${id}/favorite`,{active:next});
      state.favorites=next?[...state.favorites,id]:state.favorites.filter(value=>value!==id);
      ctx.renderPos();
      return toast(next?'Adicionado aos favoritos.':'Favorito removido.');
    }
    case 'manual':
      return show('Acesso por número',form('manual',lab('Número do cartão',qty('number','','required min="1" max="999999" autofocus'))+
        reason('Motivo da abertura excepcional'),'Localizar cartão'));
    case 'card-block':
    case 'card-replace':
      return show(key==='card-block'?'Bloquear cartão':'Substituir QR Code',form(key,hidden('id',id)+
        `<p class="dialog-note span-two">${key==='card-block'?'O cartão fica indisponível, inclusive em atendimentos abertos.':'Imprima o novo QR após a troca. O código anterior será invalidado.'}</p>`+reason(),'Confirmar'));
    case 'transfer':
    case 'split':
    case 'merge':
      return show(titles[key],transferForm(state,order,key),{order,wide:true});
    case 'refund':
      return show('Registrar devolução',refundForm(orderShown,state),{order:orderShown,wide:true});
    case 'payment-pix':
    case 'payment-void': {
      const paymentOrder=ctx.dialog.order;
      const method=key==='payment-pix'?'Confirmação manual de PIX':'Cancelar parcela';
      const example=key==='payment-pix'?'Confirme no extrato que o PIX foi recebido.':'Registre o cancelamento após devolver o valor, quando a parcela já foi recebida.';
      return show(method,form(key,hidden('id',id)+`<p class="dialog-note span-two">${example}</p>`+reason()+modals.adminConfirm(),'Confirmar'),
        {order:paymentOrder,wide:true});
    }
    case 'reconcile':
      return show('Conferência de recebimento',form('reconcile',hidden('id',id)+hidden('entity',element.dataset.entity)+
        hidden('reviewed',element.dataset.reviewed)+reason('Referência ou motivo'),'Registrar conferência'));
    case 'sales': {
      const {start,end}=state.report.period;
      state.historyFilter={start,end,employee:state.dashboardApplied.employee,method:state.dashboardApplied.method,
        category:state.dashboardApplied.category,product:state.dashboardApplied.product,register:state.dashboardApplied.register,
        shift:state.dashboardApplied.shift,status:'sales',page:1};
      return ctx.navigate('history');
    }
    case 'management-page':
      state.managementPage=Number(element.dataset.page);
      return reload();
    case 'management-export':
      location.href='/api/'+ctx.query('management.csv',{...state.dashboardApplied,stockDays:state.stockDays});
      return;
    case 'backup': {
      const status=await send('backups');
      state.backups=status;
      await reload();
      return toast(status.error || 'Backup verificado.',status.error?'error':'success');
    }
  }
}
export async function submit(ctx,name,fields,context) {
  const {state,send,close,reload,toast,show,showOrder,showPayment,applyCard,receiveCard}=ctx;
  const id=Number(fields.id)||null, approval=modals.approvalFrom(fields);
  const protect=(path,payload)=>protectedSend(ctx,path,payload,context);
  let message='Operação registrada.';
  switch (name) {
    case 'register': await send('cash/registers',fields); break;
    case 'shift-open': await protect('cash/open',{register:Number(fields.register),opening:cents(fields.opening)}); message='Turno aberto.'; break;
    case 'shift-close': await protect(`shifts/${id}/close`,{counted:cents(fields.counted),reason:fields.reason}); message='Turno fechado.'; break;
    case 'cash-move': await protect(`shifts/${id}/move`,{kind:fields.kind,amount:cents(fields.amount)*(fields.direction==='out'?-1:1),reason:fields.reason}); break;
    case 'supplier': await send(id?`suppliers/${id}`:'suppliers',{...fields,active:fields.active==='yes'}); break;
    case 'receive': await protect('merchandise',{product:Number(fields.product),supplier:Number(fields.supplier)||null,
      customer:Number(fields.customer)||null,quantity:Number(fields.quantity),cost:cents(fields.cost),reason:fields.reason,approval}); break;
    case 'trade-correct': {
      const mode=fields.mode;
      await protect(`merchandise/${id}/correct`,{mode,reason:fields.reason,approval,
        ...(mode==='replace'?{product:Number(fields.product),quantity:Number(fields.quantity),cost:cents(fields.cost)}:{})});
      message='Compra corrigida no estoque e no extrato.';
      break;
    }
    case 'count': await send('inventory/count',{product:id,expected:context.product.stock,counted:Number(fields.counted),reason:fields.reason,approval}); break;
    case 'breakpack': await protect('inventory/breakpack',{source:Number(fields.source),target:Number(fields.target),consumed:Number(fields.consumed),per:Number(fields.per),reason:fields.reason}); break;
    case 'import': {
      if (fields.csv.size>750000) throw Error('O CSV deve ter até 750 KB.');
      const csv=await fields.csv.text(), mode=fields.mode;
      const preview=await send('import/preview',{csv,mode});
      return show('Prévia de importação',modals.form('ext-import-apply',`<div class="span-two">${preview.errors.length ? table(['Linha','Erro'],preview.errors.map(row=>tr(row.line,text(row.error)))):''}
        ${table(['Linha','Ação','Código','Produto','Estoque anterior','Novo estoque','Preço'],preview.rows.map(row=>tr(row.line,row.action==='create'?'Criar':'Atualizar',text(row.code),text(row.name),text(row.oldStock),num(row.stock),money(row.price))))}</div>`,
        preview.errors.length?'':confirm('Aplicar importação')),{csv,mode,fingerprint:preview.fingerprint,wide:true});
    }
    case 'import-apply': {
      const result=await send('import/apply',{csv:context.csv,mode:context.mode,fingerprint:context.fingerprint});
      message=`${result.applied} produtos importados.`; break;
    }
    case 'manual': {
      const card=await send('scan/number',{number:Number(fields.number),reason:fields.reason});
      close();
      return receiveCard(card.id,card);
    }
    case 'card-block':
    case 'card-replace': await send(`cards/${id}/${name.slice(5)}`,fields); break;
    case 'transfer': {
      const order=context.order, target=state.scanned.get(Number(fields.target));
      const result=await send(`orders/${order.id}/move`,{version:order.version,target:target.id,targetVersion:target.order?.version,
        mode:fields.mode,items:selectedItems(order,fields),reason:fields.reason});
      close();
      if (result.source) applyCard(result.source);
      else ctx.finishCard(order);
      await receiveCard(result.destination.id,result.destination);
      return;
    }
    case 'refund': {
      const order=context.order;
      const payload={items:selectedItems(order,fields),reason:fields.reason,approval,exchange_order:Number(fields.exchange)||null};
      payload.request_id=requestId(context,payload);
      showOrder(await send(`orders/${order.id}/refund`,payload));
      ctx.refresh();
      return toast('Devolução registrada.');
    }
    case 'payment-pix':
    case 'payment-void': {
      const order=context.order;
      const payload={payment:id,reason:fields.reason,approval};
      payload.request_id=requestId(context,payload);
      const result=await send(`orders/${order.id}/${name.slice(8)}`,payload);
      if (result.order) {
        applyCard(result);
        return showPayment(result.order);
      }
      return showOrder(result);
    }
    case 'reconcile': await send('reconcile',{id,entity:fields.entity,reviewed:fields.reviewed==='yes',reason:fields.reason}); break;
    case 'stock-days': state.stockDays=Number(fields.days); state.managementPage=1; return reload();
    default: return;
  }
  close();
  await reload();
  toast(message);
}
