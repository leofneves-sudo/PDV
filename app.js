import {$,h,icon,btn,iconBtn,header,empty,money,decimal,cents,dayKey,cardNumber,timeZone,uppercaseField,editMoneyField,formatMoneyField} from './ui.js';
import * as views from './views.js';
import * as modals from './modals.js';
import * as scanner from './scanner.js';
import * as updates from './updates.js';

const app=$('#app');
const dialog=$('#modal');
const printArea=$('#print-area');
const themeKey='pdv.theme';
function savedTheme() {
  try {return localStorage.getItem(themeKey)==='dark'?'dark':'light';}
  catch {return 'light';}
}
const state={
  theme:savedTheme(),
  me:null,config:null,view:null,online:false,favorites:[],products:[],customers:[],cards:[],users:[],
  pairing:{reader:null,readers:[]},scanMode:'direct',vibrate:localStorage.getItem('pdv.vibrate')==='true',
  scanned:new Map(),card:null,notes:new Map(),selectedCards:new Set(),donutMode:'count',
  openCards:{total:null,cards:[]},
  dashboardFilter:{period:'today'},dashboardApplied:{period:'today'},
  historyFilter:{page:1},auditFilter:{page:1},filters:{employees:[],categories:[]},local:{}
};
function applyTheme(theme) {
  state.theme=theme;
  document.documentElement.dataset.theme=theme;
  $('meta[name="theme-color"]').content=theme==='dark'?'#101725':'#f5f7fc';
  for (const button of document.querySelectorAll('[data-action="toggle-theme"]')) {
    button.setAttribute('aria-pressed',String(theme==='dark'));
  }
}
applyTheme(state.theme);
const can = key => views.permissionsFor(state,key);
const find = (list,id) => list.find(row=>row.id===id);
const send = (path,body={}) => api(path,{body});
let events=null;
let renderId=0;
let refreshTimer;
let refreshActive=false;
let refreshPending=false;
let reconnectTimer;
let reconnectDelay=1000;
let dialogState={};
let pairingTimer;
let authVersion=0;
let receiptOrder=null;
let mutationQueue=Promise.resolve();
let booting=false;

class ApiError extends Error {
  constructor(message,status) {
    super(message);
    this.status=status;
  }
}
async function api(path,{body}={}) {
  let response;
  try {
    response=await fetch('/api/'+path,body===undefined ? {cache:'no-store'} : {
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store'
    });
  } catch {
    online(false);
    throw new ApiError('Conexão perdida. Aguarde a reconexão e confira se a operação foi registrada.',0);
  }
  const data=await response.json().catch(()=>null);
  if (!response.ok || !data) {
    if (response.status===401 && state.me && path!=='login') locked();
    if (response.status===428 && state.me) {
      state.config.pairingRequired=true;
      showPairingGate();
    }
    throw new ApiError(data?.error || 'O servidor não confirmou a operação.',response.status);
  }
  return data;
}
const query = (path,values) => path+'?'+new URLSearchParams(Object.entries(values).filter(([,value])=>value!==''&&value!=null));
function online(value) {
  const changed=state.online!==value;
  state.online=value;
  const indicator=$('#connectivity');
  if (indicator) {
    indicator.className='connection '+(value?'up':'down');
    indicator.lastElementChild.textContent=value?'Conectado':'Sem conexão';
  }
  const banner=$('#connection-banner');
  if (banner) banner.hidden=value;
  document.querySelectorAll('[data-action="payment"]').forEach(button=>{
    button.disabled=views.paymentDisabled(state);
  });
  if (!value && state.me && state.view==='scanner') scanner.status('Sem conexão com o servidor. Aguarde a reconexão.','error');
  if (changed && state.view==='pos') renderPos();
  updatePayment();
}
function toast(message,tone='success') {
  const node=document.createElement('div');
  node.className='toast '+tone;
  node.setAttribute('role',tone==='error'?'alert':'status');
  node.innerHTML=icon(tone==='error'?'alert':tone==='neutral'?'wifi':'check',20)+`<span>${h(message)}</span>`;
  $('#toasts').append(node);
  window.setTimeout(()=>node.remove(),tone==='error'?6500:4200);
}
function sessionKey() {return 'pdv.cart.'+state.me?.started_at;}
function saveTabs() {
  if (!state.me) return;
  sessionStorage.setItem(sessionKey(),JSON.stringify({active:state.card?.id,ids:[...state.scanned.keys()],hidden:state.local.hiddenCards || []}));
}
async function restoreTabs() {
  if (!can('operate')) return;
  let snapshot;
  try {snapshot=JSON.parse(sessionStorage.getItem(sessionKey()));} catch {}
  state.local.hiddenCards=Array.isArray(snapshot?.hidden)?snapshot.hidden:[];
  const currentUser=authVersion;
  const open=await loadOpenCards().catch(()=>({total:null,cards:[]}));
  if (currentUser!==authVersion || !state.me) return;
  state.openCards=open;
  const first=open.cards[0];
  const ids=[...new Set([...(snapshot?.ids || []),...(first?[first.id]:[])])];
  const entries=await Promise.allSettled(ids.map(id=>api('cards/'+id)));
  if (currentUser!==authVersion || !state.me) return;
  for (const entry of entries) {
    if (entry.status==='fulfilled') state.scanned.set(entry.value.id,entry.value);
  }
  state.card=state.scanned.get(snapshot?.active) || state.scanned.get(first?.id) || null;
  saveTabs();
}
async function loadOpenCards() {
  try {return await api('open-cards');}
  catch (error) {
    if (error.status!==404) throw error;
    // Compatibilidade enquanto o servidor anterior ainda estiver rodando.
    if (can('cards')) {
      const cards=(await api('cards')).filter(card=>card.order_id && !card.blocked && card.active);
      return {total:cards.length,cards};
    }
    return {total:null,cards:[]};
  }
}
function closeModal() {
  if (dialog.open) dialog.close();
  dialogState={};
  clearInterval(pairingTimer);
}
function showModal(title,content,context={}) {
  dialogState=context;
  clearInterval(pairingTimer);
  dialog.classList.toggle('wide',!!context.wide);
  dialog.innerHTML=`<header class="dialog-heading"><h2 id="dialog-title">${h(title)}</h2>${iconBtn('Fechar','close-modal','x')}</header>${content}`;
  dialog.setAttribute('aria-labelledby','dialog-title');
  if (!dialog.open) dialog.showModal();
  const target=$('[autofocus]',dialog);
  if (target) target.focus({preventScroll:true});
}
dialog.addEventListener('cancel',event=>{
  event.preventDefault();
  if (!dialogState.busy) closeModal();
});
function showTerminal(code=null) {
  showModal('Parear caixa',modals.terminalForm(state.pairing,code),{type:'terminal',code});
  if (!code) return;
  const tick=()=>{
    const remaining=Math.max(0,Math.ceil((code.expires-Date.now())/1000));
    const node=$('#pair-expiry');
    if (node) node.textContent=remaining?`Válido por ${remaining}s`:'Código expirado';
    if (!remaining) clearInterval(pairingTimer);
  };
  tick();
  pairingTimer=setInterval(tick,1000);
}
function showPairingGate() {
  if (!state.me || !state.config?.pairingRequired) return;
  state.pairing={reader:null,readers:[]};
  if (state.view==='pairing' && $('#pairing-required')) return;
  renderId++;
  scanner.stop();
  closeModal();
  state.view='pairing';
  state.card=null;
  state.scanned.clear();
  state.openCards={total:null,cards:[]};
  state.notes.clear();
  state.products=[];
  printArea.replaceChildren();
  app.innerHTML=views.pairingView(state,modals.readerForm({required:true}));
}
function locked(message='') {
  authVersion++;
  events?.close();
  events=null;
  clearTimeout(reconnectTimer);
  reconnectDelay=1000;
  scanner.stop();
  closeModal();
  state.me=null;
  state.view=null;
  state.scanned.clear();
  state.openCards={total:null,cards:[]};
  state.card=null;
  state.notes.clear();
  state.selectedCards.clear();
  state.products=[];
  state.favorites=[];
  state.stockDays=undefined;
  state.insightIdleDays=undefined;
  state.stockInsights=null;
  state.managementPage=1;
  state.customers=[];
  state.cards=[];
  state.users=[];
  state.report=null;
  state.history=null;
  state.audit=null;
  state.filters={employees:[],categories:[]};
  state.local={};
  state.dashboardFilter={period:'today'};
  state.dashboardApplied={period:'today'};
  state.historyFilter={page:1};
  state.auditFilter={page:1};
  receiptOrder=null;
  printArea.replaceChildren();
  renderId++;
  state.online=false;
  app.innerHTML=views.auth(state.config,!!state.config,state.theme);
  if (message) toast(message,'neutral');
}
async function bootstrap() {
  if (booting) return;
  booting=true;
  try {
    const config=await api('session');
    state.config=config;
    timeZone(config.timezone);
    if (config.user) await enter(config.user,config);
    else app.innerHTML=views.auth(config,true,state.theme);
  } catch {
    app.innerHTML=views.auth(state.config,false,state.theme);
  } finally {
    booting=false;
  }
}
async function enter(user,config=null) {
  authVersion++;
  state.config=config || await api('session');
  state.me=user;
  state.config.user=user;
  state.config.initialized=true;
  state.config.setup=false;
  state.online=true;
  state.scanMode=state.config.pairingRequired?'paired':sessionStorage.getItem('pdv.reader.'+user.started_at) || 'direct';
  state.pairing=state.config.pairing || {reader:null,readers:[]};
  const view=views.initialView(user,location.hash);
  startEvents();
  if (views.pairingNeeded(state)) return showPairingGate();
  await restoreTabs();
  if (state.me) await navigate(view);
}
function startEvents() {
  clearTimeout(reconnectTimer);
  events?.close();
  const stream=new EventSource('/api/events');
  events=stream;
  stream.addEventListener('ready',()=>{
    if (stream!==events) return;
    clearTimeout(reconnectTimer);
    reconnectDelay=1000;
    online(true);
    scheduleRefresh();
  });
  stream.addEventListener('error',()=>{
    if (stream!==events) return;
    online(false);
    reconnectEvents(stream);
  });
  stream.addEventListener('locked',()=>{
    if (stream===events) locked('Sessão encerrada.');
  });
  stream.addEventListener('change',scheduleRefresh);
  stream.addEventListener('pairing',scheduleRefresh);
  stream.addEventListener('card',event=>{
    if (dialogState.type==='terminal') closeModal();
    const card=JSON.parse(event.data);
    receiveCard(card.id).catch(error=>toast(error.message,'error'));
  });
}
function reconnectEvents(stream) {
  clearTimeout(reconnectTimer);
  const version=authVersion;
  reconnectTimer=setTimeout(async()=>{
    if (stream!==events || version!==authVersion || !state.me || state.online) return;
    try {
      const config=await api('session');
      if (stream!==events || version!==authVersion || !state.me) return;
      if (!config.user) return locked('Sessão encerrada. Entre novamente.');
      startEvents();
    } catch {
      if (stream===events && version===authVersion && state.me) reconnectEvents(stream);
    }
  },reconnectDelay);
  reconnectDelay=Math.min(10000,reconnectDelay*2);
}
function scheduleRefresh() {
  refreshPending=true;
  if (refreshActive) return;
  clearTimeout(refreshTimer);
  refreshTimer=setTimeout(async()=>{
    refreshActive=true;
    refreshPending=false;
    try {
      await refresh();
    } catch (error) {
      if (error.status && ![401,403,428].includes(error.status)) toast(error.message,'error');
    } finally {
      refreshActive=false;
      if (refreshPending) scheduleRefresh();
    }
  },170);
}
async function load(view) {
  switch (view) {
    case 'dashboard': {
      const [report,filters,products,stockInsights]=await Promise.all([api(query('dashboard',state.dashboardApplied)),api('filters'),can(['products','stock'])?api('products'):Promise.resolve([]),api(query('stock-insights',{idleDays:state.insightIdleDays}))]);
      return {report,filters,products,stockInsights};
    }
    case 'insights': return {stockInsights:await api(query('stock-insights',{idleDays:state.insightIdleDays}))};
    case 'pos': {
      const [products,favorites,openCards]=await Promise.all([api('products'),api('favorites'),loadOpenCards()]);
      return {products,favorites,openCards};
    }
    case 'cash': return {cash:await api('cash')};
    case 'backups': return {backups:await api('backups')};
    case 'management': {
      const [management,filters]=await Promise.all([
        api(query('management',{...state.dashboardApplied,stockDays:state.stockDays,page:state.managementPage})),api('filters')
      ]);
      return {management,filters};
    }
    case 'supplies': {
      const [products,suppliers,merchandise]=await Promise.all([api('products'),api('suppliers'),api('merchandise')]);
      return {products,suppliers,merchandise};
    }
    case 'products':
      return {products:await api('products')};
    case 'scanner':
      return {pairing:await api('pairing')};
    case 'customers':
      return can('customer_read')?{customers:await api('customers')}:{customers:[]};
    case 'cards':
      return {cards:await api('cards')};
    case 'history': {
      const [history,filters]=await Promise.all([api(query('history',state.historyFilter)),api('filters')]);
      return {history,filters};
    }
    case 'users':
      return {users:await api('users')};
    case 'audit':
      return {audit:await api(query('audit',state.auditFilter))};
    default:
      return {};
  }
}
const pages={dashboard:views.dashboard,pos:views.pos,scanner:views.scannerView,products:views.productsView,
  customers:views.customersView,cards:views.cardsView,history:views.historyView,users:views.usersView,audit:views.auditView,
  cash:updates.cashPage,supplies:updates.suppliesPage,management:updates.managementPage,backups:updates.backupsPage,
  insights:views.stockInsightsView,
  account:()=>header('Sua sessão','Nenhuma tela está disponível para as permissões deste operador.')};
function focusBefore() {
  const active=document.activeElement;
  if (!active?.matches('#main input, #main textarea, #main select')) return null;
  const key=active.id ? '#'+active.id : `[name="${active.name}"]`;
  const caret=active.selectionStart!=null ? [active.selectionStart,active.selectionEnd] : null;
  return {key,caret};
}
function focusAfter(focus) {
  if (!focus) return;
  const target=$(focus.key,$('#main'));
  target?.focus({preventScroll:true});
  if (target && focus.caret) target.setSelectionRange(...focus.caret);
}
function renderPage() {
  if (views.pairingNeeded(state)) return showPairingGate();
  const main=$('#main');
  if (!main || !state.view) return;
  const focus=focusBefore();
  const posScroll=state.view==='pos'?posScrollBefore():null;
  const expanded=[...main.querySelectorAll('.report-details[open] summary')].map(node=>node.textContent);
  main.innerHTML=pages[state.view](state);
  for (const node of main.querySelectorAll('.report-details summary')) {
    if (expanded.includes(node.textContent)) node.parentElement.open=true;
  }
  if (posScroll) {
    scanner.mountDock();
    restorePosScroll(posScroll);
  }
  if (state.view==='scanner') scanner.restore();
  focusAfter(focus);
  updatePayment();
}
async function navigate(view,{preserveModal=false}={}) {
  if (views.pairingNeeded(state)) return showPairingGate();
  const link=views.navigation.find(item=>item[0]===view);
  if (link && !can(link[3])) return;
  if (!preserveModal) closeModal();
  if (!['scanner','pos'].includes(view)) scanner.stop();
  state.view=view;
  const stamp=++renderId;
  app.innerHTML=views.shell(state);
  if (view==='pos' && state.card) renderPage();
  const dataView=await load(view).catch(error=>{
    if (stamp===renderId && $('#main')) $('#main').innerHTML=empty('alert','Falha ao carregar a tela',error.message,btn('Tentar novamente','reload-page',{ico:'rotate',cls:'primary'}));
    return null;
  });
  if (!dataView || stamp!==renderId || !state.me) return;
  Object.assign(state,dataView);
  renderPage();
}
function captureFilterDraft() {
  const node=$('form[data-form="dashboard-filter"]');
  if (node) state.dashboardFilter={...state.dashboardFilter,...Object.fromEntries(new FormData(node))};
}
async function refresh() {
  if (!state.me) return;
  const view=state.view, stamp=renderId;
  const config=await api('session');
  if (!config.user) return locked('Sessão encerrada. Entre novamente.');
  if (stamp!==renderId || !state.me) return;
  const updated=JSON.stringify(state.me)!==JSON.stringify(config.user);
  state.me=config.user;
  state.config=config;
  state.pairing=config.pairing || {reader:null,readers:[]};
  if (views.pairingNeeded(state)) return showPairingGate();
  if (view==='pairing') {
    await restoreTabs();
    return navigate(views.initialView(state.me,location.hash));
  }
  if (updated) {
    const next=views.navigation.find(item=>item[0]===view && can(item[3]))?.[0] ||
      views.navigation.find(item=>can(item[3]))?.[0] || 'account';
    return navigate(next);
  }
  if (!view) return;
  const pendingCards=can('operate')?[...state.scanned.keys()]:[];
  const [dataView,pairs]=await Promise.all([load(view),
    Promise.all(pendingCards.map(async id=>{
      try {return [id,await api('cards/'+id)];}
      catch (error) {return [id,error.status===403 ? null : undefined];}
    }))]);
  if (stamp!==renderId || !state.me) return;
  Object.assign(state,dataView);
  for (const [id,card] of pairs) {
    const known=state.scanned.get(id);
    if (!known || card===undefined || (dialogState.submitting && dialogState.order?.card_id===id)) continue;
    if (!card) {
      state.scanned.delete(id);
      if (state.card?.id===id && !dialogState.submitting) {
        state.card=null;
        if (dialogState.type==='payment') {
          setFormError($('form[data-form="checkout"]',dialog),'Esta comanda foi encerrada ou perdeu acesso. Confira o histórico.');
          $('#confirm-checkout').disabled=true;
        }
        toast('A comanda foi encerrada ou ficou indisponível.','neutral');
      }
    } else if (!known.order || !card.order || (known.order.id===card.order.id && known.order.version<=card.order.version)) {
      setCard(card,false);
    }
  }
  saveTabs();
  if (view==='scanner') {
    const label=$('#paired-label');
    const radio=$('input[name="scan-mode"][value="paired"]');
    if (label && state.pairing.reader) label.textContent=state.pairing.reader.name+' · '+(state.pairing.reader.online?'Online':'Indisponível');
    if (radio && !state.pairing.reader && !radio.disabled) {
      radio.disabled=true;
      label.textContent='Vincule o celular ao caixa.';
      // Preserve the active camera while the reader reports the lost pairing.
      scanner.status('O pareamento foi encerrado. Faça um novo vínculo ou opere aqui.','error');
    }
    return;
  }
  if (['dashboard','management'].includes(view)) captureFilterDraft();
  if (['history','audit'].includes(view) && document.activeElement?.closest('.filter-strip')) return;
  renderPage();
}
function posScrollBefore() {
  const tabs=$('#order-tabs');
  return {
    card:tabs?.querySelector('[aria-current="true"]')?.dataset.id,
    tabs:tabs?.scrollLeft || 0,
    catalog:$('#product-grid')?.scrollTop || 0,
    order:$('#order-panel .order-content')?.scrollTop || 0
  };
}
function restorePosScroll(previous) {
  const tabs=$('#order-tabs');
  const selected=tabs.querySelector('[aria-current="true"]');
  tabs.scrollLeft=previous.tabs;
  $('#product-grid').scrollTop=previous.catalog;
  if (selected?.dataset.id===previous.card) {
    const content=$('#order-panel .order-content');
    if (content) content.scrollTop=previous.order;
  } else if (selected) {
    const card=selected.parentElement.getBoundingClientRect();
    const rail=tabs.getBoundingClientRect();
    tabs.scrollLeft+=Math.min(0,card.left-rail.left)+Math.max(0,card.right-rail.right);
  }
}
function renderPos() {
  if (state.view!=='pos') return;
  const order=$('#order-panel');
  const focus=focusBefore();
  if (order) {
    const scroll=posScrollBefore();
    order.innerHTML=views.orderPanel(state);
    $('#open-orders-region').innerHTML=views.openOrderNavigation(state);
    $('#mobile-checkout').innerHTML=views.mobileCheckout(state);
    $('#product-grid').innerHTML=views.productGrid(state);
    syncPosNavigation();
    restorePosScroll(scroll);
    focusAfter(focus);
  }
  updatePayment();
}
function syncPosNavigation() {
  const workspace=$('#pos-workspace');
  if (!workspace) return;
  workspace.dataset.mobilePanel=views.posMobilePanel(state);
  $('#mobile-pos-navigation').innerHTML=views.mobilePosNavigation(state);
  const feedback=$('#pos-add-feedback');
  feedback.textContent=state.local.posFeedback || '';
  feedback.title=feedback.textContent;
}
function setCard(card,activate=true) {
  const known=state.scanned.get(card.id);
  if (known?.order && card.order && known.order.id===card.order.id && known.order.version>card.order.version) card=known;
  if (state.card?.id===card.id && !state.card.order && card.order) state.local.posMobilePanel='catalog';
  state.scanned.set(card.id,card);
  if (activate || state.card?.id===card.id) state.card=card;
  saveTabs();
}
function finishCard(order) {
  state.scanned.delete(order.card_id);
  clearTimeout(state.notes.get(order.id)?.timer);
  state.notes.delete(order.id);
  if (state.card?.id===order.card_id) state.card=null;
  const open=state.openCards;
  const cards=open.cards.filter(card=>card.id!==order.card_id || card.order_id!==order.id);
  state.openCards={...open,cards,total:open.total==null?null:Math.max(0,open.total-(open.cards.length-cards.length))};
  saveTabs();
  renderPos();
}
async function requestCardClosure(id) {
  if (!state.online) throw new Error('Sem conexão. Aguarde o servidor para encerrar a comanda.');
  const version=authVersion;
  await mutationQueue.catch(()=>{});
  const known=state.scanned.get(id)?.order;
  if (known) await flushNotes(known.id);
  const card=await api('cards/'+id);
  if (version!==authVersion || !state.me) return;
  if (card.order) {
    await receiveCard(id,card);
    return showModal(`Encerrar comanda #${cardNumber(card.number)}`,modals.closeOrderView(card.order,state),{order:card.order});
  }
  state.local.hiddenCards=[...new Set([...(state.local.hiddenCards || []),id])];
  state.scanned.delete(id);
  if (state.card?.id===id) state.card=null;
  saveTabs();
  renderPos();
}
async function receiveCard(id,data=null) {
  const version=authVersion;
  const card=data || await api('cards/'+id);
  if (version!==authVersion || !state.me) return;
  state.local.posMobilePanel=card.order?'catalog':'order';
  state.local.posFeedback='';
  state.local.hiddenCards=(state.local.hiddenCards || []).filter(id=>id!==card.id);
  setCard(card);
  if (state.view==='pos' && $('#order-panel')) renderPos();
  else await navigate('pos',{preserveModal:dialog.open});
  if (card.order) toast(`Comanda #${cardNumber(card.number)} selecionada.`);
}
async function scanCode(code,{external=false}={}) {
  if (!state.online) {
    const message='Sem conexão. Aguarde o servidor antes de ler novamente.';
    scanner.status(message,'error');
    if (external) throw new Error(message);
    return;
  }
  const readerMode=state.scanMode;
  const version=authVersion;
  try {
    const value=await send('scan',{code,mode:readerMode});
    if (version!==authVersion) return;
    scanner.feedback(true,state.vibrate);
    if (value.sent) {
      if (value.card) await receiveCard(value.card.id,value.card);
      scanner.status(value.card?`Cartão #${cardNumber(value.number)} disponível neste celular e enviado para ${value.terminal}.`:
        `Cartão #${cardNumber(value.number)} enviado para ${value.terminal}.`,'success');
    } else {
      await receiveCard(value.id,value);
    }
  } catch (error) {
    scanner.status(error.message,'error');
    scanner.feedback(false,state.vibrate);
    if (external) throw error;
  }
}
function applyCard(data) {
  if (!state.me) return;
  if (state.scanned.has(data.id) || state.card?.id===data.id) setCard(data,false);
  renderPos();
  scheduleRefresh();
}
function captureNotes(field) {
  const order=state.card?.order;
  if (!order) return;
  let draft=state.notes.get(order.id);
  if (!draft) {
    draft={base:order.notes,value:field.value,error:null,timer:null,pending:null,card:order.card_id};
    state.notes.set(order.id,draft);
  } else {
    draft.value=field.value;
    draft.error=null;
  }
  clearTimeout(draft.timer);
  draft.timer=setTimeout(()=>flushNotes(order.id).catch(()=>{}),520);
  const status=$('#notes-status');
  if (status) status.textContent='Salvando…';
}
async function flushNotes(id) {
  const draft=state.notes.get(id);
  if (!draft) return;
  clearTimeout(draft.timer);
  if (draft.pending) {
    await draft.pending;
    if (state.notes.get(id)!==draft) return;
  }
  if (draft.value===draft.base) {
    state.notes.delete(id);
    renderPos();
    return;
  }
  const saved=draft.value;
  const version=authVersion;
  draft.pending=send(`orders/${id}/update`,{field:'notes',value:saved,previous:draft.base}).then(data=>{
    if (version!==authVersion) return;
    draft.base=data.order.notes;
    if (draft.value===saved) state.notes.delete(id);
    applyCard(data);
  }).catch(error=>{
    if (version===authVersion) {
      draft.error=error.message;
      renderPos();
    }
    throw error;
  }).finally(()=>{draft.pending=null;});
  await draft.pending;
  if (state.notes.get(id)===draft && !draft.error) return flushNotes(id);
}
function setFormError(form,message='') {
  const target=form && $('.form-error',form);
  if (target) {
    target.textContent=message;
    target.hidden=!message;
  }
}
function checkoutFields(form) {
  const parsed={};
  let valid=true;
  for (const [key] of Object.entries(state.config.methods)) {
    try {parsed[key]=form.elements[key]?.value ? cents(form.elements[key].value) : 0;}
    catch {parsed[key]=0;valid=false;}
  }
  const receivedField=form.elements.received;
  if (receivedField) receivedField.disabled=!parsed.cash;
  let received=0;
  try {received=parsed.cash && receivedField?.value ? cents(receivedField.value) : 0;}
  catch {valid=false;}
  const total=Object.values(parsed).reduce((sum,amount)=>sum+amount,0);
  return {parsed,received,total,valid};
}
function updatePayment() {
  if (dialogState.type!=='payment') return;
  const form=$('form[data-form="checkout"]',dialog);
  if (!form) return;
  const order=dialogState.order;
  const current=state.scanned.get(order.card_id)?.order;
  const {parsed,received,total,valid}=checkoutFields(form);
  const remaining=order.total-order.confirmed;
  const available=remaining-order.pending;
  $('#payments-value',form).textContent=money(order.confirmed);
  $('#payments-remaining',form).textContent=money(remaining);
  $('#payments-pending',form).textContent=order.pending ? `${money(order.pending)} em PIX pendente` : '';
  $('#cash-change',form).textContent=money(Math.max(0,received-parsed.cash));
  const error=dialogState.finalized?'':!current?'Esta comanda foi encerrada ou perdeu acesso. Confira o histórico.':
    current.sale_blocks?.length?'Venda bloqueada por validade. Cancele as parcelas e remova os itens vencidos ou regularize as validades ausentes.':
    current.version!==order.version?'A comanda mudou. Reabra o pagamento para conferir o estado salvo.':
    !valid?'Confira os valores informados.':parsed.store>(current?.balance ?? order.balance)?'Saldo de crédito insuficiente.':
    parsed.cash && received<parsed.cash?'Informe o valor recebido em dinheiro.':
    total>available?'O valor informado ultrapassa o saldo disponível.':'';
  if (!dialogState.busy && !dialogState.transportError) setFormError(form,error);
  const disable=dialogState.busy || !state.online || !!error;
  $('#confirm-checkout',form).disabled=disable || !!order.pending || !!parsed.pix || remaining!==total;
  const partial=$('#register-payment',form);
  if (partial) partial.disabled=disable || !total;
}
function showPayment(order) {
  showModal('Receber pagamento',modals.paymentView(order,state.config),{type:'payment',order,wide:true});
  updatePayment();
}
async function openCustomer(id) {
  const customer=await api('customers/'+id);
  showModal(customer.name,modals.customerDetailView(customer,state),{type:'customer-detail',customer,wide:true});
}
function showOrder(order) {
  receiptOrder=order;
  showModal(`Atendimento #${order.id}`,modals.orderDetailView(order,state),{type:'order-detail',order,wide:true});
}
async function pageReload() {
  const view=state.view;
  const stamp=++renderId;
  const values=await load(view);
  if (stamp!==renderId || state.view!==view) return;
  Object.assign(state,values);
  renderPage();
}
async function printCards(ids) {
  if (!ids.length) return;
  if (ids.length>100) throw new Error('Selecione no máximo 100 cartões por impressão.');
  const cards=await api('cards/print?ids='+ids.join(','));
  if (!cards.length) throw Error('Selecione ao menos um cartão disponível para impressão.');
  const images=cards.map(row=>`<article class="printed-card"><h2>Comanda #${cardNumber(row.number)}</h2><img src="/api/cards/${row.id}/qr" alt="QR da comanda ${row.number}" width="240" height="240"><b>Last Place PDV</b></article>`);
  printArea.innerHTML=`<div class="printed-grid">${images.join('')}</div>`;
  try {
    await Promise.all([...printArea.querySelectorAll('img')].map(img=>img.decode()));
    window.print();
  } catch {
    throw new Error('O servidor não conseguiu gerar os QR Codes para impressão.');
  }
}
function extensionContext() {
  return {state,show:showModal,dialog:dialogState,order:receiptOrder,showOrder,showPayment,
    api,send,navigate,close:closeModal,reload:pageReload,toast,query,applyCard,receiveCard,finishCard,renderPos,refresh:scheduleRefresh};
}
async function actions(action,element) {
  const id=Number(element.dataset.id)||null;
  const data=state.card?.order;
  if (action.startsWith('ext-')) return updates.act(extensionContext(),action.slice(4),element);
  switch (action) {
    case 'retry': return bootstrap();
    case 'toggle-theme': {
      const theme=state.theme==='dark'?'light':'dark';
      applyTheme(theme);
      try {localStorage.setItem(themeKey,theme);} catch {}
      return;
    }
    case 'menu': $('.layout')?.classList.toggle('menu-open'); return;
    case 'navigate': return navigate(element.dataset.view);
    case 'reload-page': return navigate(state.view);
    case 'close-modal': if (!dialogState.busy) closeModal(); return;
    case 'lock': {
      for (const id of [...state.notes.keys()]) await flushNotes(id);
      await send('logout');
      if (state.me) locked('Sessão bloqueada.');
      return;
    }
    case 'terminal':
      state.pairing=await api('pairing');
      return showTerminal();
    case 'revoke-readers':
      return showModal('Desvincular leitores',modals.confirmation('revoke-readers','Todos os celulares vinculados a este caixa deixarão de enviar leituras.',null,'Desvincular'),{});
    case 'pair-reader':
      return showModal('Parear com caixa',modals.readerForm());
    case 'unlink-reader':
      return showModal('Desvincular celular',modals.body('<p>Este celular deixará de enviar leituras ao caixa.</p>',
        btn('Voltar','close-modal')+btn('Desvincular','unlink-confirm',{cls:'danger-btn'})));
    case 'unlink-confirm':
      state.pairing=await send('pairing/unlink');
      state.scanMode=state.config.pairingRequired?'paired':'direct';
      sessionStorage.setItem('pdv.reader.'+state.me.started_at,state.scanMode);
      closeModal();
      renderPage();
      return toast('Celular desvinculado.');
    case 'camera-start': return scanner.start(code=>scanCode(code));
    case 'camera-stop': scanner.stop(true); return;
    case 'camera-flash': return scanner.flash();
    case 'category':
      state.local.posCategory=element.dataset.category;
      document.querySelectorAll('[data-action="category"]').forEach(button=>{
        button.classList.toggle('chosen',button===element);
        button.setAttribute('aria-pressed',String(button===element));
      });
      $('#product-grid').innerHTML=views.productGrid(state);
      $('#product-grid').scrollTop=0;
      return;
    case 'switch-card': return receiveCard(id);
    case 'pos-panel':
      state.local.posMobilePanel=element.dataset.panel==='order'?'order':'catalog';
      syncPosNavigation();
      $('#mobile-checkout').innerHTML=views.mobileCheckout(state);
      $('#pos-workspace')?.scrollIntoView({block:'start'});
      $(views.posMobilePanel(state)==='catalog'?'#catalog-heading':'#order-panel')?.focus({preventScroll:true});
      return;
    case 'hide-card':
    case 'close-card': return requestCardClosure(id);
    case 'close-card-payment': {
      const order=dialogState.order;
      if (!order) return;
      await mutationQueue.catch(()=>{});
      await flushNotes(order.id);
      const card=await api('cards/'+order.card_id);
      if (!card.order || card.order.id!==order.id) throw new Error('Esta comanda foi encerrada. Confira o histórico ou leia o cartão novamente.');
      setCard(card);
      renderPos();
      return showPayment(card.order);
    }
    case 'close-card-cancel': {
      const order=dialogState.order;
      if (!order) return;
      return showModal(`Cancelar comanda #${cardNumber(order.number)}`,modals.confirmation('cancel-order',
        'O atendimento será cancelado e o cartão e as reservas serão liberados.',order.id,'Confirmar cancelamento'),{order});
    }
    case 'open-order':
      state.local.posMobilePanel='catalog';
      return applyCard(await send(`cards/${id}/open`));
    case 'add-item':
    case 'item-plus':
    case 'item-minus': {
      if (!data) return;
      if (!state.online) throw new Error('Sem conexão. Aguarde o servidor para adicionar ou alterar produtos.');
      const version=authVersion;
      const patch=action==='add-item'?{product:id}:{item:id};
      const next=mutationQueue.catch(()=>{}).then(async()=>{
        if (version!==authVersion) return;
        if (!state.online) throw new Error('Sem conexão. Aguarde o servidor para adicionar ou alterar produtos.');
        const current=state.scanned.get(data.card_id)?.order;
        if (action==='item-minus') {
          const item=find(current?.items || [],id);
          if (!item) return;
          if (item.quantity===1) {
            if (can('item_remove')) showModal('Remover item',modals.itemForm('remove',item,state),{order:current,item});
            return;
          }
          patch.expectedQuantity=item.quantity;
        }
        const result=await send(`orders/${data.id}/items`,{...patch,action:'delta',delta:action==='item-minus'?-1:1});
        if (version!==authVersion) return;
        if (action==='add-item') state.local.posFeedback=`${find(state.products,id)?.name || 'Produto'} adicionado à comanda #${cardNumber(data.number)}.`;
        applyCard(result);
      });
      mutationQueue=next;
      return next;
    }
    case 'item-remove':
    case 'item-price':
    case 'item-quantity': {
      const item=find(data?.items || [],id);
      if (!item) return;
      const mode=action.slice(5);
      return showModal({remove:'Remover item',price:'Alterar preço',quantity:'Quantidade'}[mode],
        modals.itemForm(mode,item,state),{order:data,item});
    }
    case 'discount':
      return showModal('Desconto da comanda',modals.discountForm(data),{order:data});
    case 'cancel-order':
      return showModal('Cancelar comanda',modals.confirmation('cancel-order','A comanda será encerrada e as reservas serão liberadas.',data.id,'Confirmar cancelamento'),{order:data});
    case 'order-customer':
      state.customers=await api('customers');
      if (!state.card?.order) return;
      return showModal('Vincular cliente',modals.orderCustomer(state),{order:state.card.order});
    case 'pick-customer':
      applyCard(await send(`orders/${dialogState.order.id}/update`,{field:'customer',value:id}));
      closeModal();
      return toast(id?'Cliente vinculado.':'Cliente desvinculado.');
    case 'notes-discard':
      if (!data) return;
      state.notes.delete(data.id);
      renderPos();
      return;
    case 'notes-retry': {
      const draft=data && state.notes.get(data.id);
      if (!draft) return;
      draft.base=data.notes;
      return flushNotes(data.id);
    }
    case 'payment': {
      await mutationQueue.catch(()=>{});
      if (!data) return;
      await flushNotes(data.id);
      const order=state.scanned.get(data.card_id)?.order;
      if (!order?.items.length) throw new Error('A comanda mudou. Leia novamente ou confira os itens.');
      return showPayment(order);
    }
    case 'fill-payment': {
      const form=element.form;
      const {parsed}=checkoutFields(form);
      const key=element.dataset.method;
      const order=dialogState.order;
      const others=Object.values(parsed).reduce((sum,n)=>sum+n,0)-parsed[key];
      const available=order.total-order.confirmed-order.pending;
      const limit=key==='store'?order.balance:available;
      form.elements[key].value=decimal(Math.max(0,Math.min(limit,available-others)));
      dialogState.transportError=false;
      updatePayment();
      return;
    }
    case 'receipt-print':
      if (!receiptOrder) return;
      printArea.innerHTML=modals.receipt(receiptOrder,state.config);
      window.print();
      return;
    case 'insights-export': location.href='/api/'+query('stock-insights.csv',{idleDays:state.insightIdleDays}); return;
    case 'insights-product':
      state.local.productSearch=element.dataset.code;
      state.local.productStatus='';
      state.local.expiryFilter='';
      return navigate('products');
    case 'insights-page':
      state.local.insightPage=Number(element.dataset.page);
      $('#insight-results').innerHTML=views.stockInsightRows(state);
      return;
    case 'expiry-filter':
      state.local.expiryFilter=element.dataset.status;
      state.local.productStatus='';
      state.local.productSearch='';
      if (state.view==='products') return renderPage();
      return navigate('products');
    case 'expiry-export': location.href='/api/inventory/expiry.csv'; return;
    case 'expiry-loss': return showModal('Registrar perda por validade',modals.expiryLossForm(find(state.products,id)));
    case 'product-edit': return showModal(id?'Editar produto':'Novo produto',modals.productForm(find(state.products,id),state));
    case 'stock': return showModal('Movimentar estoque',modals.stockForm(find(state.products,id)));
    case 'stock-history': {
      const [rows,counts]=await Promise.all([api(`products/${id}/movements`),api(`products/${id}/counts`)]);
      return showModal('Movimentações de estoque',modals.movementsView(rows,counts),{wide:true});
    }
    case 'customer-edit': {
      const customer=find(state.customers,id) || (id?await api('customers/'+id):null);
      return showModal(id?'Editar cliente':'Novo cliente',modals.customerForm(customer),
        {order:element.dataset.inOrder==='true'?dialogState.order:null,customer});
    }
    case 'customer-detail': return openCustomer(id);
    case 'credit-add':
      return showModal('Adicionar crédito',modals.depositForm(dialogState.customer || await api('customers/'+id),state.config));
    case 'credit-correct': {
      const customer=dialogState.customer;
      const entry=find(customer?.ledger || [],id);
      if (entry) showModal('Corrigir recarga',modals.correctCreditForm(entry,state.config),{customer});
      return;
    }
    case 'credit-reverse': {
      const customer=Number(element.dataset.customer);
      return showModal('Estornar recarga',modals.confirmation('credit-reverse','Será registrado um débito no extrato, vinculado à recarga original.',id,'Confirmar estorno',
        `<input type="hidden" name="customer" value="${customer}">`));
    }
    case 'card-create': return showModal('Novo lote de cartões',modals.cardsForm());
    case 'card-print': return printCards(id?[id]:[...state.selectedCards]);
    case 'card-status': {
      const card=find(state.cards,id);
      const title=card.active?'Inativar cartão':'Reativar cartão';
      return showModal(title,modals.confirmation('card-status',`${title} #${cardNumber(card.number)}?`,id,title),{card});
    }
    case 'user-edit': return showModal(id?'Editar operador':'Novo operador',modals.userForm(find(state.users,id),state.config),{wide:true});
    case 'order-detail': return showOrder(await api('orders/'+id));
    case 'order-refund':
      return showModal('Estornar venda',modals.confirmation('refund','O estoque e o crédito da loja serão devolvidos. Para dinheiro ou cartão, faça a devolução pelo meio original.',id,'Confirmar estorno'));
    case 'audit-detail': {
      const row=find(state.audit.rows,id);
      return showModal('Registro de auditoria',modals.auditDetail(row),{wide:true});
    }
    case 'export':
      location.href='/api/'+(state.view==='dashboard'?query('dashboard.csv',state.dashboardApplied):query('history.csv',state.historyFilter));
      return;
    case 'donut':
      captureFilterDraft();
      state.donutMode=element.dataset.mode;
      return renderPage();
    case 'page':
      (state.view==='history'?state.historyFilter:state.auditFilter).page=Number(element.dataset.page);
      return pageReload();
  }
}
async function fileData(file) {
  if (file.size>1_000_000) throw new Error('A imagem deve ter até 1 MB.');
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(reader.result);
    reader.onerror=()=>reject(new Error('Não foi possível ler a imagem.'));
    reader.readAsDataURL(file);
  });
}
async function checkout(form,context,mode) {
  const order=context.order, close=mode==='close';
  await flushNotes(order.id);
  const {parsed,received,total,valid}=checkoutFields(form);
  const remaining=order.total-order.confirmed-order.pending;
  if (!valid || total>remaining || received<parsed.cash || (!close && !total)) throw Error('Confira os valores dos pagamentos.');
  if (close && (total!==remaining || order.pending || parsed.pix)) throw Error('Quite a comanda e confirme os PIX antes de fechar.');
  const payer=form.elements.payer?.value || '';
  const payments=Object.entries(parsed).filter(([,amount])=>amount>0).map(([method,amount])=>
    ({method,amount,payer,...(method==='cash'?{received}:{})}));
  const payload={version:order.version,payments};
  payload.request_id=updates.requestId(context,{close,...payload});
  context.submitting=true;
  let result;
  try {
    result=await send(`orders/${order.id}/${close?'checkout':'payments'}`,payload);
  } catch (error) {
    if (close && (error.status===0 || error.status===409 || error.status>=500)) {
      result=await api(`orders/${order.id}/receipt`).catch(()=>null);
    }
    if (!result) {
      context.transportError=true;
      throw error;
    }
  } finally {
    context.submitting=false;
  }
  if (result.order) {
    applyCard(result);
    showPayment(result.order);
    return toast(parsed.pix?'Parcela registrada. Confirme o PIX após conferir o extrato.':'Parcela confirmada pelo servidor.');
  }
  context.finalized=true;
  finishCard(result);
  showOrder(result);
  toast('Venda confirmada pelo servidor.');
  scheduleRefresh();
}
async function submit(form,name,fields,context) {
  const id=Number(fields.id)||null;
  const protect=(path,payload)=>updates.protectedSend(extensionContext(),path,payload,context);
  if (name.startsWith('ext-')) return updates.submit(extensionContext(),name.slice(4),fields,context);
  switch (name) {
    case 'setup':
    case 'login': {
      const answer=await send(name,fields);
      return enter(answer.user);
    }
    case 'dashboard-filter':
      state.dashboardFilter=fields;
      state.dashboardApplied={...fields};
      state.managementPage=1;
      return pageReload();
    case 'insights-filter':
      state.insightIdleDays=Number(fields.idleDays);
      state.local.insightPage=1;
      return pageReload();
    case 'history-filter':
      state.historyFilter={...fields,page:1};
      return pageReload();
    case 'audit-filter':
      state.auditFilter={...fields,page:1};
      return pageReload();
    case 'external-scan':
      scanner.prepareSound();
      await scanCode(fields.code,{external:true});
      form.reset();
      return;
    case 'terminal':
      return showTerminal(await send('pairing/code',fields));
    case 'revoke-readers':
      state.pairing=await send('pairing/revoke',{reason:fields.reason});
      return showTerminal();
    case 'pair-reader': {
      const wasGate=state.view==='pairing';
      state.pairing=await send('pairing/link',fields);
      state.scanMode='paired';
      sessionStorage.setItem('pdv.reader.'+state.me.started_at,'paired');
      closeModal();
      if (wasGate) {
        await restoreTabs();
        await navigate(views.initialView(state.me,location.hash));
      } else renderPage();
      return toast(`Vinculado a ${state.pairing.reader?.name || 'caixa'}.`);
    }
    case 'product': {
      const category=fields.category.trim();
      const originalCategory=state.products.find(product=>product.category.toLocaleUpperCase('pt-BR')===category)?.category;
      const values={...fields,category:originalCategory ?? category,price:cents(fields.price),cost:fields.cost?cents(fields.cost):null,
        stock:Number(fields.stock || 0),minimum:Number(fields.minimum),active:fields.active==='yes',foil:fields.foil===''?null:fields.foil==='foil'};
      delete values.image;
      if (fields.image?.size) values.image=await fileData(fields.image);
      else if (fields.removeImage) values.image=null;
      await send(id?`products/${id}`:'products',values);
      closeModal();
      await pageReload();
      return toast('Produto salvo.');
    }
    case 'stock':
      await protect(`products/${id}/stock`,{delta:Number(fields.quantity)*(fields.direction==='out'?-1:1),reason:fields.reason,approval:modals.approvalFrom(fields)});
      closeModal();
      await pageReload();
      return toast('Movimentação registrada.');
    case 'expiry-loss':
      await protect(`products/${id}/expiry-loss`,{quantity:Number(fields.quantity),expected_stock:Number(fields.expected_stock),expected_expiry:fields.expected_expiry || null,reason:fields.reason,approval:modals.approvalFrom(fields)});
      closeModal();
      await pageReload();
      return toast('Perda registrada no estoque e na auditoria.');
    case 'customer': {
      const customer=await send(id?`customers/${id}`:'customers',{...fields,active:fields.active!=='no'});
      if (context.order) {
        try {
          applyCard(await send(`orders/${context.order.id}/update`,{field:'customer',value:customer.id}));
          closeModal();
          return toast('Cliente cadastrado e vinculado.');
        } catch (error) {
          closeModal();
          toast('Cliente cadastrado. '+error.message,'error');
          return;
        }
      }
      closeModal();
      await pageReload();
      if (can('customer_read')) await openCustomer(customer.id);
      return toast('Cliente salvo.');
    }
    case 'deposit':
      await protect(`customers/${id}/deposit`,{amount:cents(fields.amount),source:fields.source,origin:fields.origin,reason:fields.reason,approval:modals.approvalFrom(fields)});
      await openCustomer(id);
      return toast('Crédito adicionado.');
    case 'credit-correct':
      await protect(`ledger/${id}/correct`,{...fields,amount:cents(fields.amount)});
      await openCustomer(context.customer.id);
      return toast('Recarga corrigida.');
    case 'credit-reverse':
      await protect(`ledger/${id}/reverse`,fields);
      await openCustomer(Number(fields.customer));
      return toast('Recarga estornada.');
    case 'card-create':
      await send('cards',{start:Number(fields.start),count:Number(fields.count)});
      closeModal();
      await pageReload();
      return toast('Cartões cadastrados.');
    case 'card-status':
      await send(`cards/${id}`,{reason:fields.reason,active:!context.card.active});
      closeModal();
      await pageReload();
      return toast('Status do cartão atualizado.');
    case 'user': {
      const permissions=Object.fromEntries(Object.keys(state.config.permissions).map(key=>[key,fields['allow-'+key]==='on']));
      await send(id?`users/${id}`:'users',{...fields,active:fields.active==='yes',permissions,discount_limit:cents(fields.discount_limit)});
      closeModal();
      await pageReload();
      return toast('Operador salvo.');
    }
    case 'discount':
      applyCard(await send(`orders/${context.order.id}/update`,{field:'discount',value:cents(fields.value),reason:fields.reason,approval:modals.approvalFrom(fields)}));
      closeModal();
      return toast('Desconto atualizado.');
    case 'item': {
      const mode=fields.mode;
      const data={item:id,reason:fields.reason};
      if (mode==='price') Object.assign(data,{action:'price',price:cents(fields.value)});
      else if (mode==='remove') data.action='remove';
      else {
        data.action='delta';
        data.delta=Number(fields.value)-context.item.quantity;
        data.expectedQuantity=context.item.quantity;
        if (!data.delta) return closeModal();
      }
      applyCard(await send(`orders/${context.order.id}/items`,data));
      closeModal();
      return toast('Item atualizado.');
    }
    case 'cancel-order': {
      const order=await send(`orders/${id}/cancel`,{reason:fields.reason,approval:modals.approvalFrom(fields)});
      finishCard(order);
      closeModal();
      scheduleRefresh();
      return toast('Comanda cancelada.');
    }
    case 'refund':
      showOrder(await send(`orders/${id}/refund`,fields));
      scheduleRefresh();
      return toast('Estorno registrado.');
    case 'checkout': return checkout(form,context,fields.mode);
  }
}
document.addEventListener('click',event=>{
  const element=event.target.closest('[data-action]');
  if (!element || element.disabled) return;
  const action=element.dataset.action;
  if (event.target.closest('#modal') && dialogState.busy) return;
  Promise.resolve(actions(action,element)).catch(error=>toast(error.message,'error'));
});
document.addEventListener('submit',async event=>{
  const form=event.target;
  const name=form.dataset.form;
  if (!name) return;
  event.preventDefault();
  if (form.dataset.busy) return;
  form.dataset.busy='true';
  for (const field of form.elements) {
    uppercaseField(field);
    formatMoneyField(field);
  }
  const fields=Object.fromEntries(new FormData(form));
  if (name==='checkout') fields.mode=event.submitter?.value || 'partial';
  const context=form.closest('#modal')?dialogState:{};
  context.busy=true;
  const button=event.submitter || $('button[type="submit"]',form);
  if (button) button.disabled=true;
  setFormError(form);
  try {
    await submit(form,name,fields,context);
  } catch (error) {
    if ($('.form-error',form)) setFormError(form,error.message);
    else toast(error.message,'error');
  } finally {
    delete form.dataset.busy;
    context.busy=false;
    if (button && form.isConnected) button.disabled=false;
    if (name==='checkout') {
      const error=$('.form-error',form);
      if (error && !error.hidden) context.transportError=true;
      updatePayment();
    }
  }
});
document.addEventListener('focusin',event=>editMoneyField(event.target));
document.addEventListener('focusout',event=>formatMoneyField(event.target));
document.addEventListener('compositionend',event=>{
  if (event.target.hasAttribute('data-uppercase')) event.target.dispatchEvent(new Event('input',{bubbles:true}));
});
document.addEventListener('input',event=>{
  const field=event.target;
  if (event.isComposing) return;
  uppercaseField(field);
  if (field.name==='category' && field.form?.dataset.form==='product') modals.updateProductExpiry(field.form);
  if (field.hasAttribute('data-money') && event.inputType==='insertFromPaste') {
    formatMoneyField(field);
    editMoneyField(field);
  }
  if (field.id==='pos-search') {
    state.local.posSearch=field.value;
    $('#product-grid').innerHTML=views.productGrid(state);
    $('#product-grid').scrollTop=0;
  } else if (field.id==='insight-search') {
    state.local.insightSearch=field.value;
    state.local.insightPage=1;
    $('#insight-results').innerHTML=views.stockInsightRows(state);
  } else if (field.id==='product-search') {
    state.local.productSearch=field.value;
    $('#list-results').innerHTML=views.productRows(state);
  } else if (field.id==='customer-search') {
    state.local.customerSearch=field.value;
    $('#list-results').innerHTML=views.customerRows(state);
  } else if (field.id==='customer-picker') {
    $('#customer-choices').innerHTML=modals.pickerRows(state,field.value);
  } else if (field.id==='order-notes') captureNotes(field);
  else if (field.closest('form[data-form="checkout"]')) {
    if (field.name==='people') {
      const people=Number(field.value), order=dialogState.order;
      $('#share-value').textContent=people>=2&&people<=99&&Number.isInteger(people)?
        money(Math.floor((order.total-order.confirmed-order.pending)/people)):'—';
    }
    dialogState.transportError=false;
    updatePayment();
  }
});
document.addEventListener('change',event=>{
  const field=event.target;
  uppercaseField(field);
  if (field.name==='category' && field.form?.dataset.form==='product') modals.updateProductExpiry(field.form);
  if (field.name==='period' && ['dashboard','management'].includes(state.view)) {
    captureFilterDraft();
    if (!state.dashboardFilter.start) state.dashboardFilter.start=dayKey();
    if (!state.dashboardFilter.end) state.dashboardFilter.end=dayKey();
    renderPage();
  } else if (field.id==='product-status') {
    state.local.productStatus=field.value;
    $('#list-results').innerHTML=views.productRows(state);
  } else if (field.id==='insight-signal') {
    state.local.insightSignal=field.value;
    state.local.insightPage=1;
    $('#insight-results').innerHTML=views.stockInsightRows(state);
  } else if (field.id==='product-expiry') {
    state.local.expiryFilter=field.value;
    renderPage();
  } else if (field.id==='deposit-source') {
    const origin=$('#deposit-origin');
    origin.disabled=field.value!=='funded';
    origin.required=!origin.disabled;
  } else if (field.id==='vibrate') {
    state.vibrate=field.checked;
    localStorage.setItem('pdv.vibrate',String(field.checked));
  } else if (field.name==='scan-mode') {
    state.scanMode=state.config.pairingRequired?'paired':field.value;
    sessionStorage.setItem('pdv.reader.'+state.me.started_at,state.scanMode);
  }
  else if (field.id==='camera-select') scanner.setCamera(field.value);
  else if (field.id==='user-role') $('#permissions-field').hidden=field.value==='admin';
  else if (field.classList.contains('select-card')) {
    const id=Number(field.value);
    if (field.checked) {
      if (state.selectedCards.size>=100) {
        field.checked=false;
        toast('Selecione até 100 cartões por impressão.','error');
      } else state.selectedCards.add(id);
    } else state.selectedCards.delete(id);
    $('#select-all-cards').checked=state.cards.filter(card=>!card.blocked).every(card=>state.selectedCards.has(card.id));
    $('#print-selection').disabled=!state.selectedCards.size;
  } else if (field.id==='select-all-cards') {
    state.selectedCards.clear();
    if (field.checked) {
      const available=state.cards.filter(card=>!card.blocked);
      available.slice(0,100).forEach(card=>state.selectedCards.add(card.id));
      if (available.length>100) toast('Os primeiros 100 cartões foram selecionados.','neutral');
    }
    renderPage();
  }
});
window.addEventListener('storage',event=>{
  if (event.key===themeKey) applyTheme(savedTheme());
});
window.addEventListener('online',()=>{
  if (state.me && !state.online) startEvents();
  scheduleRefresh();
});
window.addEventListener('offline',()=>api('session').then(()=>online(true)).catch(()=>online(false)));
window.addEventListener('afterprint',()=>printArea.replaceChildren());
setInterval(()=>{
  if (state.me && !document.hidden && ['dashboard','products','pos','insights'].includes(state.view)) scheduleRefresh();
},60000);
document.addEventListener('visibilitychange',()=>{
  if (!document.hidden && state.me) scheduleRefresh();
});
bootstrap();
