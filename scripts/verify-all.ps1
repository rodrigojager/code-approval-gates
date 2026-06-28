$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot

Push-Location (Join-Path $root "semantic-gate")
try {
  npm install --workspaces=false
  npm test --workspaces=false
  npm run pack:dry-run --workspaces=false
} finally {
  Pop-Location
}

Push-Location (Join-Path $root "quality-gate")
try {
  npm install --workspaces=false
  npm test --workspaces=false
  npm pack --dry-run
} finally {
  Pop-Location
}
