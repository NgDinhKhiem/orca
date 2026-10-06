import type * as NodeFs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { openSyncSpy } = vi.hoisted(() => ({ openSyncSpy: vi.fn() }))

// Why a pass-through spy: POSIX mode bits are invisible on Windows, but the requested mode is not.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  openSyncSpy.mockImplementation(actual.openSync)
  return { ...actual, openSync: openSyncSpy }
})

import { RotatingLogWriter } from './rotating-log-writer'

describe('RotatingLogWriter file mode', () => {
  let dir: string
  let logPath: string

  beforeEach(() => {
    openSyncSpy.mockClear()
    dir = mkdtempSync(path.join(tmpdir(), 'relay-log-mode-'))
    logPath = path.join(dir, 'relay.log')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates relay.log and every rotated replacement owner-only', () => {
    const writer = new RotatingLogWriter(logPath, 1024)
    try {
      for (let i = 0; i < 20; i += 1) {
        writer.write(`${'x'.repeat(200)}\n`)
      }
    } finally {
      writer.dispose()
    }

    const opens = openSyncSpy.mock.calls.filter(([file]) => file === logPath)
    expect(opens.length).toBeGreaterThan(1)
    for (const [, , mode] of opens) {
      expect(mode).toBe(0o600)
    }
  })
})
