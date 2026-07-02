$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot

Push-Location $root
try {
  npm install -g .
} finally {
  Pop-Location
}

semantic-gate status
Get-Command quality-check | Out-String | Write-Host
Get-Command code-approval-gates | Out-String | Write-Host
code-approval-gates doctor --json --no-interactive
