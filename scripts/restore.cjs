const {copyFileSync,constants,existsSync,mkdirSync}=require('node:fs');
const {resolve,dirname}=require('node:path');
const {verify}=require('../backup');

const [sourcePath,targetPath]=process.argv.slice(2);
if (!sourcePath || !targetPath) {
  console.error('Uso: npm run restaurar -- backup.sqlite banco-restaurado.sqlite');
  process.exit(1);
}
const source=resolve(sourcePath),target=resolve(targetPath);
if ([target,target+'-wal',target+'-shm'].some(existsSync)) {
  console.error('O destino precisa ser um caminho novo.');
  process.exit(1);
}
process.umask(0o077);
verify(source);
mkdirSync(dirname(target),{recursive:true,mode:0o700});
copyFileSync(source,target,constants.COPYFILE_EXCL);
verify(target);
console.log('Banco restaurado e verificado:',target);
