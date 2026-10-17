# Fetches the pinned officecli binary into vendor\ and verifies its SHA-256 from vendor\manifest.json.
# Build the pinned, patched aionrs separately with scripts/build-agent.ps1.
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
# Browser tool: portable Node, @playwright/cli and the headless Chromium shell (the smallest build).
$nd = "$root\vendor\node"; New-Item -ItemType Directory -Force $nd | Out-Null
if (-not (Test-Path "$nd\node.exe")) {
  $v = $m.node.version; $zip = "$env:TEMP\node-$v.zip"
  Invoke-WebRequest "https://nodejs.org/dist/v$v/node-v$v-win-x64.zip" -OutFile $zip -UseBasicParsing
  Expand-Archive $zip "$env:TEMP\node-$v" -Force
  Copy-Item "$env:TEMP\node-$v\node-v$v-win-x64\node.exe", "$env:TEMP\node-$v\node-v$v-win-x64\LICENSE" $nd
}
if ((Get-FileHash "$nd\node.exe" -Algorithm SHA256).Hash.ToLower() -ne $m.node.sha256) { throw 'node checksum mismatch' }
$pw = "$root\vendor\playwright"; New-Item -ItemType Directory -Force $pw | Out-Null
Set-Content "$pw\package.json" ('{"name":"pw-vendor","private":true,"dependencies":{"@playwright/cli":"' + $m.'playwright-cli'.version + '"}}')
$env:PLAYWRIGHT_BROWSERS_PATH = "$root\vendor\browsers"
$env:PATH = "$nd;$env:PATH"
$npm = (Get-ChildItem "$env:TEMP\node-$($m.node.version)\node-v$($m.node.version)-win-x64" -Filter npm.cmd -ErrorAction SilentlyContinue | Select-Object -First 1)
Push-Location $pw
try {
  & "$env:TEMP\node-$($m.node.version)\node-v$($m.node.version)-win-x64\npm.cmd" install --no-audit --no-fund
  & "$nd\node.exe" "$pw\node_modules\playwright-core\cli.js" install chromium-headless-shell
} finally { Pop-Location }
Write-Host 'browser ok'
