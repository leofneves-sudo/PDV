const {createServer: createHttpsServer} = require('node:https');
const {request: httpRequest} = require('node:http');
const {execFileSync} = require('node:child_process');
const {X509Certificate} = require('node:crypto');
const {existsSync, mkdirSync, readFileSync, writeFileSync} = require('node:fs');
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
mkdirSync(certDir,{recursive:true,mode:0o700});

const ca=join(certDir,'balcao-ca.pem');
const caKey=join(certDir,'balcao-ca.key');
const publicCa=join(certDir,'balcao-ca.cer');
const key=join(certDir,`server-${host}.key`);
const cert=join(certDir,`server-${host}.pem`);
function openssl(...args) {
  return execFileSync('openssl',args,{stdio:['ignore','pipe','pipe']});
}
if (existsSync(ca)!==existsSync(caKey)) {
  throw new Error('O certificado ou a chave da autoridade local está faltando em '+certDir);
}
if (!existsSync(ca)) {
  const config=join(certDir,'ca.cnf');
  writeFileSync(config,`[req]
prompt=no
distinguished_name=dn
x509_extensions=ca
[dn]
CN=Balcao PDV Autoridade Local
[ca]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
`);
  openssl('req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','1095','-config',config,'-keyout',caKey,'-out',ca);
}
writeFileSync(publicCa,openssl('x509','-in',ca,'-outform','DER'));
const certificate=existsSync(cert) && new X509Certificate(readFileSync(cert));
if (!existsSync(key) || !certificate || Date.parse(certificate.validTo)<Date.now()+86400000 ||
    !certificate.checkIP(host) || !certificate.verify(new X509Certificate(readFileSync(ca)).publicKey)) {
  const csr=join(certDir,`server-${host}.csr`);
  const config=join(certDir,`server-${host}.cnf`);
  writeFileSync(config,`[server]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:${host}
authorityKeyIdentifier=keyid,issuer
`);
  openssl('req','-new','-newkey','rsa:2048','-nodes','-subj','/CN=Balcao PDV','-keyout',key,'-out',csr);
  openssl('x509','-req','-in',csr,'-CA',ca,'-CAkey',caKey,'-CAcreateserial','-sha256','-days','365','-extfile',config,'-extensions','server','-out',cert);
}

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
  console.log(`Leitor do Balcão: ${origin}/#leitor`);
  console.log(`Certificado público para o celular: ${publicCa}`);
});
