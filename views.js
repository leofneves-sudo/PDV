import {h,icon,btn,iconBtn,empty,header,lab,input,select,search,textarea,normalize,money,num,dt,humanDay,cardNumber,badge,avatar,pagination} from './ui.js';

export const navigation = [
  ['dashboard','Visão geral','dashboard','reports','Operação'],
  ['cash','Caixa e turnos','wallet','cashier','Operação'],
  ['pos','Atendimento','cart','operate','Operação'],
  ['scanner','Leitor de QR','scan','operate','Operação'],
  ['history','Histórico','clock',['history_all','history_own'],'Operação'],
  ['products','Produtos','box',['operate','products','stock'],'Cadastros'],
  ['customers','Clientes','people',['customer_read','customer_create'],'Cadastros'],
  ['supplies','Compras e fornecedores','box','suppliers','Cadastros'],
  ['cards','Cartões QR','qr','cards','Cadastros'],
  ['users','Operadores','shield','users','Administração'],
  ['management','Conferência gerencial','chart','reports','Administração'],
  ['audit','Auditoria','clipboard','audit','Administração'],
  ['backups','Backups','export','backup','Administração']
];
export const allowed = (user,permission) => Array.isArray(permission) ?
  permission.some(key=>user?.permissions[key]) : !!user?.permissions[permission];
export const permissionsFor = (state,key) => allowed(state.me,key);
export function initialView(user,fragment) {
  if (allowed(user,'operate')) {
    if (fragment==='#leitor') return 'scanner';
    if (user.role==='operator') return 'pos';
  }
  return navigation.find(([,,,permission])=>allowed(user,permission))?.[0] || 'account';
}
const ID = id => `data-id="${id}"`;
const labelMethods = (names,methods) => names.map(name=>methods[name]).join(' · ');
const fmtShort = day => day ? day.slice(5).split('-').reverse().join('/') : '';

function themeButton(theme) {
  return `<button class="btn theme-toggle" type="button" data-action="toggle-theme" aria-label="Modo noturno"
    aria-pressed="${theme==='dark'}" title="Alternar modo claro e noturno">
    <span class="theme-action-dark" aria-hidden="true">${icon('moon',19)}<span class="theme-caption">Modo noturno</span></span>
    <span class="theme-action-light" aria-hidden="true">${icon('sun',19)}<span class="theme-caption">Modo claro</span></span>
  </button>`;
}
export function auth(config,connected=true,theme='light') {
  const setup=config?.setup;
  const tiles = [
    '1111111001001111111','1000001011101000001','1011101010001011101','1011101001101011101','1011101010101011101',
    '1000001000101000001','1111111010101111111','0000000011000000000','0110011100011001010','1011010001110100111',
    '1100100101011010010','0011011101101001001','1111111010100010011','1000001001011000100','1011101011110100110',
    '1011101010001110001','1011101001010011010','1000001010101110101','1111111011010110011'
  ].map(row=>[...row].map(cell=>`<i class="${cell==='1'?'ink':''}"></i>`).join('')).join('');
  return `<div class="auth-layout">
    <aside class="auth-art"><div class="auth-brand"><img src="/brand.svg" alt="" width="43" height="43"> balcão<span>.</span></div>
      <div class="auth-message"><h2>O PDV da<br> sua loja<span>.</span></h2><p>Atenda, receba e acompanhe suas vendas com comandas QR.</p></div>
      <div class="auth-illustration" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div>
        <div class="qr-back"></div><div class="qr-ticket"><div class="qr-matrix">${tiles}</div></div>
        <div class="scan-line"></div><div class="art-corner art-top"></div><div class="art-corner art-bottom"></div></div>
      <div class="auth-footer"><i></i> Balcão PDV</div></aside>
    <main class="auth-main"><div class="auth-theme-control">${themeButton(theme)}</div><div class="auth-form-wrap">
      <div class="auth-mobile"><img src="/brand.svg" alt="" width="40" height="40"> balcão<span>.</span></div>
      <div class="auth-icon">${icon(setup?'shield':'lock',23)}</div>
      <h1>${setup?'Configure seu PDV':'Entre no Balcão'}</h1>
      <p>${setup?'Crie a conta do administrador para começar.':'Acesse com o seu usuário de operador.'}</p>
      ${!connected ? `<div class="notice error">${icon('wifi')} Servidor indisponível. Confira a conexão e tente de novo.</div>${btn('Reconectar','retry',{ico:'rotate',cls:'primary full'})}` :
        !config.initialized && !setup ? `<div class="notice">${icon('terminal')} Conclua a configuração inicial no computador do servidor pelo localhost.</div>${btn('Verificar novamente','retry',{cls:'primary full'})}` :
        `<form data-form="${setup?'setup':'login'}" class="auth-form">
          ${setup ? lab('Nome do administrador',input('name','','required autocomplete="name" maxlength="120" autofocus')) : ''}
          ${lab('Usuário',input('username','',`required autocomplete="username" maxlength="40" ${setup?'minlength="3" placeholder="Ex. leonardo"':'autofocus placeholder="Seu usuário"'}`))}
          ${lab('Senha',input('password','',`required type="password" autocomplete="${setup?'new-password':'current-password'}" maxlength="128" ${setup?'minlength="10" placeholder="Pelo menos 10 caracteres"':'placeholder="Sua senha"'}`))}
          <div class="form-error" role="alert" hidden></div>
          <button class="btn primary full" type="submit">${setup?'Criar administrador':'Entrar'} ${icon('chevron',18)}</button>
        </form>`}
    </div></main></div>`;
}
export function shell(state) {
  const can = key => permissionsFor(state,key);
  const links = ['Operação','Cadastros','Administração'].map(group=>{
    const options=navigation.filter(item=>item[4]===group && can(item[3]));
    if (!options.length) return '';
    return `<div class="nav-group"><div class="nav-label">${group}</div>${options.map(([key,label,ico])=>
      `<button type="button" class="navigation ${state.view===key?'current':''}" data-action="navigate" data-view="${key}" ${state.view===key?'aria-current="page"':''}>${icon(ico,20)}<span>${label}</span>${state.view===key?'<i></i>':''}</button>`
    ).join('')}</div>`;
  }).join('');
  const current = navigation.find(item=>item[0]===state.view)?.[1] || 'Conta';
  return `<div class="layout">
    <aside id="sidebar" class="sidebar"><div class="logo"><img src="/brand.svg" alt="" width="39" height="39"><div>balcão<span>.</span><small>PONTO DE VENDA</small></div></div>
      <nav aria-label="Menu principal">${links}</nav>
      <div class="sidebar-bottom">${can('operate')?btn('Parear caixa','terminal',{ico:'terminal',cls:'nav-minor'}):''}
        ${btn('Bloquear sessão','lock',{ico:'lock',cls:'nav-minor'})}</div>
    </aside>
    <button type="button" id="nav-backdrop" data-action="menu" aria-label="Fechar menu"></button>
    <div class="workspace"><header class="topbar">
      <div class="breadcrumbs">${iconBtn('Abrir menu','menu','menu','id="mobile-menu"')}${icon('terminal',19)} <span>Balcão PDV</span>${icon('chevron',14)}<strong>${h(current)}</strong></div>
      <div class="top-right"><span id="connectivity" class="connection ${state.online?'up':'down'}"><i></i><span>${state.online?'Conectado':'Sem conexão'}</span></span>
        ${themeButton(state.theme)}
        <div class="user-chip"><span class="avatar">${avatar(state.me.name)}</span><div><strong>${h(state.me.name)}</strong><small>${state.me.role==='admin'?'Administrador':'Operador'}</small></div></div>
      </div>
    </header><div id="connection-banner" class="connection-banner" ${state.online?'hidden':''}>${icon('wifi',19)} Sem conexão com o servidor. Aguarde a reconexão antes de confirmar operações.</div>
    <main id="main" class="main" tabindex="-1"><div class="loading">Carregando…</div></main></div>
  </div>`;
}

const tones = ['#5969ee','#26ac99','#f2a94d','#8d79ed','#ed7d9e','#a4aeca'];
function metric(name,value,ico,tone,detail='') {
  return `<article class="metric"><div class="metric-top"><span class="metric-icon ${tone}">${icon(ico,20)}</span><span>${name}</span></div><strong>${value}</strong><div class="metric-detail">${detail}</div></article>`;
}
function comparison(current,prior) {
  if (!prior) return current ? '<span class="neutral">Sem base no período anterior</span>' : 'Período anterior: 0';
  const change = (current-prior)/prior*100;
  const signed = change>0 ? '+' : '';
  return `<span class="${change>0?'positive':change<0?'negative':'neutral'}">${signed}${new Intl.NumberFormat('pt-BR',{maximumFractionDigits:1}).format(change)}%</span> vs. período anterior`;
}
function lineChart(series) {
  const width=710,height=224,left=70,right=22,top=15,bottom=32;
  const max=Math.max(100,...series.map(row=>row.amount));
  const step=Math.pow(10,Math.floor(Math.log10(max)));
  const roof=Math.ceil(max/step)*step;
  const base=height-bottom;
  const points=series.map((row,index)=>({
    x:left+index*(width-left-right)/Math.max(1,series.length-1),
    y:base-row.amount/roof*(base-top),...row
  }));
  const path=points.map((point,index)=>`${index?'L':'M'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
  const grid=Array.from({length:5},(_,index)=>{
    const y=top+(base-top)*index/4;
    return `<line x1="${left}" x2="${width-right}" y1="${y}" y2="${y}" stroke="#e9edf5" stroke-dasharray="4 4"/><text x="${left-9}" y="${y+4}" text-anchor="end">${h(new Intl.NumberFormat('pt-BR',{notation:'compact',maximumFractionDigits:1}).format(roof*(1-index/4)/100))}</text>`;
  }).join('');
  const every=Math.ceil(points.length/7);
  const labels=points.map((point,index)=>{
    if (index%every!==0 && index!==points.length-1) return '';
    const label=point.name.length===10 ? fmtShort(point.name) : point.name.length===7 ? point.name.slice(5)+'/'+point.name.slice(2,4) : point.name;
    if (index===points.length-1 && points.length>7 && index%every<every/2 && index%every!==0) return '';
    return `<text x="${point.x}" y="${height-7}" text-anchor="middle">${h(label)}</text>`;
  }).join('');
  const area=points.length ? `${path} L${points.at(-1).x} ${base} L${points[0].x} ${base} Z` : '';
  return `<svg class="sales-chart" viewBox="0 0 ${width} ${height}" aria-label="Evolução das vendas em reais" role="img">
    <defs><linearGradient id="sales-area" x1="0" x2="0" y1="0" y2="1"><stop stop-color="#6879f7" stop-opacity=".22"/><stop offset="1" stop-color="#6879f7" stop-opacity=".025"/></linearGradient></defs>
    ${grid}<path d="${area}" fill="url(#sales-area)"/><path d="${path}" fill="none" stroke="#5668ef" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
    ${labels}${points.filter(point=>point.amount>0).map(point=>`<circle cx="${point.x}" cy="${point.y}" r="4" fill="#fff" stroke="#5668ef" stroke-width="2"><title>${h(point.name)} · ${money(point.amount)}</title></circle>`).join('')}
  </svg>`;
}
function donut(rows,mode) {
  const key=mode==='amount'?'amount':'count';
  const ranked=[...rows].filter(row=>row[key]>0).sort((a,b)=>b[key]-a[key]);
  const total=ranked.reduce((sum,row)=>sum+row[key],0);
  const items=ranked.slice(0,5);
  if (ranked.length>5) items.push({name:'Outros',[key]:ranked.slice(5).reduce((sum,row)=>sum+row[key],0)});
  let cursor=0;
  const stops=items.map((row,index)=>{
    const start=cursor;
    cursor+=row[key]*100/total;
    return `${tones[index]} ${start.toFixed(3)}% ${cursor.toFixed(3)}%`;
  });
  return `<div class="donut-wrap"><div class="donut" style="--fill:${stops.length?`conic-gradient(${stops.join(',')})`:'var(--donut-empty,#edf0f7)'}"><div>
    <strong>${key==='amount'?money(total):num(total)}</strong><span>${key==='amount'?'faturamento':'itens vendidos'}</span></div></div>
    ${items.length ? `<ul class="legend">${items.map((row,index)=>`<li><i style="--tone:${tones[index]}"></i><span title="${h(row.name)}">${h(row.name)}</span><b>${Math.round(row[key]*100/total)}%</b></li>`).join('')}</ul>` : '<p class="muted center">Nenhuma venda no período</p>'}</div>`;
}
function panel(title,subtitle,body,action='') {
  return `<section class="panel"><div class="panel-heading"><div><h2>${h(title)}</h2>${subtitle?`<p>${h(subtitle)}</p>`:''}</div>${action}</div>${body}</section>`;
}
function ranking(rows,{by='amount',count='itens',limit=10}={}) {
  const ordered=[...rows].sort((a,b)=>b[by]-a[by]);
  if (!ordered.length) return empty('chart','Nenhum registro no período');
  return `<div class="ranking">${ordered.slice(0,limit).map((row,index)=>`<div><span class="rank-number">${index+1}</span><span><strong>${h(row.name)}</strong><small>${num(row.count)} ${count}</small></span><b>${money(row.amount)}</b></div>`).join('')}</div>`;
}
function bars(rows) {
  const max=Math.max(1,...rows.map(row=>row.amount));
  return `<div class="bars">${rows.map(row=>`<div><span>${h(row.name)}</span><div class="bar-track"><i style="--width:${row.amount/max*100}%"></i></div><strong>${money(row.amount)}</strong></div>`).join('')}</div>`;
}
function filterField(label,name,options,value,placeholder) {
  return lab(label,select(name,options,value,placeholder));
}
function registerFilters(state,f) {
  const filters=state.filters;
  return filterField('Produto','product',(filters.products || []).map(row=>[row.id,`${row.code} · ${row.name}`]),f.product,'Todos os produtos')+
    filterField('Caixa','register',(filters.registers || []).map(row=>[row.id,row.name]),f.register,'Todos os caixas')+
    filterField('Turno','shift',(filters.shifts || []).map(row=>[row.id,`#${row.id} · ${row.register_name} · ${dt(row.opened_at)}`]),f.shift,'Todos os turnos');
}
export function dashboardFilters(state) {
  const f=state.dashboardFilter || {period:'today'};
  return `<form data-form="dashboard-filter" class="filter-strip">
    ${filterField('Período','period',[['today','Hoje'],['yesterday','Ontem'],['week','Últimos 7 dias'],['month','Mês atual'],['custom','Personalizado']],f.period)}
    ${f.period==='custom' ? lab('De',input('start',f.start,'type="date" required'))+lab('Até',input('end',f.end,'type="date" required')):''}
    ${filterField('Funcionário','employee',state.filters.employees.map(row=>[row.id,row.name]),f.employee,'Todos os funcionários')}
    ${filterField('Categoria','category',state.filters.categories.map(name=>[name,name]),f.category,'Todas as categorias')}
    ${filterField('Pagamento','method',Object.entries(state.config.methods),f.method,'Todas as formas')}
    ${registerFilters(state,f)}
    <button class="btn primary" type="submit">Aplicar</button></form>`;
}
export function dashboard(state) {
  const report=state.report;
  const values=report.indicators;
  const prior=report.previous;
  const period=report.period;
  const split=state.donutMode;
  return `${header('Visão geral','Acompanhe vendas, comandas e estoque.',`
    ${btn('Exportar CSV','export',{ico:'export',cls:'outline'})}
    ${btn('Conferência gerencial','navigate',{ico:'wallet',attrs:'data-view="management"'})}
    ${permissionsFor(state,['history_all','history_own'])?btn('Ver vendas','ext-sales',{ico:'receipt'}):''}
    ${permissionsFor(state,'operate')?btn('Ir para atendimento','navigate',{ico:'cart',cls:'primary',attrs:'data-view="pos"'}):''}`)}
    ${dashboardFilters(state)}
    <div class="period-caption">${icon('calendar',17)} <strong>${humanDay(period.start)}${period.start===period.end?'':` – ${humanDay(period.end)}`}</strong>
    <span>Comparação com ${humanDay(period.previousStart)}${period.previousStart===period.previousEnd?'':` – ${humanDay(period.previousEnd)}`}</span></div>
    <div class="metric-grid">
      ${metric('Vendas brutas do período',money(values.grossSales),'wallet','indigo',comparison(values.grossSales,prior.grossSales))}
      ${metric('Devoluções pela data da ocorrência',money(values.refundValue),'rotate','rose',`${num(values.refunds)} ocorrências`)}
      ${metric('Líquido atualizado das vendas originais',money(values.netSales),'chart','violet',comparison(values.netSales,prior.netSales))}
      ${metric('Vendas concluídas',num(values.grossOrders),'receipt','mint',comparison(values.grossOrders,prior.grossOrders))}
    </div>
    <div class="dashboard-charts">
      ${panel('Evolução das vendas','Líquido atualizado pela data da venda original',`<div class="chart-scroll">${lineChart(report.timeline)}</div>`,'<span class="chart-key"><i></i> Líquido (R$)</span>')}
      ${panel('Produtos mais vendidos','Participação nas vendas',donut(report.products,split),`<div class="segmented">${btn('Quantidade','donut',{cls:split==='count'?'chosen':'',attrs:'data-mode="count"'})}${btn('Faturamento','donut',{cls:split==='amount'?'chosen':'',attrs:'data-mode="amount"'})}</div>`)}
    </div>
    <div class="metric-grid secondary-metrics">
      ${metric('Comandas abertas',num(values.open),'ticket','indigo',`${money(values.openValue)} em aberto agora`)}
      ${metric('Tempo de atendimento',`${num(values.averageMinutes)} min`,'clock','violet',comparison(values.averageMinutes,prior.averageMinutes))}
      ${metric('Descontos concedidos',money(values.discounts),'tag','orange',comparison(values.discounts,prior.discounts))}
      ${metric('Estoque baixo',num(values.lowStock),'alert','rose','Produtos no mínimo ou abaixo')}
      ${metric('Saldo de créditos',money(values.creditBalance),'wallet','mint','Saldo atual de todos os clientes')}
      ${metric('Créditos adicionados',money(values.deposits),'plus','indigo',`${money(values.depositReversals)} em recargas estornadas`)}
      ${metric('Créditos utilizados',money(values.used),'credit','violet',`${money(values.restored)} devolvidos em estornos`)}
      ${metric('Lucro bruto atualizado',values.profit==null?'—':money(values.profit),'chart','mint',values.missingCost?`${num(values.missingCost)} linhas sem custo exato`:values.margin==null?'Margem indisponível':`Margem de ${num(values.margin)}%`)}
      ${metric('Cancelamentos',num(values.cancellations),'x','rose',`${money(values.cancelledValue)} em comandas`)}
      ${metric('Ticket médio líquido',money(values.ticket),'chart','violet',comparison(values.ticket,prior.ticket))}
      ${metric('Itens vendidos líquidos',num(values.units),'box','orange',comparison(values.units,prior.units))}
      ${metric('Clientes novos',num(values.newCustomers),'user','mint','Primeira compra no período')}
      ${metric('Clientes recorrentes',num(values.returningCustomers),'people','indigo','Com compra anterior ao período')}
    </div>
    <div class="dashboard-detail">
      ${panel('Formas de pagamento','Total recebido em vendas concluídas',ranking(report.payments,{count:'parcelas'}))}
      ${panel('Vendas por funcionário','Total recebido por operador de fechamento',ranking(report.staff,{count:'vendas'}))}
      ${panel('Ranking de produtos','Unidades vendidas e faturamento',ranking(report.products,{by:split}))}
      ${panel('Ranking de categorias','Unidades vendidas e faturamento',ranking(report.categories))}
      ${panel('Vendas por dia da semana','Faturamento por dia',bars(report.weekdays))}
      ${panel('Vendas por horário','Faturamento por hora',`<div class="hours-bars">${bars(report.hours)}</div>`)}
      ${panel('Entradas de crédito','Recargas líquidas por forma de recebimento',ranking(report.deposits,{count:'movimentos'}))}
      ${panel('Produtos com estoque baixo','Disponibilidade atual após reservas',report.lowStock.length?`<div class="ranking">${report.lowStock.map(row=>`<div><span class="rank-number">${icon('alert',16)}</span><span><strong>${h(row.name)}</strong><small>Mínimo: ${num(row.minimum)}</small></span><b>${num(row.available)}</b></div>`).join('')}</div>`:empty('box','Estoque acima dos mínimos'))}
    </div>
    <p class="report-note">O bruto considera o valor original após descontos. Devoluções por ocorrência usam a data da devolução. O líquido atualizado deduz todas as devoluções das vendas encerradas no período. Produto, categoria e pagamento selecionam atendimentos inteiros. Comandas abertas, estoque e saldo de créditos refletem o estado atual.</p>`;
}

export function productGrid(state) {
  const term=normalize(state.local.posSearch);
  const products=state.products.filter(product=>product.active &&
    (!state.local.posCategory || (state.local.posCategory==='@favorites'?state.favorites.includes(product.id):product.category===state.local.posCategory)) &&
    (!term || [product.name,product.code,product.barcode].some(value=>normalize(value).includes(term))));
  if (!products.length) return empty('box',term?'Nenhum produto encontrado':'Nenhum produto disponível',term?'Tente outro nome ou código.':'Cadastre produtos ativos no catálogo.',
    permissionsFor(state,'products')?btn('Gerenciar produtos','navigate',{ico:'box',attrs:'data-view="products"'}):'');
  return `<div class="product-grid">${products.map(product=>`<div class="tile-wrap"><button type="button" class="product-tile" data-action="add-item" ${ID(product.id)} ${!state.card?.order || !product.available?'disabled':''}>
    <div class="tile-icon">${product.image?`<img src="${h(product.image)}" alt="" loading="lazy">`:icon('box',26)}</div>
    <strong>${h(product.name)}</strong><small>${h(product.code)} · ${product.available ? `${num(product.available)} disponíveis` : 'Sem estoque'}</small>
    <div class="tile-bottom"><b>${money(product.price)}</b><span>${icon('plus',18)}</span></div></button>
    ${btn(state.favorites.includes(product.id)?'★':'☆','ext-favorite',{cls:'favorite-button',attrs:`data-id="${product.id}" aria-label="${state.favorites.includes(product.id)?'Remover dos':'Adicionar aos'} favoritos"`})}</div>`).join('')}</div>`;
}
export function orderPanel(state) {
  const card=state.card;
  const order=card?.order;
  const can=key=>permissionsFor(state,key);
  if (!card) return `<section class="panel order-panel order-idle"><div class="panel-heading"><h2>Comanda</h2>${badge('neutral','Aguardando leitura')}</div>
    ${empty('scan','Leia o QR da comanda','Use a câmera deste dispositivo ou um celular pareado.',
      btn('Abrir leitor de QR','navigate',{ico:'scan',cls:'primary',attrs:'data-view="scanner"'}))}</section>`;
  if (!order) return `<section class="panel order-panel order-idle"><div class="panel-heading"><h2>Cartão #${cardNumber(card.number)}</h2>${badge('closed','Disponível')}</div>
    ${empty('ticket','Cartão disponível','Inicie uma comanda para registrar o atendimento.',
      btn('Iniciar atendimento','open-order',{ico:'plus',cls:'primary',attrs:ID(card.id)}))}</section>`;
  const draft=state.notes.get(order.id);
  return `<section class="panel order-panel"><div class="panel-heading order-title"><div><h2>Comanda #${cardNumber(card.number)}</h2><p>Atendimento #${order.id} · ${h(order.opened_name)} · ${dt(order.opened_at)}</p></div>${badge('open')}</div>
    <div class="order-content">
      <div class="customer-line"><span class="small-icon">${icon('user',19)}</span><div><small>Cliente</small><strong>${h(order.customer_name || 'Sem cliente vinculado')}</strong></div>
        ${can('customer_read')?btn(order.customer_id?'Trocar':'Vincular','order-customer',{cls:'outline'}):''}</div>
      <div class="order-list">${order.items.length ? order.items.map(item=>`<article class="order-item">
        <div class="item-info"><strong>${h(item.name)}</strong><small>${money(item.price)} un.</small></div><b>${money(item.subtotal)}</b>
        <div class="quantity">
          ${can(['item_reduce','item_remove'])?iconBtn('Reduzir quantidade','item-minus','minus',ID(item.id)+(item.quantity===1&&!can('item_remove')?' disabled':'')):''}
          ${btn(String(item.quantity),'item-quantity',{cls:'qty-button',attrs:`${ID(item.id)} aria-label="Alterar quantidade de ${h(item.name)}"`})}
          ${iconBtn('Aumentar quantidade','item-plus','plus',ID(item.id))}
        </div><div class="item-tools">${can('item_price')?iconBtn('Alterar preço','item-price','pencil',ID(item.id)):''}
          ${can('item_remove')?iconBtn('Remover item','item-remove','trash',ID(item.id)):''}</div>
      </article>`).join(''):empty('cart','A comanda está vazia','Toque em um produto para incluir.')}</div>
      ${lab('Observações',textarea('order-notes',draft?.value ?? order.notes,'id="order-notes" placeholder="Adicionar observação…" rows="2" maxlength="2000"'))}
      <div id="notes-status" class="notes-status" role="status">${h(draft?.error || (draft?'Salvando…':'Salvamento automático'))}</div>
      ${draft?.error?`<div id="notes-actions">${btn('Usar texto salvo','notes-discard')}${btn('Salvar meu texto','notes-retry',{cls:'outline'})}</div>`:'<div id="notes-actions"></div>'}
    </div>
    <div class="order-summary">
      <div class="sum-line"><span>Subtotal</span><b>${money(order.subtotal)}</b></div>
      ${order.discount || can('operate')?`<div class="sum-line"><span>Desconto ${can('operate')?btn('Editar','discount',{ico:'tag',cls:'text-btn'}):''}</span><b>${money(order.discount)}</b></div>`:''}
      <div class="sum-total"><span>Total da comanda</span><strong>${money(order.total)}</strong></div>
      ${can('checkout')?btn('Receber pagamento','payment',{ico:'wallet',cls:'primary full pay-button',attrs:(!order.items.length || !state.online)?'disabled':''}):''}
      ${order.confirmed || order.pending?`<p class="notes-status">Confirmado: ${money(order.confirmed)} · Saldo: ${money(order.total-order.confirmed)}${order.pending?' · PIX pendente: '+money(order.pending):''}</p>`:''}
      <div class="flex-actions order-tools">
      ${can('order_transfer')?btn('Transferir','ext-transfer')+btn('Dividir','ext-split'):''}
      ${can('order_merge')?btn('Unir','ext-merge'):''}</div>
      ${can('operate')?btn('Cancelar comanda','cancel-order',{cls:'text-btn danger full'}):''}
    </div></section>`;
}
export function pos(state) {
  const categories=[...new Set(state.products.filter(product=>product.active).map(product=>product.category))].sort((a,b)=>a.localeCompare(b,'pt-BR'));
  return `${header('Atendimento','Selecione os produtos e acompanhe a comanda.',btn('Ler QR Code','navigate',{ico:'scan',cls:'primary',attrs:'data-view="scanner"'})+
      (permissionsFor(state,'scan_number')?btn('Número do cartão','ext-manual',{ico:'ticket'}):''))}
    <div id="order-tabs" class="order-tabs">${orderTabs(state)}</div>
    <div id="camera-dock" class="camera-dock" hidden><div class="dock-video"></div><div><strong>Leitura contínua ativa</strong><small>Aponte para outro cartão.</small></div>${iconBtn('Desligar câmera','camera-stop','x')}</div>
    <div class="pos-layout"><section class="catalog-panel">
      <div class="catalog-title"><h2>Catálogo</h2><span>${num(state.products.filter(p=>p.active).length)} produtos ativos</span></div>
      ${search('pos-search',state.local.posSearch,'Buscar por nome, código ou código de barras')}
      <div class="categories">${[['','Todas'],['@favorites','★ Favoritos'],...categories.map(key=>[key,key])].map(([key,name])=>
        btn(name,'category',{cls:state.local.posCategory===key?'chosen':'',attrs:`data-category="${h(key)}"`})
      ).join('')}</div><div id="product-grid">${productGrid(state)}</div></section>
    <div id="order-panel">${orderPanel(state)}</div></div><div id="mobile-checkout">${mobileCheckout(state)}</div>`;
}
export function mobileCheckout(state) {
  const order=state.card?.order;
  if (!order || !permissionsFor(state,'checkout')) return '';
  return `<div class="mobile-checkout-bar"><div><small>Total · #${cardNumber(order.number)}</small><strong>${money(order.total)}</strong></div>
  ${btn('Receber','payment',{ico:'wallet',cls:'primary',attrs:(!order.items.length || !state.online)?'disabled':''})}</div>`;
}
export function orderTabs(state) {
  return [...state.scanned.values()].map(card=>{
    const current=state.card?.id===card.id;
    const number=cardNumber(card.number);
    const status=card.order?(current?'Em atendimento':'Em aberto'):'Disponível';
    return `<div class="order-tab${card.order?' is-open':''}${current?' current':''}">
      <button type="button" class="btn order-tab-select" data-action="switch-card" ${ID(card.id)} ${current?'aria-current="true"':''}>
        ${icon('ticket',19)}<span><strong>#${number}</strong><small>${status}</small></span>
      </button>${iconBtn(`Ocultar cartão #${number} da fila`,'hide-card','x',ID(card.id))}</div>`;
  }).join('');
}

export function scannerView(state) {
  const paired=state.pairing.reader;
  return `${header('Leitor de QR','Aponte a câmera para o QR do cartão físico.',btn('Voltar ao atendimento','navigate',{ico:'cart',attrs:'data-view="pos"'})+
    (permissionsFor(state,'scan_number')?btn('Número do cartão','ext-manual',{ico:'ticket'}):''))}
    <div class="scanner-layout">
      <section class="panel scanner-panel"><div class="panel-heading"><div><h2>Câmera</h2><p>Leitura contínua de cartões</p></div><span id="camera-badge">${badge('neutral','Desligada')}</span></div>
        <div id="camera-stage" class="camera-stage"><video id="camera-video" playsinline muted aria-label="Imagem da câmera"></video><div class="camera-overlay" aria-hidden="true"><div></div></div>
          <div id="camera-placeholder" class="camera-placeholder">${icon('scan',43)}<p>Enquadre o QR Code aqui</p></div>
        </div>
        <div id="scan-status" class="scan-status" role="status">${icon('camera',19)} Ative a câmera para começar.</div>
        <div class="camera-controls">
          ${btn('Ativar câmera','camera-start',{ico:'camera',cls:'primary',attrs:'id="camera-start"'})}
          ${btn('Desligar câmera','camera-stop',{ico:'x',attrs:'id="camera-stop" hidden'})}
          ${btn('Lanterna','camera-flash',{ico:'flash',attrs:'id="camera-flash" hidden aria-pressed="false"'})}
          ${lab('Selecionar câmera',select('camera',[],null,'Câmera padrão','id="camera-select" disabled'))}
        </div>
      </section>
      <aside class="scanner-options">
        ${panel('Destino da leitura','Escolha onde a comanda será aberta.',`<div class="scanner-settings">
          <label class="radio-tile"><input type="radio" name="scan-mode" value="direct" ${state.scanMode==='direct'?'checked':''}><span>${icon('camera')}<strong>Neste dispositivo</strong><small>Abra e opere a comanda aqui.</small></span></label>
          <label class="radio-tile"><input type="radio" name="scan-mode" value="paired" ${state.scanMode==='paired'?'checked':''} ${paired?'':'disabled'}><span>${icon('terminal')}<strong>No caixa pareado</strong><small id="paired-label">${paired?`${h(paired.name)} · ${paired.online?'Online':'Indisponível'}`:'Vincule o celular ao caixa.'}</small></span></label>
          <div class="flex-actions">${btn(paired?'Trocar caixa':'Parear com caixa','pair-reader',{ico:'link',cls:'outline'})}${paired?btn('Desvincular','unlink-reader'):''}</div>
          <label class="toggle-row"><input id="vibrate" type="checkbox" ${state.vibrate?'checked':''}> Vibrar após a leitura</label>
        </div>`)}
        ${panel('Leitor externo','Use quando o leitor envia o QR como teclado.',`<form class="scanner-settings" data-form="external-scan">
          ${lab('Código do cartão',input('code','','data-verbatim placeholder="Aponte o leitor ou cole o código" autocomplete="off" required maxlength="80"'))}<button class="btn outline" type="submit">${icon('scan',19)} Ler código</button><div class="form-error" role="alert" hidden></div></form>`)}
      </aside></div>`;
}

function rowActions(actions) {return `<div class="table-actions">${actions}</div>`;}
function table(columns,rows,emptyHtml) {
  return rows.length?`<div class="table-scroll"><table><thead><tr>${columns.map(label=>`<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`:emptyHtml;
}
export function productRows(state) {
  const can=key=>permissionsFor(state,key);
  const term=normalize(state.local.productSearch);
  const rows=state.products.filter(product=>[product.name,product.code,product.barcode,product.category].some(value=>normalize(value).includes(term)) &&
    (!state.local.productStatus || (state.local.productStatus==='active')===!!product.active));
  return table(['Produto','Categoria','Preço','Estoque','Disponível','Status','Ações'],rows.map(row=>
    `<tr><td><div class="table-name">${row.image?`<img src="${h(row.image)}" alt="" loading="lazy">`:`<span class="small-icon">${icon('box',19)}</span>`}<div><strong>${h(row.name)}</strong><small>${h(row.code)}${row.barcode?' · '+h(row.barcode):''}</small><small>${[row.game,row.collection,row.collector_number,row.language,row.condition,row.rarity,row.foil===1?'Foil':row.foil===0?'Normal':null].filter(Boolean).map(h).join(' · ')}</small></div></div></td>
    <td>${h(row.category)}</td><td><strong>${money(row.price)}</strong></td><td>${num(row.stock)}</td><td>${num(row.available)} ${row.active && row.available<=row.minimum?badge('open','Baixo'):''}</td><td>${badge(row.active?'closed':'neutral',row.active?'Ativo':'Inativo')}</td>
    <td>${rowActions(`${can('products')?iconBtn('Editar produto','product-edit','pencil',ID(row.id)):''}${can(['stock','operate'])?iconBtn('Movimentar estoque','stock','box',ID(row.id))+iconBtn('Conferência física','ext-count','clipboard',ID(row.id)):''}
    ${can('stock')?iconBtn('Ver movimentações','stock-history','clock',ID(row.id)):''}`)}</td></tr>`),
    empty('box',term?'Nenhum produto encontrado':'Nenhum produto cadastrado',term?'Tente alterar os filtros.':'Os produtos ativos aparecerão no catálogo do atendimento.'));
}
export function productsView(state) {
  return `${header('Produtos','Gerencie o catálogo, os preços e a disponibilidade.',(permissionsFor(state,'products')?btn('Novo produto','product-edit',{ico:'plus',cls:'primary'}):'')+
       (permissionsFor(state,'stock')?btn('Desmembrar','ext-breakpack',{ico:'box'}):'')+
       (permissionsFor(state,'products')&&permissionsFor(state,'stock')?btn('Importar CSV','ext-import',{ico:'clipboard'}):''))}
    <section class="panel"><div class="table-toolbar">${search('product-search',state.local.productSearch,'Buscar produto por nome ou código')}
    ${lab('Status',select('status',[['active','Ativos'],['inactive','Inativos']],state.local.productStatus,'Todos','id="product-status"'))}</div><div id="list-results">${productRows(state)}</div></section>`;
}
export function customerRows(state) {
  const term=normalize(state.local.customerSearch);
  const rows=state.customers.filter(row=>[row.name,row.phone,row.document,row.email].some(value=>normalize(value).includes(term)));
  return table(['Cliente','Telefone','CPF/CNPJ','Saldo','Status','Ações'],rows.map(row=>`<tr>
    <td><div class="table-name"><span class="avatar">${avatar(row.name)}</span><div><strong>${h(row.name)}</strong><small>${h(row.email || '')}</small></div></div></td>
    <td>${h(row.phone)}</td><td>${h(row.document || '—')}</td><td><strong>${money(row.balance)}</strong></td>
    <td>${badge(row.active?'closed':'neutral',row.active?'Ativo':'Inativo')}</td>
    <td>${rowActions(btn('Ver ficha','customer-detail',{ico:'clipboard',attrs:ID(row.id)}))}</td></tr>`),
    empty('people',term?'Nenhum cliente encontrado':'Nenhum cliente cadastrado',term?'Tente outro nome ou documento.':'Cadastre um cliente para vincular compras e créditos.'));
}
export function customersView(state) {
  const can=key=>permissionsFor(state,key);
  return `${header('Clientes','Consulte o histórico de compras e o saldo de créditos.',can('customer_create')?btn('Novo cliente','customer-edit',{ico:'plus',cls:'primary'}):'')}
    ${!can('customer_read')?'':`<section class="panel"><div class="table-toolbar">${search('customer-search',state.local.customerSearch,'Buscar por nome, telefone ou documento')}</div><div id="list-results">${customerRows(state)}</div></section>`}`;
}
export function cardsView(state) {
  return `${header('Cartões QR','Cadastre cartões reutilizáveis e imprima os códigos.',btn('Novo lote','card-create',{ico:'plus',cls:'primary'}))}
    <section class="panel"><div class="table-toolbar"><label class="toggle-row"><input id="select-all-cards" type="checkbox" ${state.cards.some(row=>!row.blocked)&&state.cards.filter(row=>!row.blocked).every(row=>state.selectedCards.has(row.id))?'checked':''}> Selecionar cartões</label>
    ${btn('Imprimir seleção','card-print',{ico:'printer',cls:'outline',attrs:`id="print-selection" ${state.selectedCards.size?'':'disabled'}`})}</div>
    ${table(['','Número','Status','Atendimento','Ações'],state.cards.map(row=>`<tr>
      <td><label class="check-cell" aria-label="Selecionar cartão ${cardNumber(row.number)}"><input type="checkbox" class="select-card" value="${row.id}" ${row.blocked?'disabled':state.selectedCards.has(row.id)?'checked':''}></label></td>
      <td><strong>#${cardNumber(row.number)}</strong></td><td>${badge(row.blocked?'cancelled':!row.active?'neutral':row.order_id?'open':'closed',row.blocked?'Bloqueado':!row.active?'Inativo':row.order_id?'Em uso':'Disponível')}</td>
      <td>${row.order_id?`#${row.order_id}`:'—'}</td><td>${rowActions((row.blocked?'':iconBtn('Imprimir cartão','card-print','printer',ID(row.id))+btn('Bloquear','ext-card-block',{attrs:ID(row.id)}))+
    btn('Substituir QR','ext-card-replace',{attrs:ID(row.id)})+(!row.blocked?btn(row.active?'Inativar':'Reativar','card-status',{attrs:ID(row.id)}):''))}</td></tr>`),
      empty('qr','Nenhum cartão cadastrado','Crie um lote para começar a imprimir e usar as comandas.',btn('Criar primeiro lote','card-create',{ico:'plus',cls:'primary'})))}</section>`;
}
export function historyView(state) {
  const f=state.historyFilter;
  const data=state.history;
  return `${header('Histórico','Consulte atendimentos concluídos, cancelados e estornados.',btn('Exportar CSV','export',{ico:'export',cls:'outline'}))}
    <form class="filter-strip history-filter" data-form="history-filter">
      ${lab('Buscar',input('q',f.q,'placeholder="Atendimento, cartão ou cliente"'))}
      ${lab('De',input('start',f.start,'type="date"'))}${lab('Até',input('end',f.end,'type="date"'))}
      ${filterField('Funcionário','employee',state.filters.employees.map(row=>[row.id,row.name]),f.employee,'Todos')}
      ${filterField('Pagamento','method',Object.entries(state.config.methods),f.method,'Todas')}
      ${filterField('Categoria','category',state.filters.categories.map(name=>[name,name]),f.category,'Todas')}
      ${registerFilters(state,f)}
      ${filterField('Status','status',[['sales','Vendas e estornos'],['closed','Concluída'],['cancelled','Cancelada'],['refunded','Estornada']],f.status,'Todos')}
      <button class="btn primary" type="submit">Aplicar</button>
    </form><section class="panel">${table(['Atendimento','Cliente','Encerramento','Funcionário','Pagamento','Total','Status',''],data.rows.map(row=>`<tr>
      <td><strong>#${row.id}</strong><small>Cartão #${cardNumber(row.number)}</small></td><td>${h(row.customer_name || '—')}</td>
      <td>${dt(row.ended_at)}</td><td>${h(row.ended_name)}${row.closed_shift_id?`<small>Turno #${row.closed_shift_id}</small>`:''}</td><td>${h(labelMethods(row.methods,state.config.methods) || '—')}</td>
      <td><strong>${money(row.total)}</strong>${row.returned?`<small>Devolvido: ${money(row.returned)}</small><small>Líquido: ${money(row.total-row.returned)}</small>`:''}</td><td>${badge(row.status,row.merged_into?'Unida':undefined)}</td><td>${btn('Detalhes','order-detail',{attrs:ID(row.id)})}</td></tr>`),
      empty('clock','Nenhum atendimento encontrado','Os atendimentos encerrados que você pode consultar aparecem aqui.'))}${pagination(data)}</section>`;
}
export function usersView(state) {
  return `${header('Operadores','Gerencie contas, perfis e permissões por ação.',btn('Novo operador','user-edit',{ico:'plus',cls:'primary'}))}
    <section class="panel">${table(['Operador','Usuário','Perfil','Status','Ações'],state.users.map(row=>`<tr><td><div class="table-name"><span class="avatar">${avatar(row.name)}</span><strong>${h(row.name)}</strong></div></td><td>${h(row.username)}</td>
      <td>${row.role==='admin'?'Administrador':'Operador'}</td><td>${badge(row.active?'closed':'neutral',row.active?'Ativo':'Inativo')}</td><td>${btn('Editar','user-edit',{ico:'pencil',attrs:ID(row.id)})}</td></tr>`),empty('shield','Nenhum operador cadastrado'))}</section>`;
}
const auditNames = {
  'auth.login':'Login efetuado','auth.falha':'Login malsucedido','auth.bloqueado':'Tentativas limitadas','auth.bloqueio':'Sessão bloqueada',
  'comanda.aberta':'Comanda aberta','comanda.fechada':'Comanda fechada','comanda.cancelada':'Comanda cancelada',
  'item.adicionado':'Item adicionado','item.quantidade':'Quantidade alterada','item.removido':'Item removido','item.preco':'Preço do item alterado',
  'comanda.desconto':'Desconto alterado','comanda.cliente':'Cliente vinculado','comanda.observacoes':'Observações alteradas',
  'credito.deposit':'Recarga de crédito','credito.use':'Crédito utilizado','credito.deposit_reversal':'Recarga estornada','credito.use_reversal':'Crédito devolvido',
  'pagamento.registrado':'Pagamento registrado','pagamento.estornado':'Pagamento estornado','venda.estornada':'Venda estornada',
  'estoque.movimentado':'Movimento de estoque','produto.alterado':'Produto alterado','produto.criado':'Produto criado',
  'cliente.alterado':'Cliente alterado','cliente.criado':'Cliente cadastrado','usuario.criado':'Operador criado','usuario.alterado':'Operador alterado',
  'cartao.criado':'Cartão criado','cartao.status':'Status do cartão alterado','leitor.pareado':'Leitor pareado','leitor.desvinculado':'Leitores desvinculados'
};
export function auditView(state) {
  const data=state.audit;
  return `${header('Auditoria','Consulte as ações registradas por operador e atendimento.')}
    <form data-form="audit-filter" class="filter-strip"><div class="grow">${lab('Buscar ação ou responsável',input('q',state.auditFilter.q,'placeholder="Ex. estoque, caixa ou número do registro"'))}</div><button class="btn primary" type="submit">Buscar</button></form>
    <section class="panel">${table(['Data e hora','Usuário','Ação','Registro','Motivo',''],data.rows.map(row=>`<tr>
      <td>${dt(row.created_at)}</td><td>${h(row.user_name)}</td><td><strong>${h(auditNames[row.action] || row.action)}</strong></td>
      <td>${h(row.entity)}${row.entity_id?' #'+row.entity_id:''}</td><td>${h(row.reason || '—')}</td><td>${btn('Detalhes','audit-detail',{attrs:ID(row.id)})}</td></tr>`),
      empty('clipboard','Nenhum registro encontrado'))}${pagination(data)}</section>`;
}
