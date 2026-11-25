const https=require('node:https');
const dns=require('node:dns/promises');
const net=require('node:net');
const fs=require('node:fs');
const {join,resolve}=require('node:path');
const {spawn}=require('node:child_process');
const {setTimeout:delay}=require('node:timers/promises');
const {chromium}=require('playwright-core');
const {storeUrl,imageUrl,parsePage,sameListing,sameProduct}=require('./site-catalog');
const pageReady=(parsed,url,options={})=>options.productDetails?
  parsed.rows.some(row=>sameProduct(url,row.url) && row.price!=null && row.stock!=null):parsed.rows.length>0;
function retryAfterMs(value,now=Date.now()) {
  const raw=String(value ?? '').trim();
  const milliseconds=raw && /^\d+(?:\.\d+)?$/.test(raw)?Number(raw)*1000:raw?Date.parse(raw)-now:NaN;
  return Number.isFinite(milliseconds)?Math.max(1000,milliseconds):60000;
}

function publicAddress(address) {
  if(net.isIP(address)===4) {
    const [a,b,c]=address.split('.').map(Number);
    return a>0 && a<224 && a!==10 && a!==127 && !(a===169&&b===254) && !(a===172&&b>=16&&b<=31) &&
      !(a===192&&(b===168||b===0&&(c===0||c===2))) && !(a===100&&b>=64&&b<=127) && !(a===198&&(b===18||b===19||b===51&&c===100)) && !(a===203&&b===0&&c===113);
  }
  return net.isIP(address)===6 && /^[23]/i.test(address) && !/^2001:db8:/i.test(address);
}
async function publicHost(hostname) {
  const addresses=await dns.lookup(hostname,{all:true});
  if(!addresses.length || addresses.some(row=>!publicAddress(row.address))) throw Error('O endereço do site não aponta para uma rede pública permitida.');
  return addresses.find(row=>row.family===4) || addresses[0];
}
async function download(urlValue,{image=false,signal,redirects=0}={}) {
  const url=image?new URL(imageUrl(urlValue,urlValue) || 'invalid:'):storeUrl(urlValue);
  if(url.protocol!=='https:') throw Error('Endereço de imagem não permitido.');
  const address=await publicHost(url.hostname);
  const combined=AbortSignal.any([signal || new AbortController().signal,AbortSignal.timeout(image?7000:20000)]);
  const result=await new Promise((resolve,reject)=>{
    const request=https.get(url,{signal:combined,headers:{'User-Agent':'LastPlacePDV/1.0 (importacao de catalogo)','Accept-Encoding':'identity'},
      lookup:(_host,options,callback)=>callback(null,options?.all?[address]:address.address,address.family)},response=>{
      const chunks=[];let size=0;
      response.on('data',chunk=>{
        size+=chunk.length;
        if(size>(image?800000:8*1024*1024)) response.destroy(Error('O arquivo do site excede o tamanho permitido.'));
        else chunks.push(chunk);
      });
      response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks)}));
      response.on('error',reject);
    });
    request.on('error',reject);
  });
  if([301,302,303,307,308].includes(result.status)) {
    if(redirects>=3 || !result.headers.location) throw Error('O site redirecionou muitas vezes.');
    const next=new URL(result.headers.location,url);
    if(image && !imageUrl(next.href,url)) throw Error('Redirecionamento de imagem não permitido.');
    if(!image)storeUrl(next.href);
    return download(next.href,{image,signal,redirects:redirects+1});
  }
  return {...result,url:url.href};
}
function browserExecutable() {
  const candidates=[process.env.PDV_IMPORT_BROWSER,
    process.env.ProgramFiles&&join(process.env.ProgramFiles,'Google/Chrome/Application/chrome.exe'),
    process.env['ProgramFiles(x86)']&&join(process.env['ProgramFiles(x86)'],'Microsoft/Edge/Application/msedge.exe'),
    process.env.ProgramFiles&&join(process.env.ProgramFiles,'BraveSoftware/Brave-Browser/Application/brave.exe'),
    process.env.LOCALAPPDATA&&join(process.env.LOCALAPPDATA,'Google/Chrome/Application/chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'
  ].filter(Boolean);
  const executable=candidates.find(path=>fs.existsSync(path));
  if(!executable)throw Error('Instale Chrome, Edge ou Brave no computador do PDV para concluir a leitura do site.');
  return executable;
}
class CatalogBrowser {
  constructor({directory,signal,onWaiting=()=>{},headless=false,allowTestUrl=false}={}) {
    this.directory=resolve(directory);this.signal=signal;this.onWaiting=onWaiting;
    this.headless=headless;this.allowTestUrl=allowTestUrl;
  }
  async open(url) {
    if(!this.allowTestUrl) {storeUrl(url);await publicHost(new URL(url).hostname);}
    fs.mkdirSync(this.directory,{recursive:true,mode:0o700});
    const activePort=join(this.directory,'DevToolsActivePort');
    fs.rmSync(activePort,{force:true});
    const args=['--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+this.directory,
      '--no-first-run','--no-default-browser-check','--new-window'];
    if(this.headless)args.push('--headless=new');
    args.push(url);
    this.child=spawn(browserExecutable(),args,{windowsHide:this.headless,stdio:'ignore'});
    let launchError;this.child.on('error',error=>{launchError=error;});
    const until=Date.now()+20000;
    let port;
    while(Date.now()<until) {
      this.signal?.throwIfAborted();
      if(launchError)throw launchError;
      if(fs.existsSync(activePort)) {
        port=Number(fs.readFileSync(activePort,'utf8').split(/\r?\n/)[0]);
        if(Number.isInteger(port) && port>0 && port<65536)break;
      }
      if(this.child.exitCode!==null)throw Error('Feche a janela de importação anterior e tente novamente.');
      await delay(100,undefined,{signal:this.signal});
    }
    if(!port)throw Error('Não foi possível abrir o navegador de importação.');
    this.browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:10000,noDefaults:true});
    this.page=this.browser.contexts()[0]?.pages()[0] || await this.browser.contexts()[0].newPage();
  }
  async read(url,options={}) {
    if(!this.browser) await this.open(url);
    else {
      this.signal?.throwIfAborted();
      if(!this.allowTestUrl){storeUrl(url);await publicHost(new URL(url).hostname);}
      await this.page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
    }
    const until=Date.now()+180000;
    let emptySince=Date.now(),lastHtml='';
    while(Date.now()<until) {
      this.signal?.throwIfAborted();
      if(this.page.isClosed())throw Error('O navegador de importação foi fechado. Analise o link novamente.');
      const actual=this.page.url();
      if(actual==='about:blank'){await delay(300,undefined,{signal:this.signal});continue;}
      if(!this.allowTestUrl)storeUrl(actual);
      lastHtml=await this.page.content();
      const parsed=parsePage(lastHtml,options.sourceUrl || url,options);
      if(parsed.challenge) {
        this.onWaiting('Conclua a verificação de acesso na janela do navegador aberta no computador.');
        emptySince=Date.now();
      } else if(pageReady(parsed,options.sourceUrl || url,options) || Date.now()-emptySince>10000) {
        if(!this.allowTestUrl && !sameListing(url,actual))throw Error('O site redirecionou para outra listagem ou alterou os filtros. Copie o link atual da listagem desejada e analise novamente.');
        return lastHtml;
      }
      await delay(700,undefined,{signal:this.signal});
    }
    throw Error('A verificação do site não foi concluída. Abra novamente a análise ou use um arquivo HTML salvo da listagem.');
  }
  async close() {
    if(this.browser) {
      try {
        const session=await this.browser.newBrowserCDPSession();
        await session.send('Browser.close');
      } catch {}
      try {await this.browser.close();} catch {}
    } else if(this.child && this.child.exitCode===null) this.child.kill();
  }
}
function createPageReader({directory,signal,onWaiting,headless=false,allowTestUrl=false,downloadPage=download,wait=delay}={}) {
  let browser;
  return {
    async read(url,options) {
      if(!browser) {
        let response;
        for(let attempt=0;attempt<3;attempt++) {
          response=await downloadPage(url,{signal});
          if(response.status!==429)break;
          const pause=retryAfterMs(response.headers['retry-after']);
          if(attempt===2 || pause>180000)throw Object.assign(Error('O site manteve o limite de acessos. Aguarde alguns minutos antes de analisar novamente.'),{code:'SITE_RATE_LIMIT'});
          onWaiting?.('O site limitou os acessos. Aguardando '+Math.ceil(pause/1000)+' segundos para retomar a consulta automaticamente.');
          await wait(pause,undefined,{signal});
          signal?.throwIfAborted();
        }
        const charset=/charset=([^;\s]+)/i.exec(String(response.headers['content-type']))?.[1] || 'utf-8';
        let html;try {html=new TextDecoder(charset).decode(response.body);} catch {html=response.body.toString('utf8');}
        const parsed=parsePage(html,url,options);
        if(response.status===200 && !parsed.challenge && pageReady(parsed,url,options)) {
          if(!sameListing(url,response.url))throw Error('O site alterou os filtros no redirecionamento. Copie o link da listagem atual e analise novamente.');
          return html;
        }
        if(![200,403,503].includes(response.status))throw Error('O site respondeu com erro HTTP '+response.status+'.');
        onWaiting?.('O site exige um navegador. Conclua a verificação na janela que será aberta no computador.');
        browser=new CatalogBrowser({directory,signal,onWaiting,headless,allowTestUrl});
      }
      return browser.read(url,options);
    },
    async close(){await browser?.close();}
  };
}
async function downloadImage(value,{signal}={}) {
  const result=await download(value,{image:true,signal});
  const type=String(result.headers['content-type'] || '').split(';')[0].toLowerCase();
  if(result.status!==200 || !['image/png','image/jpeg','image/gif','image/webp'].includes(type))throw Error('Imagem indisponível no site.');
  const body=result.body;
  const valid=type==='image/png'?body.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
    type==='image/jpeg'?body[0]===255&&body[1]===216:
    type==='image/gif'?/^GIF8[79]a/.test(body.toString('ascii',0,6)):
    body.toString('ascii',0,4)==='RIFF'&&body.toString('ascii',8,12)==='WEBP';
  if(!valid)throw Error('O arquivo de imagem retornado pelo site é inválido.');
  return 'data:'+type+';base64,'+body.toString('base64');
}
module.exports={publicAddress,publicHost,download,downloadImage,browserExecutable,CatalogBrowser,createPageReader,retryAfterMs};
