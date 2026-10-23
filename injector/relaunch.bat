@echo off
setlocal
set "PORT=9333"
cd /d "%~dp0"

set "ZCODE="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0find-zcode.ps1"`) do set "ZCODE=%%P"
if not defined ZCODE exit /b 1

:wait
tasklist /fi "IMAGENAME eq ZCode.exe" 2>nul | find /i "ZCode.exe" >nul
if not errorlevel 1 (
  timeout /t 2 /nobreak >nul
  goto wait
)

start "" "%ZCODE%" --remote-debugging-port=%PORT%

:waitport
timeout /t 1 /nobreak >nul
powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:%PORT%/json/version').StatusCode}catch{exit 1}" >nul 2>&1
if errorlevel 1 goto waitport

start "" /min cmd /c "node ""%~dp0injector.mjs"" --port %PORT% --ctl-port 9334"
timeout /t 2 /nobreak >nul
