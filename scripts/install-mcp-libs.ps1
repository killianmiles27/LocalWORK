# Installs the web tool libraries for the workbench MCP server into workbench-mcp\libs (self-contained, does not touch the model environment).
param([string]$Python,
      [string]$Dest = (Join-Path $PSScriptRoot '..\workbench-mcp\libs'))
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not $Python) {
    $strataRoot = $env:LOCALWORK_STRATA_ROOT
    if (-not $strataRoot) { $strataRoot = Join-Path (Split-Path -Parent $repo) 'strata' }
    $Python = Join-Path $strataRoot '.venv\Scripts\python.exe'
}
if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
    throw "Strata's Python was not found at '$Python'. Set LOCALWORK_STRATA_ROOT or pass -Python with the full path to Strata's .venv\Scripts\python.exe. Install Strata and run SETUP.bat first."
}
New-Item -ItemType Directory -Path $Dest -Force | Out-Null
$requirements = Join-Path $repo 'workbench-mcp\requirements-web.txt'
if (-not (Test-Path -LiteralPath $requirements -PathType Leaf)) { throw "Pinned web dependency list is missing: $requirements" }

function Get-PinMismatches([string]$Target, [string]$RequirementsFile) {
    $expected = @{}
    foreach ($line in Get-Content -LiteralPath $RequirementsFile) {
        if ($line -match '^\s*([^#\s][^=<>!~;\s]*)==([^;\s]+)\s*$') {
            $name = $matches[1].ToLowerInvariant() -replace '[_.]', '-'
            $expected[$name] = $matches[2]
        }
    }
    $installed = @{}
    foreach ($metadata in Get-ChildItem -LiteralPath $Target -Directory -Filter '*.dist-info' -ErrorAction SilentlyContinue) {
        $file = Join-Path $metadata.FullName 'METADATA'
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
        $nameLine = Select-String -LiteralPath $file -Pattern '^Name: (.+)$' | Select-Object -First 1
        $versionLine = Select-String -LiteralPath $file -Pattern '^Version: (.+)$' | Select-Object -First 1
        if ($nameLine -and $versionLine) {
            $name = $nameLine.Matches.Groups[1].Value.ToLowerInvariant() -replace '[_.]', '-'
            $installed[$name] = $versionLine.Matches.Groups[1].Value
        }
    }
    return @($expected.Keys | Where-Object { $installed[$_] -ne $expected[$_] } | ForEach-Object {
        $found = if ($installed[$_]) { $installed[$_] } else { 'missing' }
        "$_ expected $($expected[$_]), found $found"
    })
}

$mismatches = Get-PinMismatches -Target $Dest -RequirementsFile $requirements
if ($mismatches.Count -gt 0) {
    & $Python -m pip install --disable-pip-version-check --no-input --upgrade --requirement $requirements --target $Dest
    if ($LASTEXITCODE -ne 0) { throw "Installing the pinned web dependencies failed (pip exit $LASTEXITCODE). Check network access and Python's pip installation." }
    $mismatches = Get-PinMismatches -Target $Dest -RequirementsFile $requirements
}
if ($mismatches.Count -gt 0) { throw "Web dependency pins do not match the installed libraries: $($mismatches -join '; '). Review $requirements and the target directory." }
Write-Host "Web tool dependencies installed to $((Resolve-Path $Dest).Path)"
