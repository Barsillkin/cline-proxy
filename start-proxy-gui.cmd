@echo off
REM cline-proxy GUI launcher (Windows)
REM Starts the proxy and opens the dashboard in the default browser.
setlocal
if "%PROXY_PORT%"=="" set PROXY_PORT=8787
set URL=http://127.0.0.1:%PROXY_PORT%/gui
echo Starting cline-proxy GUI on %URL% ...
start "" /min cmd /c "node "%~dp0proxy.mjs""
REM Give the proxy a moment to bind, then open the dashboard.
timeout /t 2 /nobreak >nul
start "" %URL%
echo Proxy running at %URL% (close the minimized window to stop it).
