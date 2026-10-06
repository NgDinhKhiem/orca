import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { queryWindowsProcessIdentity } = vi.hoisted(() => ({
  queryWindowsProcessIdentity: vi.fn()
}))
vi.mock('./daemon-process-identity-query', () => ({
  queryWindowsProcessIdentity,
  getPsProcessIdentityAsync: vi.fn(async () => null)
}))

import { isDaemonStaleForCurrentBundle } from './daemon-bundle-staleness'
import { getDaemonLaunchIdentity } from './daemon-pid-identity'
import { getDaemonPidPath, serializeDaemonPidFile } from './daemon-spawner'

const STARTED_AT_MS = 1_700_000_000_000
const realPlatform = process.platform

describe('daemon replacement preflight identity reads', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let entryPath: string

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    dir = mkdtempSync(join(tmpdir(), 'daemon-verified-pid-reuse-'))
    socketPath = join(dir, 'daemon.sock')
    tokenPath = join(dir, 'daemon.token')
    entryPath = join(dir, 'daemon-entry.js')
    queryWindowsProcessIdentity.mockReset()
    queryWindowsProcessIdentity.mockResolvedValue({
      commandLine: `node ${entryPath} daemon-entry --socket ${socketPath} --token ${tokenPath}`,
      startedAtMs: STARTED_AT_MS
    })
    // The current process stands in for the daemon so `process.kill(pid, 0)` succeeds.
    writeFileSync(
      getDaemonPidPath(dir),
      serializeDaemonPidFile({
        pid: process.pid,
        startedAtMs: STARTED_AT_MS,
        entryPath,
        appVersion: '1.2.2'
      })
    )
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    rmSync(dir, { recursive: true, force: true })
  })

  it('shares one Windows identity query between concurrent launch-identity and staleness checks', async () => {
    const [identity, stale] = await Promise.all([
      getDaemonLaunchIdentity(dir, socketPath, tokenPath, entryPath),
      isDaemonStaleForCurrentBundle(dir, socketPath, tokenPath, '1.2.3')
    ])
    expect(identity).toBe('match')
    expect(stale).toBe(true)
    expect(queryWindowsProcessIdentity).toHaveBeenCalledTimes(1)
  })

  it('verifies afresh once the shared query has settled', async () => {
    expect(await getDaemonLaunchIdentity(dir, socketPath, tokenPath, entryPath)).toBe('match')
    expect(await getDaemonLaunchIdentity(dir, socketPath, tokenPath, entryPath)).toBe('match')
    expect(queryWindowsProcessIdentity).toHaveBeenCalledTimes(2)
  })

  it('verifies again when the pid file changes', async () => {
    expect(await getDaemonLaunchIdentity(dir, socketPath, tokenPath, entryPath)).toBe('match')
    writeFileSync(
      getDaemonPidPath(dir),
      serializeDaemonPidFile({
        pid: process.pid,
        startedAtMs: STARTED_AT_MS,
        entryPath,
        appVersion: '1.2.3'
      })
    )
    expect(await isDaemonStaleForCurrentBundle(dir, socketPath, tokenPath, '1.2.3')).toBe(false)
    expect(queryWindowsProcessIdentity).toHaveBeenCalledTimes(2)
  })
})
