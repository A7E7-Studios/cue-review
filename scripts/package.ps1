$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
& node scripts/package.mjs @args
exit $LASTEXITCODE
