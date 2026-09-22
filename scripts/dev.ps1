$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ApiDir = Join-Path $RepoRoot "apps\api"
$WebDir = Join-Path $RepoRoot "apps\web"
$PythonExe = Join-Path $ApiDir ".venv\Scripts\python.exe"
$DataDir = Join-Path $RepoRoot "data"

if (-not (Test-Path $PythonExe)) {
    throw "尚未安装依赖，请先运行 .\scripts\setup.ps1"
}

$ApiCommand = "`$env:CIC_DATA_DIR='$DataDir'; Set-Location '$ApiDir'; & '$PythonExe' -m uvicorn app.main:app --reload --port 8000"
$WebCommand = "Set-Location '$WebDir'; npm run dev"
Start-Process powershell -ArgumentList "-NoExit", "-Command", $ApiCommand
Start-Process powershell -ArgumentList "-NoExit", "-Command", $WebCommand

Write-Host "后端和前端已在两个窗口启动。请打开 http://localhost:5173" -ForegroundColor Green
