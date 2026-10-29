# Installs the web tool libraries for the workbench MCP server into workbench-mcp\libs (self-contained, does not touch the model environment).
# With -PythonVersions it runs on a build machine instead (no Strata needed): it installs binary wheels
# for each listed CPython version side by side, so the installer works with whichever Python the
# user's Strata uses. Example: -PythonVersions 3.12,3.13,3.11,3.14
param([string]$Python,
      [string]$Dest = (Join-Path $PSScriptRoot '..\workbench-mcp\libs'),
      [string[]]$PythonVersions)
$ErrorActionPreference = 'Stop'
# A separate `pwsh -File` process passes a comma-separated array as one string.
# Accept that documented invocation as well as native PowerShell arrays.
if ($PythonVersions) {
    $PythonVersions = @($PythonVersions | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() })
    foreach ($v in $PythonVersions) {
        if ($v -notmatch '^3\.[0-9]+$') { throw "Invalid Python version '$v'; use versions such as 3.12,3.13." }
    }
}
$repo = Split-Path -Parent $PSScriptRoot
if ($PythonVersions) {
    if (-not $Python) { $Python = (Get-Command python -ErrorAction Stop).Source }
} elseif (-not $Python) {
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

if ($PythonVersions) {
    # Each version goes into its own staging folder first: pip --target --upgrade replaces whole
    # package folders, which would delete the compiled modules of the versions installed before it.
    # Pure-Python files are identical across versions and compiled ones carry the version in their
    # names (etree.cp312-win_amd64.pyd), so merging without overwriting keeps every version working.
    $destFull = [System.IO.Path]::GetFullPath($Dest)
    foreach ($v in $PythonVersions) {
        $stage = Join-Path ([System.IO.Path]::GetTempPath()) ("localwork-libs-$v-" + [guid]::NewGuid().ToString('N'))
        try {
            & $Python -m pip install --disable-pip-version-check --no-input --only-binary=:all: --implementation cp --python-version $v --platform win_amd64 --requirement $requirements --target $stage
            if ($LASTEXITCODE -ne 0) {
                if ($v -in @('3.12', '3.13')) { throw "Web libraries for Python $v failed (pip exit $LASTEXITCODE)." }
                Write-Warning "No wheels for Python $v; skipped"
                continue
            }
            $stageFull = [System.IO.Path]::GetFullPath($stage)
            foreach ($file in Get-ChildItem -LiteralPath $stage -Recurse -File) {
                $target = Join-Path $destFull $file.FullName.Substring($stageFull.Length).TrimStart('\', '/')
                if (-not (Test-Path -LiteralPath $target)) {
                    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
                    Copy-Item -LiteralPath $file.FullName -Destination $target
                }
            }
        } finally {
            if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
        }
    }
}

$mismatches = Get-PinMismatches -Target $Dest -RequirementsFile $requirements
if ($mismatches.Count -gt 0 -and -not $PythonVersions) {
    & $Python -m pip install --disable-pip-version-check --no-input --upgrade --requirement $requirements --target $Dest
    if ($LASTEXITCODE -ne 0) { throw "Installing the pinned web dependencies failed (pip exit $LASTEXITCODE). Check network access and Python's pip installation." }
    $mismatches = Get-PinMismatches -Target $Dest -RequirementsFile $requirements
}
if ($mismatches.Count -gt 0) { throw "Web dependency pins do not match the installed libraries: $($mismatches -join '; '). Review $requirements and the target directory." }
Write-Host "Web tool dependencies installed to $((Resolve-Path $Dest).Path)"
# An optional version without wheels must not leak pip's failure status to the caller.
$global:LASTEXITCODE = 0
