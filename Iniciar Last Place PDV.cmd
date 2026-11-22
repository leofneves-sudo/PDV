@echo off
setlocal
if not exist "%~dp0scripts\iniciar.vbs" (
  echo Mantenha este arquivo junto com a pasta scripts do projeto.
  pause
  exit /b 1
)
start "" "%SystemRoot%\System32\wscript.exe" //Nologo "%~dp0scripts\iniciar.vbs"
endlocal
