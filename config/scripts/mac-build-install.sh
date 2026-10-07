#!/usr/bin/env bash
# Build Orca for macOS from source and install (or update) it in /Applications.
# Works from a fresh clone: bootstraps Xcode CLT check, Node 24, the pinned pnpm,
# root + mobile dependencies, the full `pnpm build:mac`, then swaps the app in.
#
# Usage:
#   ./config/scripts/mac-build-install.sh             # build + install/update /Applications/Orca.app
#   ./config/scripts/mac-build-install.sh --pull      # git pull --ff-only first (update source)
#   ./config/scripts/mac-build-install.sh --open      # launch Orca after installing
#   ./config/scripts/mac-build-install.sh --no-install  # build only, leave /Applications alone
#   ORCA_INSTALL_DIR=~/Applications ./config/scripts/mac-build-install.sh   # other install dir
set -euo pipefail

PULL=0
OPEN=0
INSTALL=1
for arg in "$@"; do
  case "$arg" in
    --pull) PULL=1 ;;
    --open) OPEN=1 ;;
    --no-install) INSTALL=0 ;;
    -h|--help)
      sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--pull] [--open] [--no-install] [--help]" >&2
      exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL_DIR="${ORCA_INSTALL_DIR:-/Applications}"
APP_NAME="Orca.app"
APP_ID="com.stablyai.orca"
REQUIRED_NODE_MAJOR=24
START_TS=$(date +%s)

log() { printf '\033[1;34m[mac-build-install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[mac-build-install] warning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[mac-build-install] error:\033[0m %s\n' "$*" >&2; exit 1; }

cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# 1. Host checks
# ---------------------------------------------------------------------------
[[ "$(uname -s)" == "Darwin" ]] || die "macOS only."
[[ -f package.json && -d .git ]] || die "$REPO_ROOT is not an Orca git checkout."

case "$(uname -m)" in
  arm64) HOST_ARCH=arm64; BUILT_APP="dist/mac-arm64/$APP_NAME" ;;
  x86_64) HOST_ARCH=x64; BUILT_APP="dist/mac/$APP_NAME" ;;
  *) die "Unsupported CPU architecture: $(uname -m)" ;;
esac

if ! xcode-select -p >/dev/null 2>&1 || ! xcrun --find swift >/dev/null 2>&1; then
  log "Xcode Command Line Tools missing; opening the installer."
  xcode-select --install || true
  die "Finish the Command Line Tools install, then re-run this script."
fi

FREE_GB=$(df -g "$REPO_ROOT" | awk 'NR==2 {print $4}')
if [[ -n "$FREE_GB" && "$FREE_GB" -lt 20 ]]; then
  warn "only ${FREE_GB} GB free; a full x64+arm64 build needs roughly 15-20 GB."
fi

# ---------------------------------------------------------------------------
# 2. Optional source update
# ---------------------------------------------------------------------------
if [[ "$PULL" -eq 1 ]]; then
  log "Updating source (git pull --ff-only)"
  git pull --ff-only
fi

# ---------------------------------------------------------------------------
# 3. Node 24
# ---------------------------------------------------------------------------
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

if [[ "$(node_major)" != "$REQUIRED_NODE_MAJOR" ]]; then
  log "Node $REQUIRED_NODE_MAJOR not active (found: $(node -v 2>/dev/null || echo none)); provisioning it."
  NVM_SH="${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  if [[ -s "$NVM_SH" ]]; then
    # Why set +u: nvm.sh references unset variables and aborts under `set -u`.
    set +u
    # shellcheck disable=SC1090
    . "$NVM_SH"
    nvm install "$REQUIRED_NODE_MAJOR"
    nvm use "$REQUIRED_NODE_MAJOR"
    set -u
  elif command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env)"
    fnm install "$REQUIRED_NODE_MAJOR"
    fnm use "$REQUIRED_NODE_MAJOR"
  elif command -v brew >/dev/null 2>&1; then
    brew install "node@$REQUIRED_NODE_MAJOR"
    export PATH="$(brew --prefix "node@$REQUIRED_NODE_MAJOR")/bin:$PATH"
  else
    die "Install Node $REQUIRED_NODE_MAJOR (https://nodejs.org, nvm, fnm, or Homebrew) and re-run."
  fi
  [[ "$(node_major)" == "$REQUIRED_NODE_MAJOR" ]] || die "Node $REQUIRED_NODE_MAJOR still not active: $(node -v)"
fi
log "Node $(node -v)"

# ---------------------------------------------------------------------------
# 4. pnpm, pinned by package.json "packageManager"
# ---------------------------------------------------------------------------
PNPM_VERSION=$(node -p 'require("./package.json").packageManager.split("@")[1].split("+")[0]')
if [[ "$(pnpm -v 2>/dev/null || true)" != "$PNPM_VERSION" ]]; then
  log "Installing pnpm $PNPM_VERSION"
  # Why npm and not corepack: older corepack releases cannot activate pnpm 12's package layout.
  if ! npm install -g "pnpm@$PNPM_VERSION"; then
    warn "global npm prefix not writable; installing pnpm under ~/.local"
    npm install -g --prefix "$HOME/.local" "pnpm@$PNPM_VERSION"
    export PATH="$HOME/.local/bin:$PATH"
  fi
  hash -r
fi
[[ "$(pnpm -v)" == "$PNPM_VERSION" ]] || die "pnpm $PNPM_VERSION not on PATH (found $(pnpm -v))."
log "pnpm $(pnpm -v)"

# ---------------------------------------------------------------------------
# 5. Dependencies
# ---------------------------------------------------------------------------
# Why install:release: build:mac packs x64 and arm64, and a host-only install
# leaves the other arch's native modules missing (see AGENTS.md).
log "Installing root dependencies (both CPU architectures)"
pnpm install:release

# Why: mobile/ is its own workspace and lockfile; build:mobile-web needs its deps.
log "Installing mobile workspace dependencies"
pnpm --dir mobile install --frozen-lockfile

# ---------------------------------------------------------------------------
# 6. Build + package
# ---------------------------------------------------------------------------
log "Building and packaging (pnpm build:mac)"
pnpm build:mac

[[ -d "$BUILT_APP" ]] || die "Expected packaged app at $BUILT_APP, but it is missing."
log "Packaged: $REPO_ROOT/$BUILT_APP"
ls -1 dist/*.dmg dist/*.zip 2>/dev/null | sed 's/^/  /' || true

# ---------------------------------------------------------------------------
# 7. Install / update in $INSTALL_DIR
# ---------------------------------------------------------------------------
if [[ "$INSTALL" -eq 1 ]]; then
  TARGET="$INSTALL_DIR/$APP_NAME"
  SUDO=""
  mkdir -p "$INSTALL_DIR" 2>/dev/null || true
  if [[ ! -w "$INSTALL_DIR" ]] || { [[ -e "$TARGET" ]] && [[ ! -w "$TARGET" ]]; }; then
    log "$INSTALL_DIR needs admin rights; sudo will prompt."
    SUDO="sudo"
  fi

  if pgrep -f "$TARGET/Contents/MacOS/" >/dev/null 2>&1; then
    log "Quitting running Orca before updating"
    osascript -e "tell application id \"$APP_ID\" to quit" >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do
      pgrep -f "$TARGET/Contents/MacOS/" >/dev/null 2>&1 || break
      sleep 1
    done
    # Why abort instead of kill: Orca may hold unsaved editors and live agent sessions.
    if pgrep -f "$TARGET/Contents/MacOS/" >/dev/null 2>&1; then
      die "Orca is still running. Quit it manually and re-run (the build is ready in $BUILT_APP)."
    fi
  fi

  STAGING="$INSTALL_DIR/.Orca.app.installing"
  BACKUP="$INSTALL_DIR/.Orca.app.previous"
  $SUDO rm -rf "$STAGING" "$BACKUP"

  log "Copying app into $INSTALL_DIR"
  $SUDO ditto "$BUILT_APP" "$STAGING"

  if [[ -e "$TARGET" ]]; then
    log "Replacing existing $TARGET"
    $SUDO mv "$TARGET" "$BACKUP"
  fi
  if ! $SUDO mv "$STAGING" "$TARGET"; then
    [[ -e "$BACKUP" ]] && $SUDO mv "$BACKUP" "$TARGET"
    die "Could not move the new app into place; previous version restored."
  fi
  $SUDO rm -rf "$BACKUP"
  # Locally built apps carry no quarantine flag, but a copied-in tree might.
  $SUDO xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true

  INSTALLED_VERSION=$(defaults read "$TARGET/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo "?")
  log "Installed $TARGET (version $INSTALLED_VERSION, $HOST_ARCH)"

  if [[ "$OPEN" -eq 1 ]]; then
    open "$TARGET"
  fi
fi

ELAPSED=$(( $(date +%s) - START_TS ))
log "Done in $((ELAPSED / 60))m $((ELAPSED % 60))s"
