import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createFsmonitorMarkerRepo,
  createTextconvMarkerRepo
} from '../shared/git-repo-config-command-test-fixture'
import type { MockDispatcher } from './git-handler-test-setup'
import {
  createGitHandlerRelay,
  createGitTempDir,
  removeGitTempDir
} from './git-handler-test-harness'
import { listFilesWithGit } from './fs-handler-git-fallback'
import { searchWithGitGrep } from './fs-handler-git-search'

describe('relay git repo-config command guard', () => {
  let dispatcher: MockDispatcher
  let tmpDir: string

  beforeEach(() => {
    tmpDir = createGitTempDir()
    ;({ dispatcher } = createGitHandlerRelay())
  })

  afterEach(async () => {
    await removeGitTempDir(tmpDir)
  })

  function armedFixture(): ReturnType<typeof createFsmonitorMarkerRepo> {
    const fixture = createFsmonitorMarkerRepo(tmpDir)
    // Proves the fixture is armed: plain git runs the configured command.
    fixture.runUnguardedGitStatus()
    expect(fixture.markerExists()).toBe(true)
    fixture.clearMarker()
    return fixture
  }

  it('does not run a core.fsmonitor command from the remote folder during git.status', async () => {
    const fixture = armedFixture()

    const result = (await dispatcher.callRequest('git.status', {
      worktreePath: fixture.repo
    })) as { entries: { path?: unknown }[] }

    expect(result.entries.map((entry) => entry.path)).toEqual(['tracked.txt'])
    expect(fixture.markerExists()).toBe(false)
  })

  it('does not run it from the git grep search or ls-files listing fallbacks', async () => {
    const fixture = armedFixture()

    const search = await searchWithGitGrep(fixture.repo, 'changed', { maxResults: 10 })
    const files = await listFilesWithGit(fixture.repo)

    expect(search.totalMatches).toBe(1)
    expect(files).toContain('tracked.txt')
    expect(fixture.markerExists()).toBe(false)
  })

  it('does not run a repo textconv driver for staged or review patches', async () => {
    const fixture = createTextconvMarkerRepo(tmpDir)

    const staged = (await dispatcher.callRequest('git.exec', {
      args: ['diff', '--cached', '--patch', '--minimal', '--no-color', '--no-ext-diff'],
      cwd: fixture.repo
    })) as { stdout: string }
    const review = (await dispatcher.callRequest('git.reviewDiff', {
      worktreePath: fixture.repo,
      mergeBase: fixture.baseOid,
      format: 'patch'
    })) as { stdout: string }

    expect(staged.stdout).toContain('+staged')
    expect(review.stdout).toContain('+committed')
    expect(fixture.markerExists()).toBe(false)
  })
})
