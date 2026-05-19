#Requires -Version 5.1
# Launch the bridge. Run from the repo root: .\scripts\start.ps1
# Ctrl+C to stop.

$ErrorActionPreference = "Stop"
# This script lives in <repo>/scripts/. Walk up one level so the bridge's
# venv + .env.local + bridge/ all resolve at the repo root.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $here
Set-Location $repoRoot

if (-not (Test-Path ".\.venv\Scripts\python.exe")) {
    Write-Host "Venv not found. Run .\scripts\setup.ps1 first." -ForegroundColor Red
    exit 1
}
if (-not (Test-Path ".\.env.local")) {
    Write-Host ".env.local not found. Run .\scripts\setup.ps1 and fill in the values." -ForegroundColor Red
    exit 1
}

& .\.venv\Scripts\python.exe -m bridge.main
