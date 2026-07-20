$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$verifyDir = Join-Path ([System.IO.Path]::GetTempPath()) ("code-approval-gates-verify-" + [guid]::NewGuid().ToString())
$previousNpmCache = $env:NPM_CONFIG_CACHE
$ciRangeVariableNames = @(
  "GITHUB_BASE_REF",
  "GITHUB_HEAD_REF",
  "GITHUB_SHA",
  "GITLAB_CI",
  "CI_MERGE_REQUEST_DIFF_BASE_SHA",
  "CI_MERGE_REQUEST_TARGET_BRANCH_NAME",
  "CI_COMMIT_SHA"
)
$previousCiRangeVariables = @{}
$initialGitStatus = @(& git -C $root status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0) {
  throw "Unable to capture the initial Git worktree state."
}

# Unit tests create isolated Git repositories and inject their own ranges where
# required. Ambient CI refs point at the outer checkout and would make those
# fixtures resolve an unrelated range, so keep verification deterministic.
foreach ($name in $ciRangeVariableNames) {
  $previousCiRangeVariables[$name] = [Environment]::GetEnvironmentVariable(
    $name,
    [EnvironmentVariableTarget]::Process
  )
}

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

try {
  $env:NPM_CONFIG_CACHE = Join-Path $verifyDir "npm-cache"
  foreach ($name in $ciRangeVariableNames) {
    [Environment]::SetEnvironmentVariable(
      $name,
      $null,
      [EnvironmentVariableTarget]::Process
    )
  }
  New-Item -ItemType Directory -Path $verifyDir | Out-Null

  # Root end-to-end tests execute the bundled Python sidecar in quick mode.
  # Install its sole runtime dependency before those tests in a pristine CI
  # environment; the quality workspace test repeats this idempotently later.
  Invoke-Native python -m pip install --disable-pip-version-check --quiet "defusedxml==0.7.1"

  # Root tests exercise `doctor semantic`, which intentionally verifies the
  # compiled semantic wrapper. Bootstrap that workspace first so a pristine
  # checkout is tested in the same valid state as an installed checkout.
  Push-Location (Join-Path $root "semantic-gate")
  try {
    Invoke-Native npm ci --workspaces=false
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
    Invoke-Native npm ci --workspaces=false
    Invoke-Native npm test --workspaces=false
    Invoke-Native npm pack --dry-run
  } finally {
    Pop-Location
  }

  $finalGitStatus = @(& git -C $root status --porcelain=v1 --untracked-files=all)
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to capture the final Git worktree state."
  }
  $worktreeDelta = @(Compare-Object -ReferenceObject $initialGitStatus -DifferenceObject $finalGitStatus)
  if ($worktreeDelta.Count -ne 0) {
    $details = ($worktreeDelta | ForEach-Object { "$($_.SideIndicator) $($_.InputObject)" }) -join [Environment]::NewLine
    throw "Verification changed the Git worktree:`n$details"
  }
} finally {
  $env:NPM_CONFIG_CACHE = $previousNpmCache
  foreach ($name in $ciRangeVariableNames) {
    [Environment]::SetEnvironmentVariable(
      $name,
      $previousCiRangeVariables[$name],
      [EnvironmentVariableTarget]::Process
    )
  }
  if (Test-Path $verifyDir) {
    Remove-Item -Recurse -Force $verifyDir
  }
}
