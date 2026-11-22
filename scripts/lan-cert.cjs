const {generateKeyPairSync,randomBytes,X509Certificate,createPublicKey}=require('node:crypto');
const {existsSync,mkdirSync,readFileSync,writeFileSync}=require('node:fs');
const {join}=require('node:path');
const forge=require('node-forge');

function keys() {
  return generateKeyPairSync('rsa',{modulusLength:2048,
    publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs1',format:'pem'}});
}
function certificate(publicKey,days) {
  const cert=forge.pki.createCertificate();
  cert.publicKey=forge.pki.publicKeyFromPem(publicKey);
  cert.serialNumber='01'+randomBytes(16).toString('hex');
  cert.validity.notBefore=new Date(Date.now()-5*60000);
  cert.validity.notAfter=new Date(Date.now()+days*86400000);
  return cert;
}
function matchesKey(cert,file) {
  try {
    return cert.publicKey.export({type:'spki',format:'der'}).equals(createPublicKey(readFileSync(file)).export({type:'spki',format:'der'}));
  } catch {return false;}
}
function ensureCertificates(directory,host) {
  mkdirSync(directory,{recursive:true,mode:0o700});
  const ca=join(directory,'balcao-ca.pem'),caKey=join(directory,'balcao-ca.key');
  const publicCa=join(directory,'balcao-ca.cer');
  const key=join(directory,`server-${host}.key`),cert=join(directory,`server-${host}.pem`);
  if (existsSync(ca)!==existsSync(caKey)) throw Error('O certificado ou a chave da autoridade local está faltando em '+directory);
  if (!existsSync(ca)) {
    const pair=keys(),root=certificate(pair.publicKey,1095);
    root.setSubject([{name:'commonName',value:'Last Place PDV Autoridade Local'}]);
    root.setIssuer(root.subject.attributes);
    root.setExtensions([
      {name:'basicConstraints',critical:true,cA:true,pathLenConstraint:0},
      {name:'keyUsage',critical:true,keyCertSign:true,cRLSign:true},
      {name:'subjectKeyIdentifier'}
    ]);
    root.sign(forge.pki.privateKeyFromPem(pair.privateKey),forge.md.sha256.create());
    writeFileSync(caKey,pair.privateKey,{mode:0o600});
    writeFileSync(ca,forge.pki.certificateToPem(root),{mode:0o644});
  }
  const rootPem=readFileSync(ca,'utf8'),root=new X509Certificate(rootPem);
  if (!root.ca || !root.verify(root.publicKey) || !matchesKey(root,caKey)) throw Error('A autoridade local do PDV está inválida ou não corresponde à chave.');
  if (Date.parse(root.validTo)<Date.now()+86400000) throw Error('A autoridade local expirou ou está prestes a expirar. Renove os certificados e a confiança nos celulares.');
  writeFileSync(publicCa,root.raw,{mode:0o644});
  let server;
  try {if (existsSync(cert)) server=new X509Certificate(readFileSync(cert));} catch {}
  if (!server || !matchesKey(server,key) || Date.parse(server.validTo)<Date.now()+86400000 || !server.checkIP(host) || !server.verify(root.publicKey)) {
    const pair=keys(),leaf=certificate(pair.publicKey,365);
    const issuer=forge.pki.certificateFromPem(rootPem);
    leaf.validity.notAfter=new Date(Math.min(+leaf.validity.notAfter,Date.parse(root.validTo)));
    leaf.setSubject([{name:'commonName',value:'Last Place PDV'}]);
    leaf.setIssuer(issuer.subject.attributes);
    leaf.setExtensions([
      {name:'basicConstraints',critical:true,cA:false},
      {name:'keyUsage',critical:true,digitalSignature:true,keyEncipherment:true},
      {name:'extKeyUsage',serverAuth:true},
      {name:'subjectAltName',altNames:[{type:7,ip:host}]},
      {name:'subjectKeyIdentifier'}
    ]);
    leaf.sign(forge.pki.privateKeyFromPem(readFileSync(caKey,'utf8')),forge.md.sha256.create());
    writeFileSync(key,pair.privateKey,{mode:0o600});
    writeFileSync(cert,forge.pki.certificateToPem(leaf),{mode:0o644});
  }
  return {ca,caKey,publicCa,key,cert};
}
module.exports={ensureCertificates};
