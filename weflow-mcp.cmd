@echo off
setlocal
if exist "%~dp0resources\mcp\server.cjs" (
  set ELECTRON_RUN_AS_NODE=1
  set "WEFLOW_MCP_ASSETS=%~dp0resources\mcp"
  set "NODE_PATH=%~dp0resources\app.asar\node_modules;%~dp0resources\app.asar.unpacked\node_modules"
  set "WEFLOW_BACKEND_ROOT="
  "%~dp0WeFlow.exe" "%~dp0resources\mcp\server.cjs" --resources-path "%~dp0resources" %*
  exit /b
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\mcp.ps1" %*
exit /b %errorlevel%
