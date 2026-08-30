@echo off
REM ---------------------------------------------------------------------------
REM  Double-click this to host a game.
REM
REM  Builds if needed, starts the server on :8787, and — if cloudflared is
REM  installed — opens a public tunnel so friends can join from anywhere with
REM  nothing to install. Without cloudflared it still works on your own network.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

echo.
echo   DBZ CCG Battle Sim
echo   ------------------
echo.

if not exist "node_modules" (
  echo   First run: installing dependencies. This takes a few minutes...
  call npm install || goto :fail
)

if not exist "packages\client\dist\index.html" (
  echo   Building the game...
  call npm run build --workspaces --if-present || goto :fail
)

echo   Starting the server on http://localhost:8787
start "DBZ server" /min cmd /c "node packages\server\dist\index.js"

REM Give the server a moment to bind before anything tries to reach it.
timeout /t 3 /nobreak >nul

where cloudflared >nul 2>&1
if %errorlevel%==0 (
  echo.
  echo   Opening a public link for your friends. Watch for the
  echo   https://....trycloudflare.com address below, and send it to them.
  echo   Keep this window open while you play. Close it to end the session.
  echo.
  cloudflared tunnel --url http://localhost:8787
) else (
  echo.
  echo   Playing on this computer:  http://localhost:8787
  echo   Same wi-fi as your friend:  http://%COMPUTERNAME%:8787
  echo.
  echo   To let friends join from anywhere, install cloudflared once:
  echo       winget install --id Cloudflare.cloudflared
  echo   then run this file again.
  echo.
  start "" "http://localhost:8787"
  echo   Press Ctrl+C or close this window to stop the server.
  pause >nul
)
goto :eof

:fail
echo.
echo   Something went wrong. Scroll up for the error.
pause
