$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ApiDir = Join-Path $RepoRoot "apps\api"
$WebDir = Join-Path $RepoRoot "apps\web"
$PythonExe = Join-Path $ApiDir ".venv\Scripts\python.exe"

if (-not (Test-Path $PythonExe)) {
    python -m venv (Join-Path $ApiDir ".venv")
}

& $PythonExe -m pip install --upgrade pip
& $PythonExe -m pip install -e "$ApiDir[dev]"
Push-Location $WebDir
npm install
Pop-Location

Write-Host "安装完成。运行 .\scripts\dev.ps1 启动工作台。" -ForegroundColor Green
