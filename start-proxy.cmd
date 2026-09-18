@echo off
REM cline-proxy launcher (Windows)
REM Env: PROXY_PORT, PROXY_API_KEY, CLINE_PROVIDERS_PATH, ...
setlocal
if "%PROXY_PORT%"=="" set PROXY_PORT=8787
echo Starting cline-proxy on http://127.0.0.1:%PROXY_PORT%/v1 ...
node "%~dp0proxy.mjs"
