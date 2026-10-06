import type * as NodeFs from 'node:fs'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { grantClaudeFolderTrust } from './claude-folder-trust-file'

const fsSpy = vi.hoisted(() => ({
  reads: new Map<string, number>(),
  // Why: models a write the stat cannot see (same size, same mtime/ctime tick, same inode).
  frozenStats: new Map<string, NodeFs.Stats>()
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const [path] = args
      if (typeof path === 'string') {
        fsSpy.reads.set(path, (fsSpy.reads.get(path) ?? 0) + 1)
      }
      return actual.readFileSync(...args)
    },
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      const [path] = args
      const frozen = typeof path === 'string' ? fsSpy.frozenStats.get(path) : undefined
      return frozen ?? actual.statSync(...args)
    }
  }
})

let root: string
let file: string

function writeSettledConfig(value: unknown, mtimeSeconds: number): void {
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 })
  chmodSync(file, 0o600)
  // Why: an mtime well in the past is outside the racy-write window, so the parse is cacheable.
  utimesSync(file, mtimeSeconds, mtimeSeconds)
}

function readsOf(path: string): number {
  return fsSpy.reads.get(path) ?? 0
}

const settledSeconds = Math.floor(Date.now() / 1000) - 3600

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-claude-trust-cache-')))
  file = join(root, '.claude.json')
  fsSpy.reads.clear()
  fsSpy.frozenStats.clear()
})

afterEach(() => {
  fsSpy.frozenStats.clear()
  rmSync(root, { recursive: true, force: true })
})

describe('grantClaudeFolderTrust config read cache', () => {
  it('parses an unchanged config once across repeated already-trusted launches', async () => {
    writeSettledConfig({ projects: { '/wt': { hasTrustDialogAccepted: true } } }, settledSeconds)
    for (let launch = 0; launch < 3; launch++) {
      await expect(grantClaudeFolderTrust({ configFile: file, folderKeys: ['/wt'] })).resolves.toBe(
        'unchanged'
      )
    }
    expect(readsOf(file)).toBe(1)
  })

  it('re-reads the config once its size or mtime changes', async () => {
    writeSettledConfig({ projects: { '/wt': { hasTrustDialogAccepted: true } } }, settledSeconds)
    await grantClaudeFolderTrust({ configFile: file, folderKeys: ['/wt'] })
    // Why: Claude dropped the trust entry; a stale cache would still answer `unchanged`.
    writeSettledConfig({ projects: { '/wt': {} } }, settledSeconds + 60)
    await expect(grantClaudeFolderTrust({ configFile: file, folderKeys: ['/wt'] })).resolves.toBe(
      'granted'
    )
    expect(JSON.parse(readFileSync(file, 'utf-8')).projects).toEqual({
      '/wt': { hasTrustDialogAccepted: true }
    })
  })

  it("rewrites from fresh content, keeping Claude's write the stat could not see", async () => {
    const seen = { '/seen': { hasTrustDialogAccepted: true } }
    writeSettledConfig({ theme: 'dark', projects: seen }, settledSeconds)
    await expect(grantClaudeFolderTrust({ configFile: file, folderKeys: ['/seen'] })).resolves.toBe(
      'unchanged'
    )
    fsSpy.frozenStats.set(file, statSync(file))
    writeFileSync(file, JSON.stringify({ theme: 'lite', projects: seen }))
    await expect(grantClaudeFolderTrust({ configFile: file, folderKeys: ['/wt'] })).resolves.toBe(
      'granted'
    )
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({
      theme: 'lite',
      projects: { ...seen, '/wt': { hasTrustDialogAccepted: true } }
    })
  })

  it("sees Orca's own grant on the next launch", async () => {
    writeSettledConfig({ projects: {} }, settledSeconds)
    await expect(grantClaudeFolderTrust({ configFile: file, folderKeys: ['/wt'] })).resolves.toBe(
      'granted'
    )
    await expect(grantClaudeFolderTrust({ configFile: file, folderKeys: ['/wt'] })).resolves.toBe(
      'unchanged'
    )
  })
})
