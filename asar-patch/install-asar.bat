@echo off
setlocal
cd /d "%~dp0.."
echo ============================================
echo  ZCode Token Bar - app.asar injection
echo ============================================
echo.
echo Waiting for ZCode to fully exit (close it now)...
:wait
tasklist /fi "IMAGENAME eq ZCode.exe" 2>nul | find /i "ZCode.exe" >nul
if not errorlevel 1 ( timeout /t 2 /nobreak >nul & goto wait )
echo ZCode is closed.
echo.
"D:\nodejs\node.exe" "asar-patch\install-asar.mjs"
if errorlevel 1 (
  echo.
  echo [X] Injection failed. ZCode was NOT modified.
  pause & exit /b 1
)
echo.
echo Starting ZCode ...
set "ZCODE="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -ExecutionPolicy Bypass -File "injector\find-zcode.ps1"`) do set "ZCODE=%%P"
if defined ZCODE start "" "%ZCODE%"
echo Done. The tok/s bar should appear under the chat input.
pause
