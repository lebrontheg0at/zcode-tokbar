@echo off
setlocal
cd /d "%~dp0.."
echo Waiting for ZCode to fully exit...
:wait
tasklist /fi "IMAGENAME eq ZCode.exe" 2>nul | find /i "ZCode.exe" >nul
if not errorlevel 1 ( timeout /t 2 /nobreak >nul & goto wait )
node "asar-patch\install-asar.mjs" --restore
pause
