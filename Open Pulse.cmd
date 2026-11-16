@echo off
setlocal
title Pulse - Uptime Monitor
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" "%~dp0src\server.ts" --open
endlocal
