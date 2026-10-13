# Start the proxy on Windows: the Node.js app alone (Varnish does not run on Windows).
#
#   powershell -ExecutionPolicy Bypass -File scripts\start.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\start.ps1 -Port 9000
#   $env:BASIC_AUTH = 'me:secret'; .\scripts\start.ps1
#
# Every setting in src/config.js can be given as an environment variable (see README.md).
# Stop it with Ctrl+C.
param(
  [int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 8080 }),
  [string]$ListenHost = $(if ($env:HOST) { $env:HOST } else { '0.0.0.0' })
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js 18 or newer is required: https://nodejs.org/' -ForegroundColor Red
  exit 1
}
$major = [int](& node -p "process.versions.node.split('.')[0]")
if ($major -lt 18) {
  Write-Host "Node.js 18 or newer is required, found $(& node --version)." -ForegroundColor Red
  exit 1
}

$env:PORT = "$Port"
$env:HOST = $ListenHost
$scheme = if ($env:TLS_CERT -and $env:TLS_KEY) { 'https' } else { 'http' }

Set-Location $root
Write-Host "Starting the proxy on ${ListenHost}:$Port. Open:"
& node scripts/urls.js $scheme $Port
if (-not $env:BASIC_AUTH) {
  Write-Host 'Tip: set $env:BASIC_AUTH = "user:password" before exposing this to a network.'
}
Write-Host 'If Windows Firewall asks, allow Node.js on private networks so other machines can connect.'
Write-Host ''

# Proxied URLs embed whole target URLs, hence the larger header limit.
& node --max-http-header-size=65536 server.js
exit $LASTEXITCODE
