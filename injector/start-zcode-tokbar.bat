@echo off
setlocal
set "PORT=9333"
cd /d "%~dp0"

echo ============================================
echo  ZCode Token Bar launcher
echo ============================================
echo.

set "ZCODE="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0find-zcode.ps1"`) do set "ZCODE=%%P"
if not defined ZCODE (
  echo [X] Cannot locate ZCode.exe.
  echo     Set the ZCODE_EXE environment variable to its full path, then retry.
  echo     Example:  set "ZCODE_EXE=C:\path\to\ZCode.exe"
  pause & exit /b 1
)
echo ZCode: %ZCODE%

echo.
echo Waiting for ZCode to fully exit...
:wait
tasklist /fi "IMAGENAME eq ZCode.exe" 2>nul | find /i "ZCode.exe" >nul
if not errorlevel 1 (
  timeout /t 2 /nobreak >nul
  goto wait
)
echo ZCode is closed.

echo Starting ZCode with remote debugging on port %PORT% ...
start "" "%ZCODE%" --remote-debugging-port=%PORT%

echo Waiting for the debug port...
:waitport
timeout /t 1 /nobreak >nul
powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:%PORT%/json/version').StatusCode}catch{exit 1}" >nul 2>&1
if errorlevel 1 goto waitport

echo Debug port is up. Injecting token bar...
echo (Keep this window open. Closing it stops the live updates.)
echo.
node "%~dp0injector.mjs" --port %PORT% --ctl-port 9334

echo.
echo Injector stopped. Press any key to close.
pause
