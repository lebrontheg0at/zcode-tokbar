@echo off
setlocal
cd /d "%~dp0"
echo ============================================
echo  ZCode Token Bar - installer / checker
echo ============================================
echo.

echo [1/3] Checking Node.js ...
where node >nul 2>&1
if errorlevel 1 (
  echo   [X] Node.js not found.
  echo       Install the LTS build from https://nodejs.org/ then run this again.
  pause & exit /b 1
)
for /f "delims=" %%V in ('node --version') do echo   Node %%V OK

echo [2/3] Locating ZCode ...
set "ZCODE="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0injector\find-zcode.ps1"`) do set "ZCODE=%%P"
if not defined ZCODE (
  echo   [X] Cannot locate ZCode.exe.
  echo       Set it manually:  set "ZCODE_EXE=C:\path\to\ZCode.exe"
  pause & exit /b 1
)
echo   Found: %ZCODE%

echo [3/3] Creating desktop shortcut ...
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'ZCode Token Bar.lnk')); $s.TargetPath='%~dp0injector\start-zcode-tokbar.bat'; $s.WorkingDirectory='%~dp0injector'; $s.IconLocation='%ZCODE%'; $s.Save()"
echo   Shortcut: ZCode Token Bar

echo.
echo ============================================
echo  Ready.
echo.
echo  Usage:
echo    1. Make sure ZCode is fully exited
echo    2. Run the desktop shortcut "ZCode Token Bar"
echo    3. It relaunches ZCode with a debug port and shows the bar
echo ============================================
pause
