import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createFsmonitorMarkerRepo,
  createTextconvMarkerRepo
} from '../../shared/git-repo-config-command-test-fixture'
import { getStagedCommitContext } from './source-control/staged-commit-context'
import { getStatus, invalidateGitReadCaches } from './status'

const tempRoots: string[] = []

beforeEach(() => {
  invalidateGitReadCaches()
})

afterEach(async () => {
  invalidateGitReadCaches()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('repo-config command guard against a real repository', () => {
  it('does not run a core.fsmonitor command from an opened folder during status', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orca-fsmonitor-guard-'))
    tempRoots.push(root)
    const fixture = createFsmonitorMarkerRepo(root)
    // Proves the fixture is armed: plain git runs the configured command.
    fixture.runUnguardedGitStatus()
    expect(fixture.markerExists()).toBe(true)
    fixture.clearMarker()

    const result = await getStatus(fixture.repo)

    expect(result.entries.map((entry) => entry.path)).toEqual(['tracked.txt'])
    expect(fixture.markerExists()).toBe(false)
  })

  it('does not run a repo textconv driver while reading the staged patch', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orca-textconv-guard-'))
    tempRoots.push(root)
    const fixture = createTextconvMarkerRepo(root)

    const context = await getStagedCommitContext(fixture.repo)

    expect(context?.stagedPatch).toContain('+staged')
    expect(fixture.markerExists()).toBe(false)
  })
})
