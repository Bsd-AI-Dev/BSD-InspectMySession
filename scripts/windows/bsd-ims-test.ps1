<#
  bsd-ims test run (version 0.2: one server, session menu).
  1. Installs or updates bsd-ims with scripts/windows/install.ps1 from GitHub.
  2. Opens the newest session of a project folder in your browser.
  3. Checks by itself that a second run reuses the same server and that only one server runs.
  4. Asks you a few yes/no questions about what you see in the browser.
  5. Checks that "Stop server" in the menu stops the server.
  6. Runs the transcript checker on your 5 newest sessions.
  Everything is saved to bsd-ims-test-report.txt on your Desktop and copied to the clipboard.
  The report has versions, counts, field names and file paths, not your conversation text.
  The private live-page links (they contain an access token) are replaced with <live URL>.

  Run (PowerShell 7):
    Invoke-WebRequest https://raw.githubusercontent.com/Bsd-AI-Dev/BSD-InspectMySession/main/scripts/windows/bsd-ims-test.ps1 -OutFile $env:TEMP\bsd-ims-test.ps1; pwsh -ExecutionPolicy Bypass -File $env:TEMP\bsd-ims-test.ps1 -ProjectFolder 'C:\projects\sdlc'
#>
param(
  [string]$ProjectFolder = 'C:\projects\sdlc',
  [string]$Branch = 'main'
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
  [void](Ask 'Is there a session menu on the left?')
  [void](Ask 'Are the sessions grouped by project name (for example sdlc, BSDEditor, wp-content)?')
  [void](Ask "Is the newest session of $ProjectFolder highlighted in the menu and shown on the right?")
  [void](Ask 'Click another session in the menu. Is it shown on the right?')
  [void](Ask 'Type a word in the filter box at the top. Does the list show only matching sessions?')
  [void](Ask 'In "Show context", is there a Tools row with one smaller row per tool under it?')
  Write-Host 'In the Conversation tab, select a sentence Claude wrote and click "Where did this come from?" (wait up to a minute).' -ForegroundColor Cyan
  if ((Ask 'Did it show the source lines?') -eq 'n') { AskDetails 'Paste the exact error text' }
  Write-Host 'Click "Copy path" next to a session in the menu, then paste it here with Ctrl+V.' -ForegroundColor Cyan
  $copied = (Read-Host 'Pasted path').Trim().Trim('"')
  Note "copy path works: $(if ($copied -and (Test-Path -LiteralPath $copied)) { 'yes' } else { "NO ('$copied')" })"

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
Note '== 6. Transcript checker (5 newest sessions)'
$checker = Join-Path (npm root -g) 'bsd-ims\contract\check-transcript.mjs'
if (Test-Path -LiteralPath $checker) {
  Note (Hide-Url ((node $checker --latest 5 2>&1 | Out-String).Trim()))
  Note "checker exit code: $LASTEXITCODE"
} else {
  Note "Checker not found at $checker"
}

# ------------------------------------------------------------ report
$report = Join-Path ([Environment]::GetFolderPath('Desktop')) 'bsd-ims-test-report.txt'
$log | Set-Content -LiteralPath $report -Encoding utf8
try { $log -join "`n" | Set-Clipboard; $copiedNote = ' It is also copied to the clipboard.' } catch { $copiedNote = '' }
Write-Host ''
Write-Host "Done. Report saved to $report.$copiedNote" -ForegroundColor Green
Write-Host 'Send the report back (upload the file or paste it).' -ForegroundColor Green
