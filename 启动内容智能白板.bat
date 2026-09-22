@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev.ps1"
if errorlevel 1 (
  echo.
  echo 启动失败。首次使用请先双击“首次安装.bat”。
  pause
  exit /b 1
)
