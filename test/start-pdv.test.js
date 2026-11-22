const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtemp,readFile,rm}=require('node:fs/promises');
const {tmpdir,networkInterfaces}=require('node:os');
const {join,resolve}=require('node:path');
const {once}=require('node:events');
const net=require('node:net');
const http=require('node:http');
const {startPdv,privateIP,acquireLock}=require('../scripts/start-pdv.cjs');
async function freePort(host) {
  const server=net.createServer();
  await new Promise(resolve=>server.listen(0,host,resolve));
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}
function cleanup(path) {
  const target=resolve(path),temporary=resolve(tmpdir());
  if (!target.toLowerCase().startsWith(temporary.toLowerCase()+require('node:path').sep)) throw Error('Diretório temporário fora do local esperado.');
  return rm(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
test('seleção de IP aceita apenas redes locais IPv4',()=>{
  for(const ip of ['192.168.50.16','10.0.0.5','172.16.0.1','172.31.255.1'])assert.equal(privateIP(ip),true);
  for(const ip of ['127.0.0.1','8.8.8.8','172.32.0.1','192.168.500.1','::1',undefined])assert.equal(privateIP(ip),false);
});
test('o bloqueio impede duas inicializações simultâneas e recupera bloqueio inválido',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'last-place-launch-lock-'));
  try {
    const file=join(directory,'iniciar.lock');
    assert.equal(acquireLock(file),true);
    assert.equal(acquireLock(file),false);
    await require('node:fs/promises').writeFile(file,'inválido');
    assert.equal(acquireLock(file),false);
    await require('node:fs/promises').utimes(file,new Date(0),new Date(0));
    assert.equal(acquireLock(file),true);
  } finally {await cleanup(directory);}
});
test('iniciador liga PC e HTTPS do celular e reutiliza ambos na segunda execução',{timeout:40000},async t=>{
  const ip=Object.values(networkInterfaces()).flat().find(row=>row.family==='IPv4' && !row.internal && privateIP(row.address))?.address;
  if(!ip){t.skip('Sem interface de rede local disponível.');return;}
  const directory=await mkdtemp(join(tmpdir(),'last-place-launch-'));
  const options={directory,openBrowser:false,env:{PDV_DB:':memory:',PDV_PORT:String(await freePort('127.0.0.1')),
    PDV_LAN_IP:ip,PDV_LAN_PORT:String(await freePort(ip)),PDV_LAN_CERT_DIR:join(directory,'https'),PDV_BACKUP_MINUTES:'0'}};
  let first;
  try {
    first=await startPdv(options);
    assert.equal(first.started.length,2);
    assert.match(first.pcUrl,/^http:\/\/localhost:/);
    assert.match(first.mobileUrl,/#leitor$/);
    const second=await startPdv(options);
    assert.equal(second.started.length,0);
    assert.equal(second.pcUrl,first.pcUrl);
    assert.equal(second.mobileUrl,first.mobileUrl);
    const state=JSON.parse(await readFile(join(directory,'estado.json'),'utf8'));
    assert.equal(state.mobileUrl,first.mobileUrl);
    assert.match(await readFile(join(directory,'enderecos.txt'),'utf8'),/Last Place PDV/);
  } finally {
    for(const processInfo of first?.started || []) {
      try{process.kill(processInfo.pid,'SIGTERM');}catch{}
    }
    await cleanup(directory);
  }
});
test('porta ocupada por outro serviço resulta em erro sem encerrar o serviço existente',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'last-place-launch-port-'));
  const server=http.createServer((req,res)=>res.end('Outro serviço'));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    await assert.rejects(startPdv({directory,openBrowser:false,env:{PDV_PORT:String(server.address().port),PDV_LAN_IP:'192.168.1.2'}}),/ocupada/);
    assert.equal(server.listening,true);
  } finally {await new Promise(resolve=>server.close(resolve));await cleanup(directory);}
});
