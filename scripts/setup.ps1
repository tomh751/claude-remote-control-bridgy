#Requires -Version 5.1
# One-time setup: create venv, install deps, copy .env.local.example.
# Run once from the repo root: .\scripts\setup.ps1

$ErrorActionPreference = "Stop"
# This script lives in <repo>/scripts/. Walk up one level so venv, .env.local,
# requirements.txt, and bridge/ resolve relative to the repo root regardless
# of which folder the user invoked the script from.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $here
Set-Location $repoRoot

# Find a Python launcher: prefer `py` (Windows launcher), fall back to `python` / `python3`.
$pyCmd = $null
foreach ($candidate in @("py", "python", "python3")) {
    if (Get-Command $candidate -ErrorAction SilentlyContinue) {
        $pyCmd = $candidate
        break
    }
}
if (-not $pyCmd) {
    Write-Host "No Python launcher found on PATH (tried: py, python, python3)." -ForegroundColor Red
    Write-Host "Install Python from https://www.python.org/downloads/ and tick 'Add to PATH' during install." -ForegroundColor Red
    exit 1
}
Write-Host "Using Python launcher: $pyCmd" -ForegroundColor Gray

Write-Host "[1/3] Creating Python venv at .\.venv ..." -ForegroundColor Cyan
if (-not (Test-Path ".\.venv")) {
    & $pyCmd -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw "venv creation failed." }
}

Write-Host "[2/3] Installing dependencies ..." -ForegroundColor Cyan
& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw "pip install failed." }

Write-Host "[3/3] Checking .env.local ..." -ForegroundColor Cyan
if (-not (Test-Path ".\.env.local")) {
    Copy-Item ".\.env.local.example" ".\.env.local"
    Write-Host "    Created .env.local from template. Fill in PROJECTS_ROOT and WEB_PASSWORD before running .\scripts\start.ps1." -ForegroundColor Yellow
} else {
    Write-Host "    .env.local already exists; leaving it alone." -ForegroundColor Green
}

Write-Host ""
Write-Host "Setup complete. Next:" -ForegroundColor Green
Write-Host "  1. Open .env.local in a text editor and fill in:"
Write-Host "     - PROJECTS_ROOT  (absolute path to the folder whose subfolders are your projects)"
Write-Host "     - WEB_PASSWORD   (10+ chars; you'll type this once on your phone, then save it)"
Write-Host "  2. Install Tailscale on this laptop AND your phone, sign both into the same tailnet."
Write-Host "  3. Run .\scripts\start.ps1, then on the phone visit http://<laptop-tailscale-name>:8787"
Write-Host "     and Share -> Add to Home Screen for the PWA."
