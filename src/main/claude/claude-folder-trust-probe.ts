import { ClaudeConfigProjectionCache } from './claude-config-projection-cache'

export function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isTrustedClaudeProjectEntry(entry: unknown): boolean {
  return isPlainJsonObject(entry) && entry.hasTrustDialogAccepted === true
}

/** The trusted project keys, or why the config cannot be rewritten — not the multi-MB parse. */
type ClaudeTrustSummary = 'unreadable' | ReadonlySet<string>

function summarizeClaudeFolderTrust(parsed: unknown): ClaudeTrustSummary {
  if (!isPlainJsonObject(parsed)) {
    return 'unreadable'
  }
  const { projects } = parsed
  if (projects === undefined) {
    return new Set()
  }
  if (!isPlainJsonObject(projects)) {
    return 'unreadable'
  }
  return new Set(Object.keys(projects).filter((key) => isTrustedClaudeProjectEntry(projects[key])))
}

// Why: every Claude launch probes this config; re-parse it only when Claude has changed it.
const trustSummaryCache = new ClaudeConfigProjectionCache(summarizeClaudeFolderTrust)

function readClaudeTrustSummary(configPath: string): ClaudeTrustSummary {
  try {
    return trustSummaryCache.readSync(configPath)
  } catch {
    return 'unreadable'
  }
}

/** Mirrors `applyClaudeFolderTrust` against a cached summary, so most launches skip the parse. */
export function planClaudeFolderTrust(
  configPath: string,
  folderKeys: readonly string[]
): 'changed' | 'unchanged' | 'unreadable' {
  const summary = readClaudeTrustSummary(configPath)
  if (summary === 'unreadable') {
    return 'unreadable'
  }
  return folderKeys.some((key) => summary.has(key)) ? 'unchanged' : 'changed'
}
