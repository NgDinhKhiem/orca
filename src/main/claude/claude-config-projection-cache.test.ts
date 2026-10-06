import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ClaudeConfigProjectionCache,
  forgetCachedClaudeConfig
} from './claude-config-projection-cache'

const settledSeconds = Math.floor(Date.now() / 1000) - 3600
let root: string
let file: string

function writeConfig(value: unknown, mtimeSeconds: number | null = settledSeconds): void {
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
  if (mtimeSeconds !== null) {
    utimesSync(file, mtimeSeconds, mtimeSeconds)
  }
}

function countingCache(): {
  cache: ClaudeConfigProjectionCache<unknown>
  project: ReturnType<typeof vi.fn<(parsed: unknown) => unknown>>
} {
  const project = vi.fn((parsed: unknown) => parsed)
  return { cache: new ClaudeConfigProjectionCache(project), project }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-claude-config-cache-'))
  file = join(root, '.claude.json')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('ClaudeConfigProjectionCache', () => {
  it('projects an unchanged file once', () => {
    writeConfig({ a: 1 })
    const { cache, project } = countingCache()
    expect(cache.readSync(file)).toEqual({ a: 1 })
    expect(cache.readSync(file)).toEqual({ a: 1 })
    expect(project).toHaveBeenCalledTimes(1)
  })

  it('re-projects when the size or mtime changes', () => {
    writeConfig({ a: 1 })
    const { cache, project } = countingCache()
    cache.readSync(file)
    writeConfig({ a: 22 })
    expect(cache.readSync(file)).toEqual({ a: 22 })
    writeConfig({ a: 33 }, settledSeconds + 60)
    expect(cache.readSync(file)).toEqual({ a: 33 })
    expect(project).toHaveBeenCalledTimes(3)
  })

  it('re-projects an in-place rewrite that keeps the size and mtime', async () => {
    writeConfig({ a: 1 })
    const { cache } = countingCache()
    cache.readSync(file)
    // Why: past a coarse ctime tick (Linux uses jiffies) so the rewrite's ctime is distinct.
    await new Promise((resolve) => setTimeout(resolve, 25))
    // Same size and restored mtime; only the ctime the rewrite bumps tells them apart.
    writeConfig({ a: 2 })
    expect(cache.readSync(file)).toEqual({ a: 2 })
  })

  it('never caches a file written inside the racy-mtime window', () => {
    writeConfig({ a: 1 }, null)
    const { cache, project } = countingCache()
    cache.readSync(file)
    cache.readSync(file)
    expect(project).toHaveBeenCalledTimes(2)
  })

  it('projects invalid JSON as undefined and throws for a missing file', () => {
    writeConfig('{"a": ')
    const { cache } = countingCache()
    expect(cache.readSync(file)).toBeUndefined()
    expect(() => cache.readSync(join(root, 'missing.json'))).toThrow(/ENOENT/)
  })

  it('drops an entry Orca has just rewritten', () => {
    writeConfig({ a: 1 })
    const { cache, project } = countingCache()
    cache.readSync(file)
    forgetCachedClaudeConfig(file)
    cache.readSync(file)
    expect(project).toHaveBeenCalledTimes(2)
  })
})
