import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

export type GitRepoConfigCommandFixture = {
  repo: string
  markerPath: string
  markerExists: () => boolean
  clearMarker: () => void
  runUnguardedGitStatus: () => void
}

function gitIn(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
}

/**
 * A repo whose `.git/config` names a `core.fsmonitor` command that writes a
 * marker, the way a hostile cloned folder would. Git runs the hook through
 * `sh` on every platform (Git for Windows ships one), so the POSIX command
 * string works on Windows too.
 */
export function createFsmonitorMarkerRepo(root: string): GitRepoConfigCommandFixture {
  const repo = path.join(root, 'repo')
  const markerPath = path.join(root, 'fsmonitor-ran')
  mkdirSync(repo, { recursive: true })
  gitIn(repo, ['init', '-q'])
  gitIn(repo, ['config', 'user.email', 'test@example.com'])
  gitIn(repo, ['config', 'user.name', 'Test User'])
  gitIn(repo, ['config', 'commit.gpgSign', 'false'])
  writeFileSync(path.join(repo, 'tracked.txt'), 'base\n')
  gitIn(repo, ['add', '-A'])
  gitIn(repo, ['commit', '-q', '-m', 'base'])
  writeFileSync(path.join(repo, 'tracked.txt'), 'changed\n')
  const shellMarkerPath = markerPath.replace(/\\/g, '/')
  gitIn(repo, ['config', 'core.fsmonitor', `echo ran >> '${shellMarkerPath}'`])
  return {
    repo,
    markerPath,
    markerExists: () => existsSync(markerPath),
    clearMarker: () => rmSync(markerPath, { force: true }),
    runUnguardedGitStatus: () => gitIn(repo, ['status', '--porcelain=v2'])
  }
}

export type GitTextconvMarkerFixture = {
  repo: string
  baseOid: string
  markerExists: () => boolean
  clearMarker: () => void
}

/**
 * A repo whose config names a textconv driver (applied via `.gitattributes`) that writes a
 * marker, with a staged change and a commit on top of `baseOid` for patch reads to render.
 */
export function createTextconvMarkerRepo(root: string): GitTextconvMarkerFixture {
  const repo = path.join(root, 'textconv-repo')
  const markerPath = path.join(root, 'textconv-ran')
  mkdirSync(repo, { recursive: true })
  gitIn(repo, ['init', '-q'])
  gitIn(repo, ['config', 'user.email', 'test@example.com'])
  gitIn(repo, ['config', 'user.name', 'Test User'])
  gitIn(repo, ['config', 'commit.gpgSign', 'false'])
  writeFileSync(path.join(repo, '.gitattributes'), '*.txt diff=orcaprobe\n')
  writeFileSync(path.join(repo, 'tracked.txt'), 'base\n')
  gitIn(repo, ['add', '-A'])
  gitIn(repo, ['commit', '-q', '-m', 'base'])
  const baseOid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  writeFileSync(path.join(repo, 'tracked.txt'), 'committed\n')
  gitIn(repo, ['commit', '-q', '-am', 'change'])
  writeFileSync(path.join(repo, 'tracked.txt'), 'staged\n')
  gitIn(repo, ['add', 'tracked.txt'])
  const shellMarkerPath = markerPath.replace(/\\/g, '/')
  gitIn(repo, ['config', 'diff.orcaprobe.textconv', `echo ran >> '${shellMarkerPath}'; cat`])
  return {
    repo,
    baseOid,
    markerExists: () => existsSync(markerPath),
    clearMarker: () => rmSync(markerPath, { force: true })
  }
}
