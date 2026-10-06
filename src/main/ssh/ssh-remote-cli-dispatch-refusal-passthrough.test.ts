import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

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
import { runRemoteOrcaCli } from './ssh-remote-orca-cli'

// Why: the SSH bridge captures the host CLI child's stdout and exit code without reparsing; this
// pins that a typed refusal envelope and its nonzero exit reach the remote agent unchanged.
// `orchestration send` stands in for `dispatch`, which an SSH host may no longer run.
it('relays typed orchestration refusal codes from the host CLI unchanged', async () => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { end: vi.fn(), on: vi.fn() }
  child.kill = vi.fn()
  const spawn = vi.fn(() => child)
  const refusal = {
    id: 'rpc_1',
    ok: false,
    error: {
      code: 'consumer_fenced',
      message: 'This process no longer owns dispatch_1',
      data: { dispatchId: 'dispatch_1' }
    },
    _meta: { runtimeId: 'runtime_1' }
  }

  const resultPromise = runRemoteOrcaCli(
    new OrcaRuntimeService(),
    {
      argv: ['orchestration', 'send', '--to', 'term_c', '--subject', 'done', '--json'],
      cwd: '/home/alice/repo',
      env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
    },
    {
      execPath: '/host/electron',
      cliEntryPath: '/host/app/out/cli/index.js',
      userDataPath: '/host/user-data',
      entryExists: () => true,
      spawn: spawn as never
    }
  )

  const stdout = `${JSON.stringify(refusal, null, 2)}\n`
  await Promise.resolve()
  child.stdout.emit('data', Buffer.from(stdout))
  child.emit('close', 1)

  expect(await resultPromise).toEqual({ stdout, stderr: '', exitCode: 1 })
})
