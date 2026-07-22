#!/bin/sh
# Golem installer for Linux and macOS (Decision 41b).
#   curl -fsSL https://golem.run | sh
#
# Tiered, npm-first:
#   1. Node >= 22 + npm present         -> npm install -g golem-run  (self-updating)
#   2. otherwise                        -> download the standalone binary (no Node)
#   3. GOLEM_INSTALL_NODE=1 only        -> bootstrap Node, then retry (1)
#
# Env knobs (all optional):
#   GOLEM_INSTALL_BASE   base URL for binaries      (default https://golem.run)
#   GOLEM_VERSION        pin an npm version          (default: latest)
#   GOLEM_INSTALL_NODE   1 = allow Node bootstrap    (default: 0)
#   GOLEM_BIN_DIR        override the binary install dir
#
# POSIX sh only (no bashisms). main() is called last so a truncated download
# never executes a half-script.
set -eu

# ---- output helpers (color only on a tty) --------------------------------
if [ -t 2 ]; then C_INFO='\033[1;34m'; C_WARN='\033[1;33m'; C_ERR='\033[1;31m'; C_OK='\033[1;32m'; C_OFF='\033[0m'
else C_INFO=''; C_WARN=''; C_ERR=''; C_OK=''; C_OFF=''; fi
info() { printf '%bgolem:%b %s\n' "$C_INFO" "$C_OFF" "$*" >&2; }
warn() { printf '%bgolem:%b %s\n' "$C_WARN" "$C_OFF" "$*" >&2; }
err()  { printf '%bgolem:%b %s\n' "$C_ERR" "$C_OFF" "$*" >&2; }
ok()   { printf '%bgolem:%b %s\n' "$C_OK" "$C_OFF" "$*" >&2; }
die()  { err "$*"; exit 1; }

has() { command -v "$1" >/dev/null 2>&1; }

# Node major version, or 0 if node is absent/unparseable.
node_major() {
  has node || { echo 0; return; }
  # `node -v` -> "v24.13.1"; strip the v, take the major field.
  v=$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)
  case "$v" in ''|*[!0-9]*) echo 0 ;; *) echo "$v" ;; esac
}

# Download $1 to $2; return non-zero (without aborting) on any HTTP/network error.
download() {
  if has curl; then curl -fsSL "$1" -o "$2"
  elif has wget; then wget -q "$1" -O "$2"
  else die "need curl or wget to download; please install one."; fi
}

next_steps() {
  ok "installed. Next:"
  info "  golem init      # wire this project's Claude Code to Golem"
  info "  golem --help    # all commands"
}

install_via_npm() {
  spec="golem-run"
  [ -n "${GOLEM_VERSION:-}" ] && spec="golem-run@${GOLEM_VERSION}"
  info "installing $spec globally via npm ..."
  if npm install -g "$spec"; then
    next_steps
    return 0
  fi
  warn "npm install failed. If golem-run isn't published yet, this is expected — see https://golem.run"
  return 1
}

install_via_binary() {
  os="$1"; arch="$2"
  asset="golem-${os}-${arch}"
  url="${GOLEM_INSTALL_BASE}/bin/${asset}"

  # Pick an install dir: explicit override, else ~/.local/bin, else /usr/local/bin.
  if [ -n "${GOLEM_BIN_DIR:-}" ]; then bindir="$GOLEM_BIN_DIR"; sudo=""
  elif mkdir -p "$HOME/.local/bin" 2>/dev/null; then bindir="$HOME/.local/bin"; sudo=""
  else
    bindir="/usr/local/bin"
    if [ -w "$bindir" ]; then sudo=""
    elif has sudo; then sudo="sudo"; warn "installing to $bindir (needs sudo)"
    else die "no writable install dir; set GOLEM_BIN_DIR to a directory on your PATH."; fi
  fi

  tmp=$(mktemp 2>/dev/null || echo "/tmp/golem.$$")
  trap 'rm -f "$tmp"' EXIT INT TERM
  info "downloading standalone binary: $url"
  if ! download "$url" "$tmp"; then
    err "could not download $asset (release may not be published yet, or this OS/arch has no binary)."
    die "install Node >= 22 (https://nodejs.org) and re-run, or set GOLEM_INSTALL_NODE=1."
  fi
  chmod +x "$tmp"
  $sudo mv "$tmp" "$bindir/golem"
  trap - EXIT INT TERM
  ok "installed golem to $bindir/golem"

  # Warn if the dir isn't on PATH (case match on the padded PATH is POSIX-safe).
  case ":$PATH:" in
    *":$bindir:"*) : ;;
    *) warn "$bindir is not on your PATH. Add it, e.g.:"
       warn "  echo 'export PATH=\"$bindir:\$PATH\"' >> ~/.profile" ;;
  esac
  next_steps
}

bootstrap_node() {
  info "attempting to install Node.js (GOLEM_INSTALL_NODE=1) ..."
  if has brew; then brew install node && return 0; fi
  if has apt-get; then sudo apt-get update && sudo apt-get install -y nodejs npm && return 0; fi
  if has dnf; then sudo dnf install -y nodejs npm && return 0; fi
  if has pacman; then sudo pacman -S --noconfirm nodejs npm && return 0; fi
  warn "no supported package manager found for automatic Node install."
  return 1
}

main() {
  GOLEM_INSTALL_BASE="${GOLEM_INSTALL_BASE:-https://golem.run}"

  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) die "unsupported OS '$(uname -s)'. Windows: use PowerShell (irm https://golem.run | iex). See https://golem.run" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) die "unsupported architecture '$(uname -m)'. See https://golem.run" ;;
  esac
  info "detected ${os}/${arch}"

  # Tier 1: Node >= 22 + npm.
  if [ "$(node_major)" -ge 22 ] && has npm; then
    install_via_npm && exit 0
    warn "falling back to the standalone binary ..."
  fi

  # Tier 3 (opt-in): bootstrap Node, then retry Tier 1 once.
  if [ "${GOLEM_INSTALL_NODE:-0}" = "1" ] && { [ "$(node_major)" -lt 22 ] || ! has npm; }; then
    if bootstrap_node && [ "$(node_major)" -ge 22 ] && has npm; then
      install_via_npm && exit 0
    fi
    warn "Node bootstrap did not yield Node >= 22 + npm; falling back to the binary ..."
  fi

  # Tier 2: standalone binary (no Node required).
  install_via_binary "$os" "$arch"
}

main "$@"
