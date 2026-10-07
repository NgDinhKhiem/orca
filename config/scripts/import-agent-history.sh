#!/usr/bin/env bash
# Bring this Mac's Claude Code and Codex conversations + context into Orca.
#
# Orca has no import step: it reads transcripts live from the agents' own homes
# and builds its search index from them. So this script copies nothing. It
# inventories conversations and context, checks Orca can actually see them,
# fixes the one thing it can (a non-default CLAUDE_CONFIG_DIR), and reports the
# search index.
#
# Usage:
#   ./config/scripts/import-agent-history.sh                     # inventory + checks + index status
#   ./config/scripts/import-agent-history.sh --link-claude-config-dir
#       # CLAUDE_CONFIG_DIR is non-default: symlink ~/.claude/projects to it so Orca lists those sessions
set -euo pipefail

LINK_CLAUDE_CONFIG_DIR=0
for arg in "$@"; do
  case "$arg" in
    --link-claude-config-dir) LINK_CLAUDE_CONFIG_DIR=1 ;;
    -h|--help)
      sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--link-claude-config-dir] [--help]" >&2
      exit 2 ;;
  esac
done

DEFAULT_CLAUDE_DIR="$HOME/.claude"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$DEFAULT_CLAUDE_DIR}"
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
INSTALL_DIR="${ORCA_INSTALL_DIR:-/Applications}"
APP="$(cd "$INSTALL_DIR" 2>/dev/null && pwd -P || echo "$INSTALL_DIR")/Orca.app"
WARNINGS=0

log() { printf '\033[1;34m[import-agent-history]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[import-agent-history] warning:\033[0m %s\n' "$*" >&2; WARNINGS=$((WARNINGS + 1)); }

# count_files <dir> <find predicates...>
count_files() {
  local dir="$1"; shift
  [[ -d "$dir" ]] || { echo 0; return; }
  find "$dir" -type f "$@" 2>/dev/null | wc -l | tr -d ' '
}
count_lines() { [[ -f "$1" ]] && wc -l < "$1" | tr -d ' ' || echo 0; }
size_of() { [[ -e "$1" ]] && du -sh "$1" 2>/dev/null | cut -f1 | tr -d ' ' || echo '-'; }
present() { [[ -e "$1" ]] && echo yes || echo no; }
row() { printf '  %-28s %10s %8s  %s\n' "$1" "$2" "$3" "$4"; }

# ---------------------------------------------------------------------------
# Claude Code
# ---------------------------------------------------------------------------
CLAUDE_PROJECTS="$CLAUDE_DIR/projects"
log "Claude Code home: $CLAUDE_DIR"
row "ITEM" "COUNT" "SIZE" "HOW ORCA USES IT"
row "conversations" \
  "$(count_files "$CLAUDE_PROJECTS" -name '*.jsonl' -not -path '*/subagents/*')" \
  "$(size_of "$CLAUDE_PROJECTS")" "session sidebar + search"
row "subagent conversations" \
  "$(count_files "$CLAUDE_PROJECTS" -name '*.jsonl' -path '*/subagents/*')" "" \
  "opened inside parent session"
row "project memory (*.md)" \
  "$(count_files "$CLAUDE_PROJECTS" -name '*.md' -path '*/memory/*')" "" \
  "read by Claude in Orca terminals"
row "CLAUDE.md (global)" "$(present "$CLAUDE_DIR/CLAUDE.md")" "" "read by Claude in Orca terminals"
row "prompt history" "$(count_lines "$CLAUDE_DIR/history.jsonl")" \
  "$(size_of "$CLAUDE_DIR/history.jsonl")" "read by Claude (up-arrow); not shown in Orca"

# Why: Orca's session sidebar and search hardcode ~/.claude/projects and ignore
# CLAUDE_CONFIG_DIR, so a relocated config dir's conversations are invisible.
if [[ "$CLAUDE_DIR" != "$DEFAULT_CLAUDE_DIR" && -d "$CLAUDE_PROJECTS" ]]; then
  if [[ "$(cd "$DEFAULT_CLAUDE_DIR/projects" 2>/dev/null && pwd -P)" == "$(cd "$CLAUDE_PROJECTS" && pwd -P)" ]]; then
    log "~/.claude/projects already points at $CLAUDE_PROJECTS"
  elif [[ "$LINK_CLAUDE_CONFIG_DIR" -eq 1 ]]; then
    if [[ -e "$DEFAULT_CLAUDE_DIR/projects" ]]; then
      warn "~/.claude/projects already exists; not replacing it. Merge it into $CLAUDE_PROJECTS by hand first."
    else
      mkdir -p "$DEFAULT_CLAUDE_DIR"
      ln -s "$CLAUDE_PROJECTS" "$DEFAULT_CLAUDE_DIR/projects"
      log "Linked ~/.claude/projects -> $CLAUDE_PROJECTS"
    fi
  else
    warn "CLAUDE_CONFIG_DIR=$CLAUDE_DIR, but Orca only lists ~/.claude/projects. Re-run with --link-claude-config-dir."
  fi
fi

# ---------------------------------------------------------------------------
# Codex
# ---------------------------------------------------------------------------
echo
log "Codex home: $CODEX_DIR"
row "ITEM" "COUNT" "SIZE" "HOW ORCA USES IT"
row "conversations" "$(count_files "$CODEX_DIR/sessions" -name '*.jsonl')" \
  "$(size_of "$CODEX_DIR/sessions")" "session sidebar + search"
row "archived conversations" "$(count_files "$CODEX_DIR/archived_sessions" -name '*.jsonl')" \
  "$(size_of "$CODEX_DIR/archived_sessions")" "session sidebar + search (Orca with archived support)"
row "session titles index" "$(count_lines "$CODEX_DIR/session_index.jsonl")" "" "titles in sidebar"
row "AGENTS.md (global)" "$(present "$CODEX_DIR/AGENTS.md")" "" "read by Codex; mirrored into Orca's Codex home"
row "memories" "$(count_files "$CODEX_DIR/memories")" "$(size_of "$CODEX_DIR/memories")" \
  "read by Codex in Orca terminals"
row "prompt history" "$(count_lines "$CODEX_DIR/history.jsonl")" \
  "$(size_of "$CODEX_DIR/history.jsonl")" "read by Codex; not shown in Orca"

if [[ -n "${CODEX_HOME:-}" && "$CODEX_HOME" != "$HOME/.codex" ]]; then
  warn "CODEX_HOME=$CODEX_HOME is set in this shell only. Orca opened from Finder/Dock reads ~/.codex unless launched with it."
fi

# ---------------------------------------------------------------------------
# File health: Orca skips what it cannot read and lists empty files as nothing.
# ---------------------------------------------------------------------------
echo
UNREADABLE=0
EMPTY=0
for dir in "$CLAUDE_PROJECTS" "$CODEX_DIR/sessions" "$CODEX_DIR/archived_sessions"; do
  [[ -d "$dir" ]] || continue
  UNREADABLE=$((UNREADABLE + $(find "$dir" -type f -name '*.jsonl' ! -perm -u+r 2>/dev/null | wc -l)))
  EMPTY=$((EMPTY + $(find "$dir" -type f -name '*.jsonl' -empty 2>/dev/null | wc -l)))
done
if [[ "$UNREADABLE" -gt 0 ]]; then
  warn "$UNREADABLE transcript(s) are not readable by $(whoami); Orca will skip them. Fix with: chmod u+r <file>"
fi
log "Transcript files: $UNREADABLE unreadable, $EMPTY empty (empty ones have nothing to show)"

# ---------------------------------------------------------------------------
# Orca side
# ---------------------------------------------------------------------------
echo
if [[ ! -d "$APP" ]]; then
  warn "Orca is not installed at $APP. Build + install with ./config/scripts/mac-build-install.sh"
else
  VERSION=$(defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo '?')
  log "Orca installed: $APP ($VERSION)"
  # Why app.asar.unpacked: the session scanner runs in a child service, so its chunk is unpacked.
  RES="$APP/Contents/Resources"
  if LC_ALL=C grep -rqs 'session_index.jsonl' "$RES/app.asar.unpacked/out/main" "$RES/app.asar" \
    && ! LC_ALL=C grep -rqs 'archived_sessions' "$RES/app.asar.unpacked/out/main" "$RES/app.asar"; then
    warn "This Orca build does not read ~/.codex/archived_sessions. Rebuild from this checkout to include them."
  fi

  ORCA_CLI="$(command -v orca 2>/dev/null || true)"
  [[ -n "$ORCA_CLI" ]] || ORCA_CLI="$APP/Contents/Resources/bin/orca"
  if pgrep -f "$APP/Contents/MacOS/" >/dev/null 2>&1 && [[ -x "$ORCA_CLI" ]]; then
    log "Search index status (from the running Orca):"
    "$ORCA_CLI" search --index-status 2>&1 | sed 's/^/  /' || warn "could not read index status"
  else
    log "Orca is not running; open it to see the search index status."
  fi
fi

echo
log "Next steps in Orca:"
echo "  1. Settings -> Session History: turn on session search (off by default; indexes all history)."
echo "  2. The index rebuilds itself every ~20s while on. Check with: orca search --index-status"
echo "  3. Try: orca search \"<something you remember>\" --scope conversation"

if [[ "$WARNINGS" -gt 0 ]]; then
  echo
  log "$WARNINGS warning(s) above."
fi
