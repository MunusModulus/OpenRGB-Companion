@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Build-Release.ps1" %*
if errorlevel 1 (
  echo.
  echo [NG] Release build failed.
  pause
  exit /b 1
)
echo.
echo [PASS] Release build completed.
pause
