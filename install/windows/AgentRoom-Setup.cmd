@echo off
setlocal

where pwsh >nul 2>nul
if errorlevel 1 (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0AgentRoom-Setup.ps1" %*
) else (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0AgentRoom-Setup.ps1" %*
)

set EXIT_CODE=%errorlevel%

echo.
if not "%EXIT_CODE%"=="0" (
    echo Agent Room setup finished with errors. Exit code: %EXIT_CODE%
) else (
    echo Agent Room setup completed successfully.
)

echo.
pause
exit /b %EXIT_CODE%
