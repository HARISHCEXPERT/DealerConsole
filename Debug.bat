@echo off
chcp 65001 >nul
title Dealer Console - DEBUG
cd /d "%~dp0"
if not exist logs mkdir logs
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set TS=%%i
set LOG=logs\run-%TS%.log

echo.
echo ==================================================
echo   DEALER CONSOLE - DEBUG MODE
echo   Har cheez yahan dikhegi aur %LOG% me save hogi
echo ==================================================
echo.
echo [1/3] Jaanch (doctor)...
node scripts\doctor.js
if errorlevel 2 (
  echo.
  echo  Upar X wali galti theek karo. Phir bhi chalana hai to koi key dabao, band karna hai to window band karo.
  pause >nul
)

echo.
echo [2/3] Server chalu ho raha... browser 6 second me khulega
echo       Band karna ho to is window me Ctrl+C dabao (phir N)
echo.
start "" cmd /c "timeout /t 6 >nul & start http://localhost:4000"
powershell -NoProfile -Command "cmd /c 'node --disable-warning=ExperimentalWarning src/server.js 2>&1' | Tee-Object -FilePath '%LOG%'"

echo.
echo [3/3] Server band. Bug report bana raha...
node scripts\doctor.js --report %LOG% >nul
set /p RDIR=<logs\last-report.txt
powershell -NoProfile -Command "Compress-Archive -Path '%RDIR%\*' -DestinationPath '%RDIR%.zip' -Force"
echo.
echo  Bug report: %RDIR%.zip
echo  Ye zip chat me bhej do (password isme nahi hote).
explorer /select,"%RDIR%.zip"
pause
