<#
  bsd-ims test run (version 0.3: one server, session menu with Settings and Ask log, theme button, waiting popup).
  By default it checks only what is still open; add -Full for every question.
  1. Installs or updates bsd-ims with scripts/windows/install.ps1 from GitHub.
  2. Opens the newest session of a project folder in your browser.
  3. Checks by itself that a second run reuses the same server and that only one server runs.
  4. Asks you yes/no questions about what you see in the browser (-Full: all of them; default: the open ones).
  5. Checks that "Stop server" in the menu stops the server.
  6. Runs the transcript checker (-Full: your 5 newest sessions; default: the sessions in -CheckSessions).
  Everything is saved to bsd-ims-test-report.txt on your Desktop and copied to the clipboard.
  The report has versions, counts, field names and file paths, not your conversation text.
  The private live-page links (they contain an access token) are replaced with <live URL>.

  Run (PowerShell 7):
    Invoke-WebRequest https://raw.githubusercontent.com/Bsd-AI-Dev/BSD-InspectMySession/main/scripts/windows/bsd-ims-test.ps1 -OutFile $env:TEMP\bsd-ims-test.ps1; pwsh -ExecutionPolicy Bypass -File $env:TEMP\bsd-ims-test.ps1 -ProjectFolder 'C:\projects\sdlc'
#>
param(
  [string]$ProjectFolder = 'C:\projects\sdlc',
  [string]$Branch = 'main',
  [switch]$Full,
  [string[]]$CheckSessions = @('24255504')
)

$ErrorActionPreference = 'Continue'
# Read program output as UTF-8, so characters such as the middle dot in bsd-ims output stay readable.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$log = [System.Collections.Generic.List[string]]::new()
function Note([string]$Text) { Write-Host $Text; $log.Add($Text) }
function Ask([string]$Question) {
  do { $answer = (Read-Host "$Question (y/n)").Trim().ToLower() } until ($answer -in 'y', 'n')
  $log.Add("$Question -> $answer")
  return $answer
}
function AskDetails([string]$Question) {
  $text = Read-Host "$Question (or just press Enter)"
  if ($text) { $log.Add("  details: $(Hide-Url $text)") }
}
function Hide-Url([string]$Text) { return ($Text -replace 'http://127\.0\.0\.1\S*', '<live URL>') }
function Get-Servers {
  return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'bsd-ims\.mjs' -and $_.CommandLine -match '--serve' })
}
function BaseUrl([string]$Text) { return [regex]::Match($Text, 'http://127\.0\.0\.1:\d+/[0-9a-f]{64}/').Value }

Note "== bsd-ims test run $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
Note "PowerShell $($PSVersionTable.PSVersion) | Node $((node --version | Out-String).Trim()) | npm $((npm --version | Out-String).Trim())"

# ------------------------------------------------------------ 1. install / update
Note ''
Note '== 1. Install or update'
$installer = Join-Path $env:TEMP 'bsd-ims-install.ps1'
try {
  Invoke-WebRequest "https://raw.githubusercontent.com/Bsd-AI-Dev/BSD-InspectMySession/$Branch/scripts/windows/install.ps1" -OutFile $installer -ErrorAction Stop
  Note ((& pwsh -NoProfile -ExecutionPolicy Bypass -File $installer -Branch $Branch 2>&1 | Out-String).Trim())
} catch {
  Note "Could not download the installer: $($_.Exception.Message)"
}

# ------------------------------------------------------------ 2.-4. open, reuse, one server
Note ''
Note "== 2. Open the newest session for $ProjectFolder"
if (-not (Test-Path -LiteralPath $ProjectFolder)) {
  Note "Folder not found: $ProjectFolder. Run again with -ProjectFolder 'C:\your\folder'."
} else {
  Push-Location -LiteralPath $ProjectFolder
  $first = (bsd-ims 2>&1 | Out-String).Trim()
  Note (Hide-Url $first)
  Note ''
  Note '== 3. Second run reuses the same server'
  $second = (bsd-ims --no-open 2>&1 | Out-String).Trim()
  Pop-Location
  Note (Hide-Url $second)
  $firstUrl = BaseUrl $first
  $sameServer = $firstUrl -and ($firstUrl -eq (BaseUrl $second))
  Note "same server reused: $(if ($sameServer) { 'yes' } else { 'NO' })"
  Note ''
  Note '== 4. Number of bsd-ims servers running'
  Note "servers running: $((Get-Servers).Count) (expected: 1)"

  Write-Host ''
  Write-Host 'Look at the page that opened in your browser, then answer:' -ForegroundColor Cyan
  if (-not $Full) {
    Note ''
    Note '== 4a. Open items only (run with -Full for every question)'
    Write-Host 'In the menu, open the Settings tab, choose "Same as the session" and click Save.' -ForegroundColor Cyan
    Write-Host 'Then, in the Conversation tab, select a sentence Claude wrote, click "Where did this come from?" and wait for the answer.' -ForegroundColor Cyan
    [void](Ask 'Did the popup say "Set in Settings: the same model as the session"?')
    [void](Ask 'Does the model at the bottom of the answer card match the session model?')
    AskDetails 'Copy the model name shown at the bottom of the answer card here'
    Write-Host 'In Settings, choose "Auto (recommended)" again and click Save.' -ForegroundColor Cyan
    [void](Read-Host 'Press Enter when done')
  } else {
  [void](Ask 'Is there a session menu on the left?')
  [void](Ask 'Are the sessions grouped by project name (for example sdlc, BSDEditor, wp-content)?')
  [void](Ask "Is the newest session of $ProjectFolder highlighted in the menu and shown on the right?")
  [void](Ask 'Click another session in the menu. Is it shown on the right?')
  [void](Ask 'Type a word in the filter box at the top. Does the list show only matching sessions?')
  [void](Ask 'In "Show context", is there a Tools row with one smaller row per tool under it?')
  [void](Ask 'Are the menu and the session page both dark?')
  [void](Ask 'Click "Light theme" at the top of the menu. Do both the menu and the session page turn light?')
  [void](Ask 'Click "Dark theme". Do both turn dark again?')
  Write-Host 'In the Conversation tab, select a sentence Claude wrote and click "Where did this come from?".' -ForegroundColor Cyan
  [void](Ask 'Did a popup "Analyzing your question..." with a running timer appear?')
  [void](Ask 'Did a black console window open while it was waiting? (the answer should be n)')
  if ((Ask 'When the popup closed, did it show the source lines?') -eq 'n') { AskDetails 'Paste the exact error text' }
  Write-Host 'Ask "Where did this come from?" again, and click Cancel in the popup after a few seconds.' -ForegroundColor Cyan
  [void](Ask 'Did the popup close?')
  [void](Ask 'Ask once more and wait. Did it show an answer (not "An ask is already running")?')
  [void](Ask 'Did the popup show "Using <model>:" and a reason (for example "cache expired")?')
  [void](Ask 'Does the bottom of the answer card show the model, "tokens in (... from cache ...)", "out" and a cost?')
  Write-Host 'Click the Settings tab in the menu.' -ForegroundColor Cyan
  [void](Ask 'Does it show "Model for Where did this come from?" set to Auto, and a price table?')
  Write-Host 'Click the Ask log tab.' -ForegroundColor Cyan
  [void](Ask 'Are your questions listed, newest first, with model and cost?')
  [void](Ask 'Click the newest one. Does a popup show why the model was chosen and the tokens and cost per part?')
  AskDetails 'Copy the "Model" and "Why this model" lines from that popup here'
  Write-Host 'Close the popup. In Settings choose "Same as the session", click Save, and ask one more question.' -ForegroundColor Cyan
  [void](Ask 'Did the popup and the answer use the session model?')
  Write-Host 'Click "Copy path" next to a session in the menu, then paste it here with Ctrl+V.' -ForegroundColor Cyan
  $copied = (Read-Host 'Pasted path').Trim().Trim('"')
  Note "copy path works: $(if ($copied -and (Test-Path -LiteralPath $copied)) { 'yes' } else { "NO ('$copied')" })"
  }

  Note ''
  Note '== 4b. Ask log: models of the last 5 questions (no question text)'
  $asksFile = Join-Path $env:USERPROFILE '.cache\bsd-ims\asks.jsonl'
  if (Test-Path -LiteralPath $asksFile) {
    foreach ($line in @(Get-Content -LiteralPath $asksFile -Tail 5)) {
      try { $a = $line | ConvertFrom-Json } catch { continue }
      $used = @($a.models | ForEach-Object { "$($_.model) `$$($_.costUsd)" }) -join ', '
      Note "$($a.time) | $($a.status) | asked with: '$($a.choice.model)' | session model: '$($a.choice.sessionModel)' | answered by: $used"
      Note "    reason: $($a.choice.reason)"
    }
  } else {
    Note "No ask log at $asksFile"
  }

  Note ''
  Note '== 5. Stop server button'
  Write-Host 'Click "Stop server" at the top of the menu and confirm. Then press Enter here.' -ForegroundColor Cyan
  [void](Read-Host 'Press Enter when done')
  Start-Sleep -Seconds 1
  Note "servers running after Stop server: $((Get-Servers).Count) (expected: 0)"
  Note "bsd-ims --stop afterwards: $((bsd-ims --stop 2>&1 | Out-String).Trim()) (expected: no server running)"
}

# ------------------------------------------------------------ 6. checker
Note ''
$checker = Join-Path (npm root -g) 'bsd-ims\contract\check-transcript.mjs'
if (-not (Test-Path -LiteralPath $checker)) {
  Note "Checker not found at $checker"
} elseif ($Full) {
  Note '== 6. Transcript checker (5 newest sessions)'
  Note (Hide-Url ((node $checker --latest 5 2>&1 | Out-String).Trim()))
  Note "checker exit code: $LASTEXITCODE"
} else {
  Note "== 6. Transcript checker (sessions: $($CheckSessions -join ', '))"
  foreach ($id in $CheckSessions) {
    Note (Hide-Url ((node $checker $id 2>&1 | Out-String).Trim()))
    Note "checker exit code: $LASTEXITCODE"
  }
}

# ------------------------------------------------------------ report
$report = Join-Path ([Environment]::GetFolderPath('Desktop')) 'bsd-ims-test-report.txt'
$log | Set-Content -LiteralPath $report -Encoding utf8
try { $log -join "`n" | Set-Clipboard; $copiedNote = ' It is also copied to the clipboard.' } catch { $copiedNote = '' }
Write-Host ''
Write-Host "Done. Report saved to $report.$copiedNote" -ForegroundColor Green
Write-Host 'Send the report back (upload the file or paste it).' -ForegroundColor Green
