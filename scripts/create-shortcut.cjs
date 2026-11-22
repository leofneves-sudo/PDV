const {execFileSync}=require('node:child_process');
const {resolve}=require('node:path');

if(process.platform!=='win32')throw Error('O atalho da Área de Trabalho é destinado ao Windows.');
const script=String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$desktopPath = [Environment]::GetFolderPath('DesktopDirectory')
if (-not (Test-Path -LiteralPath $desktopPath)) { throw 'Área de Trabalho não encontrada.' }
$shortcutPath = Join-Path $desktopPath 'Iniciar Last Place PDV.lnk'
$targetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$scriptPath = Join-Path $env:PDV_SHORTCUT_ROOT 'scripts\iniciar.vbs'
$arguments = '//Nologo "' + $scriptPath + '" "' + $env:PDV_SHORTCUT_NODE + '"'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
if ((Test-Path -LiteralPath $shortcutPath) -and ($shortcut.TargetPath -ne $targetPath -or $shortcut.Arguments -ne $arguments)) {
  throw 'Já existe um atalho com esse nome apontando para outro programa; ele foi preservado.'
}
$shortcut.TargetPath = $targetPath
$shortcut.Arguments = $arguments
$shortcut.WorkingDirectory = $env:PDV_SHORTCUT_ROOT
$shortcut.Description = 'Inicia o Last Place PDV no computador e no celular e abre o navegador.'
$shortcut.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',14'
$shortcut.WindowStyle = 7
$shortcut.Save()
Write-Output $shortcutPath
`;
const output=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{
  env:{...process.env,PDV_SHORTCUT_ROOT:resolve(__dirname,'..'),PDV_SHORTCUT_NODE:process.execPath},
  windowsHide:true,encoding:'utf8'
});
console.log('Atalho criado: '+output.trim());
