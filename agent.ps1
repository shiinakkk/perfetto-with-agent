$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root
& node bin/perfetto-agent.mjs @args
exit $LASTEXITCODE
