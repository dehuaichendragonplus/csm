@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo [sync-manager] installing dependencies (first run)...
  call npm install || exit /b 1
)
node server.js
endlocal
