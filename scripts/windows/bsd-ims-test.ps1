<#
  bsd-ims test run.
  1. Downloads and installs the latest bsd-ims from GitHub.
  2. Opens the newest Claude Code session of a project folder in your browser.
  3. Asks you a few yes/no questions about what you saw.
  4. Runs the transcript checker on your 5 newest sessions.
  Everything is saved to bsd-ims-test-report.txt on your Desktop and copied to the clipboard.
  The report contains versions, counts, field names and file paths, not your conversation text.
  The private live-page link (it contains an access token) is replaced with <live URL>.

  Run:  pwsh -ExecutionPolicy Bypass -File .\bsd-ims-test.ps1  (see README, "Test on Windows")
  Other folder:  pwsh -ExecutionPolicy Bypass -File .\bsd-ims-test.ps1 -ProjectFolder 'C:\path\to\project'
#>
param([string]$ProjectFolder = 'C:\projects\sdlc')

$ErrorActionPreference = 'Continue'
$log = [System.Collections.Generic.List[string]]::new()
function Note([string]$text) { Write-Host $text; $log.Add($text) }
function Ask([string]$question) {
  do { $answer = (Read-Host "$question (y/n)").Trim().ToLower() } until ($answer -in 'y', 'n')
  $log.Add("$question -> $answer")
  return $answer
}
function Hide-Url([string]$text) { return ($text -replace 'http://127\.0\.0\.1\S*', '<live URL>') }

Note "== bsd-ims test run $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
Note "PowerShell $($PSVersionTable.PSVersion) | Node $(node --version) | npm $(npm --version)"

# ------------------------------------------------------------ 1. update
Note ''
Note '== 1. Install the latest bsd-ims'
$tgz = Join-Path $env:TEMP 'bsd-ims-main.tar.gz'
try {
  Invoke-WebRequest 'https://github.com/Bsd-AI-Dev/BSD-InspectMySession/archive/refs/heads/main.tar.gz' -OutFile $tgz
  Note 'download: ok'
} catch {
  Note "download FAILED: $($_.Exception.Message)"
}
Note ((npm install -g $tgz 2>&1 | Out-String).Trim())
Note "bsd-ims --version: $((bsd-ims --version 2>&1 | Out-String).Trim())"

# ------------------------------------------------------------ 2. open the newest session of the folder
Note ''
Note "== 2. Open the newest session for $ProjectFolder"
if (Test-Path -LiteralPath $ProjectFolder) {
  Push-Location -LiteralPath $ProjectFolder
  $result = (bsd-ims 2>&1 | Out-String).Trim()
  Pop-Location
  Note (Hide-Url $result)
  Write-Host ''
  Write-Host 'Look at your screen and browser, then answer:' -ForegroundColor Cyan
  [void](Ask 'Did the browser open the page by itself?')
  [void](Ask 'Did a black console window flash for a moment?')
  Write-Host 'In the page, look at the top block "Loaded at start".' -ForegroundColor Cyan
  if ((Ask 'Is there a "Tools" row with one smaller row per tool under it, each with a size?') -eq 'n') {
    [void](Ask 'Does that block say "Not recorded in this session file"?')
  }
} else {
  Note "Folder not found: $ProjectFolder (run again with -ProjectFolder 'C:\your\folder')"
}

# ------------------------------------------------------------ 3. checker
Note ''
Note '== 3. Transcript checker (5 newest sessions)'
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
try { $log -join "`n" | Set-Clipboard; $copied = ' It is also copied to the clipboard.' } catch { $copied = '' }
Write-Host ''
Write-Host "Done. Report saved to $report.$copied" -ForegroundColor Green
Write-Host 'Paste the report into the chat. The live page keeps running; you can leave it open.' -ForegroundColor Green
