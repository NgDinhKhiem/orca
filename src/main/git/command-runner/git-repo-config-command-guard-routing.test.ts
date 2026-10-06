import { afterEach, describe, expect, it } from 'vitest'
import { resolveCommand } from './wsl-command-resolution'
import { resolveGitCommand } from './git-command-resolution'

const originalPlatform = process.platform
const UNC_REPO = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'
const READ_ENVIRONMENT = { gitPath: '/usr/bin/git', home: '/home/dev', path: '/usr/bin:/bin' }

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

describe('Orca-spawned git disables repo core.fsmonitor on every route', () => {
  afterEach(() => setPlatform(originalPlatform))

  it('prefixes native git ahead of existing leading -c options', () => {
    setPlatform('linux')

    const resolved = resolveCommand(
      'git',
      ['-c', 'maintenance.auto=false', 'fetch', 'origin'],
      '/repo'
    )

    expect(resolved.args).toEqual([
      '-c',
      'core.fsmonitor=',
      '-c',
      'maintenance.auto=false',
      'fetch',
      'origin'
    ])
  })

  it('guards git resolved through the runner entry point', () => {
    setPlatform('darwin')

    expect(resolveGitCommand(['status'], { cwd: '/repo' }).args).toEqual([
      '-c',
      'core.fsmonitor=',
      'status'
    ])
  })

  it('guards WSL git run through bash -c', () => {
    setPlatform('win32')

    const resolved = resolveCommand('git', ['status'], UNC_REPO)

    expect(resolved.wslMode).toBe('non-login-shell')
    expect(resolved.args.at(-1)).toMatch(/ 'git' '-c' 'core\.fsmonitor=' 'status'$/)
  })

  it('guards WSL git run through the login shell', () => {
    setPlatform('win32')

    const resolved = resolveCommand('git', ['status'], UNC_REPO, undefined, {
      useWslLoginShell: true
    })

    expect(resolved.wslMode).toBe('login-shell')
    // The login-shell wrapper quotes the inner command a second time.
    expect(resolved.args.join(' ')).toContain(
      `'\\''git'\\'' '\\''-c'\\'' '\\''core.fsmonitor='\\'' '\\''status'\\''`
    )
  })

  it('guards shell-free WSL git after the -C cwd option', () => {
    setPlatform('win32')

    const resolved = resolveCommand('git', ['status'], UNC_REPO, undefined, {
      wslGitReadEnvironment: READ_ENVIRONMENT
    })

    expect(resolved.wslMode).toBe('direct-git')
    expect(resolved.args.slice(resolved.args.indexOf(READ_ENVIRONMENT.gitPath))).toEqual([
      READ_ENVIRONMENT.gitPath,
      '-C',
      '/home/dev/repo',
      '-c',
      'core.fsmonitor=',
      'status'
    ])
  })

  it('leaves non-git commands untouched', () => {
    setPlatform('linux')

    expect(resolveCommand('gh', ['auth', 'status'], '/repo').args).toEqual(['auth', 'status'])
  })
})
