import { readFileSync, statSync, type Stats } from 'node:fs'

// Why: like git's racy-clean check, reuse a parse only once its mtime is older than the coarsest
// timestamp tick (FAT: 2 s), so a same-tick, same-size rewrite cannot hide behind an equal stat.
const RACY_MTIME_WINDOW_MS = 2_000
// Why: Orca reads only a handful of Claude configs (host, CLAUDE_CONFIG_DIR, WSL guests).
const MAX_ENTRIES_PER_CACHE = 8

const liveCaches = new Set<{ forget: (filePath: string) => void }>()

function fileVersion(stats: Stats): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`
}

function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Re-parses a Claude config file (often several MB, rewritten by Claude itself) only when its
 * stat changes, and keeps just the small projection a caller needs. For reads only: a
 * read-modify-write must read the file fresh. Projections are shared, so never mutate one.
 */
export class ClaudeConfigProjectionCache<T> {
  private readonly entries = new Map<string, { version: string; value: T }>()

  /** `project` receives `undefined` when the file is not valid JSON. */
  constructor(private readonly project: (parsed: unknown) => T) {
    liveCaches.add(this)
  }

  /** Throws when the file cannot be stat'd or read (e.g. ENOENT). */
  readSync(filePath: string): T {
    const stats = statSync(filePath)
    const version = fileVersion(stats)
    const cached = this.entries.get(filePath)
    if (cached?.version === version) {
      return cached.value
    }
    // Why: a change after the stat only leaves a newer parse under an older version — a later miss.
    const value = this.project(parseJsonOrUndefined(readFileSync(filePath, 'utf-8')))
    this.entries.delete(filePath)
    if (Date.now() - stats.mtimeMs >= RACY_MTIME_WINDOW_MS) {
      this.entries.set(filePath, { version, value })
      const oldest = this.entries.keys().next().value
      if (this.entries.size > MAX_ENTRIES_PER_CACHE && oldest !== undefined) {
        this.entries.delete(oldest)
      }
    }
    return value
  }

  forget(filePath: string): void {
    this.entries.delete(filePath)
  }
}

/** Drops every cached projection of `filePath`; call after Orca rewrites it. */
export function forgetCachedClaudeConfig(filePath: string): void {
  for (const cache of liveCaches) {
    cache.forget(filePath)
  }
}
