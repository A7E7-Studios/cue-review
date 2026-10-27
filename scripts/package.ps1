$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& cargo build --manifest-path src-tauri/Cargo.toml --release --bin cue --features custom-protocol --locked
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& npm.cmd run tauri -- build --config src-tauri/tauri.bundle.conf.json
exit $LASTEXITCODE
