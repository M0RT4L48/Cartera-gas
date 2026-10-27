@echo off
cd /d %~dp0
echo Iniciando Gas_App Financiero en http://localhost:3000 ...
node --disable-warning=ExperimentalWarning server\index.js
pause
