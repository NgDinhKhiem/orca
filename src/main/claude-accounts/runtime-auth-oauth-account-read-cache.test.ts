import type * as NodeFs from 'node:fs'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createElectronMock,
  createKeychainMock,
  testState
} from './runtime-auth-service-test-harness'
import { ClaudeRuntimeAuthRuntimeState } from './runtime-auth/runtime-auth-runtime-state'
import { RUNTIME_OAUTH_ACCOUNT_PARSE_ERROR } from './runtime-auth/runtime-auth-types'

const reads = vi.hoisted(() => new Map<string, number>())

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const [path] = args
      if (typeof path === 'string') {
        reads.set(path, (reads.get(path) ?? 0) + 1)
      }
      return actual.readFileSync(...args)
    }
  }
})
vi.mock('electron', () => createElectronMock())
vi.mock('./keychain', () => createKeychainMock())

class RuntimeStateProbe extends ClaudeRuntimeAuthRuntimeState {
  constructor() {
    super({ getSettings: vi.fn(), updateSettings: vi.fn() } as never)
  }

  readOauthAccount(): unknown {
    return this.readRuntimeOauthAccount()
  }

  writeOauthAccount(oauthAccount: unknown): boolean {
    return this.writeRuntimeOauthAccount(oauthAccount)
  }
}

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const settledSeconds = Math.floor(Date.now() / 1000) - 3600
let configDir: string
let configPath: string

function writeSettledConfig(value: unknown, mtimeSeconds = settledSeconds): void {
  writeFileSync(configPath, JSON.stringify(value))
  utimesSync(configPath, mtimeSeconds, mtimeSeconds)
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'orca-claude-oauth-cache-'))
  configPath = join(configDir, '.claude.json')
  testState.userDataDir = configDir
  process.env.CLAUDE_CONFIG_DIR = configDir
  reads.clear()
})

afterEach(() => {
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  rmSync(configDir, { recursive: true, force: true })
})

describe('ClaudeRuntimeAuthRuntimeState runtime oauthAccount reads', () => {
  it('parses an unchanged ~/.claude.json once across repeated reads', () => {
    writeSettledConfig({ oauthAccount: { emailAddress: 'a@example.com' }, projects: {} })
    const probe = new RuntimeStateProbe()
    for (let read = 0; read < 3; read++) {
      expect(probe.readOauthAccount()).toEqual({ emailAddress: 'a@example.com' })
    }
    expect(reads.get(configPath) ?? 0).toBe(1)
  })

  it('re-reads after Claude changes the file', () => {
    writeSettledConfig({ oauthAccount: { emailAddress: 'a@example.com' } })
    const probe = new RuntimeStateProbe()
    expect(probe.readOauthAccount()).toEqual({ emailAddress: 'a@example.com' })
    writeSettledConfig({ oauthAccount: { emailAddress: 'bb@example.com' } }, settledSeconds + 60)
    expect(probe.readOauthAccount()).toEqual({ emailAddress: 'bb@example.com' })
  })

  it('hands out copies so a caller cannot corrupt the cached account', () => {
    writeSettledConfig({ oauthAccount: { emailAddress: 'a@example.com' } })
    const probe = new RuntimeStateProbe()
    const first = probe.readOauthAccount()
    if (first && typeof first === 'object') {
      Object.assign(first, { emailAddress: 'mutated@example.com' })
    }
    expect(probe.readOauthAccount()).toEqual({ emailAddress: 'a@example.com' })
  })

  it('reports a parse error for a corrupt file and null for a missing one', () => {
    const probe = new RuntimeStateProbe()
    expect(probe.readOauthAccount()).toBeNull()
    writeFileSync(configPath, '{"oauthAccount": ')
    expect(probe.readOauthAccount()).toBe(RUNTIME_OAUTH_ACCOUNT_PARSE_ERROR)
  })

  it("sees Orca's own oauthAccount write and keeps Claude's other fields", () => {
    writeSettledConfig({ oauthAccount: { emailAddress: 'a@example.com' }, numStartups: 3 })
    const probe = new RuntimeStateProbe()
    expect(probe.readOauthAccount()).toEqual({ emailAddress: 'a@example.com' })
    expect(probe.writeOauthAccount({ emailAddress: 'b@example.com' })).toBe(true)
    expect(probe.readOauthAccount()).toEqual({ emailAddress: 'b@example.com' })
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual({
      oauthAccount: { emailAddress: 'b@example.com' },
      numStartups: 3
    })
  })
})
