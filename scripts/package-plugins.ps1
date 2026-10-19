<# Packages the official plugins (a checkout of github.com/killianmiles27/LocalWORK-plugins, by default
   ..\LocalWORK-plugins next to this repository) for a release:
     dist-plugins/LocalWORK-recommended-plugins_<version>.zip  every plugin, one import installs them all
     dist-plugins/<id>_<plugin version>.zip                    each plugin on its own
   Settings -> Plugins -> Import accepts any of these. Reads only the plugin checkout; writes only dist-plugins/. #>
[CmdletBinding()]
param([string[]]$Only, [string]$Source)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $repo 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version
if (-not $Source) { $Source = Join-Path (Split-Path -Parent $repo) 'LocalWORK-plugins' }
if (-not (Test-Path -LiteralPath $Source)) { throw "No plugin checkout at $Source. Clone github.com/killianmiles27/LocalWORK-plugins there or pass -Source." }
$out = Join-Path $repo 'dist-plugins'
New-Item -ItemType Directory -Path $out -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

# Windows PowerShell's CreateFromDirectory writes backslashes into entry names; zips need '/'.
function New-Zip([string]$Folder, [string]$Zip) {
    if (Test-Path -LiteralPath $Zip) { Remove-Item -LiteralPath $Zip }
    $parent = Split-Path -Parent $Folder
    $z = [IO.Compression.ZipFile]::Open($Zip, 'Create')
    try {
        Get-ChildItem -LiteralPath $Folder -Recurse -File | Sort-Object FullName | ForEach-Object {
            $name = $_.FullName.Substring($parent.Length + 1).Replace([char]92, [char]47)
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z, $_.FullName, $name, 'Optimal')
        }
    } finally { $z.Dispose() }
}

$plugins = Get-ChildItem -LiteralPath $Source -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'plugin.json') }
if ($Only) { $plugins = $plugins | Where-Object { $Only -contains $_.Name } }
if (-not $plugins) { throw 'No plugins to package.' }

$stage = Join-Path ([IO.Path]::GetTempPath()) ('lw-plugins-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$pack = Join-Path $stage 'LocalWORK-recommended-plugins'
try {
    $made = @()
    foreach ($p in $plugins) {
        $m = Get-Content -LiteralPath (Join-Path $p.FullName 'plugin.json') -Raw | ConvertFrom-Json
        if ($m.id -ne $p.Name) { throw "$($p.Name): the folder name must equal the plugin id ($($m.id))." }
        Copy-Item -LiteralPath $p.FullName -Destination (Join-Path $pack $p.Name) -Recurse
        $single = Join-Path $stage "single\$($p.Name)"
        Copy-Item -LiteralPath $p.FullName -Destination $single -Recurse
        $zip = Join-Path $out "$($m.id)_$($m.version).zip"
        New-Zip $single $zip
        $made += $zip
    }
    $packZip = Join-Path $out "LocalWORK-recommended-plugins_$version.zip"
    New-Zip $pack $packZip
    $made += $packZip
    $made | ForEach-Object { [pscustomobject]@{ File = $_; Sha256 = (Get-FileHash -LiteralPath $_).Hash.ToLowerInvariant() } }
} finally {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
