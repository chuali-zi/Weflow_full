@echo off
chcp 65001 >nul
setlocal
if exist "%~dp0resources\backend\weflow-backend.exe" (
  "%~dp0resources\backend\weflow-backend.exe" cli %*
  exit /b
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\cli.ps1" %*
exit /b %errorlevel%
