@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在安装内容智能白板所需依赖，请保持网络连接...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1"
if errorlevel 1 (
  echo.
  echo 安装失败，请查看上方错误信息，并确认已安装 Python 3.11+ 和 Node.js 20.19+。
  pause
  exit /b 1
)
echo.
echo 安装完成。以后双击“启动内容智能白板.bat”即可启动。
pause
