@echo off
chcp 65001 >nul
title Dealer Console - Setup
setlocal enabledelayedexpansion

set "REPO=https://github.com/HARISHCEXPERT/DealerConsole-release.git"
set "DEST=%LOCALAPPDATA%\DealerConsole"

echo ============================================
echo        DEALER CONSOLE - SETUP
echo ============================================
echo.

REM ---- Chrome check (sirf chetavni) ----
if not exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" if not exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" if not exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" (
  echo [!] Google Chrome nahi mila. Sync ke liye Chrome chahiye - baad me install kar lena.
  echo.
)

set "NEEDRERUN="

REM ---- Git ----
where git >nul 2>nul
if errorlevel 1 (
  echo [1/4] Git install kar rahe...
  where winget >nul 2>nul
  if errorlevel 1 (
    echo     winget nahi hai. Git khud install karo: https://git-scm.com/download/win
    echo     phir is file ko dobara chalao.
    pause & exit /b
  )
  winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
  set "NEEDRERUN=1"
) else (
  echo [1/4] Git mila.
)

REM ---- Node ----
where node >nul 2>nul
if errorlevel 1 (
  echo [2/4] Node install kar rahe...
  where winget >nul 2>nul
  if errorlevel 1 (
    echo     winget nahi hai. Node khud install karo: https://nodejs.org
    echo     phir is file ko dobara chalao.
    pause & exit /b
  )
  winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
  set "NEEDRERUN=1"
) else (
  echo [2/4] Node mila.
)

if defined NEEDRERUN (
  echo.
  echo ============================================
  echo   Git/Node install ho gaya.
  echo   Ab is file ^(DealerConsole-Setup.bat^) ko
  echo   EK BAAR DOBARA double-click karo.
  echo ============================================
  pause & exit /b
)

REM ---- Clone ya update ----
echo [3/4] App la rahe...
if exist "%DEST%\.git" (
  git -C "%DEST%" fetch --quiet origin
  git -C "%DEST%" reset --hard origin/main --quiet
) else (
  git clone "%REPO%" "%DEST%"
  if errorlevel 1 ( echo     Clone fail - internet / repo URL check karo. & pause & exit /b )
)

REM ---- Desktop shortcut ----
echo [4/4] Desktop pe icon bana rahe...
powershell -NoProfile -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Dealer Console.lnk'); $s.TargetPath='%DEST%\Dealer Console.bat'; $s.WorkingDirectory='%DEST%'; $s.IconLocation='%SystemRoot%\System32\SHELL32.dll,13'; $s.Save()"

echo.
echo ============================================
echo   HO GAYA! App chalu ho raha hai...
echo   Aage se Desktop ke "Dealer Console" icon se kholo.
echo ============================================
echo.
timeout /t 2 >nul
call "%DEST%\Dealer Console.bat"