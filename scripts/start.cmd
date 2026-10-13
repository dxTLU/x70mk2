@echo off
rem Start the proxy on Windows: the Node.js app alone (Varnish does not run on Windows).
rem Double-click it, or run it from a terminal. Settings are environment variables, e.g.
rem   set BASIC_AUTH=me:secret
rem   set PORT=9000
rem Stop it with Ctrl+C.
setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required: https://nodejs.org/
  pause
  exit /b 1
)

if not defined PORT set PORT=8080
if not defined HOST set HOST=0.0.0.0
set SCHEME=http
if defined TLS_CERT if defined TLS_KEY set SCHEME=https

echo Starting the proxy on %HOST%:%PORT%. Open:
node scripts\urls.js %SCHEME% %PORT%
if not defined BASIC_AUTH echo Tip: set BASIC_AUTH=user:password before exposing this to a network.
echo If Windows Firewall asks, allow Node.js on private networks so other machines can connect.
echo.

rem Proxied URLs embed whole target URLs, hence the larger header limit.
node --max-http-header-size=65536 server.js
if errorlevel 1 pause
endlocal
