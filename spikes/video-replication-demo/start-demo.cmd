@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required.
  pause
  exit /b 1
)
if not exist ".env.local" copy /y ".env.example" ".env.local" >nul
echo Open http://127.0.0.1:1768 after the server starts.
echo Close this window or press Ctrl+C to stop the demo.
node server.mjs
if errorlevel 1 pause
