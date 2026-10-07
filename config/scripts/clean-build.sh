#!/usr/bin/env bash
# Remove Orca build output so the next build starts clean.
#
# Usage:
#   ./config/scripts/clean-build.sh            # dist/, out/, native .build dirs, tsbuildinfo, caches
#   ./config/scripts/clean-build.sh --all      # also node_modules (root, mobile, native workspaces)
#   ./config/scripts/clean-build.sh --dry-run  # list what would be removed, delete nothing
set -euo pipefail

ALL=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --all) ALL=1 ;;
    --dry-run|-n) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--all] [--dry-run] [--help]" >&2
      exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
[[ -f package.json && -d .git ]] || { echo "[clean-build] $REPO_ROOT is not an Orca checkout" >&2; exit 1; }

# Candidates only; the loop below deletes a path only if git ignores it.
TARGETS=$(
  {
    for p in dist dist-electron out release build .oxlintcache coverage mobile/dist mobile/.expo; do
      [[ -e "$p" ]] && echo "$p"
    done
    find native -type d \( -name .build -o -name target \) -prune -print 2>/dev/null
    for p in native/windows-registry/build native/windows-registry/bin; do
      [[ -e "$p" ]] && echo "$p"
    done
    find . -maxdepth 3 -name '*.tsbuildinfo' -not -path '*/node_modules/*' -print 2>/dev/null | sed 's|^\./||'
    if [[ "$ALL" -eq 1 ]]; then
      find . -maxdepth 3 -type d -name node_modules -not -path '*/node_modules/*/*' -prune -print 2>/dev/null | sed 's|^\./||'
    fi
  } | sort -u
)

if [[ -z "$TARGETS" ]]; then
  echo "[clean-build] nothing to clean"
  exit 0
fi

while IFS= read -r path; do
  [[ -n "$path" ]] || continue
  # Guard: refuse anything absolute, upward, tracked, or not git-ignored.
  case "$path" in /*|..*|*/../*) echo "[clean-build] skip unsafe path: $path" >&2; continue ;; esac
  if [[ -n "$(git ls-files -- "$path" | head -n 1)" ]] || ! git check-ignore -q -- "$path"; then
    echo "[clean-build] skip non-ignored path: $path" >&2
    continue
  fi
  size=$(du -sh "$path" 2>/dev/null | cut -f1)
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[clean-build] would remove $path ($size)"
  else
    rm -rf -- "$path"
    echo "[clean-build] removed $path ($size)"
  fi
done <<< "$TARGETS"

if [[ "$ALL" -eq 1 && "$DRY_RUN" -eq 0 ]]; then
  echo "[clean-build] node_modules removed; next build reinstalls them (mac-build-install.sh does this)."
fi
