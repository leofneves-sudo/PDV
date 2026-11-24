const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {once}=require('node:events');
const {existsSync,mkdirSync,writeFileSync}=require('node:fs');
const {join,resolve}=require('node:path');
const {chromium}=require('playwright-core');
const {storeDay}=require('../expiry.mjs');

// Instância isolada: banco em memória, contas fictícias e perfil novo do navegador.
const root=resolve(__dirname,'..');
const output=resolve(process.env.PDV_TEST_OUTPUT || join(root,'test-output','mobile'));
const code1='11111111-1111-4111-8111-111111111111';
const code2='22222222-2222-4222-8222-222222222222';
const code3='33333333-3333-4333-8333-333333333333';
const code4='44444444-4444-4444-8444-444444444444';
const code5='55555555-5555-4555-8555-555555555555';
const candidates=[process.env.PDV_TEST_BROWSER,
  process.env.ProgramFiles && join(process.env.ProgramFiles,'Google','Chrome','Application','chrome.exe'),
  process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'],'Microsoft','Edge','Application','msedge.exe'),
  '/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);
const executablePath=candidates.find(existsSync);
if (!executablePath) throw Error('Navegador Chromium não encontrado. Defina PDV_TEST_BROWSER com o caminho do Chrome ou Edge instalado.');

async function startServer() {
  const seed=`const {run}=require('./db');
    run('INSERT INTO cards(number,token) VALUES(41,?)','${code1}');
    run('INSERT INTO cards(number,token) VALUES(42,?)','${code2}');
    run('INSERT INTO cards(number,token) VALUES(43,?)','${code3}');
    run('INSERT INTO cards(number,token) VALUES(44,?)','${code4}');
    run('INSERT INTO cards(number,token) VALUES(45,?)','${code5}');
    require('./server');`;
  const child=spawn(process.execPath,['-e',seed],{cwd:root,windowsHide:true,
    env:{...process.env,PDV_DB:':memory:',PDV_HOST:'127.0.0.1',PDV_PORT:'0',PDV_ORIGIN:'',PDV_TLS_CERT:'',PDV_TLS_KEY:'',PDV_BACKUP_MINUTES:'0'},
    stdio:['ignore','pipe','pipe']});
  const exited=once(child,'exit');
  let log='',errors='';
  child.stderr.on('data',chunk=>errors+=chunk);
  const url=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(Error('Servidor de teste não iniciou: '+errors));},10000);
    child.stdout.on('data',chunk=>{
      log+=chunk;
      const match=log.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {clearTimeout(timer);resolve(match[0]);}
    });
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',()=>{clearTimeout(timer);reject(Error(errors));});
  });
  return {url,async stop(){
    if (child.exitCode===null && child.signalCode===null) child.kill();
    await exited;
  }};
}

async function api(context,url,path,data) {
  const response=await context.request[data===undefined?'get':'post'](url+'/api/'+path,data===undefined?{}:{data});
  assert.equal(response.status(),200,await response.text());
  return response.json();
}
async function waitFor(condition,label,timeout=12000) {
  const until=Date.now()+timeout;
  while (!await condition()) {
    if (Date.now()>until) throw Error('Tempo esgotado: '+label);
    await new Promise(resolve=>setTimeout(resolve,50));
  }
}
async function checkLayout(page,label) {
  const result=await page.evaluate(()=>({
    width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
    overflow:[...document.querySelectorAll('#main *, .topbar *')].filter(node=>{
      const rect=node.getBoundingClientRect();
      return rect.width && (rect.right>innerWidth+1 || rect.left<-1) && !node.closest('.categories,.table-scroll,.sidebar');
    }).slice(0,5).map(node=>node.className || node.tagName)
  }));
  assert.ok(result.scrollWidth<=result.width+1,`${label}: rolagem horizontal ${JSON.stringify(result)}`);
  const buttons=await page.locator('.mobile-pos-switch button:visible,.mobile-checkout-bar button:visible,.product-tile:visible').evaluateAll(nodes=>nodes.map(node=>{
    const box=node.getBoundingClientRect();return {width:box.width,height:box.height};
  }));
  assert.ok(buttons.every(box=>box.width>=44 && box.height>=44),label+': controles pequenos para toque');
}

async function checkSidebar(page) {
  const labels=await page.locator('.sidebar .navigation>span').evaluateAll(nodes=>nodes
    .filter(node=>node.scrollWidth>node.clientWidth+1 || getComputedStyle(node).whiteSpace!=='nowrap')
    .map(node=>node.textContent));
  assert.deepEqual(labels,[],'Opções da barra lateral quebradas ou cortadas');
  const colors=await page.locator('.sidebar .nav-label').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).color));
  assert.deepEqual(colors,Array(3).fill('rgb(255, 205, 146)'),'Os três títulos do menu devem usar o âmbar de Administração.');
}

async function scan(page,code,mode=null) {
  await page.getByRole('button',{name:'Ler QR Code',exact:true}).click();
  mode=mode || (await page.locator('input[name="scan-mode"][value="direct"]').count()?'direct':'paired');
  await page.locator(`input[name="scan-mode"][value="${mode}"]`).check();
  await page.getByLabel('Código do cartão',{exact:true}).fill('pdv:'+code);
  await page.getByRole('button',{name:'Ler código',exact:true}).click();
  await page.locator('#pos-workspace').waitFor();
}

(async()=>{
  mkdirSync(output,{recursive:true});
  const server=await startServer();
  let browser;
  const checks=[],pageErrors=[];
  try {
    browser=await chromium.launch({executablePath,headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
    const desktop=await browser.newContext({viewport:{width:1366,height:900},locale:'pt-BR'});
    await api(desktop,server.url,'setup',{username:'admin',name:'Administrador de teste',password:'teste-mobile-admin'});
    await api(desktop,server.url,'users',{username:'atendente',name:'Atendente de teste',password:'teste-mobile-operador',role:'operator',permissions:{checkout:false}});
    const expiry=new Date(storeDay()+'T00:00:00Z');expiry.setUTCDate(expiry.getUTCDate()+90);
    const product=await api(desktop,server.url,'products',{code:'SUCO',name:'Suco de uva 300 ml',category:'Bebidas',expires_on:expiry.toISOString().slice(0,10),stock:100,price:750,cost:300,minimum:3});
    await api(desktop,server.url,'products',{code:'LANCH',name:'Sanduíche natural com frango e salada',category:'Alimentação',expires_on:expiry.toISOString().slice(0,10),stock:30,price:1400,cost:600,minimum:3});
    const expired=new Date(storeDay()+'T00:00:00Z');expired.setUTCDate(expired.getUTCDate()-1);
    const blocked=await api(desktop,server.url,'products',{code:'VENC',name:'Produto vencido de teste',category:'Alimentação',expires_on:expired.toISOString().slice(0,10),stock:5,price:500,cost:200,minimum:0});

    const till=await desktop.newPage();
    till.on('pageerror',error=>pageErrors.push(error.message));
    await till.goto(server.url);
    await till.getByRole('button',{name:'Atendimento',exact:true}).click();
    const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1,locale:'pt-BR',extraHTTPHeaders:{'X-Forwarded-For':'192.168.50.200'}});
    const phone=await mobile.newPage();
    phone.on('pageerror',error=>pageErrors.push(error.message));
    phone.setDefaultTimeout(12000);
    await phone.goto(server.url);
    await phone.getByLabel('Usuário',{exact:true}).fill('atendente');
    await phone.getByLabel('Senha',{exact:true}).fill('teste-mobile-operador');
    await phone.getByRole('button',{name:'Entrar',exact:true}).click();
    await phone.locator('#pairing-required').waitFor();
    await till.getByRole('button',{name:'Parear caixa',exact:true}).click();
    await till.getByLabel('Nome do caixa',{exact:true}).fill('Caixa inicial');
    await till.getByRole('button',{name:'Gerar código',exact:true}).click();
    await till.locator('.pair-code strong').waitFor();
    const initialPair={code:await till.locator('.pair-code strong').textContent()};
    assert.equal(await phone.locator('#pos-workspace,.navigation').count(),0);
    assert.equal((await mobile.request.get(server.url+'/api/products')).status(),428);
    await phone.getByLabel('Código do caixa',{exact:true}).fill('000000');
    await phone.getByRole('button',{name:'Vincular celular',exact:true}).click();
    await phone.locator('.form-error:visible').waitFor();
    assert.equal(await till.locator('#modal[open] .pair-code').count(),1);
    assert.equal(await till.getByText('Celular vinculado com sucesso.',{exact:true}).count(),0);
    await phone.reload();
    await phone.locator('#pairing-required').waitFor();
    for (const width of [320,390]) {
      await phone.setViewportSize({width,height:844});
      await checkLayout(phone,'vínculo obrigatório em '+width+' px');
      assert.ok(await phone.getByRole('button',{name:'Vincular celular',exact:true}).evaluate(node=>node.getBoundingClientRect().height>=44));
    }
    await phone.screenshot({path:join(output,'celular-vinculo-obrigatorio.png')});
    checks.push('Celular sem vínculo fica bloqueado, inclusive pela API e após recarregar; código inválido não libera o acesso e a tela cabe em 320 px.');
    await phone.getByLabel('Código do caixa',{exact:true}).fill(initialPair.code);
    await phone.getByRole('button',{name:'Vincular celular',exact:true}).click();
    await phone.locator('#pos-workspace').waitFor();
    await till.locator('#modal').waitFor({state:'hidden'});
    await till.getByText('Celular vinculado com sucesso.',{exact:true}).waitFor();
    await till.screenshot({path:join(output,'caixa-celular-vinculado.png')});
    checks.push('Código inválido mantém a janela do PC aberta; vínculo confirmado fecha Parear caixa e mostra a confirmação antes de ler qualquer cartão.');
    await phone.reload();
    await phone.locator('#pos-workspace').waitFor();
    checks.push('Código gerado no computador libera o atendimento e o vínculo válido permanece ao recarregar o celular.');
    await scan(phone,code1);
    assert.equal(await phone.getByRole('button',{name:'Iniciar atendimento',exact:true}).isVisible(),true);
    await phone.getByRole('button',{name:'Iniciar atendimento',exact:true}).click();
    const add=()=>phone.locator(`button[data-action="add-item"][data-id="${product.id}"]`);
    await add().waitFor({state:'visible'});
    assert.equal(await phone.locator(`button[data-action="add-item"][data-id="${blocked.id}"]`).isDisabled(),true);
    let quantity=0;
    const addOne=async()=>{
      await add().tap();quantity++;
      await waitFor(async()=>{
        const card=await api(desktop,server.url,'cards/1');
        return card.order?.items.find(row=>row.product_id===product.id)?.quantity===quantity;
      },'inclusão pelo celular');
      await waitFor(async()=>/adicionado à comanda #041/.test(await phone.locator('#pos-add-feedback').textContent()),'confirmação na tela');
      await waitFor(async()=>(await phone.locator('.mobile-pos-context small').textContent())===`${quantity} itens`,'quantidade atualizada no celular');
    };
    await api(desktop,server.url,'scan',{code:'pdv:'+code1,mode:'direct'});
    await addOne();
    checks.push('Operador sem permissão de pagamento inclui produtos e vê o total da comanda.');

    await scan(till,code1);
    await till.getByRole('button',{name:'Alterar quantidade de Suco de uva 300 ml',exact:true}).waitFor();
    const sizes=[[320,568],[360,640],[375,667],[390,844],[414,896],[430,932],[568,320],[844,390],[932,430],[768,1024],[1024,768],[1366,900]];
    for (const [width,height] of sizes) {
      await phone.setViewportSize({width,height});
      if (width<=1000) {
        await phone.locator('#mobile-pos-navigation [data-panel="catalog"]').tap();
        assert.equal(await phone.locator('#order-panel').isVisible(),false);
        assert.equal(await phone.locator('#catalog-panel').isVisible(),true);
        await addOne();
        await checkLayout(phone,`${width}x${height} produtos`);
        if (width===390) {
          await phone.evaluate(()=>window.scrollTo(0,0));
          await phone.screenshot({path:join(output,'celular-produtos.png')});
        }
        await phone.locator('.mobile-checkout-bar [data-panel="order"]').tap();
        assert.equal(await phone.locator('#catalog-panel').isVisible(),false);
        assert.equal(await phone.locator('#order-panel').isVisible(),true);
        await checkLayout(phone,`${width}x${height} comanda`);
        assert.equal(await phone.getByRole('button',{name:'Receber pagamento',exact:true}).count(),0);
        if (width===390) {
          await phone.evaluate(()=>window.scrollTo(0,0));
          await phone.screenshot({path:join(output,'celular-comanda.png')});
        }
      } else {
        assert.equal(await phone.locator('#catalog-panel').isVisible(),true);
        assert.equal(await phone.locator('#order-panel').isVisible(),true);
        assert.equal(await phone.locator('#mobile-pos-navigation').isVisible(),false);
        await checkLayout(phone,`${width}x${height} atendimento completo`);
      }
      checks.push(`${width}x${height}: disposição, toque e rolagem verificados.`);
    }
    await waitFor(async()=>Number(await till.getByRole('button',{name:'Alterar quantidade de Suco de uva 300 ml',exact:true}).textContent())===quantity,'sincronização com o caixa');
    checks.push('Inclusões do celular sincronizadas com a comanda aberta no caixa.');
    await phone.setViewportSize({width:390,height:844});
    await phone.locator('#mobile-pos-navigation [data-panel="order"]').tap();
    await phone.getByRole('button',{name:'Alterar quantidade de Suco de uva 300 ml',exact:true}).tap();
    await phone.getByLabel('Nova quantidade',{exact:true}).fill(String(quantity+2));
    await checkLayout(phone,'edição de quantidade no celular');
    await phone.getByRole('button',{name:'Salvar quantidade',exact:true}).tap();
    quantity+=2;
    await waitFor(async()=>(await api(desktop,server.url,'cards/1')).order.items[0].quantity===quantity,'edição de quantidade');
    checks.push('Edição de quantidade pelo diálogo no celular.');
    await phone.locator('#mobile-pos-navigation [data-panel="catalog"]').tap();
    await phone.locator('#pos-search').fill('SUCO');
    assert.equal(await phone.locator('.product-tile:visible').count(),1);
    await addOne();
    assert.equal(await phone.locator('#pos-search').inputValue(),'SUCO');
    await phone.reload();
    await add().waitFor({state:'visible'});
    assert.match(await phone.locator('.mobile-checkout-bar').textContent(),/#041/);
    checks.push('Busca preservada após adicionar e comanda recuperada ao recarregar.');
    await mobile.setOffline(true);
    await phone.locator('#connectivity.down').waitFor();
    await waitFor(()=>add().isDisabled(),'bloqueio sem conexão');
    await mobile.setOffline(false);
    await phone.locator('#connectivity.up').waitFor();
    await waitFor(async()=>!await add().isDisabled(),'retomada após reconexão');
    checks.push('Inclusão bloqueada sem conexão e retomada após reconectar.');
    await scan(phone,code2);
    await phone.getByRole('button',{name:'Iniciar atendimento',exact:true}).click();
    await add().waitFor({state:'visible'});
    await add().tap();
    await waitFor(async()=>{
      await api(desktop,server.url,'scan',{code:'pdv:'+code2,mode:'direct'});
      return (await api(desktop,server.url,'cards/2')).order?.items[0]?.quantity===1;
    },'produto na segunda comanda');
    assert.equal((await api(desktop,server.url,'cards/1')).order.items[0].quantity,quantity);
    checks.push('Troca de cartão mantém os produtos separados em cada comanda.');
    await till.setViewportSize({width:320,height:568});
    await checkLayout(till,'administrador no celular');
    await till.getByRole('button',{name:'Abrir menu',exact:true}).click();
    await checkSidebar(till);
    await till.locator('#nav-backdrop').click({position:{x:308,y:80}});
    await till.locator('#mobile-pos-navigation [data-panel="order"]').click();
    const mobilePayment=till.locator('.mobile-checkout-bar').getByRole('button',{name:'Receber pagamento',exact:true});
    assert.equal(await till.getByRole('button',{name:'Receber pagamento',exact:true}).count(),1);
    await mobilePayment.click();
    await till.locator('dialog[open]').waitFor();
    const dialog=await till.locator('dialog[open]').boundingBox();
    assert.ok(dialog.x>=0 && dialog.width<=320,'Diálogo deve caber no celular');
    assert.ok(await till.locator('dialog input:not([type="hidden"])').evaluateAll(fields=>fields.every(field=>parseFloat(getComputedStyle(field).fontSize)>=16)),'Campos pequenos podem causar zoom automático no celular');
    checks.push('Administrador, atalhos adicionais e diálogo de pagamento em 320 px.');
    await till.getByRole('button',{name:'Voltar',exact:true}).click();
    await till.getByRole('button',{name:'Ler QR Code',exact:true}).click();
    await till.locator('#camera-stage').waitFor();
    await checkLayout(till,'leitor em 320 px');
    await till.setViewportSize({width:1024,height:768});
    await checkLayout(till,'leitor em 1024 px');
    await checkSidebar(till);
    checks.push('Menu completo cabe em uma linha por opção no celular e no caixa, com os três títulos em âmbar.');
    await till.getByRole('button',{name:'Ativar câmera',exact:true}).click();
    await till.locator('#camera-stage.active').waitFor();
    assert.ok(await till.locator('#camera-video').evaluate(video=>video.videoWidth>0));
    await till.getByRole('button',{name:'Desligar câmera',exact:true}).click();
    await till.getByRole('button',{name:'Ativar câmera',exact:true}).waitFor();
    await till.screenshot({path:join(output,'caixa-leitor.png')});
    await till.getByRole('button',{name:'Gerar código no caixa',exact:true}).click();
    await till.getByLabel('Nome do caixa',{exact:true}).fill('Caixa de teste');
    await till.getByRole('button',{name:'Gerar código',exact:true}).click();
    await till.locator('.pair-code strong').waitFor();
    const code=await till.locator('.pair-code strong').textContent();
    assert.match(code,/^\d{6}$/);
    await phone.getByRole('button',{name:'Ler QR Code',exact:true}).click();
    assert.equal(await phone.locator('input[name="scan-mode"][value="direct"]').count(),0);
    assert.equal(await phone.getByRole('button',{name:'Gerar código no caixa',exact:true}).count(),0);
    await phone.getByRole('button',{name:'Trocar caixa',exact:true}).click();
    await phone.getByLabel('Código do caixa',{exact:true}).fill(code);
    await phone.getByRole('button',{name:'Vincular celular',exact:true}).click();
    await waitFor(()=>phone.locator('input[name="scan-mode"][value="paired"]').isChecked(),'pareamento pelo leitor de QR');
    await till.locator('#modal').waitFor({state:'hidden'});
    await till.getByText('Celular vinculado com sucesso.',{exact:true}).last().waitFor();
    await till.getByRole('button',{name:'Voltar ao atendimento',exact:true}).click();
    checks.push('Um novo vínculo do mesmo celular também confirma no PC e fecha a janela, mesmo sem aumentar a quantidade de leitores.');
    checks.push('O leitor inicia e desliga a câmera simulada e permite gerar e inserir o código de pareamento pela interface.');
    await phone.getByLabel('Código do cartão',{exact:true}).fill('pdv:'+code3);
    await phone.getByRole('button',{name:'Ler código',exact:true}).click();
    await waitFor(async()=>/Cartão #043/.test(await till.locator('#order-panel').textContent()),'cartão enviado ao caixa');
    await till.getByRole('button',{name:'Iniciar atendimento',exact:true}).click();
    await waitFor(async()=>/Comanda #043/.test(await phone.locator('.mobile-pos-context').textContent()),'comanda do caixa também no celular pareado');
    await phone.locator('#mobile-pos-navigation [data-panel="catalog"]').tap();
    await add().tap();
    await waitFor(async()=>/Suco de uva/.test(await till.locator('#order-panel').textContent()),'inclusão sincronizada no modo pareado');
    await phone.reload();
    await phone.locator('#pos-workspace').waitFor();
    assert.match(await phone.locator('.mobile-pos-context').textContent(),/#043/);
    checks.push('Leitura pareada e abertura no caixa aparecem também no celular, permitem adicionar itens e sobrevivem ao recarregamento.');
    const recoveredContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,locale:'pt-BR',extraHTTPHeaders:{'X-Forwarded-For':'192.168.50.201'}});
    await api(recoveredContext,server.url,'login',{username:'atendente',password:'teste-mobile-operador'});
    const recoveryPair=await api(desktop,server.url,'pairing/code',{name:'Caixa para recuperação'});
    await api(recoveredContext,server.url,'pairing/link',{code:recoveryPair.code});
    const recovered=await recoveredContext.newPage();
    recovered.on('pageerror',error=>pageErrors.push(error.message));
    await recovered.goto(server.url);
    await recovered.locator('#pos-workspace').waitFor();
    assert.equal(await recovered.locator('[data-open-order-count]').textContent(),'3');
    assert.equal(await till.locator('[data-open-order-count]').textContent(),'3');
    assert.equal(await recovered.locator('#order-tabs .is-open').count(),3);
    await recovered.locator('#mobile-pos-navigation [data-panel="order"]').tap();
    assert.match(await recovered.locator('#order-panel').textContent(),/Suco de uva/);
    assert.match(await recovered.locator('#mobile-pos-navigation [data-panel="order"]').textContent(),/itens/);
    await checkLayout(recovered,'comandas recuperadas em nova sessão');
    checks.push('Nova sessão do celular pareado recupera as três comandas do caixa e mostra o mesmo total, separado do número de itens.');
    await recovered.evaluate(()=>{
      const key=Object.keys(sessionStorage).find(key=>key.startsWith('pdv.cart.'));
      const saved=JSON.parse(sessionStorage.getItem(key));
      saved.hidden=[3];
      sessionStorage.setItem(key,JSON.stringify(saved));
    });
    await recovered.reload();
    await recovered.locator('#pos-workspace').waitFor();
    assert.equal(await recovered.locator('[data-action="switch-card"][data-id="3"]').count(),1);
    assert.equal(await recovered.locator('[data-open-order-count]').textContent(),'3');
    checks.push('Comandas abertas voltam a aparecer mesmo quando o navegador guardou a preferência antiga de ocultá-las.');

    await api(desktop,server.url,'scan',{code:'pdv:'+code4,mode:'direct'});
    const emptyOrder=(await api(desktop,server.url,'cards/4/open',{})).order;
    await phone.locator('[data-action="close-card"][data-id="4"]').waitFor();
    await phone.locator('[data-action="close-card"][data-id="4"]').tap();
    await phone.locator('#modal').getByRole('button',{name:'Confirmar encerramento',exact:true}).click();
    await phone.locator('#modal .form-error:visible').waitFor();
    assert.match(await phone.locator('#modal .form-error').textContent(),/aprovação/);
    assert.equal((await api(desktop,server.url,'open-cards')).total,4);
    await phone.locator('#modal').getByRole('button',{name:'Voltar',exact:true}).click();
    checks.push('O X mantém a exigência de aprovação para um operador sem permissão de cancelar.');
    assert.match(await till.locator('#order-panel .order-identity').textContent(),/#043/);
    await till.locator('[data-action="close-card"][data-id="4"]').click();
    await till.locator('#modal').getByRole('button',{name:'Voltar',exact:true}).click();
    assert.equal((await api(desktop,server.url,'open-cards')).total,4);
    await till.locator('[data-action="close-card"][data-id="4"]').click();
    await till.locator('#modal').getByRole('button',{name:'Confirmar encerramento',exact:true}).click();
    await waitFor(async()=>(await till.locator('[data-open-order-count]').textContent())==='3','encerramento da comanda vazia');
    await waitFor(async()=>(await phone.locator('[data-open-order-count]').textContent())==='3','encerramento sincronizado no celular');
    assert.equal((await api(desktop,server.url,'orders/'+emptyOrder.id)).status,'cancelled');
    assert.equal(await till.locator('[data-action="switch-card"][data-id="4"]').count(),0);
    await till.reload();
    await till.getByRole('button',{name:'Atendimento',exact:true}).click();
    await till.locator('#pos-workspace').waitFor();
    assert.equal(await till.locator('[data-open-order-count]').textContent(),'3');
    assert.equal(await till.locator('[data-action="switch-card"][data-id="4"]').count(),0);
    checks.push('O X encerra a comanda escolhida, inclusive fora da seleção atual, atualiza o contador nos dois dispositivos e permanece encerrada após recarregar.');

    await api(desktop,server.url,'scan',{code:'pdv:'+code5,mode:'direct'});
    const disposable=(await api(desktop,server.url,'cards/5/open',{})).order;
    const stockBefore=(await api(desktop,server.url,'products')).find(row=>row.id===product.id).stock;
    await api(desktop,server.url,`orders/${disposable.id}/items`,{product:product.id,action:'delta',delta:1});
    await till.locator('[data-action="close-card"][data-id="5"]').click();
    await till.locator('#modal [data-action="close-card-cancel"]').click();
    await till.locator('#modal').getByLabel('Motivo',{exact:true}).fill('Encerramento pelo X no teste');
    await till.locator('#modal').getByRole('button',{name:'Confirmar cancelamento',exact:true}).click();
    await waitFor(async()=>(await till.locator('[data-open-order-count]').textContent())==='3','cancelamento pelo X');
    assert.equal((await api(desktop,server.url,'orders/'+disposable.id)).status,'cancelled');
    assert.equal((await api(desktop,server.url,'products')).find(row=>row.id===product.id).stock,stockBefore);
    checks.push('Cancelar pelo X encerra no servidor e libera as reservas sem registrar venda ou baixar estoque.');
    await scan(till,code5);
    await till.locator('[data-action="hide-card"][data-id="5"]').click();
    await waitFor(async()=>(await till.locator('[data-action="switch-card"][data-id="5"]').count())===0,'retirada de cartão disponível');
    assert.equal((await api(desktop,server.url,'open-cards')).total,3);
    await till.locator('[data-action="switch-card"][data-id="3"]').click();
    checks.push('O X de um cartão disponível apenas retira esse cartão da tela, sem alterar os atendimentos.');

    await till.setViewportSize({width:1366,height:768});
    await api(desktop,server.url,'cash/open',{register:1,opening:0,request_id:randomUUID()});
    const order=(await api(desktop,server.url,'cards/3')).order;
    for (let number=1;number<=12;number++) {
      const item=await api(desktop,server.url,'products',{code:'AC'+number,name:'Acessório '+number,category:'Acessórios',stock:5,price:250,cost:100,minimum:0});
      await api(desktop,server.url,`orders/${order.id}/items`,{product:item.id,action:'delta',delta:1});
    }
    const updated=(await api(desktop,server.url,'cards/3')).order;
    await api(desktop,server.url,`orders/${order.id}/payments`,{version:updated.version,request_id:randomUUID(),payments:[{method:'debit',amount:500},{method:'pix',amount:200}]});
    const content=till.locator('#order-panel .order-content');
    const summary=till.locator('#order-panel .order-summary');
    await summary.getByText('Falta receber',{exact:true}).waitFor();
    assert.match(await summary.textContent(),/R\$\s*32,50/);
    assert.match(await summary.textContent(),/Total · R\$\s*37,50/);
    assert.match(await summary.textContent(),/PIX pendente · R\$\s*2,00/);
    const selection=till.locator('#order-tabs [aria-current="true"]');
    assert.match(await selection.textContent(),/#043\s*Em atendimento/);
    assert.equal(await selection.locator('.order-tab-check').isVisible(),true);
    await till.evaluate(()=>window.scrollTo(0,0));
    const desktopPayment=summary.getByRole('button',{name:'Receber pagamento',exact:true});
    assert.ok(await desktopPayment.evaluate(button=>button.getBoundingClientRect().bottom<=innerHeight));
    assert.ok(await content.evaluate(node=>node.scrollHeight>node.clientHeight));
    await content.evaluate(node=>{node.scrollTop=node.scrollHeight;});
    assert.ok(await desktopPayment.evaluate(button=>button.getBoundingClientRect().bottom<=innerHeight));
    await content.evaluate(node=>{node.scrollTop=0;});
    await till.screenshot({path:join(output,'caixa-atendimento-claro.png')});
    const lightPaymentColor=await desktopPayment.evaluate(node=>getComputedStyle(node).backgroundColor);
    await till.locator('[data-action="toggle-theme"]').click();
    assert.equal(await till.locator('html').getAttribute('data-theme'),'dark');
    await desktopPayment.evaluate(node=>Promise.all(node.getAnimations().map(animation=>animation.finished)));
    assert.notEqual(await desktopPayment.evaluate(node=>getComputedStyle(node).backgroundColor),lightPaymentColor);
    assert.ok(await desktopPayment.evaluate(button=>button.getBoundingClientRect().bottom<=innerHeight));
    await till.screenshot({path:join(output,'caixa-atendimento-escuro.png')});
    checks.push('Comanda ativa identificada nos dois temas e saldo, total, PIX e pagamento acessíveis com uma lista longa.');
    await till.locator('[data-action="close-card"][data-id="3"]').click();
    assert.equal(await till.locator('#modal [data-action="close-card-cancel"]').count(),0);
    await till.locator('#modal [data-action="close-card-payment"]').click();
    assert.equal(await till.locator('#confirm-checkout').isDisabled(),true);
    assert.match(await till.locator('#modal').textContent(),/Aguardando confirmação/);
    await till.locator('#modal').getByRole('button',{name:'Voltar',exact:true}).click();
    assert.equal((await api(desktop,server.url,'open-cards')).total,3);
    checks.push('O X de uma comanda com parcelas preserva os valores e impede fechar enquanto existir PIX pendente.');
    const currentOrder=(await api(desktop,server.url,'cards/3')).order;
    const pending=currentOrder.payments.find(payment=>payment.state==='pending');
    await api(desktop,server.url,`orders/${currentOrder.id}/pix`,{request_id:randomUUID(),payment:pending.id,reason:'PIX confirmado no teste isolado'});
    await till.locator('[data-action="close-card"][data-id="3"]').click();
    await till.locator('#modal [data-action="close-card-payment"]').click();
    await till.locator('#modal [data-action="fill-payment"][data-method="debit"]').click();
    await till.locator('#modal').getByRole('button',{name:'Fechar comanda',exact:true}).click();
    await waitFor(async()=>(await till.locator('[data-open-order-count]').textContent())==='2','fechamento com pagamento pelo X');
    await waitFor(async()=>(await phone.locator('[data-open-order-count]').textContent())==='2','fechamento pago sincronizado no celular');
    assert.equal((await api(desktop,server.url,'orders/'+currentOrder.id)).status,'closed');
    assert.equal(await till.locator('[data-action="switch-card"][data-id="3"]').count(),0);
    checks.push('O fluxo do X permite receber o saldo e concluir a venda, retirando a comanda dos atendimentos ativos no PC e no celular.');
    await phone.getByRole('button',{name:'Ler QR Code',exact:true}).click();
    await phone.getByRole('button',{name:'Desvincular',exact:true}).click();
    await phone.locator('#modal').getByRole('button',{name:'Desvincular',exact:true}).click();
    await phone.locator('#pairing-required').waitFor();
    assert.equal((await mobile.request.get(server.url+'/api/open-cards')).status(),428);
    const relink=await api(desktop,server.url,'pairing/code',{name:'Caixa novamente'});
    await phone.getByLabel('Código do caixa',{exact:true}).fill(relink.code);
    await phone.getByRole('button',{name:'Vincular celular',exact:true}).click();
    await phone.locator('#pos-workspace').waitFor();
    checks.push('Desvincular pelo celular bloqueia o atendimento imediatamente; um novo código do computador permite voltar.');
    await api(desktop,server.url,'pairing/revoke',{reason:'Teste de bloqueio dos celulares'});
    await phone.locator('#pairing-required').waitFor();
    await recovered.locator('#pairing-required').waitFor();
    await phone.reload();
    await phone.locator('#pairing-required').waitFor();
    assert.equal((await mobile.request.get(server.url+'/api/products')).status(),428);
    checks.push('Revogar os vínculos no computador bloqueia todos os celulares em tempo real e impede voltar por recarregamento.');
    assert.deepEqual(pageErrors,[],'Erros de JavaScript no navegador');
    writeFileSync(join(output,'resultado.json'),JSON.stringify({checks,pageErrors},null,2));
    for (const check of checks) console.log('OK '+check);
    console.log(`Teste mobile concluído. Evidências: ${output}`);
  } finally {
    if (browser) await browser.close();
    await server.stop();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
