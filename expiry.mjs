export function needsExpiry(category) {
  const normalized=String(category ?? '').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();
  return /(?:^|[^a-z])(?:alimentacao|alimentos?|bebidas?)(?:$|[^a-z])/.test(normalized);
}

const dayFormatters=new Map();
export function storeDay(instant=Date.now(),timezone='America/Sao_Paulo') {
  if (!dayFormatters.has(timezone)) dayFormatters.set(timezone,new Intl.DateTimeFormat('en-CA',{
    timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'
  }));
  const parts=Object.fromEntries(dayFormatters.get(timezone).formatToParts(new Date(instant)).map(part=>[part.type,part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function expiryInfo(product,today=storeDay()) {
  if (!product.expires_on) {
    const missing=needsExpiry(product.category);
    return {status:missing?'missing':'none',days:null,blocked:missing,
      label:missing?'Sem validade':'Não se aplica',reason:missing?'Validade não cadastrada. Regularize o produto antes de vender.':null};
  }
  const days=Math.round((Date.parse(`${product.expires_on}T00:00:00Z`)-Date.parse(`${today}T00:00:00Z`))/86400000);
  if (!Number.isFinite(days)) return {status:'missing',days:null,blocked:true,label:'Validade inválida',reason:'Validade inválida. Regularize o produto antes de vender.'};
  const status=days<0?'expired':days===0?'today':days<=7?'critical':days<=30?'warning':'valid';
  const label=days<0?`Vencido há ${-days} dia(s)`:days===0?'Vence hoje':`Vence em ${days} dia(s)`;
  return {status,days,blocked:days<0,label,reason:days<0?'Produto vencido. Retire do estoque de venda e registre a perda.':null};
}
