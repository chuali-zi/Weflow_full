@echo off
chcp 65001 >nul
title WeFlow 本地整合版
echo 首次启动会自动下载环境和构建应用，请保持联网并等待。
echo 后续启动会复用已有环境。遇到失败时，此窗口会保留错误信息。
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch.ps1" %*
if errorlevel 1 pause
