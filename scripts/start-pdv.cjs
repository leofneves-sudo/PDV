const {spawn,execFileSync}=require('node:child_process');
const {networkInterfaces}=require('node:os');
const {join,resolve}=require('node:path');
const fs=require('node:fs');
const http=require('node:http');
const https=require('node:https');
const net=require('node:net');

const root=resolve(__dirname,'..');
const privateIP=value=>typeof value==='string' && net.isIP(value)===4 && /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(value);
function localIP() {
  const addresses=Object.entries(networkInterfaces()).flatMap(([name,rows])=>(rows || [])
    .filter(row=>row.family==='IPv4' && !row.internal && privateIP(row.address)).map(row=>({name,ip:row.address})));
  if (process.platform==='win32') {
    try {
      const script="$route=Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop | Sort-Object RouteMetric | Select-Object -First 1; Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 | Select-Object -ExpandProperty IPAddress";
      const preferred=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:5000}).trim().split(/\s+/);
      const match=addresses.find(row=>preferred.includes(row.ip));
      if (match) return match.ip;
    } catch {}
  }
  addresses.sort((a,b)=>Number(/virtual|vethernet|vmware|vpn|wsl|docker/i.test(a.name))-Number(/virtual|vethernet|vmware|vpn|wsl|docker/i.test(b.name)));
  return addresses[0]?.ip || null;
}
function port(value,label) {
  const number=Number(value);
  if (!Number.isInteger(number) || number<1 || number>65535) throw Error(label+' deve estar entre 1 e 65535.');
  return number;
}
function probe(url,ca) {
  return new Promise(resolve=>{
    const request=(url.startsWith('https:')?https:http).get(url+'/api/session',{ca,timeout:1500},response=>{
      let data='';
      response.on('data',chunk=>{data+=chunk;if(data.length>250000)request.destroy();});
      response.on('end',()=>{
        try {
          const body=JSON.parse(data);
          resolve(response.statusCode===200 && typeof body.initialized==='boolean' && !!body.permissions?.operate && !!body.methods?.cash);
        } catch {resolve(false);}
      });
      response.on('error',()=>resolve(false));
    });
    request.on('timeout',()=>request.destroy());
    request.on('error',()=>resolve(false));
  });
}
function busyPort(host,port) {
  return new Promise(resolve=>{
    const socket=net.connect({host,port});
    let settled=false;
    const finish=value=>{if(!settled){settled=true;socket.destroy();resolve(value);}};
    socket.setTimeout(1000,()=>finish(false));
    socket.once('connect',()=>finish(true));
    socket.once('error',()=>finish(false));
  });
}
function acquireLock(file) {
  for (let attempt=0;attempt<2;attempt++) {
    try {fs.writeFileSync(file,JSON.stringify({pid:process.pid,at:Date.now()}),{flag:'wx'});return true;}
    catch (error) {
      if(error.code!=='EEXIST')throw error;
      let current;
      try {current=JSON.parse(fs.readFileSync(file,'utf8'));} catch {}
      if(!current && Date.now()-fs.statSync(file).mtimeMs<5000)return false;
      if(current?.at && Date.now()-current.at<120000){
        try {process.kill(current.pid,0);return false;} catch {}
      }
      fs.rmSync(file,{force:true});
    }
  }
  return false;
}
function launch(script,args,env,log) {
  const fd=fs.openSync(log,'a',0o600);
  let child;
  try {child=spawn(process.execPath,[join(root,'scripts',script),...args],{cwd:root,env,detached:true,windowsHide:true,stdio:['ignore',fd,fd]});}
  finally {fs.closeSync(fd);}
  let error;
  child.on('error',value=>{error=value;});
  child.unref();
  return {child,error:()=>error};
}
async function waitReady(check,processInfo,label,log) {
  const until=Date.now()+25000;
  do {
    if(await check())return;
    if(processInfo.error())throw processInfo.error();
    if(processInfo.child.exitCode!==null || processInfo.child.signalCode!==null) throw Error(label+' encerrou ao iniciar. Consulte '+log);
    await new Promise(resolve=>setTimeout(resolve,200));
  } while(Date.now()<until);
  throw Error(label+' não respondeu a tempo. Consulte '+log);
}
function openBrowser(url) {
  const program=process.platform==='win32'?'rundll32.exe':process.platform==='darwin'?'open':'xdg-open';
  const args=process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url];
  return new Promise((resolve,reject)=>{
    const child=spawn(program,args,{detached:true,windowsHide:false,stdio:'ignore'});
    child.once('error',reject);
    child.once('spawn',()=>{child.unref();resolve();});
  });
}
async function startPdv(options={}) {
  if(Number(process.versions.node.split('.')[0])<24)throw Error('Instale o Node.js 24 ou mais recente.');
  const env={...process.env,...options.env};
  const directory=resolve(options.directory || env.PDV_START_DIR || join(root,'data','inicializador'));
  fs.mkdirSync(directory,{recursive:true});
  const lock=join(directory,'iniciar.lock');
  if(!acquireLock(lock))return {starting:true,started:[]};
  const log=message=>fs.appendFileSync(join(directory,'iniciar.log'),new Date().toISOString()+' '+message+'\n');
  try {
    const pcPort=port(env.PDV_PORT || 3000,'Porta do computador');
    const lanPort=port(env.PDV_LAN_PORT || 3443,'Porta do celular');
    const ip=env.PDV_LAN_IP || localIP();
    if(!privateIP(ip))throw Error('Conecte o computador à rede da loja para iniciar o acesso do celular.');
    const pcUrl=`http://localhost:${pcPort}`,probeUrl=`http://127.0.0.1:${pcPort}`,mobileUrl=`https://${ip}:${lanPort}`;
    const started=[];
    if(!await probe(probeUrl)) {
      if(await busyPort('127.0.0.1',pcPort))throw Error(`A porta ${pcPort} está ocupada por um serviço que não respondeu como PDV. Nenhum processo foi encerrado.`);
      const pcLog=join(directory,'computador.log');
      const info=launch('../server.js',[],{...env,PDV_HOST:'127.0.0.1',PDV_PORT:String(pcPort),PDV_ORIGIN:'',PDV_TLS_CERT:'',PDV_TLS_KEY:''},pcLog);
      started.push({service:'computador',pid:info.child.pid});
      log('Iniciando computador: PID '+info.child.pid);
      await waitReady(()=>probe(probeUrl),info,'Servidor do computador',pcLog);
    } else log('Servidor do computador já está disponível.');
    const caFile=join(resolve(env.PDV_LAN_CERT_DIR || join(root,'data','https')),'balcao-ca.pem');
    const mobileProbe=()=>probe(mobileUrl,fs.existsSync(caFile)?fs.readFileSync(caFile):undefined);
    if(!await mobileProbe()) {
      if(await busyPort(ip,lanPort))throw Error(`A porta ${lanPort} está ocupada ou o certificado não corresponde a esta instalação. Consulte o serviço existente antes de iniciar outro.`);
      const mobileLog=join(directory,'celular.log');
      const info=launch('celular.cjs',[ip],{...env,PDV_LOCAL_PORT:String(pcPort),PDV_LAN_PORT:String(lanPort)},mobileLog);
      started.push({service:'celular',pid:info.child.pid});
      log('Iniciando celular: PID '+info.child.pid);
      await waitReady(mobileProbe,info,'Servidor do celular',mobileLog);
    } else log('Servidor do celular já está disponível.');
    const result={pcUrl,mobileUrl:mobileUrl+'/#leitor',started,at:new Date().toISOString()};
    fs.writeFileSync(join(directory,'estado.json'),JSON.stringify(result,null,2));
    fs.writeFileSync(join(directory,'enderecos.txt'),`Last Place PDV\r\n\r\nComputador: ${pcUrl}\r\nCelular: ${result.mobileUrl}\r\n\r\nUse a mesma rede Wi-Fi e instale o certificado público do PDV no celular.\r\n`);
    fs.rmSync(join(directory,'ultimo-erro.txt'),{force:true});
    log('Computador e celular prontos.');
    if(options.openBrowser!==false)await openBrowser(pcUrl);
    return result;
  } finally {fs.rmSync(lock,{force:true});}
}
if(require.main===module) {
  startPdv({openBrowser:!process.argv.includes('--no-browser')}).then(result=>{
    console.log(result.starting?'O PDV já está sendo iniciado.':`Computador: ${result.pcUrl}\nCelular: ${result.mobileUrl}`);
  }).catch(error=>{
    const directory=resolve(process.env.PDV_START_DIR || join(root,'data','inicializador'));
    fs.mkdirSync(directory,{recursive:true});
    fs.writeFileSync(join(directory,'ultimo-erro.txt'),error.message);
    console.error(error.message);process.exitCode=1;
  });
}
module.exports={startPdv,privateIP,acquireLock};
