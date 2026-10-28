param(
  [int]$Port = 19400,
  [string]$UiDir = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node) {
  throw "Node.js 22+ is required. Install Node.js and rerun this script."
}
$NodeVersion = [int](node -p "process.versions.node.split('.')[0]")
if ($NodeVersion -lt 22) {
  throw "Node.js 22+ is required; the current executable is $(node --version)."
}
if (-not (Test-Path (Join-Path $Root "node_modules/ws"))) {
  throw "Dependencies are missing. Run 'npm install' in $Root."
}
if (-not $UiDir) {
  $UiDir = Join-Path $Root "ui-dist"
}
if (-not (Test-Path (Join-Path $UiDir "index.html"))) {
  throw "The local Perfetto UI has not been built. Run 'npm run build' first, or pass -UiDir <path>."
}

Write-Host "Starting local-only Perfetto on http://127.0.0.1:$Port/" -ForegroundColor Green
Write-Host "Open a trace through the file picker, then use the Agent collaboration panel."
node server/index.mjs --host 127.0.0.1 --port $Port --ui $UiDir
