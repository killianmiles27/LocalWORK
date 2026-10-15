<#
.SYNOPSIS
  Local acceptance suite for LocalWORK (spec section 15): installer checks, lifecycle T-L1..T-L6, feasible security tests.

.DESCRIPTION
  Every run uses an isolated data directory (LOCALAPPDATA is redirected for the app under test), so the real
  %LOCALAPPDATA%\Workbench is never read or written. By default Strata is replaced by scripts\e2e\stub_strata.py
  (same HTTP contract, plus a grandchild process) so the suite takes minutes, not GPU-hours. -RealStrata uses the
  configured Strata instead (needs the GPU free).

  The app's WebView2 is started with a loopback remote-debugging port so the harness can call the app's own Tauri
  commands (model_status, model_start, create_conversation...). That one extra listener is test-only and is
  excluded from T-S3.

  Not automatable without a model or the artifact UI (reported as SKIP): T-S1 (prompt injection), T-S2 (agent write
  to C:\Windows), T-S4 (artifact sandbox), T-L7 (8 h soak), agent benchmarks B1-B9.

.PARAMETER Exe          App under test. Default: the installed one (%LOCALAPPDATA%\LocalWORK\localwork.exe).
.PARAMETER Installer    NSIS setup .exe. When given, the suite first installs it silently (per-user) and later uninstalls it.
.PARAMETER Iterations   Repeats per lifecycle test. The spec requires 10 (default).
.PARAMETER Only         Run only these test ids, e.g. -Only T-L1,T-S3
.PARAMETER RealStrata   Use the real Strata instead of the stub.
.PARAMETER KeepInstalled  With -Installer: leave the app installed afterwards.
#>
[CmdletBinding()]
param(
  [string]$Exe,
  [string]$Installer,
  [int]$Iterations = 10,
  [string[]]$Only,
  [switch]$RealStrata,
  [switch]$KeepInstalled
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$work = Join-Path $env:TEMP ("lw-e2e-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $work | Out-Null
$results = New-Object System.Collections.ArrayList
$consoleHits = New-Object System.Collections.ArrayList
$cdpPort = 9333

Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class Win {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  // Returns "pid|class|visible" for every top-level window.
  public static List<string> All() {
    var l = new List<string>();
    EnumWindows((h, p) => { uint pid; GetWindowThreadProcessId(h, out pid); var sb = new StringBuilder(256);
      GetClassName(h, sb, 256); l.Add(pid + "|" + sb + "|" + (IsWindowVisible(h) ? 1 : 0)); return true; }, IntPtr.Zero);
    return l;
  }
}
"@

# ---------------------------------------------------------------- helpers
function Record($id, $name, $status, $detail) {
  [void]$results.Add([pscustomobject]@{ Id = $id; Test = $name; Status = $status; Detail = $detail })
  $c = @{ PASS = 'Green'; FAIL = 'Red'; SKIP = 'Yellow' }[$status]
  Write-Host ("[{0}] {1} {2} - {3}" -f $status, $id, $name, $detail) -ForegroundColor $c
}
function Wanted($id) { return (-not $Only) -or ($Only -contains $id) }

function All-Procs { Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CreationDate, ExecutablePath, CommandLine }

# Everything that belongs to the app: descendants of the root pid, plus anything running from the install dir or stub root.
function Get-Tree([int]$rootPid) {
  $all = All-Procs
  $set = @{}
  if ($rootPid) { $set[$rootPid] = $true }
  $grew = $true
  while ($grew) {
    $grew = $false
    foreach ($p in $all) {
      if ($set.ContainsKey([int]$p.ParentProcessId) -and -not $set.ContainsKey([int]$p.ProcessId)) { $set[[int]$p.ProcessId] = $true; $grew = $true }
    }
  }
  $inst = Split-Path -Parent $script:ExePath
  $out = foreach ($p in $all) {
    $byPath = $p.ExecutablePath -and ($p.ExecutablePath -like ($inst + '\*') -or ($script:StubRoot -and $p.ExecutablePath -like ($script:StubRoot + '\*')))
    $byCmd = $p.CommandLine -and $script:StubRoot -and ($p.CommandLine -like ('*' + $script:StubRoot + '*'))
    if ($set.ContainsKey([int]$p.ProcessId) -or $byPath -or $byCmd) { $p }
  }
  return @($out)
}
function Is-Alive($rec) {
  $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $rec.ProcessId) -ErrorAction SilentlyContinue
  return ($p -and $p.CreationDate -eq $rec.CreationDate)
}
function Survivors($snapshot) { return @($snapshot | Where-Object { Is-Alive $_ }) }
function Wait-Gone($snapshot, [double]$seconds) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  do {
    $left = Survivors $snapshot
    Check-Consoles $snapshot
    if ($left.Count -eq 0) { return @{ Ok = $true; Secs = $sw.Elapsed.TotalSeconds; Left = @() } }
    Start-Sleep -Milliseconds 200
  } while ($sw.Elapsed.TotalSeconds -lt $seconds)
  return @{ Ok = $false; Secs = $sw.Elapsed.TotalSeconds; Left = (Survivors $snapshot) }
}

# T-L5: a visible console-class window, or any visible window of a console/tool process, owned by an app process.
function Check-Consoles($snapshot) {
  $pids = @{}; $names = @{}
  foreach ($p in $snapshot) { $pids[[int]$p.ProcessId] = $true; $names[[int]$p.ProcessId] = $p.Name }
  foreach ($w in [Win]::All()) {
    $f = $w.Split('|'); $wp = [int]$f[0]
    if (-not $pids.ContainsKey($wp) -or $f[2] -ne '1') { continue }
    $n = $names[$wp]
    if ($f[1] -match 'ConsoleWindowClass|CASCADIA' -or $n -match '^(python|pythonw|node|aionrs|officecli|cmd|conhost|powershell|pwsh|OpenConsole)\.exe$') {
      [void]$consoleHits.Add("$n pid $wp class $($f[1])")
    }
  }
}

function New-Env {
  # Fresh isolated data dir + settings pointing at the stub (or real Strata).
  $script:DataRoot = Join-Path $work ("data-" + [guid]::NewGuid().ToString('N').Substring(0, 6))
  $script:WbDir = Join-Path $script:DataRoot 'Workbench'
  New-Item -ItemType Directory -Force (Join-Path $script:WbDir 'logs') | Out-Null
  if (-not $RealStrata) { Set-Settings $script:GoodCfg }
}
function Set-Settings($cfgPath) {
  $s = @{ strataRoot = $script:StubRoot; modelConfig = $cfgPath } | ConvertTo-Json
  [IO.File]::WriteAllText((Join-Path $script:WbDir 'settings.json'), $s)
}

function Start-App {
  $saved = @{ L = $env:LOCALAPPDATA; W = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS; K = $env:E2E_KEY_OUT }
  $env:LOCALAPPDATA = $script:DataRoot
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$cdpPort --remote-allow-origins=*"
  $script:KeyFile = Join-Path $script:DataRoot 'key.txt'
  $env:E2E_KEY_OUT = $script:KeyFile
  try { return Start-Process -FilePath $script:ExePath -PassThru } finally {
    $env:LOCALAPPDATA = $saved.L; $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $saved.W; $env:E2E_KEY_OUT = $saved.K
  }
}

# --- minimal Chrome-DevTools client: lets the harness call the app's own Tauri commands.
function Cdp-Eval([string]$expr, [int]$timeoutSec = 15) {
  $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$cdpPort/json/list" -TimeoutSec 3
  $page = $targets | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
  if (-not $page) { throw 'no webview page' }
  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $cts = New-Object System.Threading.CancellationTokenSource ($timeoutSec * 1000)
  try {
    $ws.ConnectAsync([uri]$page.webSocketDebuggerUrl, $cts.Token).Wait()
    $msg = @{ id = 1; method = 'Runtime.evaluate'; params = @{ expression = $expr; awaitPromise = $true; returnByValue = $true } } | ConvertTo-Json -Depth 6 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($msg)
    $ws.SendAsync([ArraySegment[byte]]$bytes, 'Text', $true, $cts.Token).Wait()
    $buf = New-Object byte[] 65536; $sb = New-Object Text.StringBuilder
    do {
      $r = $ws.ReceiveAsync([ArraySegment[byte]]$buf, $cts.Token); $r.Wait()
      [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $r.Result.Count))
    } until ($r.Result.EndOfMessage)
    $o = $sb.ToString() | ConvertFrom-Json
    if ($o.result.exceptionDetails) { return @{ Error = $o.result.exceptionDetails.exception.description } }
    return @{ Value = $o.result.result.value }
  } finally { $ws.Dispose() }
}
function Invoke-Cmd([string]$cmd, [string]$argsJson = '{}') {
  $e = "window.__TAURI_INTERNALS__.invoke('$cmd', $argsJson).then(v=>({ok:v}),e=>({err:String(e)}))"
  $r = Cdp-Eval $e
  if ($r.Error) { return @{ err = $r.Error } }
  return $r.Value
}
function Model-State { try { $v = Invoke-Cmd 'model_status'; if ($v.ok) { return $v.ok } } catch {} return $null }
function Wait-Model([string]$state, [int]$timeoutSec) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
    $m = Model-State
    if ($m -and $m.state -eq $state) { return $m }
    Start-Sleep -Milliseconds 400
  }
  return $null
}
function Wait-Ready([System.Diagnostics.Process]$proc) {
  $limit = if ($RealStrata) { 420 } else { 45 }
  $m = Wait-Model 'ready' $limit
  if ($m) { Check-Consoles (Get-Tree $proc.Id) }
  return $m
}
function Stop-AppHard($proc) {
  if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}
function Cleanup-All {
  # Safety net between iterations: nothing from the test run may survive.
  foreach ($r in (Get-Tree 0)) { Stop-Process -Id $r.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 300
}
function App-Procs { @(Get-Process -Name localwork -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $script:ExePath }) }

function Count-Strata { @(All-Procs | Where-Object { $_.CommandLine -and $_.CommandLine -like '*stub_strata.py*' -and $_.CommandLine -like '*--engine*' -and $_.Name -eq 'python.exe' }) }

function Repeat-Test($id, $name, [scriptblock]$body) {
  if (-not (Wanted $id)) { return }
  $fail = @(); $n = $Iterations
  for ($i = 1; $i -le $n; $i++) {
    New-Env
    try { $r = & $body $i; if ($r) { $fail += "run ${i}: $r" } } catch { $fail += "run ${i}: $($_.Exception.Message)" }
    Cleanup-All
  }
  if ($fail.Count -eq 0) { Record $id $name 'PASS' "$n/$n" } else { Record $id $name 'FAIL' ("{0}/{1}; {2}" -f ($n - $fail.Count), $n, ($fail -join ' | ')) }
}

# ---------------------------------------------------------------- installer
$installDir = Join-Path $env:LOCALAPPDATA 'LocalWORK'
$didInstall = $false
if ($Installer) {
  if (Wanted 'T-I1') {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $p = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru -Wait
    $smDirs = @((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))
    $lnk = Get-ChildItem $smDirs -Recurse -Filter 'LocalWORK*.lnk' -ErrorAction SilentlyContinue | Select-Object -First 1
    $uninstKey = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
      Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -eq 'LocalWORK' } | Select-Object -First 1
    $res = @{
      'exit code 0'         = ($p.ExitCode -eq 0)
      'exe in per-user dir' = (Test-Path (Join-Path $installDir 'localwork.exe'))
      'vendor\aionrs.exe'   = (Test-Path (Join-Path $installDir 'vendor\aionrs.exe'))
      'vendor\officecli.exe' = (Test-Path (Join-Path $installDir 'vendor\officecli.exe'))
      'workbench-mcp\server.py' = (Test-Path (Join-Path $installDir 'workbench-mcp\server.py'))
      'uninstall.exe'       = (Test-Path (Join-Path $installDir 'uninstall.exe'))
      'Start menu shortcut' = [bool]$lnk
      'HKCU uninstall entry' = [bool]$uninstKey
      'no HKLM entry'       = -not (Get-ChildItem 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
                                Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -eq 'LocalWORK' })
    }
    $bad = @($res.GetEnumerator() | Where-Object { -not $_.Value } | ForEach-Object { $_.Key })
    if ($bad.Count -eq 0) { Record 'T-I1' 'Silent per-user install (no admin, Start menu, uninstaller)' 'PASS' ("{0:n1}s, shortcut {1}" -f $sw.Elapsed.TotalSeconds, $lnk.FullName) }
    else { Record 'T-I1' 'Silent per-user install' 'FAIL' ("missing: " + ($bad -join ', ')) }
    $didInstall = $true
  }
  if (-not $Exe) { $Exe = Join-Path $installDir 'localwork.exe' }
}
if (-not $Exe) { $Exe = Join-Path $installDir 'localwork.exe' }
if (-not (Test-Path $Exe)) { throw "App not found: $Exe (install it, or pass -Exe / -Installer)" }
$script:ExePath = (Resolve-Path $Exe).Path

# ---------------------------------------------------------------- stub Strata
if (-not $RealStrata) {
  $script:StubRoot = Join-Path $work 'strata-stub'
  New-Item -ItemType Directory -Force (Join-Path $script:StubRoot 'serve') | Out-Null
  Copy-Item (Join-Path $here 'stub_strata.py') (Join-Path $script:StubRoot 'serve\server.py')
  # The stub's file name differs from the real one, so match on the root path instead (see Count-Strata/Get-Tree).
  $py = (Get-Command python -ErrorAction SilentlyContinue).Source
  if (-not $py) { $py = (Get-Command py -ErrorAction SilentlyContinue).Source }
  & $py -m venv (Join-Path $script:StubRoot '.venv')
  if ($LASTEXITCODE -ne 0) { throw 'could not create the stub venv' }
  $gguf = Join-Path $work 'model.gguf'; Set-Content $gguf 'x'
  $script:GoodCfg = Join-Path $work 'good.json'
  $script:BadCfg = Join-Path $work 'bad.json'
  (@{ model_name = 'stub-model'; args = @('--native', $gguf) } | ConvertTo-Json) | Set-Content $script:GoodCfg -Encoding ASCII
  (@{ model_name = 'stub-model'; args = @('--native', (Join-Path $work 'missing.gguf')) } | ConvertTo-Json) | Set-Content $script:BadCfg -Encoding ASCII
} else {
  $script:StubRoot = $null
  $script:GoodCfg = $null
}
function Count-Strata {
  if ($RealStrata) { return @(All-Procs | Where-Object { $_.CommandLine -like '*server.py*--engine*strata*' }) }
  return @(All-Procs | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -like '*serve\server.py*--engine*' -and $_.CommandLine -like ('*' + $script:StubRoot + '*') })
}

# The app is single-instance per identifier: a LocalWORK already running elsewhere (e.g. a dev build) would swallow every launch.
$other = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'LocalWORK' -or $_.Name -eq 'localwork' } | Where-Object { $_.Path -ne $script:ExePath })
if ($other.Count) { throw ('Another LocalWORK is running (' + (($other | ForEach-Object { $_.Path }) -join ', ') + '). Close it first: the app is single-instance.') }
Write-Host "App: $script:ExePath`nWork dir: $work`nStrata: $(if ($RealStrata) {'REAL'} else {'stub'})`n"
Cleanup-All

# ---------------------------------------------------------------- T-L1
Repeat-Test 'T-L1' 'Launch, ready, close window: nothing left within 10 s' {
  $app = Start-App
  if (-not (Wait-Ready $app)) { return 'model never became ready' }
  $tree = Get-Tree $app.Id
  if ($tree.Count -lt 3) { return "expected app + strata tree, saw $($tree.Count) processes" }
  [void]$app.CloseMainWindow()
  $g = Wait-Gone $tree 10
  if (-not $g.Ok) { return ("still alive after 10 s: " + (($g.Left | ForEach-Object { $_.Name + ':' + $_.ProcessId }) -join ',')) }
}

# ---------------------------------------------------------------- T-L2
# Spec calls for killing mid-browse during B1; without a model the stand-in is a ready app with the full
# tree (host + python launcher + engine/grandchild) killed from outside with Stop-Process -Force.
Repeat-Test 'T-L2' 'Stop-Process -Force on host: whole tree gone within 3 s' {
  $app = Start-App
  if (-not (Wait-Ready $app)) { return 'model never became ready' }
  $tree = Get-Tree $app.Id
  $kids = @($tree | Where-Object { $_.Name -match 'python' })
  if ($kids.Count -lt 3) { return "expected python launcher + base python + grandchild, saw $($kids.Count)" }
  Stop-Process -Id $app.Id -Force
  $g = Wait-Gone $tree 3
  if (-not $g.Ok) { return ("still alive after 3 s: " + (($g.Left | ForEach-Object { $_.Name + ':' + $_.ProcessId }) -join ',')) }
}

# ---------------------------------------------------------------- T-L3
Repeat-Test 'T-L3' 'Kill Strata: stopped state, Restart works, conversation intact' {
  $app = Start-App
  if (-not (Wait-Ready $app)) { return 'model never became ready' }
  $ws = Join-Path $work 'ws'; New-Item -ItemType Directory -Force $ws | Out-Null
  $c = Invoke-Cmd 'create_conversation' (@{ workspace = $ws } | ConvertTo-Json -Compress)
  if (-not $c.ok) { return "create_conversation: $($c.err)" }
  $convId = $c.ok
  $strata = Count-Strata
  if ($strata.Count -eq 0) { return 'strata process not found' }
  $tree = Get-Tree $app.Id
  foreach ($s in $strata) { & taskkill /PID $s.ProcessId /T /F | Out-Null }
  $m = Wait-Model 'error' 15
  if (-not $m) { return 'status never became error after Strata was killed' }
  if (-not $m.detail) { return 'error state without a message' }
  $r = Invoke-Cmd 'model_start'
  if ($r.err) { return "restart failed: $($r.err)" }
  if (-not (Wait-Model 'ready' 45)) { return 'model did not come back after restart' }
  $list = Invoke-Cmd 'list_conversations'
  if (-not ($list.ok | Where-Object { $_.id -eq $convId })) { return 'conversation missing after restart' }
  Check-Consoles (Get-Tree $app.Id)
  [void]$app.CloseMainWindow()
  $g = Wait-Gone $tree 10
  if (-not $g.Ok) { return 'processes left after close' }
}

# ---------------------------------------------------------------- T-L4
Repeat-Test 'T-L4' 'Launch twice quickly: one window, one Strata' {
  $a1 = Start-App
  $a2 = Start-App
  if (-not $a2.WaitForExit(10000)) { Stop-Process -Id $a2.Id -Force; return 'second launch did not exit' }
  if (-not (Wait-Ready $a1)) { return 'first instance never became ready' }
  Start-Sleep -Seconds 2
  $apps = App-Procs
  if ($apps.Count -ne 1) { return "expected 1 LocalWORK.exe, found $($apps.Count)" }
  $s = Count-Strata
  # venv launcher + real interpreter = 2 python processes per Strata; the stub's grandchild runs `-c`, so it is not counted.
  $roots = @($s | Where-Object { $ids = $s.ProcessId; -not ($ids -contains $_.ParentProcessId) })
  if ($roots.Count -ne 1) { return "expected 1 Strata, found $($roots.Count)" }
  $tree = Get-Tree $a1.Id
  [void]$a1.CloseMainWindow()
  $g = Wait-Gone $tree 10
  if (-not $g.Ok) { return 'processes left after close' }
}

# ---------------------------------------------------------------- T-L6
if (Wanted 'T-L6') {
  if ($RealStrata) { Record 'T-L6' 'Failed Strata start (bad gguf path)' 'SKIP' 'needs the stub config; run without -RealStrata' }
  else {
    Repeat-Test 'T-L6' 'Failed Strata start (bad gguf path): clear error, no leftovers, Retry works' {
      Set-Settings $script:BadCfg
      $app = Start-App
      $m = Wait-Model 'error' 45
      if (-not $m) { return 'no error state for bad gguf' }
      if ($m.detail -notmatch 'exited|not found|could not') { return "unclear error text: $($m.detail)" }
      Start-Sleep -Seconds 2
      if ((Count-Strata).Count -ne 0) { return 'Strata processes left behind after failure' }
      $left = @(Get-Tree $app.Id | Where-Object { $_.Name -match 'python|node|aionrs' })
      if ($left.Count -ne 0) { return "leftover: $(($left | % Name) -join ',')" }
      Set-Settings $script:GoodCfg
      $r = Invoke-Cmd 'model_start'
      if ($r.err) { return "retry failed: $($r.err)" }
      if (-not (Wait-Model 'ready' 45)) { return 'retry after fixing path did not become ready' }
      $tree = Get-Tree $app.Id
      [void]$app.CloseMainWindow()
      if (-not (Wait-Gone $tree 10).Ok) { return 'processes left after close' }
    }
  }
}

# ---------------------------------------------------------------- T-L5 (aggregated over everything above)
if (Wanted 'T-L5') {
  $hits = @($consoleHits | Select-Object -Unique)
  if ($hits.Count -eq 0) { Record 'T-L5' 'No console window owned by any app process (EnumWindows, sampled throughout)' 'PASS' 'none seen' }
  else { Record 'T-L5' 'No console window owned by any app process' 'FAIL' ($hits -join '; ') }
}

# ---------------------------------------------------------------- security
$secNeeded = @('T-S3', 'T-S5', 'T-S6') | Where-Object { Wanted $_ }
if ($secNeeded) {
  New-Env
  $app = Start-App
  if (-not (Wait-Ready $app)) { Record 'T-S*' 'security session' 'FAIL' 'model never became ready'; }
  else {
    $tree = Get-Tree $app.Id
    $treePids = @($tree | ForEach-Object { [int]$_.ProcessId })

    if (Wanted 'T-S3') {
      # Everything listening on loopback (or anywhere) that belongs to the app tree, minus the harness's debug port.
      $listen = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $treePids -contains $_.OwningProcess -and $_.LocalPort -ne $cdpPort })
      $ports = @($listen | Select-Object -ExpandProperty LocalPort -Unique)
      $m = Model-State
      $nonLoop = @($listen | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') })
      $detail = "ports: $($ports -join ',')"
      if ($ports.Count -ne 1 -or $ports[0] -ne $m.port) { Record 'T-S3' 'Only the model port listens; unauthenticated request gets 401' 'FAIL' "$detail (model port $($m.port))" }
      elseif ($nonLoop.Count) { Record 'T-S3' 'Only the model port listens' 'FAIL' 'listening beyond loopback' }
      else {
        $code = 0
        try { $code = (Invoke-WebRequest -Uri "http://127.0.0.1:$($m.port)/v1/models" -UseBasicParsing -TimeoutSec 5).StatusCode }
        catch { if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode } }
        if ($code -eq 401) { Record 'T-S3' 'Only the model port listens; unauthenticated request gets 401' 'PASS' "$detail, 401 without key$(if (-not $RealStrata) {' (stub server)'})" }
        else { Record 'T-S3' 'Only the model port listens; unauthenticated request gets 401' 'FAIL' "$detail, got HTTP $code" }
      }
    }

    if (Wanted 'T-S6') {
      # No web switch exists yet, so this checks the stronger idle condition: no off-box connections from the app's own processes.
      Start-Sleep -Seconds 5
      $own = @($tree | Where-Object { $_.Name -notmatch 'msedgewebview2' } | ForEach-Object { [int]$_.ProcessId })
      $out = @(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object {
          $own -contains $_.OwningProcess -and $_.State -in 'Established', 'SynSent' -and $_.RemoteAddress -notin @('127.0.0.1', '::1', '0.0.0.0', '::') })
      if ($out.Count -eq 0) { Record 'T-S6' 'No outbound connections from app processes while idle' 'PASS' 'app + model processes: none (WebView2 helper processes excluded)' }
      else { Record 'T-S6' 'No outbound connections from app processes while idle' 'FAIL' (($out | ForEach-Object { "$($_.OwningProcess)->$($_.RemoteAddress):$($_.RemotePort)" }) -join ', ') }
    }

    [void]$app.CloseMainWindow()
    [void](Wait-Gone $tree 10)
    Cleanup-All

    if (Wanted 'T-S5') {
      # Logs after a session: the per-launch key and generic secret shapes must not appear.
      $key = if (Test-Path $script:KeyFile) { (Get-Content $script:KeyFile -Raw).Trim() } else { '' }
      $files = @(Get-ChildItem (Join-Path $script:WbDir 'logs') -Recurse -File -ErrorAction SilentlyContinue)
      $bad = @()
      foreach ($f in $files) {
        $t = Get-Content $f.FullName -Raw -ErrorAction SilentlyContinue
        if (-not $t) { continue }
        if ($key -and $t.Contains($key)) { $bad += "$($f.Name): per-launch key" }
        if ($t -match '-----BEGIN [A-Z ]*PRIVATE KEY-----') { $bad += "$($f.Name): private key" }
        if ($t -match '(?i)authorization:\s*bearer\s+(?!\[?redacted)\S{8,}') { $bad += "$($f.Name): Authorization value" }
        if ($t -match '\bsk-[A-Za-z0-9_-]{20,}') { $bad += "$($f.Name): API key pattern" }
      }
      if (-not $key) { Record 'T-S5' 'Logs contain no private key, API key or Authorization value' 'FAIL' 'could not learn the launch key to search for' }
      elseif ($bad.Count -eq 0) { Record 'T-S5' 'Logs contain no private key, API key or Authorization value' 'PASS' "$($files.Count) log file(s) scanned (no B8 run: model-driven content not covered)" }
      else { Record 'T-S5' 'Logs contain no private key, API key or Authorization value' 'FAIL' ($bad -join '; ') }
    }
  }
  Cleanup-All
}
foreach ($s in @(
    @('T-S1', 'Prompt-injection page cannot trigger a delete'),
    @('T-S2', 'Write to C:\Windows needs approval'),
    @('T-S4', 'Artifact sandbox blocks fetch() and window.parent'))) {
  if (Wanted $s[0]) { Record $s[0] $s[1] 'SKIP' 'needs a live model / the artifact UI; not automatable here' }
}
if (Wanted 'T-L7') { Record 'T-L7' '8-hour soak' 'SKIP' 'run manually (B2-B7 loop)' }

# ---------------------------------------------------------------- updater plugin
if (Wanted 'T-U1') {
  New-Env; $app = Start-App
  if (-not (Wait-Ready $app)) { Record 'T-U1' 'Updater plugin registered' 'FAIL' 'app never became ready' }
  else {
    # One request to the configured GitHub Releases feed. "No release yet" is an error from the feed, not from a missing plugin.
    $r = Invoke-Cmd 'plugin:updater|check' '{}'
    $txt = if ($r.err) { "$($r.err)" } else { 'ok' }
    if ($txt -match 'not allowed|not found|unknown|Command .* not') { Record 'T-U1' 'Updater plugin registered and permitted' 'FAIL' $txt }
    else { Record 'T-U1' 'Updater plugin registered and permitted' 'PASS' ("feed answered: " + $txt.Substring(0, [Math]::Min(120, $txt.Length))) }
    $tree = Get-Tree $app.Id; [void]$app.CloseMainWindow(); [void](Wait-Gone $tree 10)
  }
  Cleanup-All
}

# ---------------------------------------------------------------- uninstall
if ($Installer -and $didInstall -and -not $KeepInstalled -and (Wanted 'T-I2')) {
  $marker = Join-Path $env:LOCALAPPDATA 'Workbench\e2e-marker.txt'
  New-Item -ItemType Directory -Force (Split-Path $marker) | Out-Null
  Set-Content $marker 'user data must survive uninstall'
  $u = Start-Process -FilePath (Join-Path $installDir 'uninstall.exe') -ArgumentList '/S' -PassThru -Wait
  Start-Sleep -Seconds 2   # the NSIS uninstaller re-launches itself from %TEMP%; give it time to finish
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ((Test-Path (Join-Path $installDir 'localwork.exe')) -and $sw.Elapsed.TotalSeconds -lt 30) { Start-Sleep -Milliseconds 500 }
  $gone = -not (Test-Path (Join-Path $installDir 'localwork.exe'))
  $kept = Test-Path $marker
  Remove-Item $marker -Force -ErrorAction SilentlyContinue
  if ($gone -and $kept) { Record 'T-I2' 'Silent uninstall removes the program, keeps %LOCALAPPDATA%\Workbench' 'PASS' 'program removed, data kept' }
  else { Record 'T-I2' 'Silent uninstall removes the program, keeps user data' 'FAIL' "programRemoved=$gone dataKept=$kept" }
}

# ---------------------------------------------------------------- summary
Write-Host "`n==== Summary ===="
$results | Format-Table Id, Status, Test -AutoSize | Out-String | Write-Host
$failed = @($results | Where-Object { $_.Status -eq 'FAIL' })
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
if ($failed.Count) { Write-Host "$($failed.Count) FAILED" -ForegroundColor Red; exit 1 }
Write-Host "All executed tests passed ($(@($results | Where-Object Status -eq 'SKIP').Count) skipped)" -ForegroundColor Green
exit 0


