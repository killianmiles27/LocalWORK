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

# Voice input: whisper.cpp CPU build (whisper-cli.exe + dlls) and the small multilingual model, into vendor\whisper.
$w = $m.whisper
$wd = "$root\vendor\whisper"
New-Item -ItemType Directory -Force $wd | Out-Null
$zip = Join-Path $env:TEMP 'whisper-bin-x64.zip'
Invoke-WebRequest "https://github.com/ggml-org/whisper.cpp/releases/download/$($w.version)/whisper-bin-x64.zip" -OutFile $zip
if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $w.sha256) { Remove-Item $zip; throw 'whisper checksum mismatch' }
Expand-Archive $zip -DestinationPath $wd -Force
$tmp = Get-ChildItem "$wd\Release" -ErrorAction SilentlyContinue
if ($tmp) { Move-Item "$wd\Release\*" $wd -Force; Remove-Item "$wd\Release" }
Remove-Item $zip
$mm = $m.whisperModel
$mdst = "$wd\$($mm.file)"
Invoke-WebRequest $mm.source -OutFile $mdst
if ((Get-FileHash $mdst -Algorithm SHA256).Hash.ToLower() -ne $mm.sha256) { Remove-Item $mdst; throw 'whisper model checksum mismatch' }
Write-Host 'whisper ok'
