import {h,btn,header,empty,lab,input,dt,num} from './ui.js';
const fresh=()=>({name:'',url:'',category:'Produtos Liga',interval_minutes:'30',enabled:true,create_new:true});
const draft=state=>state.siteSync ||= {form:fresh(),editId:null,jobs:[],runs:[],running:null,defaultUrl:'',saving:false};
const labels={idle:'Aguardando',queued:'Na fila',paused:'Pausado',running:'Consultando',success:'Em dia',warning:'Com pendências',error:'Falha na consulta',interrupted:'Interrompido',cancelled:'Cancelado',deferred:'Aguardando o leitor'};
const status=value=>`<span class="badge site-sync-status ${h(value)}">${h(labels[value] || value)}</span>`;
export function reset(state){state.siteSync=null;}
export async function load(ctx) {
  const d=draft(ctx.state);
  const result=await ctx.api('site-sync/list');Object.assign(d,result);
  if(!d.defaultUrl){const config=await ctx.api('site-import/config');d.defaultUrl=config.defaultUrl;if(!d.form.url)d.form.url=d.defaultUrl;}
  return {};
}
export function page(state) {
  const d=draft(state),form=d.form;
  return `${header('Sincronização do site','O servidor consulta os links nos intervalos definidos e aplica as diferenças de estoque automaticamente.')}
    <section class="panel site-import-panel"><h2>Vendas do PDV são preservadas</h2>
      <p class="site-import-note">Se o site continuar com 10 unidades e o PDV vender 2, o saldo do PDV continua em 8. Se depois o site cair de 10 para 9, o PDV desconta mais 1. Preços, custos, validade e demais dados dos produtos existentes são mantidos.</p>
      <p class="site-import-note">Na primeira consulta de um produto existente sem referência anterior, o sistema registra a quantidade do site sem alterar o saldo do PDV. Itens que desaparecem da listagem continuam sendo consultados pelo link individual; ausência ou erro nunca significam estoque zero.</p>
      <p class="site-import-note">Mantenha o computador e o servidor do PDV ligados, com acesso à internet. As consultas continuam com o navegador fechado. Reservas em comandas e saldos negativos geram pendências para conferência.</p></section>
    <section class="panel site-import-panel"><h2>${d.editId?'Editar link':'Adicionar link'}</h2>
      <form data-form="site-sync-save" class="site-import-form">
        ${lab('Nome do acompanhamento',input('name',form.name,'required data-verbatim maxlength="100" placeholder="Ex.: Selados de Pokémon"'))}
        ${lab('Intervalo em minutos',input('interval_minutes',form.interval_minutes,'type="number" min="5" max="1440" step="1" required'))}
        ${lab('Link para acompanhar',input('url',form.url,'type="url" data-verbatim required maxlength="3000"'),'span-two')}
        ${lab('Categoria dos produtos novos',input('category',form.category,'required data-verbatim maxlength="80"'))}
        <label class="toggle-row"><input type="checkbox" name="enabled" ${form.enabled?'checked':''}> Ativar consultas automáticas</label>
        <label class="toggle-row span-two"><input type="checkbox" name="create_new" ${form.create_new?'checked':''}> Cadastrar novos produtos encontrados com preço e estoque identificados</label>
        <div class="site-import-actions span-two"><button class="btn primary" type="submit" ${d.saving?'disabled':''}>${d.editId?'Salvar alterações':'Salvar acompanhamento'}</button>
          ${d.editId?btn('Cancelar edição','site-sync-reset',{cls:'outline'}):''}</div>
      </form></section>
    <section class="panel site-import-panel"><h2>Links acompanhados</h2>
      ${d.jobs.length?`<div class="site-sync-list">${d.jobs.map(job=>`<article class="site-sync-job">
        <div class="site-sync-heading"><h3>${h(job.name)}</h3>${status(job.status)}</div>
        <a href="${h(job.url)}" target="_blank" rel="noopener noreferrer" class="site-sync-url">${h(job.url)}</a>
        <p>${h(job.message)}</p><p class="site-import-note">A cada ${num(job.interval_minutes)} minutos · ${job.create_new?'Cadastra novos produtos':'Somente produtos existentes'}<br>
          Última conclusão: ${dt(job.last_finished)} · Próxima consulta: ${job.enabled?dt(job.next_run):'Pausada'}</p>
        <div class="site-import-actions">${btn('Editar','site-sync-edit',{attrs:`data-id="${job.id}"`})}
          ${btn(job.enabled?'Pausar':'Ativar','site-sync-toggle',{cls:'outline',attrs:`data-id="${job.id}"`})}
          ${btn('Verificar agora','site-sync-run',{attrs:`data-id="${job.id}" ${!job.enabled || job.id===d.running?'disabled':''}`})}
          ${btn('Verificar com navegador','site-sync-browser',{cls:'outline',attrs:`data-id="${job.id}" ${!job.enabled || job.id===d.running?'disabled':''}`})}
          ${btn('Remover link','site-sync-remove',{cls:'outline',attrs:`data-id="${job.id}"`})}</div>
      </article>`).join('')}</div>`:empty('link','Nenhum link acompanhado','Salve o primeiro link para iniciar as consultas automáticas.')}
      <p class="site-import-note">Verificar com navegador permite concluir uma verificação de acesso pedida pela loja no computador. Consultas agendadas não abrem janelas. Remover um link encerra apenas seu acompanhamento.</p></section>
    <section class="panel site-import-panel"><h2>Histórico das últimas consultas</h2>
      ${d.runs.length?d.runs.map(run=>`<details class="site-sync-history"><summary><span>${h(run.job_name)} · ${dt(run.started_at)}</span>${status(run.status)}</summary>
        <p>${h(run.message)}</p><p class="site-import-note">${num(run.total)} produto(s) · ${num(run.created)} novo(s) · ${num(run.updated)} atualizado(s) · ${num(run.baselines)} referência(s) inicial(is) · ${num(run.conflicts)} pendência(s).</p>
        ${run.report.changes?.length?`<div class="table-scroll"><table><thead><tr><th>Produto</th><th>PDV antes</th><th>PDV depois</th><th>Site antes</th><th>Site depois</th></tr></thead><tbody>
          ${run.report.changes.map(change=>`<tr><td>${h(change.name)}</td><td>${num(change.before)}</td><td>${num(change.after)}</td><td>${change.site_before==null?'Novo':num(change.site_before)}</td><td>${num(change.site_after)}</td></tr>`).join('')}</tbody></table></div>`:''}
        ${run.report.issues?.length?`<ul class="site-sync-issues">${run.report.issues.map(issue=>`<li><strong>${h(issue.name)}:</strong> ${h(issue.message)}</li>`).join('')}</ul>`:''}
        ${run.report.warnings?.map(message=>`<p class="site-import-note">${h(message)}</p>`).join('') || ''}
      </details>`).join(''):empty('clock','Nenhuma consulta realizada','Os resultados serão registrados aqui e na auditoria do PDV.')}
    </section>`;
}
export function inputChanged(ctx,field) {
  if(field.form?.dataset.form!=='site-sync-save')return;
  const d=draft(ctx.state);
  if(['name','url','category','interval_minutes'].includes(field.name))d.form[field.name]=field.value;
  else if(['enabled','create_new'].includes(field.name))d.form[field.name]=field.checked;
}
export async function submit(ctx,form) {
  const d=draft(ctx.state);if(d.saving)return;d.saving=true;
  try {
    const body={id:d.editId,name:form.elements.name.value,url:form.elements.url.value,category:form.elements.category.value,
      interval_minutes:Number(form.elements.interval_minutes.value),enabled:form.elements.enabled.checked,create_new:form.elements.create_new.checked};
    await ctx.send('site-sync/save',body);d.editId=null;d.form={...fresh(),url:d.defaultUrl};ctx.toast('Acompanhamento salvo.');await ctx.reload();
  } finally {d.saving=false;if(ctx.state.view==='site-sync')ctx.render();}
}
export async function act(ctx,action,element) {
  const d=draft(ctx.state),id=Number(element.dataset.id),job=d.jobs.find(row=>row.id===id);
  if(action==='site-sync-reset'){d.editId=null;d.form={...fresh(),url:d.defaultUrl};return ctx.render();}
  if(!job)throw Error('Atualize a tela para consultar este link.');
  if(action==='site-sync-edit') {d.editId=id;d.form={name:job.name,url:job.url,category:job.category,interval_minutes:String(job.interval_minutes),enabled:job.enabled,create_new:job.create_new};return ctx.render();}
  if(action==='site-sync-toggle')await ctx.send('site-sync/save',{id,enabled:!job.enabled});
  else if(action==='site-sync-remove')await ctx.send('site-sync/remove',{id});
  else if(action==='site-sync-run' || action==='site-sync-browser') {
    await ctx.send('site-sync/run',{id,interactive:action==='site-sync-browser'});ctx.toast('Consulta colocada na fila.');
  }
  return ctx.reload();
}
