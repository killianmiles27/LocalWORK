# Fetches the pinned officecli binary into vendor\ and verifies its SHA-256 from vendor\manifest.json.
# aionrs 0.2.11 is built from source (cargo build --release -p aion-cli at tag v0.2.11); copy the exe into vendor\.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$m = Get-Content "$root\vendor\manifest.json" | ConvertFrom-Json
$o = $m.officecli
$url = "https://github.com/iOfficeAI/OfficeCLI/releases/download/v$($o.version)/officecli-win-x64.exe"
$dst = "$root\vendor\officecli.exe"
Invoke-WebRequest $url -OutFile $dst
if ((Get-FileHash $dst -Algorithm SHA256).Hash.ToLower() -ne $o.sha256) { Remove-Item $dst; throw 'officecli checksum mismatch' }
Write-Host 'officecli ok'
