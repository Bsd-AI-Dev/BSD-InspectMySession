<#
.SYNOPSIS
  Pick a Claude Code session and open it in show-context (live mode, ask feature enabled).

.DESCRIPTION
  Lists every Claude Code session (VS Code extension and terminal) newest first, lets you
  filter and pick one, then launches show-context for it and opens the page in your browser.

  Keys in the list:
    Up/Down, PgUp/PgDn, Home/End   move
    (type)                         filter by title, project, date or id
    Backspace                      edit the filter
    Enter                          open the action menu for the selected session
    Tab                            toggle scope: all folders / only the folder you started in
    F3                             cycle source filter: All / vsc / cli
    F2                             manage running show-context servers
    Esc                            clear the filter, or quit when the filter is empty

.PARAMETER SkipPreflight   Skip the environment checks (Node, show-context, claude.exe).
.PARAMETER Scope           All (default) or Current (only sessions started in the current folder).
.PARAMETER Days            Only show sessions modified in the last N days (0 = no limit).
.PARAMETER Port            Fixed port for the live server (0 = random free port).
.PARAMETER IdleHours       How long a live server stays up without activity (default 8).
.PARAMETER NoBrowser       Print the URL but do not open the browser.
.PARAMETER DumpFirstRecord Print only the field NAMES of the first records of your newest session, then exit.
#>
[CmdletBinding()]
param(
  [switch]$SkipPreflight,
  [ValidateSet('All', 'Current')][string]$Scope = 'All',
  [int]$Days = 0,
  [int]$Port = 0,
  [double]$IdleHours = 8,
  [switch]$NoBrowser,
  [switch]$DumpFirstRecord
)

$ErrorActionPreference = 'Stop'
$script:StartDir  = (Get-Location).ProviderPath
$script:ScopeNow  = $Scope
$script:SrcFilter = 'All'
$script:Launched  = @{}

# ---------------------------------------------------------------- helpers

function Get-ProjectsRoot {
  if ($env:SHOW_CONTEXT_PROJECTS) { return $env:SHOW_CONTEXT_PROJECTS }
  return (Join-Path $HOME '.claude\projects')
}

function Resolve-ClaudeBin {
  if ($env:SHOW_CONTEXT_CLAUDE_BIN -and (Test-Path -LiteralPath $env:SHOW_CONTEXT_CLAUDE_BIN)) {
    return $env:SHOW_CONTEXT_CLAUDE_BIN
  }
  $default = Join-Path $HOME '.local\bin\claude.exe'
  if (Test-Path -LiteralPath $default) { return $default }
  $cmd = Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return $cmd.Source }
  return $null
}

function Resolve-ShowContext {
  # Prefer the .cmd shim: it works regardless of the PowerShell execution policy.
  $c = Get-Command show-context.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $c) { $c = Get-Command show-context -ErrorAction SilentlyContinue | Select-Object -First 1 }
  if ($c) { return $c.Source }
  return $null
}

function Test-Preflight {
  $ok = $true

  $nodeV = $null
  try { $nodeV = (& node --version) } catch { }
  if (-not $nodeV) {
    Write-Host '[!!] Node.js not found on PATH.' -ForegroundColor Red; $ok = $false
  } else {
    $major = [int]($nodeV.ToString().TrimStart('v').Split('.')[0])
    if ($major -lt 22) {
      Write-Host "[!!] Node $nodeV is too old, show-context needs v22 or newer." -ForegroundColor Red; $ok = $false
    } else {
      Write-Host "[OK] Node $nodeV" -ForegroundColor Green
    }
  }

  $sc = Resolve-ShowContext
  if (-not $sc) {
    Write-Host '[!!] show-context not found. Install it with: npm install -g show-context' -ForegroundColor Red; $ok = $false
  } else {
    Write-Host "[OK] show-context: $sc" -ForegroundColor Green
  }

  $bin = Resolve-ClaudeBin
  if (-not $bin) {
    Write-Host '[!!] claude.exe not found - the ask feature will not work.' -ForegroundColor Red; $ok = $false
  } elseif ($bin -match '\.(cmd|ps1|bat)$') {
    Write-Host "[!!] $bin is a script shim; Node cannot start it. Use the native claude.exe." -ForegroundColor Red; $ok = $false
  } else {
    Write-Host "[OK] claude: $bin" -ForegroundColor Green
  }

  $root = Get-ProjectsRoot
  if (Test-Path -LiteralPath $root) {
    Write-Host "[OK] sessions folder: $root" -ForegroundColor Green
  } else {
    Write-Host "[!!] sessions folder not found: $root" -ForegroundColor Red; $ok = $false
  }
  return $ok
}

function Get-FreePort {
  $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
  $l.Start()
  $p = $l.LocalEndpoint.Port
  $l.Stop()
  return $p
}

function Fit([string]$t, [int]$n) {
  if ($n -lt 1) { return '' }
  if ($t.Length -gt $n) { return $t.Substring(0, [Math]::Max(0, $n - 1)) + '~' }
  return $t.PadRight($n)
}

function Write-Line([string]$text, $fg, $bg) {
  $w = $Host.UI.RawUI.WindowSize.Width - 1
  $t = $text
  if ($t.Length -gt $w) { $t = $t.Substring(0, $w) }
  $t = $t.PadRight($w)
  $p = @{ Object = $t }
  if ($fg) { $p.ForegroundColor = $fg }
  if ($bg) { $p.BackgroundColor = $bg }
  Write-Host @p
}

function Wait-AnyKey {
  Write-Host ''
  Write-Host 'Press any key to continue...' -ForegroundColor DarkGray
  [void][Console]::ReadKey($true)
}

# ---------------------------------------------------------------- sessions

function Get-SessionMeta($file) {
  $meta = @{ Title = ''; Cwd = ''; Entry = '' }
  $fs = $null; $sr = $null
  try {
    $fs = [System.IO.File]::Open($file.FullName, 'Open', 'Read', 'ReadWrite')
    $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
    $n = 0
    while ($n -lt 80 -and -not $sr.EndOfStream) {
      $line = $sr.ReadLine(); $n++
      if (-not $line -or $line.Length -gt 300000) { continue }
      try { $o = $line | ConvertFrom-Json } catch { continue }
      if (-not $meta.Cwd -and $o.cwd) { $meta.Cwd = [string]$o.cwd }
      if (-not $meta.Entry -and $o.entrypoint) { $meta.Entry = [string]$o.entrypoint }
      if (-not $meta.Title -and $o.type -eq 'user' -and -not $o.isMeta -and $o.message) {
        $c = $o.message.content
        $candidates = @()
        if ($c -is [string]) { $candidates = @($c) }
        elseif ($c) { foreach ($part in $c) { if ($part.type -eq 'text' -and $part.text) { $candidates += [string]$part.text } } }
        foreach ($t in $candidates) {
          $t = $t.Trim()
          if ($t -and $t -notmatch '^<(ide_|system-reminder|local-command|command-)' -and $t -notmatch '^Caveat:') {
            $meta.Title = ($t -replace '\s+', ' ')
            break
          }
        }
      }
      if ($meta.Title -and $meta.Cwd -and $meta.Entry) { break }
    }
  } catch { }
  finally {
    if ($sr) { $sr.Dispose() }
    if ($fs) { $fs.Dispose() }
  }
  return $meta
}

function Get-Sessions {
  $root = Get-ProjectsRoot
  if (-not (Test-Path -LiteralPath $root)) { throw "Projects folder not found: $root" }
  $cut = $null
  if ($Days -gt 0) { $cut = (Get-Date).AddDays(-$Days) }

  $files = foreach ($d in (Get-ChildItem -LiteralPath $root -Directory)) {
    Get-ChildItem -LiteralPath $d.FullName -File -Filter *.jsonl
  }
  $files = @($files | Where-Object { $_.Length -gt 0 -and (-not $cut -or $_.LastWriteTime -ge $cut) } |
             Sort-Object LastWriteTime -Descending)

  $i = 0
  foreach ($f in $files) {
    $i++
    if (($i % 10) -eq 0 -or $i -eq $files.Count) {
      Write-Progress -Activity 'Scanning Claude sessions' -Status "$i / $($files.Count)" -PercentComplete (100 * $i / $files.Count)
    }
    $m = Get-SessionMeta $f
    $id = $f.BaseName
    $proj = $f.Directory.Name
    if ($m.Cwd) { $proj = Split-Path -Leaf $m.Cwd }
    $src = '-'
    if ($m.Entry -match 'vscode') { $src = 'vsc' }
    elseif ($m.Entry -match 'cli') { $src = 'cli' }
    elseif ($m.Entry) { $src = $m.Entry.Substring(0, [Math]::Min(4, $m.Entry.Length)) }
    $title = $m.Title
    if (-not $title) { $title = '(no prompt found)' }
    $date = $f.LastWriteTime.ToString('yyyy-MM-dd HH:mm')
    $size = if ($f.Length -ge 1MB) { '{0:N1}MB' -f ($f.Length / 1MB) } else { '{0}KB' -f [Math]::Max(1, [int]($f.Length / 1KB)) }
    [pscustomobject]@{
      Id       = $id
      Date     = $date
      Src      = $src
      Project  = $proj
      Cwd      = $m.Cwd
      Title    = $title
      Size     = $size
      File     = $f.FullName
      Haystack = ("$date $proj $title $id $($m.Cwd)").ToLower()
    }
  }
  Write-Progress -Activity 'Scanning Claude sessions' -Completed
}

function Get-View($all, [string]$filter) {
  $v = $all
  if ($script:ScopeNow -eq 'Current') {
    $cur = $script:StartDir.TrimEnd('\').ToLower()
    $v = $v | Where-Object { $_.Cwd -and $_.Cwd.TrimEnd('\').ToLower().StartsWith($cur) }
  }
  if ($script:SrcFilter -ne 'All') {
    $v = $v | Where-Object { $_.Src -eq $script:SrcFilter }
  }
  if ($filter) {
    $f = $filter.ToLower()
    $v = $v | Where-Object { $_.Haystack.Contains($f) }
  }
  return @($v)
}

# ---------------------------------------------------------------- show-context

function Invoke-ShowContext($s, [bool]$Static) {
  $exe = Resolve-ShowContext
  if (-not $exe) {
    Write-Host 'show-context is not installed. Run: npm install -g show-context' -ForegroundColor Red
    return $null
  }

  $bin = Resolve-ClaudeBin
  if ($bin) { $env:SHOW_CONTEXT_CLAUDE_BIN = $bin }
  $env:SHOW_CONTEXT_IDLE_MS = [string][int64]($IdleHours * 3600 * 1000)
  $p = $Port
  if ($p -le 0) { $p = Get-FreePort }
  $env:SHOW_CONTEXT_PORT = [string]$p
  $env:SHOW_CONTEXT_OUT = Join-Path (Join-Path $HOME '.cache\show-context') ($s.Id + '.html')

  $scArgs = @($s.Id, '--no-open')
  if ($Static) { $scArgs += '--static' }

  $pushed = $false
  if ($s.Cwd -and (Test-Path -LiteralPath $s.Cwd)) {
    Push-Location -LiteralPath $s.Cwd; $pushed = $true
  } else {
    Write-Host 'Note: original folder of this session was not found; the ask feature may not find the session.' -ForegroundColor Yellow
  }
  try { $out = (& $exe @scArgs 2>&1 | Out-String).Trim() }
  finally { if ($pushed) { Pop-Location } }
  return $out
}

function Open-Live($s) {
  Write-Host 'Starting show-context...' -ForegroundColor Cyan
  $out = Invoke-ShowContext $s $false
  if ($null -eq $out) { Wait-AnyKey; return }
  $url = [regex]::Match($out, 'http://127\.0\.0\.1:\d+\S*')
  if (-not $url.Success) {
    Write-Host 'show-context did not return a URL:' -ForegroundColor Red
    Write-Host $out
    Wait-AnyKey; return
  }
  $script:Launched[$s.Id] = $url.Value
  $stats = [regex]::Match($out, '(\d+) reads, (\d+) tokens')
  Write-Host ''
  if ($stats.Success) {
    Write-Host ("Reads: {0}   Tokens read: {1:N0}" -f $stats.Groups[1].Value, [int64]$stats.Groups[2].Value) -ForegroundColor Green
  }
  Write-Host "URL:   $($url.Value)"
  Write-Host ("Server stays up after the last activity for {0} h. Ask feature: enabled." -f $IdleHours)
  if (-not $NoBrowser) { Start-Process $url.Value }
  Wait-AnyKey
}

function Open-Static($s) {
  Write-Host 'Writing static report...' -ForegroundColor Cyan
  $out = Invoke-ShowContext $s $true
  if ($null -eq $out) { Wait-AnyKey; return }
  $file = $env:SHOW_CONTEXT_OUT
  if (-not (Test-Path -LiteralPath $file)) {
    Write-Host 'show-context did not write a report:' -ForegroundColor Red
    Write-Host $out
    Wait-AnyKey; return
  }
  $stats = [regex]::Match($out, '(\d+) reads, (\d+) tokens')
  if ($stats.Success) {
    Write-Host ("Reads: {0}   Tokens read: {1:N0}" -f $stats.Groups[1].Value, [int64]$stats.Groups[2].Value) -ForegroundColor Green
  }
  Write-Host "File: $file  (static: the ask feature does not work here)"
  if (-not $NoBrowser) { Start-Process $file }
  Wait-AnyKey
}

# ---------------------------------------------------------------- menus

function Show-Actions($s) {
  while ($true) {
    Clear-Host
    Write-Host "Session $($s.Id)" -ForegroundColor Cyan
    Write-Host "  Title:      $($s.Title)"
    Write-Host "  Updated:    $($s.Date)"
    Write-Host "  Project:    $($s.Project)"
    Write-Host "  Folder:     $($s.Cwd)"
    Write-Host "  Source:     $($s.Src)"
    Write-Host "  Size:       $($s.Size)"
    Write-Host "  Transcript: $($s.File)"
    $url = $script:Launched[$s.Id]
    if ($url) { Write-Host "  Live URL (started in this run): $url" -ForegroundColor Green }
    Write-Host ''
    Write-Host '  [1] Open live            (ask feature enabled)'
    Write-Host '  [2] Static report only   (no server, no ask)'
    Write-Host '  [3] Copy live URL to clipboard'
    Write-Host '  [4] Show transcript in Explorer'
    Write-Host '  [B] Back'
    $k = [Console]::ReadKey($true)
    if ($k.Key -eq 'Escape') { return }
    switch ($k.KeyChar.ToString().ToLower()) {
      '1' { Open-Live $s }
      '2' { Open-Static $s }
      '3' {
        if ($url) { Set-Clipboard -Value $url; Write-Host 'Copied.' -ForegroundColor Green }
        else { Write-Host 'No live URL yet - use [1] first.' -ForegroundColor Yellow }
        Wait-AnyKey
      }
      '4' { Start-Process explorer.exe -ArgumentList "/select,`"$($s.File)`"" }
      'b' { return }
    }
  }
}

function Show-Servers {
  while ($true) {
    Clear-Host
    Write-Host 'Running show-context servers' -ForegroundColor Cyan
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -match 'show-context' -and $_.CommandLine -match '--serve' })
    if ($procs.Count -eq 0) {
      Write-Host '  None running.'
      Wait-AnyKey; return
    }
    $n = 0
    foreach ($pr in $procs) {
      $n++
      $sid = [regex]::Match($pr.CommandLine, '[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}').Value
      Write-Host ("  [{0}] PID {1}   started {2}   session {3}" -f $n, $pr.ProcessId, $pr.CreationDate.ToString('yyyy-MM-dd HH:mm'), $sid)
    }
    Write-Host ''
    $a = Read-Host 'Number to stop, K = stop all, Enter = back'
    if (-not $a) { return }
    if ($a.ToLower() -eq 'k') {
      foreach ($pr in $procs) { Stop-Process -Id $pr.ProcessId -Force -ErrorAction SilentlyContinue }
      $script:Launched = @{}
    } elseif ($a -match '^\d+$' -and [int]$a -ge 1 -and [int]$a -le $procs.Count) {
      Stop-Process -Id $procs[[int]$a - 1].ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}

function Show-Picker($all) {
  # Fallback when input is redirected (no real console): numbered list.
  if ([Console]::IsInputRedirected) {
    $view = Get-View $all ''
    $shown = $view | Select-Object -First 30
    $i = 0
    foreach ($s in $shown) { $i++; Write-Host ("{0,2}. {1}  {2,-18} {3}" -f $i, $s.Date, $s.Project, $s.Title) }
    $a = Read-Host 'Number (Enter = quit)'
    if ($a -match '^\d+$' -and [int]$a -ge 1 -and [int]$a -le @($shown).Count) { return @($shown)[[int]$a - 1] }
    return $null
  }

  $filter = ''; $idx = 0; $top = 0
  Clear-Host
  while ($true) {
    $view = Get-View $all $filter
    $h = $Host.UI.RawUI.WindowSize.Height
    $w = $Host.UI.RawUI.WindowSize.Width
    $page = [Math]::Max(3, $h - 7)
    if ($idx -ge $view.Count) { $idx = $view.Count - 1 }
    if ($idx -lt 0) { $idx = 0 }
    if ($idx -lt $top) { $top = $idx }
    if ($idx -ge $top + $page) { $top = $idx - $page + 1 }

    [Console]::SetCursorPosition(0, 0)
    $scopeLabel = if ($script:ScopeNow -eq 'All') { 'all folders' } else { 'this folder: ' + $script:StartDir }
    Write-Line ("Claude sessions   scope: $scopeLabel   source: $($script:SrcFilter)") 'Cyan' $null
    Write-Line ("Filter: $filter" + '_') 'Yellow' $null
    Write-Line 'Up/Down PgUp/PgDn move | Enter open | Tab scope | F3 source | F2 servers | Esc clear/quit' 'DarkGray' $null
    $titleW = [Math]::Max(10, $w - 66)
    Write-Line ((Fit 'UPDATED' 16) + '  ' + (Fit 'SRC' 4) + '  ' + (Fit 'PROJECT' 20) + '  ' + (Fit 'SIZE' 7) + '  ' + (Fit 'ID' 8) + '  ' + 'FIRST MESSAGE') 'Gray' $null

    for ($r = 0; $r -lt $page; $r++) {
      $i = $top + $r
      if ($i -lt $view.Count) {
        $s = $view[$i]
        $row = (Fit $s.Date 16) + '  ' + (Fit $s.Src 4) + '  ' + (Fit $s.Project 20) + '  ' + (Fit $s.Size 7) + '  ' + (Fit $s.Id.Substring(0, 8) 8) + '  ' + (Fit $s.Title $titleW)
        if ($i -eq $idx) { Write-Line $row 'White' 'DarkCyan' } else { Write-Line $row $null $null }
      } else {
        Write-Line '' $null $null
      }
    }
    Write-Line ("{0} of {1} sessions" -f $view.Count, @($all).Count) 'DarkGray' $null

    $key = [Console]::ReadKey($true)
    if     ($key.Key -eq 'UpArrow')   { if ($idx -gt 0) { $idx-- } }
    elseif ($key.Key -eq 'DownArrow') { if ($idx -lt $view.Count - 1) { $idx++ } }
    elseif ($key.Key -eq 'PageUp')    { $idx = [Math]::Max(0, $idx - $page) }
    elseif ($key.Key -eq 'PageDown')  { $idx = [Math]::Min([Math]::Max(0, $view.Count - 1), $idx + $page) }
    elseif ($key.Key -eq 'Home')      { $idx = 0 }
    elseif ($key.Key -eq 'End')       { $idx = [Math]::Max(0, $view.Count - 1) }
    elseif ($key.Key -eq 'Enter')     { if ($view.Count -gt 0) { return $view[$idx] } }
    elseif ($key.Key -eq 'Escape')    { if ($filter) { $filter = ''; $idx = 0; $top = 0 } else { return $null } }
    elseif ($key.Key -eq 'Tab')       { if ($script:ScopeNow -eq 'All') { $script:ScopeNow = 'Current' } else { $script:ScopeNow = 'All' }; $idx = 0; $top = 0 }
    elseif ($key.Key -eq 'F3') {
      $order = @('All', 'vsc', 'cli')
      $pos = [Array]::IndexOf($order, $script:SrcFilter)
      $script:SrcFilter = $order[($pos + 1) % $order.Count]
      $idx = 0; $top = 0
    }
    elseif ($key.Key -eq 'F2')        { Show-Servers; Clear-Host }
    elseif ($key.Key -eq 'Backspace') { if ($filter.Length -gt 0) { $filter = $filter.Substring(0, $filter.Length - 1); $idx = 0; $top = 0 } }
    elseif ($key.KeyChar -and -not [char]::IsControl($key.KeyChar)) { $filter += $key.KeyChar; $idx = 0; $top = 0 }
  }
}

# ---------------------------------------------------------------- main

if ($DumpFirstRecord) {
  $root = Get-ProjectsRoot
  $newest = foreach ($d in (Get-ChildItem -LiteralPath $root -Directory)) { Get-ChildItem -LiteralPath $d.FullName -File -Filter *.jsonl }
  $newest = $newest | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $newest) { Write-Host 'No sessions found.'; return }
  Write-Host "Newest transcript: $($newest.FullName)"
  $n = 0
  foreach ($line in (Get-Content -LiteralPath $newest.FullName -TotalCount 8)) {
    $n++
    try {
      $o = $line | ConvertFrom-Json
      Write-Host ("record {0}: fields = {1}" -f $n, ($o.PSObject.Properties.Name -join ', '))
      if ($o.entrypoint) { Write-Host ("           entrypoint = {0}" -f $o.entrypoint) }
    } catch { Write-Host "record ${n}: (not parseable)" }
  }
  return
}

if (-not $SkipPreflight) {
  Write-Host 'Preflight checks' -ForegroundColor Cyan
  if (-not (Test-Preflight)) {
    Write-Host ''
    Write-Host 'Fix the items marked [!!], or run again with -SkipPreflight to bypass these checks.' -ForegroundColor Yellow
    return
  }
  Write-Host ''
}

$all = @(Get-Sessions)
if ($all.Count -eq 0) {
  Write-Host 'No sessions found.' -ForegroundColor Yellow
  return
}

try { [Console]::CursorVisible = $false } catch { }
try {
  while ($true) {
    $sel = Show-Picker $all
    if (-not $sel) { break }
    Show-Actions $sel
    Clear-Host
  }
}
finally {
  try { [Console]::CursorVisible = $true } catch { }
  Clear-Host
}
