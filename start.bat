@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed or not on PATH.
  echo Install LTS from https://nodejs.org/ then run start.bat again.
  pause
  exit /b 1
)

if not exist "data\objects.xml" (
  echo Missing bundled game data: data\objects.xml
  echo This folder is incomplete. Re-copy the Map map package.
  pause
  exit /b 1
)

if not exist "data\tiles.xml" (
  echo Missing bundled game data: data\tiles.xml
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo First run: installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
  echo.
)

echo Starting Hive Map Editor at http://localhost:4173
echo Close this window to stop the server.
echo.

rem Open the browser shortly after the server begins listening.
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:4173"

node server.mjs
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
  echo.
  echo Server exited with code %EXITCODE%.
  pause
)
exit /b %EXITCODE%
