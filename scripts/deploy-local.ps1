<# Copies a verified local build and its source resources to the existing local app.
   Keeps a recoverable backup; never touches app data, model files, vendor binaries or Git. #>
[CmdletBinding()]
param([string]$Destination = 'C:\Random\LocalWORK')
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$destinationRoot = (Resolve-Path -LiteralPath $Destination).Path
$builtExe = Join-Path $repo 'src-tauri\target\release\localwork.exe'
$installedExe = Join-Path $destinationRoot 'LocalWORK.exe'
if (-not (Test-Path -LiteralPath $builtExe -PathType Leaf)) { throw 'Build first with npx tauri build --no-bundle.' }
if (-not (Test-Path -LiteralPath $installedExe -PathType Leaf)) { throw 'Destination must be an existing LocalWORK installation.' }
if (Get-Process -Name localwork -ErrorAction SilentlyContinue) { throw 'Close LocalWORK before updating it; open sessions will not be interrupted.' }

$backupBase = Join-Path (Split-Path -Parent $repo) '.deployment-backups'
$backup = Join-Path $backupBase ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
$copies = @([pscustomobject]@{ Source = $builtExe; Relative = 'LocalWORK.exe' })
$copies += Get-ChildItem -LiteralPath (Join-Path $repo 'workbench-mcp') -Filter '*.py' -File | ForEach-Object {
    [pscustomobject]@{ Source = $_.FullName; Relative = Join-Path 'workbench-mcp' $_.Name }
}
$skillRoot = Join-Path $repo 'skills'
$copies += Get-ChildItem -LiteralPath $skillRoot -Recurse -File | ForEach-Object {
    [pscustomobject]@{ Source = $_.FullName; Relative = Join-Path 'skills' $_.FullName.Substring($skillRoot.Length + 1) }
}
$copies += @('HANDOFF.md','NOTICE.md') | ForEach-Object { [pscustomobject]@{ Source = Join-Path $repo $_; Relative = $_ } }

# Finish every backup before replacing any installed file.
foreach ($copy in $copies) {
    $installed = Join-Path $destinationRoot $copy.Relative
    if (Test-Path -LiteralPath $installed -PathType Leaf) {
        $saved = Join-Path $backup $copy.Relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $saved) -Force | Out-Null
        Copy-Item -LiteralPath $installed -Destination $saved
    }
}
foreach ($copy in $copies) {
    $installed = Join-Path $destinationRoot $copy.Relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $installed) -Force | Out-Null
    Copy-Item -LiteralPath $copy.Source -Destination $installed -Force
    if ((Get-FileHash -LiteralPath $copy.Source).Hash -ne (Get-FileHash -LiteralPath $installed).Hash) { throw "Copy verification failed: $installed. Backup: $backup" }
}
[pscustomobject]@{ Installed = $destinationRoot; VerifiedFiles = $copies.Count; Backup = $backup; Source = $repo }
