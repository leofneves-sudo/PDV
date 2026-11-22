const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,readFileSync,rmSync,rmdirSync}=require('node:fs');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const {X509Certificate}=require('node:crypto');
const {createServer,get}=require('node:https');
const {ensureCertificates}=require('../scripts/lan-cert.cjs');

test('certificados locais funcionam sem OpenSSL e são preservados ao reiniciar',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'last-place-cert-'));
  const host='127.0.0.1';
  let server;
  try {
    const files=ensureCertificates(directory,host);
    const root=new X509Certificate(readFileSync(files.ca));
    const leaf=new X509Certificate(readFileSync(files.cert));
    assert.equal(root.ca,true);
    assert.equal(leaf.ca,false);
    assert.ok(leaf.verify(root.publicKey));
    assert.equal(leaf.checkIP(host),host);
    assert.equal(leaf.checkIP('192.168.50.99'),undefined);
    assert.deepEqual(readFileSync(files.publicCa),root.raw);
    const original=readFileSync(files.cert);
    const again=ensureCertificates(directory,host);
    assert.deepEqual(readFileSync(again.cert),original);
    server=createServer({key:readFileSync(files.key),cert:readFileSync(files.cert)},(req,res)=>res.end('Last Place PDV'));
    await new Promise(resolve=>server.listen(0,host,resolve));
    const result=await new Promise((resolve,reject)=>{
      get({hostname:host,port:server.address().port,ca:readFileSync(files.ca)},response=>{
        let text='';response.on('data',part=>text+=part);response.on('end',()=>resolve(text));
      }).on('error',reject);
    });
    assert.equal(result,'Last Place PDV');
  } finally {
    if (server) await new Promise(resolve=>server.close(resolve));
    for (const name of ['balcao-ca.pem','balcao-ca.key','balcao-ca.cer',`server-${host}.key`,`server-${host}.pem`]) rmSync(join(directory,name),{force:true});
    rmdirSync(directory);
  }
});
