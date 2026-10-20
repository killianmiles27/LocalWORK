# Build the pinned agent with LocalWORK's small, reviewable compaction patch.
[CmdletBinding()]
param([string]$SourceDirectory)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$revision = '8e61a90329fa9f67c4fdf7e97fe02c24dba33f75'
$patch = Join-Path $repo 'patches\aionrs-localwork.patch'
if (-not $SourceDirectory) {
    $SourceDirectory = Join-Path (Split-Path -Parent $repo) ('.agent-build\aionrs-' + [guid]::NewGuid().ToString('N'))
}
if (-not (Test-Path -LiteralPath $SourceDirectory)) {
    git clone --depth 1 --branch v0.2.11 https://github.com/iOfficeAI/aionrs.git $SourceDirectory
    if ($LASTEXITCODE) { throw 'Agent source clone failed.' }
}
Push-Location $SourceDirectory
try {
    if ((git rev-parse HEAD) -ne $revision) { throw 'Agent source is not the pinned revision.' }
    if (git status --porcelain) { throw 'Use a clean checkout; existing edits will not be overwritten.' }
    git apply --check $patch
    if ($LASTEXITCODE) { throw 'Agent patch does not apply.' }
    git apply $patch
    if ($LASTEXITCODE) { throw 'Agent patch failed.' }
    cargo test --locked -p aion-agent --lib compact::
    if ($LASTEXITCODE) { throw 'Compaction regression tests failed.' }
    cargo test --locked -p aion-agent --lib native_
    if ($LASTEXITCODE) { throw 'Native agent transaction tests failed.' }
    cargo test --locked -p aion-providers native_compaction
    if ($LASTEXITCODE) { throw 'Native provider compaction tests failed.' }
    cargo test --locked -p aion-agent --test autocompact_test
    if ($LASTEXITCODE) { throw 'Automatic compaction integration tests failed.' }
    cargo test --locked -p aion-mcp --lib
    if ($LASTEXITCODE) { throw 'MCP tool-error propagation tests failed.' }
    cargo build --locked --release -p aion-cli
    if ($LASTEXITCODE) { throw 'Agent release build failed.' }
    $built = Join-Path (Get-Location).Path 'target\release\aionrs.exe'
    Copy-Item -LiteralPath $built -Destination (Join-Path $repo 'vendor\aionrs.exe') -Force
    $manifestPath = Join-Path $repo 'vendor\manifest.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $manifest.aionrs.source = 'https://github.com/iOfficeAI/aionrs at ' + $revision + '; scripts/build-agent.ps1'
    $manifest.aionrs.sha256 = (Get-FileHash -LiteralPath $built -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifest.aionrs | Add-Member -Force -NotePropertyName patch -NotePropertyValue 'patches/aionrs-localwork.patch'
    $manifest.aionrs | Add-Member -Force -NotePropertyName patch_sha256 -NotePropertyValue (Get-FileHash -LiteralPath $patch -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $manifestPath -Encoding utf8
} finally { Pop-Location }
