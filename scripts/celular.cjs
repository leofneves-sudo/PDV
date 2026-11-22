const {createServer: createHttpsServer} = require('node:https');
const {request: httpRequest} = require('node:http');
const {readFileSync} = require('node:fs');
const {ensureCertificates}=require('./lan-cert.cjs');
const {networkInterfaces} = require('node:os');
const {join, resolve} = require('node:path');

const host=process.argv[2];
const address=/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
const interfaces=Object.values(networkInterfaces()).flat();
if (!host || !address.test(host) || !interfaces.some(item=>item.family==='IPv4' && item.address===host)) {
  const choices=interfaces.filter(item=>item.family==='IPv4' && address.test(item.address)).map(item=>item.address);
  console.error('Informe o IP deste computador na rede local.\nUso: npm run celular -- '+(choices.join(' ou ') || 'IP_DO_COMPUTADOR'));
  process.exit(1);
}
const port=Number(process.env.PDV_LAN_PORT || 3443);
const localPort=Number(process.env.PDV_LOCAL_PORT || 3000);
const hostPort=`${host}:${port}`;
const origin=`https://${hostPort}`;
const localHost=`127.0.0.1:${localPort}`;
const certDir=resolve(process.env.PDV_LAN_CERT_DIR || join(__dirname,'../data/https'));
process.umask(0o077);
const {publicCa,key,cert}=ensureCertificates(certDir,host);

const hopByHop=['connection','keep-alive','proxy-connection','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade'];
function forwardHeaders(original) {
  const headers={...original};
  const connection=(headers.connection || '').toLowerCase().split(',').map(name=>name.trim());
  for (const name of [...hopByHop,...connection]) delete headers[name];
  return headers;
}
const proxy=createHttpsServer({key:readFileSync(key),cert:readFileSync(cert),minVersion:'TLSv1.2'},(req,res)=>{
  if (req.headers.host!==hostPort || !/^\/(?!\/)/.test(req.url || '')) {
    res.writeHead(421).end('Abra o endereço HTTPS mostrado no terminal.');
    return;
  }
  if (req.headers.origin && req.headers.origin!==origin) {
    res.writeHead(403).end('Origem da requisição inválida.');
    return;
  }
  const headers=forwardHeaders(req.headers);
  delete headers.forwarded;
  headers.host=localHost;
  headers['x-forwarded-for']=req.socket.remoteAddress;
  headers['x-forwarded-proto']='https';
  if (req.headers.origin) headers.origin=`http://${localHost}`;
  const upstream=httpRequest({host:'127.0.0.1',port:localPort,method:req.method,path:req.url,headers},reply=>{
    const responseHeaders=forwardHeaders(reply.headers);
    if (reply.headers['set-cookie']) {
      responseHeaders['set-cookie']=reply.headers['set-cookie'].map(cookie=>/;\s*secure(?:;|$)/i.test(cookie)?cookie:cookie+'; Secure');
    }
    res.writeHead(reply.statusCode,responseHeaders);
    reply.on('error',()=>res.destroy());
    reply.pipe(res);
  });
  upstream.on('error',()=>{
    if (res.headersSent) res.destroy();
    else res.writeHead(502,{'Content-Type':'text/plain; charset=utf-8'}).end('O servidor do PDV está desligado. Inicie com npm start.');
  });
  res.on('close',()=>upstream.destroy());
  req.on('error',()=>upstream.destroy());
  req.pipe(upstream);
});
proxy.listen(port,host,()=>{
  console.log(`Last Place PDV no celular: ${origin}/#leitor`);
  console.log(`Certificado público para o celular: ${publicCa}`);
});
