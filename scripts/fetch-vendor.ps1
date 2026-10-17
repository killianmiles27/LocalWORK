# Install pinned Windows x64 runtime tools from vendor/manifest.json.
# Existing files are reused only after their pinned hashes or package versions pass.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$vendor = Join-Path $root 'vendor'
$manifestPath = Join-Path $vendor 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Vendor manifest missing: $manifestPath" }
$m = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$tempRoot = [System.IO.Path]::GetTempPath()

function Get-Hash([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-VerifiedFile([string]$Path, [string]$Url, [string]$ExpectedHash, [string]$Label) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        if ((Get-Hash $Path) -eq $ExpectedHash.ToLowerInvariant()) {
            Write-Host "$Label already present and checksum verified"
            return $false
        }
        Write-Host "$Label exists but does not match its pinned checksum; downloading a verified replacement"
    }
    $download = Join-Path $tempRoot ("localwork-" + [guid]::NewGuid().ToString('N') + '.download')
    try {
        Invoke-WebRequest -Uri $Url -OutFile $download
        if ((Get-Hash $download) -ne $ExpectedHash.ToLowerInvariant()) { throw "$Label checksum mismatch; the existing destination was left untouched." }
        New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
        Copy-Item -LiteralPath $download -Destination $Path -Force
        if ((Get-Hash $Path) -ne $ExpectedHash.ToLowerInvariant()) { throw "$Label failed checksum verification after copying." }
        Write-Host "$Label installed and checksum verified"
        return $true
    } finally {
        if (Test-Path -LiteralPath $download -PathType Leaf) { Remove-Item -LiteralPath $download -Force }
    }
}

# OfficeCLI is a single pinned executable.
$office = $m.officecli
$officePath = Join-Path $vendor 'officecli.exe'
$officeUrl = "https://github.com/iOfficeAI/OfficeCLI/releases/download/v$($office.version)/officecli-win-x64.exe"
[void](Get-VerifiedFile $officePath $officeUrl $office.sha256 'OfficeCLI')

# Whisper archive and model are separate checksummed downloads. The archive is unpacked to a
# private staging directory and only copied into vendor after the expected executable is found.
$w = $m.whisper
$wd = Join-Path $vendor 'whisper'
$model = $m.whisperModel
$modelPath = Join-Path $wd $model.file
$modelOkay = (Test-Path -LiteralPath $modelPath -PathType Leaf) -and ((Get-Hash $modelPath) -eq $model.sha256.ToLowerInvariant())
$whisperExe = Join-Path $wd 'whisper-cli.exe'
if ($modelOkay -and (Test-Path -LiteralPath $whisperExe -PathType Leaf)) {
    Write-Host 'Whisper binary and model already present; skipping the large downloads'
} else {
    $zipPath = Join-Path $tempRoot ("localwork-whisper-" + [guid]::NewGuid().ToString('N') + '.zip')
    $stage = Join-Path $tempRoot ("localwork-whisper-stage-" + [guid]::NewGuid().ToString('N'))
    try {
        $url = "https://github.com/ggml-org/whisper.cpp/releases/download/$($w.version)/whisper-bin-x64.zip"
        Invoke-WebRequest -Uri $url -OutFile $zipPath
        if ((Get-Hash $zipPath) -ne $w.sha256.ToLowerInvariant()) { throw 'Whisper archive checksum mismatch; vendor files were left untouched.' }
        Expand-Archive -LiteralPath $zipPath -DestinationPath $stage
        $sourceExe = Get-ChildItem -LiteralPath $stage -Recurse -File -Filter 'whisper-cli.exe' | Select-Object -First 1
        if (-not $sourceExe) { throw 'Verified Whisper archive did not contain whisper-cli.exe.' }
        New-Item -ItemType Directory -Path $wd -Force | Out-Null
        $releaseRoot = $sourceExe.Directory.FullName
        Get-ChildItem -LiteralPath $releaseRoot -File | Copy-Item -Destination $wd -Force
        if (-not (Test-Path -LiteralPath $whisperExe -PathType Leaf)) { throw 'Whisper executable copy did not complete.' }
        Write-Host 'Whisper executable installed from the verified archive'
    } finally {
        if (Test-Path -LiteralPath $zipPath -PathType Leaf) { Remove-Item -LiteralPath $zipPath -Force }
        if (Test-Path -LiteralPath $stage -PathType Container) {
            $resolvedStage = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $stage).Path)
            $resolvedTemp = [System.IO.Path]::GetFullPath($tempRoot)
            if (-not $resolvedStage.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Split-Path -Leaf $resolvedStage).StartsWith('localwork-whisper-stage-')) { throw 'Refusing to clean an unexpected Whisper staging directory.' }
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force
        }
    }
}
if (-not (Test-Path -LiteralPath $modelPath -PathType Leaf) -or (Get-Hash $modelPath) -ne $model.sha256.ToLowerInvariant()) {
    $modelUrl = $model.source
    [void](Get-VerifiedFile $modelPath $modelUrl $model.sha256 'Whisper model')
}

# Node archive checksum is pinned to the same release/version as the executable SHA in the manifest.
# This archive SHA is published in Node.js' official v24.22.0 release notes.
$node = $m.node
$nodeRoot = Join-Path $vendor 'node'
$nodePath = Join-Path $nodeRoot 'node.exe'
$nodeLicense = Join-Path $nodeRoot 'LICENSE'
$nodeVersion = [string]$node.version
$nodeArchiveHash = 'f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3'
if ($nodeVersion -ne '24.22.0') { throw 'The pinned Node.js archive checksum in fetch-vendor.ps1 must be reviewed when changing vendor/manifest.json node.version.' }
$nodeValid = (Test-Path -LiteralPath $nodePath -PathType Leaf) -and ((Get-Hash $nodePath) -eq $node.sha256.ToLowerInvariant())
if ($nodeValid -and (Test-Path -LiteralPath $nodeLicense -PathType Leaf)) {
    Write-Host "Node.js $nodeVersion already present and checksum verified"
} else {
    $zipPath = Join-Path $tempRoot ("localwork-node-" + [guid]::NewGuid().ToString('N') + '.zip')
    $stage = Join-Path $tempRoot ("localwork-node-stage-" + [guid]::NewGuid().ToString('N'))
    try {
        $url = "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip"
        Invoke-WebRequest -Uri $url -OutFile $zipPath
        if ((Get-Hash $zipPath) -ne $nodeArchiveHash) { throw 'Node.js archive checksum mismatch; the existing Node installation was left untouched.' }
        Expand-Archive -LiteralPath $zipPath -DestinationPath $stage
        $sourceRoot = Join-Path $stage "node-v$nodeVersion-win-x64"
        $sourceNode = Join-Path $sourceRoot 'node.exe'
        $sourceLicense = Join-Path $sourceRoot 'LICENSE'
        if (-not (Test-Path -LiteralPath $sourceNode -PathType Leaf) -or -not (Test-Path -LiteralPath $sourceLicense -PathType Leaf)) { throw 'Verified Node.js archive is missing node.exe or LICENSE.' }
        if ((Get-Hash $sourceNode) -ne $node.sha256.ToLowerInvariant()) { throw 'Node.js executable does not match the hash in vendor/manifest.json.' }
        New-Item -ItemType Directory -Path $nodeRoot -Force | Out-Null
        Copy-Item -LiteralPath $sourceNode -Destination $nodePath -Force
        Copy-Item -LiteralPath $sourceLicense -Destination $nodeLicense -Force
    } finally {
        if (Test-Path -LiteralPath $zipPath -PathType Leaf) { Remove-Item -LiteralPath $zipPath -Force }
        if (Test-Path -LiteralPath $stage -PathType Container) {
            $resolvedStage = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $stage).Path)
            $resolvedTemp = [System.IO.Path]::GetFullPath($tempRoot)
            if (-not $resolvedStage.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Split-Path -Leaf $resolvedStage).StartsWith('localwork-node-stage-')) { throw 'Refusing to clean an unexpected Node staging directory.' }
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force
        }
    }
}
if ((Get-Hash $nodePath) -ne $node.sha256.ToLowerInvariant()) { throw 'Installed Node.js executable does not match vendor/manifest.json.' }
$nodeCheck = & $nodePath --version
if ($LASTEXITCODE -ne 0 -or $nodeCheck -ne "v$nodeVersion") { throw "Vendored Node.js failed its version check (exit $LASTEXITCODE; output '$nodeCheck')." }

# The npm dependency graph is locked and integrity-pinned in scripts/vendor-browser. Use the
# installed npm entry point with the verified vendored Node first on PATH; preserve the caller's env.
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm -or $npm.CommandType -notin @('Application', 'ExternalScript')) {
    throw 'npm was not found. Install Node.js with npm, reopen PowerShell, and rerun this script.'
}
$pw = Join-Path $vendor 'playwright'
$lockDir = Join-Path $root 'scripts\vendor-browser'
New-Item -ItemType Directory -Path $pw -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $lockDir 'package.json') -Destination (Join-Path $pw 'package.json') -Force
Copy-Item -LiteralPath (Join-Path $lockDir 'package-lock.json') -Destination (Join-Path $pw 'package-lock.json') -Force
$lockData = Get-Content -LiteralPath (Join-Path $lockDir 'package-lock.json') -Raw | ConvertFrom-Json -AsHashtable
$expectedCli = $lockData.packages['node_modules/@playwright/cli'].version
$expectedCore = $lockData.packages['node_modules/playwright-core'].version
$cliPackage = Join-Path $pw 'node_modules\@playwright\cli\package.json'
$corePackage = Join-Path $pw 'node_modules\playwright-core\package.json'
$nodeModulesOkay = $false
if ((Test-Path -LiteralPath $cliPackage -PathType Leaf) -and (Test-Path -LiteralPath $corePackage -PathType Leaf)) {
    $nodeModulesOkay = ((Get-Content -LiteralPath $cliPackage -Raw | ConvertFrom-Json).version -eq $expectedCli) -and ((Get-Content -LiteralPath $corePackage -Raw | ConvertFrom-Json).version -eq $expectedCore)
}
$oldPath = $env:PATH
$oldBrowsersPath = $env:PLAYWRIGHT_BROWSERS_PATH
try {
    $env:PATH = "$nodeRoot;$oldPath"
    $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $vendor 'browsers'
    if (-not $nodeModulesOkay) {
        Push-Location $pw
        try {
            & $npm.Source ci --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE). Check network access and the npm installation." }
        } finally { Pop-Location }
    } else {
        Write-Host 'Locked Playwright packages already installed; skipping npm download'
    }
    $browserExecutable = Join-Path $env:PLAYWRIGHT_BROWSERS_PATH "$($m.chromium.version)\chrome-headless-shell-win64\chrome-headless-shell.exe"
    if (-not (Test-Path -LiteralPath $browserExecutable -PathType Leaf)) {
        $cli = Join-Path $pw 'node_modules\playwright-core\cli.js'
        & $nodePath $cli install chromium-headless-shell
        if ($LASTEXITCODE -ne 0) { throw "Playwright browser installation failed (exit $LASTEXITCODE). Check network access and available disk space." }
    } else {
        Write-Host 'Headless Chromium already present; skipping browser download'
    }
    if (-not (Test-Path -LiteralPath $browserExecutable -PathType Leaf)) { throw "Playwright did not install the expected browser at $browserExecutable" }
    $browserVersion = & $browserExecutable --version
    if ($LASTEXITCODE -ne 0) { throw "Headless Chromium failed its executable check (exit $LASTEXITCODE)." }
    Write-Host "Browser runtime verified: $browserVersion"
} finally {
    $env:PATH = $oldPath
    if ($null -eq $oldBrowsersPath) { Remove-Item Env:PLAYWRIGHT_BROWSERS_PATH -ErrorAction SilentlyContinue } else { $env:PLAYWRIGHT_BROWSERS_PATH = $oldBrowsersPath }
}
Write-Host 'Pinned vendor setup verified'
