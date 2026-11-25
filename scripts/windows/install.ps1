<#
.SYNOPSIS
  Install or update BSD InspectMySession (bsd-ims) from GitHub. Git is not needed.

.DESCRIPTION
  1. Checks Node.js (22 or newer) and npm.
  2. Stops running bsd-ims servers, old versions included.
  3. Downloads the chosen branch from GitHub.
  4. Installs it globally with npm (from the downloaded file).
  5. Checks the installed version.
  6. Checks that Claude Code can be found (needed for "Where did this come from?").

  Run (PowerShell 7):
    Invoke-WebRequest https://raw.githubusercontent.com/Bsd-AI-Dev/BSD-InspectMySession/main/scripts/windows/install.ps1 -OutFile $env:TEMP\bsd-ims-install.ps1; pwsh -ExecutionPolicy Bypass -File $env:TEMP\bsd-ims-install.ps1

.PARAMETER Branch  GitHub branch to install. Default main. Use version-0.1 for the old version with the PowerShell picker.
#>
param([string]$Branch = 'main')

$ErrorActionPreference = 'Continue'
$Repo = 'https://github.com/Bsd-AI-Dev/BSD-InspectMySession'

function Step([int]$Number, [string]$Text) { Write-Host ''; Write-Host "[$Number/6] $Text" -ForegroundColor Cyan }
function Fail([string]$Text) { Write-Host "FAILED: $Text" -ForegroundColor Red; exit 1 }

Step 1 'Checking Node.js and npm'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail 'Node.js was not found. Install Node.js 22 or newer from https://nodejs.org, open a new PowerShell window and run this again.'
}
$nodeVersion = (& node --version | Out-String).Trim()
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 22) { Fail "Node.js $nodeVersion is too old. bsd-ims needs version 22 or newer." }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'npm was not found. It comes with Node.js; reinstall Node.js.' }
$npmVersion = (& npm --version | Out-String).Trim()
Write-Host "  Node $nodeVersion, npm $npmVersion"

Step 2 'Stopping running bsd-ims servers'
$servers = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'bsd-ims\.mjs' -and $_.CommandLine -match '--serve' })
foreach ($server in $servers) { Stop-Process -Id $server.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host "  Stopped $($servers.Count) server(s)."

Step 3 "Downloading '$Branch' from GitHub"
$file = Join-Path $env:TEMP ('bsd-ims-' + ($Branch -replace '[^\w.-]', '-') + '.tar.gz')
try {
  Invoke-WebRequest "$Repo/archive/refs/heads/$Branch.tar.gz" -OutFile $file -ErrorAction Stop
} catch {
  Fail "Download failed: $($_.Exception.Message)"
}
Write-Host "  Saved to $file"

Step 4 'Installing with npm'
$npmOutput = (& npm install -g $file 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { Write-Host $npmOutput; Fail 'npm install failed (see the messages above).' }
Write-Host "  $npmOutput"

Step 5 'Checking the installed version'
$version = (& bsd-ims --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { Fail "bsd-ims did not run: $version" }
Write-Host "  bsd-ims $version" -ForegroundColor Green

Step 6 'Looking for Claude Code (needed for "Where did this come from?")'
$native = Join-Path $HOME '.local\bin\claude.exe'
$onPath = Get-Command claude.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($env:SHOW_CONTEXT_CLAUDE_BIN) {
  Write-Host "  Using SHOW_CONTEXT_CLAUDE_BIN: $env:SHOW_CONTEXT_CLAUDE_BIN"
} elseif (Test-Path -LiteralPath $native) {
  Write-Host "  Found $native"
} elseif ($onPath) {
  Write-Host "  Found $($onPath.Source)"
} else {
  Write-Host '  claude.exe was not found. bsd-ims works, but "Where did this come from?" will not until Claude Code is installed.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Done. To use it: go to a folder where you used Claude Code and run  bsd-ims' -ForegroundColor Green
