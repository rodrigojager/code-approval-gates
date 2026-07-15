$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$verifyDir = Join-Path ([System.IO.Path]::GetTempPath()) ("code-approval-gates-verify-" + [guid]::NewGuid().ToString())
$previousNpmCache = $env:NPM_CONFIG_CACHE
$env:NPM_CONFIG_CACHE = Join-Path $verifyDir "npm-cache"

function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)]
    [string] $FilePath,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Arguments
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
  }
}

New-Item -ItemType Directory -Path $verifyDir | Out-Null

try {
  # Root tests exercise `doctor semantic`, which intentionally verifies the
  # compiled semantic wrapper. Bootstrap that workspace first so a pristine
  # checkout is tested in the same valid state as an installed checkout.
  Push-Location (Join-Path $root "semantic-gate")
  try {
    Invoke-Native npm install --workspaces=false
    Invoke-Native npm run build --workspaces=false
  } finally {
    Pop-Location
  }

  Push-Location $root
  try {
    Invoke-Native node --check "bin/code-approval-gates.js"
    Invoke-Native node --check "quality-gate/bin/quality-check.js"
    Invoke-Native npm run test:root
    Invoke-Native npm pack --dry-run
  } finally {
    Pop-Location
  }

  Push-Location (Join-Path $root "semantic-gate")
  try {
    Invoke-Native npm run test:build --workspaces=false
    Invoke-Native npm run pack:dry-run --workspaces=false
  } finally {
    Pop-Location
  }

  Push-Location (Join-Path $root "quality-gate")
  try {
    Invoke-Native npm install --workspaces=false
    Invoke-Native npm test --workspaces=false
    Invoke-Native npm pack --dry-run
  } finally {
    Pop-Location
  }
} finally {
  $env:NPM_CONFIG_CACHE = $previousNpmCache
  if (Test-Path $verifyDir) {
    Remove-Item -Recurse -Force $verifyDir
  }
}
