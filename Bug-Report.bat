@echo off
chcp 65001 >nul
title Dealer Console - Bug Report
cd /d "%~dp0"
if not exist logs mkdir logs
echo Jaanch + aakhri log + sync ki galtiyan + screenshots ikattha kar raha...
echo.
node scripts\doctor.js --report
set /p RDIR=<logs\last-report.txt
powershell -NoProfile -Command "Compress-Archive -Path '%RDIR%\*' -DestinationPath '%RDIR%.zip' -Force"
echo.
echo  Bug report: %RDIR%.zip
echo  Ye zip chat me bhej do (password isme nahi hote).
explorer /select,"%RDIR%.zip"
pause
