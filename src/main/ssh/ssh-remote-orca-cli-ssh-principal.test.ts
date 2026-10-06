import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/host/app'
  }
}))
vi.mock('../persistence', () => ({
  getCanonicalUserDataPath: () => '/host/user-data'
}))

import { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeTerminalSummary } from '../../shared/runtime-terminal-contracts'
import type {
  HostCliPassthroughOptions,
  SshCliRuntimeAuthority
} from './ssh-remote-cli-host-passthrough'
import { runRemoteOrcaCli } from './ssh-remote-orca-cli'

type FakeChild = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: { end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }
  kill: ReturnType<typeof vi.fn>
}

function createFakeChild(): FakeChild {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fields below complete the shape.
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { end: vi.fn(), on: vi.fn() }
  child.kill = vi.fn()
  return child
}

const AUTHORITY: SshCliRuntimeAuthority = {
  kind: 'ssh',
  targetId: 'box-1',
  connectionIncarnation: 'incarnation-1',
  attachmentId: 'attachment-1'
}

function passthroughOptions(spawn: ReturnType<typeof vi.fn>): HostCliPassthroughOptions {
  return {
    execPath: '/host/electron',
    cliEntryPath: '/host/app/out/cli/index.js',
    userDataPath: '/host/user-data',
    entryExists: () => true,
    spawn: spawn as never
  }
}

const LEGACY_FALLBACK_OPTIONS: HostCliPassthroughOptions = {
  execPath: '/host/electron',
  cliEntryPath: '/host/app/out/cli/index.js',
  userDataPath: '/host/user-data',
  entryExists: () => false
}

function terminal(overrides: Partial<RuntimeTerminalSummary>): RuntimeTerminalSummary {
  return {
    handle: 'term',
    ptyId: 'pty',
    worktreeId: 'wt',
    worktreePath: '/wt',
    branch: 'main',
    tabId: 'tab',
    leafId: 'leaf',
    title: null,
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: '',
    ...overrides
  }
}

describe('runRemoteOrcaCli treats an SSH caller as a less-privileged principal', () => {
  it.each([
    [['terminal', 'create', '--worktree', 'path:/Users/me/repo', '--command', 'id', '--json']],
    [['computer', 'click', '--x', '1', '--y', '1', '--json']],
    [['cookie', 'get', '--json']],
    [['repo', 'add', '--path', '/Users/me/secret', '--json']],
    [['status', '--host', 'local', '--json']]
  ])('refuses %j without launching the host CLI', async (argv) => {
    const spawn = vi.fn(() => createFakeChild())

    const result = await runRemoteOrcaCli(
      new OrcaRuntimeService(),
      { argv, cwd: '/home/alice', env: {}, runtimeAuthority: AUTHORITY },
      passthroughOptions(spawn)
    )

    expect(spawn).not.toHaveBeenCalled()
    expect(result.exitCode).toBe(1)
    const payload = JSON.parse(result.stdout) as { ok: boolean; error: { code: string } }
    expect(payload).toMatchObject({ ok: false, error: { code: 'unsupported_over_ssh' } })
  })

  it('refuses the same commands when only the legacy in-process bridge is available', async () => {
    const runtime = new OrcaRuntimeService()
    const createTerminal = vi.spyOn(runtime, 'createTerminal')

    const result = await runRemoteOrcaCli(
      runtime,
      {
        argv: ['terminal', 'create', '--worktree', 'path:/Users/me/repo', '--command', 'id'],
        cwd: '/home/alice',
        env: {},
        runtimeAuthority: AUTHORITY
      },
      LEGACY_FALLBACK_OPTIONS
    )

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('not available from an SSH host')
    expect(createTerminal).not.toHaveBeenCalled()
  })

  it('still bridges orchestration send to the host CLI, with the command checked first', async () => {
    const child = createFakeChild()
    const spawn = vi.fn(() => child)

    const resultPromise = runRemoteOrcaCli(
      new OrcaRuntimeService(),
      {
        argv: ['--json', 'orchestration', 'send', '--to', 'term_c', '--subject', 'done'],
        cwd: '/home/alice',
        env: { ORCA_TERMINAL_HANDLE: 'term_ssh' },
        runtimeAuthority: AUTHORITY
      },
      passthroughOptions(spawn)
    )
    await Promise.resolve()
    child.stdout.emit('data', Buffer.from('{"ok":true}\n'))
    child.emit('close', 0)

    await expect(resultPromise).resolves.toEqual({
      stdout: '{"ok":true}\n',
      stderr: '',
      exitCode: 0
    })
    const [, args] = spawn.mock.calls[0] as unknown as [string, string[]]
    expect(args).toEqual([
      '/host/app/out/cli/index.js',
      'orchestration',
      'send',
      '--json',
      '--to=term_c',
      '--subject=done'
    ])
  })

  it('lists only terminals on the calling SSH host', async () => {
    const runtime = new OrcaRuntimeService()
    const spawn = vi.fn(() => createFakeChild())
    const listTerminals = vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [
        terminal({
          handle: 'term_local',
          worktreeId: 'repo::/Users/me/repo',
          preview: 'LOCAL SECRET OUTPUT',
          executionHostId: 'local'
        }),
        terminal({ handle: 'term_unknown_host', preview: 'NO HOST' }),
        terminal({
          handle: 'term_other_ssh',
          worktreeId: 'repo-b::/srv',
          executionHostId: 'ssh:box-2'
        }),
        terminal({
          handle: 'term_mine',
          worktreeId: 'repo-ssh::/remote/wt',
          executionHostId: 'ssh:box-1'
        })
      ],
      topologyRevisions: { 'repo::/Users/me/repo': 3, 'repo-ssh::/remote/wt': 1 },
      totalCount: 4,
      truncated: false,
      hostScope: { hostIds: ['local', 'ssh:box-1', 'ssh:box-2'], omittedHostIds: [] }
    })

    const result = await runRemoteOrcaCli(
      runtime,
      {
        argv: ['terminal', 'list', '--json'],
        cwd: '/home/alice',
        env: {},
        runtimeAuthority: AUTHORITY
      },
      passthroughOptions(spawn)
    )

    // Why in-process: only main can filter the listing by the caller's SSH identity.
    expect(spawn).not.toHaveBeenCalled()
    expect(listTerminals).toHaveBeenCalledOnce()
    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain('LOCAL SECRET OUTPUT')
    const payload = JSON.parse(result.stdout) as {
      result: {
        terminals: { handle: string }[]
        totalCount: number
        topologyRevisions: Record<string, number>
        hostScope: { hostIds: string[]; omittedHostIds: string[] }
      }
    }
    expect(payload.result.terminals.map((entry) => entry.handle)).toEqual(['term_mine'])
    expect(payload.result.totalCount).toBe(1)
    expect(payload.result.topologyRevisions).toEqual({ 'repo-ssh::/remote/wt': 1 })
    expect(payload.result.hostScope).toEqual({
      hostIds: ['ssh:box-1'],
      omittedHostIds: ['local', 'ssh:box-2']
    })
  })

  it('applies the requested limit after scoping to the caller', async () => {
    const runtime = new OrcaRuntimeService()
    const mine = (handle: string) =>
      terminal({ handle, worktreeId: 'w', executionHostId: 'ssh:box-1' })
    const listTerminals = vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [terminal({ handle: 'l', executionHostId: 'local' }), mine('a'), mine('b')],
      totalCount: 3,
      truncated: false
    })

    const result = await runRemoteOrcaCli(
      runtime,
      {
        argv: ['terminal', 'list', '--limit', '1', '--json'],
        cwd: '/home/alice',
        env: {},
        runtimeAuthority: AUTHORITY
      },
      LEGACY_FALLBACK_OPTIONS
    )

    expect(listTerminals.mock.calls[0]?.[1]).not.toBe(1)
    const payload = JSON.parse(result.stdout) as {
      result: { terminals: { handle: string }[]; totalCount: number; truncated: boolean }
    }
    expect(payload.result.terminals.map((entry) => entry.handle)).toEqual(['a'])
    expect(payload.result).toMatchObject({ totalCount: 2, truncated: true })
  })

  it('refuses terminal list when the caller has no SSH identity to scope by', async () => {
    const runtime = new OrcaRuntimeService()
    const listTerminals = vi.spyOn(runtime, 'listTerminals')

    const result = await runRemoteOrcaCli(
      runtime,
      { argv: ['terminal', 'list'], cwd: '/home/alice', env: {} },
      LEGACY_FALLBACK_OPTIONS
    )

    expect(result.exitCode).toBe(1)
    expect(listTerminals).not.toHaveBeenCalled()
  })
})
