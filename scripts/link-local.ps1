$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$packDir = Join-Path ([System.IO.Path]::GetTempPath()) ("code-approval-gates-pack-" + [guid]::NewGuid().ToString())
$previousNpmCache = $env:NPM_CONFIG_CACHE
$env:NPM_CONFIG_CACHE = Join-Path $packDir "npm-cache"
New-Item -ItemType Directory -Path $packDir | Out-Null

Push-Location $root
try {
  npm pack --pack-destination $packDir
  if ($LASTEXITCODE -ne 0) {
    throw "npm pack failed."
  }

  $tarballPath = (Get-ChildItem -Path $packDir -Filter "*.tgz" | Select-Object -First 1).FullName
  if (-not $tarballPath) {
    throw "npm pack did not create a tarball."
  }
  npm install -g $tarballPath --force
  if ($LASTEXITCODE -ne 0) {
    throw "npm install -g failed."
  }
} finally {
  Pop-Location
  $env:NPM_CONFIG_CACHE = $previousNpmCache
  if (Test-Path $packDir) {
    Remove-Item -Recurse -Force $packDir
  }
}

semantic-gate status
Get-Command quality-check | Out-String | Write-Host
Get-Command code-approval-gates | Out-String | Write-Host
code-approval-gates doctor --json --no-interactive
