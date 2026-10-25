@echo off
setlocal
cd /d "%~dp0.."
set "LOG=%~dp0auto-install.log"
echo [%date% %time%] repatch waiting for ZCode to exit >> "%LOG%"
:wait
tasklist /fi "IMAGENAME eq ZCode.exe" 2>nul | find /i "ZCode.exe" >nul
if not errorlevel 1 ( timeout /t 2 /nobreak >nul & goto wait )
echo [%date% %time%] repatching with --force >> "%LOG%"
"D:\nodejs\node.exe" "asar-patch\install-asar.mjs" --force >> "%LOG%" 2>&1
if errorlevel 1 ( echo [%date% %time%] REPATCH FAILED >> "%LOG%" & exit /b 1 )
echo [%date% %time%] repatched, starting ZCode >> "%LOG%"
set "ZCODE="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -ExecutionPolicy Bypass -File "injector\find-zcode.ps1"`) do set "ZCODE=%%P"
if defined ZCODE start "" "%ZCODE%"
echo [%date% %time%] repatch done >> "%LOG%"
