@echo off
setlocal
cd /d "%~dp0"
set "PLAYWRIGHT_BROWSERS_PATH=%~dp0runtime\browsers"
start "" "http://127.0.0.1:3211"
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" src\web-server.js
) else (
  node src\web-server.js
)