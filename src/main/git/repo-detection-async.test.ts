import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isGitRepo, isGitRepoAsync } from './repo'

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
}

describe('isGitRepoAsync', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'orca-repo-detect-async-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns the same verdict as the synchronous probe', async () => {
    const repo = path.join(tmpDir, 'repo')
    mkdirSync(path.join(repo, 'src'), { recursive: true })
    git(repo, ['init', '-q'])
    const bare = path.join(tmpDir, 'bare.git')
    mkdirSync(bare)
    git(bare, ['init', '-q', '--bare'])
    const fake = path.join(tmpDir, 'fake')
    mkdirSync(fake)
    writeFileSync(path.join(fake, '.git'), 'not a gitdir file')
    const stale = path.join(tmpDir, 'stale')
    mkdirSync(stale)
    writeFileSync(path.join(stale, '.git'), `gitdir: ${path.join(tmpDir, 'gone')}\n`)
    const plain = path.join(tmpDir, 'plain')
    mkdirSync(plain)
    const file = path.join(tmpDir, 'file.txt')
    writeFileSync(file, 'x')

    const cases = [
      repo,
      path.join(repo, 'src'),
      bare,
      fake,
      stale,
      plain,
      file,
      path.join(tmpDir, 'missing')
    ]
    const verdicts = await Promise.all(
      cases.map(async (entry) => [entry, await isGitRepoAsync(entry)])
    )
    expect(verdicts).toEqual(cases.map((entry) => [entry, isGitRepo(entry)]))
    expect(verdicts.map(([, verdict]) => verdict)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false
    ])
  })
})
