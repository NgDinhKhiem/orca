import { describe, expect, it } from 'vitest'
import { withGitRepoConfigCommandGuard } from './git-repo-config-command-guard'

describe('withGitRepoConfigCommandGuard', () => {
  it('disables core.fsmonitor ahead of the subcommand', () => {
    expect(withGitRepoConfigCommandGuard(['status', '--porcelain=v2'])).toEqual([
      '-c',
      'core.fsmonitor=',
      'status',
      '--porcelain=v2'
    ])
  })

  it('keeps existing leading -c options before the subcommand', () => {
    expect(
      withGitRepoConfigCommandGuard(['-c', 'maintenance.auto=false', 'fetch', 'origin'])
    ).toEqual(['-c', 'core.fsmonitor=', '-c', 'maintenance.auto=false', 'fetch', 'origin'])
  })

  it('guards commands without a subcommand such as --version', () => {
    expect(withGitRepoConfigCommandGuard(['--version'])).toEqual([
      '-c',
      'core.fsmonitor=',
      '--version'
    ])
  })

  it('does not inject twice when a caller already set core.fsmonitor', () => {
    const args = ['-C', '/repo', '-c', 'core.fsMonitor=', 'status']
    expect(withGitRepoConfigCommandGuard(args)).toEqual(args)
    expect(withGitRepoConfigCommandGuard(withGitRepoConfigCommandGuard(['status']))).toEqual([
      '-c',
      'core.fsmonitor=',
      'status'
    ])
  })

  it('ignores a -c that belongs to the subcommand', () => {
    expect(withGitRepoConfigCommandGuard(['diff', '-c', 'core.fsmonitor='])).toEqual([
      '-c',
      'core.fsmonitor=',
      'diff',
      '-c',
      'core.fsmonitor='
    ])
  })

  it('does not mutate the caller array', () => {
    const args = ['status']
    withGitRepoConfigCommandGuard(args)
    expect(args).toEqual(['status'])
  })
})
