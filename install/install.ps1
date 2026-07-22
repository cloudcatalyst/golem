# Golem installer for Windows (Decision 41b).
#   irm https://golem.run | iex
#
# Tiered, npm-first:
#   1. Node >= 22 + npm present    -> npm install -g golem-run  (self-updating)
#   2. otherwise                   -> download the standalone .exe (no Node)
#   3. $env:GOLEM_INSTALL_NODE=1   -> bootstrap Node via winget, then retry (1)
#
# Env knobs (all optional):
#   GOLEM_INSTALL_BASE   base URL for binaries    (default https://golem.run)
#   GOLEM_VERSION        pin an npm version        (default: latest)
#   GOLEM_INSTALL_NODE   1 = allow Node bootstrap  (default: 0)
#   GOLEM_BIN_DIR        override the binary install dir

$ErrorActionPreference = 'Stop'

function Write-Golem($msg, $color = 'Cyan') { Write-Host "golem: $msg" -ForegroundColor $color }
function Write-GolemWarn($msg) { Write-Golem $msg 'Yellow' }
function Write-GolemErr($msg) { Write-Golem $msg 'Red' }

function Test-Command($name) { $null -ne (Get-Command $name -ErrorAction SilentlyContinue) }

# Node major version, or 0 if node is absent/unparseable.
function Get-NodeMajor {
  if (-not (Test-Command node)) { return 0 }
  try {
    $v = (& node -v) -replace '^v', ''        # "24.13.1"
    return [int]($v.Split('.')[0])
  } catch { return 0 }
}

function Show-NextSteps {
  Write-Golem 'installed. Next:' 'Green'
  Write-Golem '  golem init      # wire this project''s Claude Code to Golem'
  Write-Golem '  golem --help    # all commands'
}

function Install-ViaNpm {
  $spec = 'golem-run'
  if ($env:GOLEM_VERSION) { $spec = "golem-run@$($env:GOLEM_VERSION)" }
  Write-Golem "installing $spec globally via npm ..."
  try {
    & npm install -g $spec
    if ($LASTEXITCODE -ne 0) { throw "npm exited $LASTEXITCODE" }
    Show-NextSteps
    return $true
  } catch {
    Write-GolemWarn "npm install failed ($_). If golem-run isn't published yet, this is expected — see https://golem.run"
    return $false
  }
}

function Install-ViaBinary($arch) {
  $base = if ($env:GOLEM_INSTALL_BASE) { $env:GOLEM_INSTALL_BASE } else { 'https://golem.run' }
  $asset = "golem-windows-$arch.exe"
  $url = "$base/bin/$asset"

  $bindir = if ($env:GOLEM_BIN_DIR) { $env:GOLEM_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'Golem\bin' }
  New-Item -ItemType Directory -Force -Path $bindir | Out-Null
  $dest = Join-Path $bindir 'golem.exe'

  Write-Golem "downloading standalone binary: $url"
  try {
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
  } catch {
    Write-GolemErr "could not download $asset (release may not be published yet, or no binary for this arch)."
    Write-GolemErr 'Install Node >= 22 (https://nodejs.org) and re-run, or set $env:GOLEM_INSTALL_NODE=1.'
    exit 1
  }
  Write-Golem "installed golem to $dest" 'Green'

  # Persist $bindir onto the USER PATH if it isn't already there.
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (($userPath -split ';') -notcontains $bindir) {
    [Environment]::SetEnvironmentVariable('Path', "$bindir;$userPath", 'User')
    $env:Path = "$bindir;$env:Path"
    Write-GolemWarn "added $bindir to your user PATH — open a new terminal for it to take effect everywhere."
  }
  Show-NextSteps
}

function Install-Node {
  Write-Golem 'attempting to install Node.js (GOLEM_INSTALL_NODE=1) ...'
  if (Test-Command winget) {
    & winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    return ($LASTEXITCODE -eq 0)
  }
  if (Test-Command choco) { & choco install nodejs-lts -y; return ($LASTEXITCODE -eq 0) }
  Write-GolemWarn 'no winget/choco found for automatic Node install.'
  return $false
}

function Invoke-Main {
  switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { $arch = 'x64' }
    'ARM64' { $arch = 'arm64' }
    'x86'   { $arch = 'x64' }   # 32-bit shell on 64-bit Windows; the x64 build is correct
    default { Write-GolemErr "unsupported architecture '$($env:PROCESSOR_ARCHITECTURE)'. See https://golem.run"; exit 1 }
  }
  Write-Golem "detected windows/$arch"

  # Tier 1: Node >= 22 + npm.
  if ((Get-NodeMajor) -ge 22 -and (Test-Command npm)) {
    if (Install-ViaNpm) { return }
    Write-GolemWarn 'falling back to the standalone binary ...'
  }

  # Tier 3 (opt-in): bootstrap Node, then retry Tier 1 once.
  if ($env:GOLEM_INSTALL_NODE -eq '1' -and ((Get-NodeMajor) -lt 22 -or -not (Test-Command npm))) {
    if ((Install-Node) -and (Get-NodeMajor) -ge 22 -and (Test-Command npm)) {
      if (Install-ViaNpm) { return }
    }
    Write-GolemWarn 'Node bootstrap did not yield Node >= 22 + npm; falling back to the binary ...'
  }

  # Tier 2: standalone binary (no Node required).
  Install-ViaBinary $arch
}

Invoke-Main
