import { describe, expect, it, vi } from 'vitest'
import type { NestedRepoScanResult } from '../../shared/project-group-types'

const { isGitRepo, isGitRepoAsync, scanNestedRepos } = vi.hoisted(() => ({
  isGitRepo: vi.fn(() => true),
  isGitRepoAsync: vi.fn(),
  scanNestedRepos: vi.fn()
}))

vi.mock('../git/repo', () => ({
  isGitRepo,
  isGitRepoAsync,
  getRepoName: (path: string) => path.split('/').pop() ?? path
}))
vi.mock('../git/runner', () => ({ awaitWindowsHostGitEnvironmentReady: async () => {} }))
vi.mock('../project-groups/nested-repo-discovery', () => ({ scanNestedRepos }))
vi.mock('../project-groups/nested-repo-import-target', () => ({
  createNestedRepoImportTargetResolver: () => ({ resolveLocal: async (path: string) => path })
}))

import { RuntimeNestedRepoImport } from './runtime-nested-repo-import'

const PARENT = '/srv/platform'
const REPO_PATHS = Array.from({ length: 20 }, (_, index) => `${PARENT}/repo-${index}`)

function scanResult(): NestedRepoScanResult {
  return {
    selectedPath: PARENT,
    selectedPathKind: 'non_git_folder',
    repos: REPO_PATHS.map((path) => ({
      path,
      displayName: path.split('/').pop() ?? path,
      depth: 1
    })),
    truncated: false,
    timedOut: false,
    stopped: false,
    durationMs: 1,
    maxDepth: 4,
    maxRepos: 500,
    timeoutMs: 15_000
  }
}

describe('RuntimeNestedRepoImport', () => {
  it('probes repositories asynchronously with bounded concurrency, keeping result order', async () => {
    scanNestedRepos.mockResolvedValue(scanResult())
    let active = 0
    let maximum = 0
    isGitRepoAsync.mockImplementation(async (path: string) => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active -= 1
      return path !== REPO_PATHS[5]
    })
    const addRepo = vi.fn()
    const store = {
      createProjectGroup: vi.fn(),
      moveProjectToGroup: vi.fn(),
      deleteProjectGroup: vi.fn(),
      getRepos: () => [],
      addRepo
    }
    const importer = new RuntimeNestedRepoImport({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the importer only calls the store methods stubbed above.
      getStore: () => store as never,
      invalidateResolvedWorktrees: vi.fn(),
      invalidateWorktreeScan: vi.fn(),
      notifyReposChanged: vi.fn()
    })

    const result = await importer.import({
      parentPath: PARENT,
      groupName: '',
      projectPaths: REPO_PATHS,
      mode: 'separate'
    })

    expect(isGitRepo).not.toHaveBeenCalled()
    expect(maximum).toBeGreaterThan(1)
    expect(maximum).toBeLessThanOrEqual(6)
    expect(result.projects.map((project) => project.path)).toEqual(REPO_PATHS)
    expect(result.projects[5]).toMatchObject({
      status: 'failed',
      error: 'Not a valid git repository'
    })
    expect(addRepo).toHaveBeenCalledTimes(19)
  })
})
