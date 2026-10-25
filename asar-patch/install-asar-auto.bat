@echo off
setlocal
cd /d "%~dp0.."
set "LOG=%~dp0auto-install.log"
echo [%date% %time%] waiting for ZCode to exit >> "%LOG%"
:wait
tasklist /fi "IMAGENAME eq ZCode.exe" 2>nul | find /i "ZCode.exe" >nul
if not errorlevel 1 ( timeout /t 2 /nobreak >nul & goto wait )
echo [%date% %time%] ZCode closed, patching >> "%LOG%"
"D:\nodejs\node.exe" "asar-patch\install-asar.mjs" >> "%LOG%" 2>&1
if errorlevel 1 ( echo [%date% %time%] FAILED >> "%LOG%" & exit /b 1 )
echo [%date% %time%] patched, starting ZCode >> "%LOG%"
set "ZCODE="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -ExecutionPolicy Bypass -File "injector\find-zcode.ps1"`) do set "ZCODE=%%P"
if defined ZCODE start "" "%ZCODE%"
echo [%date% %time%] done >> "%LOG%"
