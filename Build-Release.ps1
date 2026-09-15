param(
    [string]$OutputDir = ""
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

$Version = "0.11.15"
$ExeName = "openrgb-companion.exe"

function Require-Command([string]$Name, [string]$Hint) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name が見つかりません。$Hint"
    }
    Write-Host "[OK] $Name" -ForegroundColor Green
}

Write-Host "=== OpenRGB Companion v$Version - Release Build ===" -ForegroundColor Cyan
Require-Command "node" "Node.js をインストールしてください。"
Require-Command "npm.cmd" "Node.js / npm のPATHを確認してください。"
Require-Command "cargo" "Rust (rustup) をインストールしてください。"

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $PSScriptRoot "release-out\v$Version"
}

if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot "node_modules"))) {
    Write-Host "[INFO] node_modules が無いため npm install を実行します。" -ForegroundColor Yellow
    & npm.cmd install
    if ($LASTEXITCODE -ne 0) {
        throw "npm install に失敗しました (exit $LASTEXITCODE)。"
    }
}

Write-Host "[INFO] NSIS Release installer をビルドします。" -ForegroundColor Cyan
Write-Host "       初回はRust crate / NSIS関連ファイルの取得で時間がかかる場合があります。" -ForegroundColor DarkGray
& npm.cmd run tauri build -- --bundles nsis
if ($LASTEXITCODE -ne 0) {
    throw "Tauri Release build に失敗しました (exit $LASTEXITCODE)。"
}

$TargetRoot = Join-Path $PSScriptRoot "src-tauri\target\release"
$StandaloneExe = Join-Path $TargetRoot $ExeName
$NsisDir = Join-Path $TargetRoot "bundle\nsis"

if (-not (Test-Path -LiteralPath $StandaloneExe)) {
    throw "Release EXE が見つかりません: $StandaloneExe"
}
if (-not (Test-Path -LiteralPath $NsisDir)) {
    throw "NSIS出力フォルダが見つかりません: $NsisDir"
}

$Installer = Get-ChildItem -LiteralPath $NsisDir -File -Filter "*.exe" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if ($null -eq $Installer) {
    throw "NSIS installer が見つかりません: $NsisDir"
}

if (Test-Path -LiteralPath $OutputDir) {
    Remove-Item -LiteralPath $OutputDir -Recurse -Force
}
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

$CopiedExe = Join-Path $OutputDir "OpenRGB Companion.exe"
$CopiedInstaller = Join-Path $OutputDir $Installer.Name
Copy-Item -LiteralPath $StandaloneExe -Destination $CopiedExe -Force
Copy-Item -LiteralPath $Installer.FullName -Destination $CopiedInstaller -Force

$BuildInfo = @"
OpenRGB Companion v$Version
Build time: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")

Standalone EXE:
$CopiedExe

NSIS installer:
$CopiedInstaller

Release test order:
1. OpenRGB と開発版 Companion を終了
2. NSIS installer でインストール
3. Start Menu / shortcut から OpenRGB Companion を起動
4. PowerShell / Vite / npm のウィンドウが出ないことを確認
5. OpenRGB が必要時のみ --gui --server --startminimized で自動起動することを確認
6. Connected / controller / zone 数を確認
7. Profile表示・ライブ反映・保存を1件確認
8. Scheduler Plugin導入済み環境ではScheduler設定と実発火を確認
"@
$BuildInfo | Set-Content -LiteralPath (Join-Path $OutputDir "BUILD-INFO.txt") -Encoding UTF8

Write-Host "" 
Write-Host "[PASS] Release build completed." -ForegroundColor Green
Write-Host "Output: $OutputDir" -ForegroundColor Cyan
Write-Host "Installer: $CopiedInstaller" -ForegroundColor Cyan
Write-Host "Standalone: $CopiedExe" -ForegroundColor Cyan
