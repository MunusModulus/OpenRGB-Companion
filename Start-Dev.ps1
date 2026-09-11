$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

Write-Host "=== OpenRGB Companion - Dev Start ===" -ForegroundColor Cyan

function Require-Command([string]$Name, [string]$Hint) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Write-Host "[NG] $Name not found." -ForegroundColor Red
        Write-Host $Hint
        exit 1
    }
    Write-Host "[OK] $Name" -ForegroundColor Green
}

Require-Command "node" "Install Node.js and try again."
Require-Command "npm.cmd" "Check that npm is available in the Node.js environment."
Require-Command "cargo" "Install Rust via rustup and try again."

Write-Host "[INFO] OpenRGB SDK Server readiness is managed automatically by Companion." -ForegroundColor DarkGray

if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot "node_modules"))) {
    Write-Host "Installing npm dependencies..." -ForegroundColor Cyan
    & npm.cmd install
}

Write-Host "Starting Tauri dev..." -ForegroundColor Cyan
& npm.cmd run tauri dev
