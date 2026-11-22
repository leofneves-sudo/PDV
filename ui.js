export const $ = (selector, root=document) => root.querySelector(selector);
const symbols = {
  dashboard:'<rect x="3" y="3" width="7" height="8" rx="1.3"/><rect x="14" y="3" width="7" height="5" rx="1.3"/><rect x="3" y="15" width="7" height="6" rx="1.3"/><rect x="14" y="12" width="7" height="9" rx="1.3"/>',
  cart:'<rect x="4" y="6" width="16" height="15" rx="2"/><path d="M8 8V6a4 4 0 1 1 8 0v2M9 15h6"/>',
  qr:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h4m-7 0v4h3m4-7v1m0 5v1"/>',
  scan:'<path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3M3 12h18"/><path d="M8 7v2m4-2v2m4-2v2m-8 6v2m4-2v2m4-2v2"/>',
  box:'<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 9v9M4 7.5l8 4.5 8-4.5m-12-2L16 10"/>',
  people:'<path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2m16 0v-2a4 4 0 0 0-2.5-3.7M16 3.4a4 4 0 0 1 0 7.2"/><circle cx="10" cy="7" r="4"/>',
  clock:'<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3 1.5"/>',
  shield:'<path d="M12 22s7-3.5 7-10V5l-7-3-7 3v7c0 6.5 7 10 7 10Z"/><path d="m9 12 2 2 4-4"/>',
  clipboard:'<rect x="5" y="5" width="14" height="16" rx="2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6m-6 4h6"/>',
  lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3m-4 5v2"/>',
  wallet:'<path d="M19 8V6a2 2 0 0 0-2-2l-12 3a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-2m-1-8H5a2 2 0 0 1-2-2"/><path d="M16 11h5v5h-5a2.5 2.5 0 1 1 0-5Z"/><path d="M16.5 13.5h.1"/>',
  receipt:'<path d="M5 3l2 2 2-2 3 2 3-2 2 2 2-2v18l-2-2-2 2-3-2-3 2-2-2-2 2V3Zm4 7h6m-6 4h6"/>',
  chart:'<path d="M4 4v15h16M8 14l3-4 3 2 5-6"/>',
  calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18m-13 5h2m4 0h2"/>',
  export:'<path d="M12 3v12m-4-4 4 4 4-4M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  terminal:'<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  chevron:'<path d="m9 18 6-6-6-6"/>',
  down:'<path d="m6 9 6 6 6-6"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  minus:'<path d="M5 12h14"/>',
  search:'<circle cx="10.5" cy="10.5" r="6"/><path d="m16 16 4 4"/>',
  x:'<path d="m6 6 12 12m0-12L6 18"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  link:'<path d="m10 13 4-4m-6 6-2 2a3.5 3.5 0 0 0 5 5l4-4a3.5 3.5 0 0 0 0-5m1-4 2-2a3.5 3.5 0 0 0-5-5L9 6a3.5 3.5 0 0 0 0 5" transform="translate(0 -1)"/>',
  alert:'<path d="m12 3 10 17H2L12 3Zm0 6v4m0 3v.2"/>',
  dots:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  printer:'<path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v7H6zm11-2h2"/>',
  pencil:'<path d="m4 16-1 5 5-1L20 8l-4-4L4 16Zm10-10 4 4"/>',
  trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  user:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v2"/>',
  credit:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18m-14 5h3"/>',
  menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',
  flash:'<path d="m13 2-9 12h7l-1 8 10-12h-8l1-8Z"/>',
  camera:'<path d="M8 5h8l2 3h2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2l2-3Z"/><circle cx="12" cy="14" r="3.5"/>',
  grid:'<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  ticket:'<path d="M3 7h18v3a2 2 0 0 0 0 4v3H3v-3a2 2 0 0 0 0-4V7Zm10 2v2m0 2v2"/>',
  monitor:'<rect x="3" y="3" width="18" height="14" rx="2"/><path d="M12 17v4m-4 0h8"/>',
  moon:'<path d="M20.5 14A8.7 8.7 0 0 1 10 3.5 8.8 8.8 0 1 0 20.5 14Z"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M19 5l-1.5 1.5m-11 11L5 19"/>',
  rotate:'<path d="M4 13a8 8 0 1 0 2-6l-2 2m0-5v5h5"/>',
  tag:'<path d="M4 4h8l8 8-8 8-8-8V4Z"/><circle cx="8" cy="8" r="1"/>',
  wifi:'<path d="M3 8a14 14 0 0 1 18 0M6 12a9 9 0 0 1 12 0m-9 4a4.5 4.5 0 0 1 6 0m-3 4h.1"/>'
};
export const icon = (key,size=20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${symbols[key] || ''}</svg>`;
export const h = value => String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export const normalize = value => String(value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().trim();
const moneyFormat = new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'});
const digitFormat = new Intl.NumberFormat('pt-BR');
const decimalFormat = new Intl.NumberFormat('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
export const money = (value=0) => value<0 ? `(${moneyFormat.format(-value/100)})` : moneyFormat.format((value ?? 0)/100);
export const num = value => digitFormat.format(value ?? 0);
export const decimal = value => value == null ? '' : decimalFormat.format(value/100);
export function cents(value) {
  const text=String(value ?? '').trim().replace(/^R\$\s*/i,'');
  const raw=/^,\d{1,2}$/.test(text)?'0'+text:text;
  const parts=/^(\d{1,11}|\d{1,3}(?:\.\d{3})+)(?:,(\d{0,2}))?$/.exec(raw) ??
    /^(\d{1,11})\.(\d{0,2})$/.exec(raw);
  const real=parts?.[1].replaceAll('.','');
  if (!parts || real.length>11) throw new Error('Informe um valor válido com até duas casas decimais.');
  return Number(real)*100+Number((parts[2] ?? '').padEnd(2,'0'));
}
const uppercase=value=>String(value).toLocaleUpperCase('pt-BR');
const uppercaseAttrs='data-uppercase autocapitalize="characters"';
function replaceFieldValue(field,value,transform) {
  const previous=field.value;
  if (value===previous) return;
  const start=field.selectionStart,end=field.selectionEnd,direction=field.selectionDirection;
  field.value=value;
  if (start!=null && end!=null) {
    field.setSelectionRange(transform(previous.slice(0,start)).length,transform(previous.slice(0,end)).length,direction);
  }
}
export function uppercaseField(field) {
  if (field.hasAttribute('data-uppercase') && !field.disabled) replaceFieldValue(field,uppercase(field.value),uppercase);
}
export function editMoneyField(field) {
  // Durante a edição, os pontos de milhar não competem com o separador decimal digitado.
  if (!field.hasAttribute('data-money') || !/^\d{1,3}(?:\.\d{3})+,\d{2}$/.test(field.value)) return;
  const ungroup=value=>value.replaceAll('.','');
  replaceFieldValue(field,ungroup(field.value),ungroup);
}
export function formatMoneyField(field) {
  if (!field.hasAttribute('data-money')) return;
  if (!field.value.trim()) {
    field.value='';
    return;
  }
  try {field.value=decimal(cents(field.value));} catch {}
}
let timezone = 'America/Sao_Paulo';
export function timeZone(value) { timezone=value; }
export const dt = (value,time=true) => value ? new Intl.DateTimeFormat('pt-BR',
  {timeZone:timezone,dateStyle:'short',...(time ? {timeStyle:'short'} : {})}).format(new Date(value)) : '—';
export const dayKey = () => new Intl.DateTimeFormat('en-CA',{timeZone:timezone,dateStyle:'short'}).format(new Date());
export const humanDay = value => value ? value.split('-').reverse().join('/') : '—';
export const cardNumber = value => String(value ?? '').padStart(3,'0');
export const statusLabel = {open:'Em aberto',closed:'Concluída',cancelled:'Cancelada',refunded:'Estornada'};
export function badge(value,label) {return `<span class="badge ${h(value)}">${h(label || statusLabel[value] || value)}</span>`;}
export const btn = (text,action,{ico='',cls='',attrs=''}={}) =>
  `<button type="button" class="btn ${cls}" data-action="${action}" ${attrs}>${ico ? icon(ico,19) : ''}${text ? `<span>${h(text)}</span>` : ''}</button>`;
export const iconBtn = (label,action,ico,attrs='') =>
  btn('',action,{ico,cls:'icon-btn',attrs:`aria-label="${h(label)}" title="${h(label)}" ${attrs}`});
export const empty = (ico,title,description='',extra='') =>
  `<div class="empty"><div class="empty-icon">${icon(ico,25)}</div><strong>${h(title)}</strong>${description ? `<p>${h(description)}</p>` : ''}${extra}</div>`;
export const header = (title,subtitle,actions='',cls='') =>
  `<header class="page-heading${cls?' '+h(cls):''}"><div><h1>${h(title)}</h1>${subtitle ? `<p>${h(subtitle)}</p>` : ''}</div>${actions ? `<div class="head-actions">${actions}</div>` : ''}</header>`;
export const lab = (label,field,cls='') => `<label class="field ${cls}"><span>${h(label)}</span>${field}</label>`;
export function input(name,value='',attrs='') {
  const type=/(?:^|\s)type="([^"]+)"/.exec(attrs)?.[1] || 'text';
  const upper=['text','search'].includes(type) && !/(?:^|\s)(?:data-verbatim|data-money|inputmode="numeric")(?:\s|$)/.test(attrs);
  return `<input name="${name}" value="${h(value)}" ${upper?uppercaseAttrs+' ':''}${attrs}>`;
}
export function moneyInput(name,value=null,attrs='') {
  return `<span class="money-input"><span class="money-symbol" aria-hidden="true">R$</span>${
    input(name,decimal(value),'data-money inputmode="decimal" placeholder="0,00" '+attrs)}</span>`;
}
export const opt = (values,selected,placeholder) =>
  (placeholder ? `<option value="">${h(placeholder)}</option>` : '') +
    values.map(([key,label]) => `<option value="${h(key)}" ${String(key)===String(selected) ? 'selected' : ''}>${h(label)}</option>`).join('');
export const select = (name,values,value,placeholder,attrs='') => `<select name="${name}" ${attrs}>${opt(values,value,placeholder)}</select>`;
export const search = (id,value,label) => `<label class="search" aria-label="${h(label)}">${icon('search',19)}<input type="search" id="${id}" value="${h(value)}" placeholder="${h(label)}" ${uppercaseAttrs}></label>`;
export const textarea = (name,value,attrs='') => `<textarea name="${name}" ${uppercaseAttrs} ${attrs}>${h(value)}</textarea>`;
export const avatar = name => h(String(name || '•').trim().split(/\s+/).slice(0,2).map(word=>word[0]).join('').toUpperCase());
export const pagination = data => data.total>50 ?
  `<div class="pagination"><span>${num(data.total)} registros · página ${data.page} de ${Math.ceil(data.total/50)}</span>
  ${btn('Anterior','page',{attrs:`data-page="${data.page-1}" ${data.page<=1?'disabled':''}`})}
  ${btn('Próxima','page',{attrs:`data-page="${data.page+1}" ${data.page*50>=data.total?'disabled':''}`})}</div>` : '';
