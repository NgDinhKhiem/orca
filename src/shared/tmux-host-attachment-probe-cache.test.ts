import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessTableRow } from './process-table-snapshot'
import { createTmuxHostAttachmentProbe } from './tmux-host-attachment-probe'

const { run, readProcRow } = vi.hoisted(() => ({ run: vi.fn(), readProcRow: vi.fn() }))
vi.mock('./child-process/run-process', () => ({ runProcess: run }))
vi.mock('node:fs/promises', () => ({
  stat: async () => ({ isSocket: () => true, uid: process.getuid?.() })
}))
vi.mock('./agent-process-presence-probe', () => ({
  readAgentProcess: async (pid: number) => ({ verdict: 'live', startTime: `birth-${pid}` })
}))
vi.mock('./linux-proc-process-row', () => ({ readLinuxProcProcessRow: readProcRow }))

const ROOT_PID = 100
const CLIENT_PIDS = [101, 102, 103, 104]
// Each tmux client sits under an intermediate wrapper process, which sits under the root shell.
const parentOf = (pid: number): number =>
  pid === ROOT_PID ? 1 : CLIENT_PIDS.includes(pid) ? pid + 100 : ROOT_PID

function row(pid: number): ProcessTableRow {
  return {
    pid,
    ppid: parentOf(pid),
    pgid: pid,
    tpgid: 101,
    tty: 'pts/1',
    stat: 'S',
    startTime: `birth-${pid}`,
    command: pid === ROOT_PID ? '/bin/bash' : '/usr/bin/tmux attach'
  }
}

let clientPids = CLIENT_PIDS
const realPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

function psCalls(): number[] {
  return run.mock.calls
    .filter(([options]) => options.program === '/bin/ps')
    .map(([options]) => Number(options.args[1]))
}

beforeEach(() => {
  clientPids = CLIENT_PIDS
  run.mockReset()
  readProcRow.mockReset()
  readProcRow.mockImplementation(async (pid: number) => row(pid))
  run.mockImplementation(async (options: { program: string; args: string[] }) => {
    if (options.program === 'tmux') {
      return {
        code: 0,
        timedOut: false,
        stdout: clientPids.map((pid, index) => `${pid}:%${index}`).join('\n')
      }
    }
    const pid = Number(options.args[1])
    return {
      code: 0,
      timedOut: false,
      stdout: `${pid} ${parentOf(pid)} ${pid} 101 S pts/1 Fri Oct  2 03:00:00 2026 ${row(pid).command}\n`
    }
  })
})

afterEach(() => {
  setPlatform(realPlatform)
})

describe('tmux host attachment probe cost', () => {
  it('reads the chain from procfs on Linux instead of spawning ps per pid', async () => {
    setPlatform('linux')
    const probe = createTmuxHostAttachmentProbe()
    const proof = await probe('/tmp/fixture.sock', [ROOT_PID])

    expect(proof?.rows.map((entry) => entry.pid).sort()).toEqual(
      [100, 101, 102, 103, 104, 201, 202, 203, 204].sort()
    )
    expect(psCalls()).toEqual([])
    expect(run.mock.calls.filter(([options]) => options.program === 'tmux')).toHaveLength(1)
  })

  it('reuses the cached parent chain on the next tick and re-reads only roots and clients', async () => {
    setPlatform('darwin')
    const probe = createTmuxHostAttachmentProbe()
    await probe('/tmp/fixture.sock', [ROOT_PID])
    expect(psCalls()).toHaveLength(9)

    run.mockClear()
    const proof = await probe('/tmp/fixture.sock', [ROOT_PID])
    expect(psCalls().sort()).toEqual([100, 101, 102, 103, 104])
    expect(proof?.rows).toHaveLength(9)
  })

  it('re-reads the chain when the attached client set changes', async () => {
    setPlatform('darwin')
    const probe = createTmuxHostAttachmentProbe()
    await probe('/tmp/fixture.sock', [ROOT_PID])
    run.mockClear()
    clientPids = [101, 102]
    await probe('/tmp/fixture.sock', [ROOT_PID])
    expect(psCalls().sort()).toEqual([100, 101, 102, 201, 202])
  })

  it('re-reads the chain after a probe of the socket fails', async () => {
    setPlatform('darwin')
    const probe = createTmuxHostAttachmentProbe()
    await probe('/tmp/fixture.sock', [ROOT_PID])
    run.mockImplementationOnce(async () => ({ code: 1, timedOut: false, stdout: '' }))
    expect(await probe('/tmp/fixture.sock', [ROOT_PID])).toBeNull()
    run.mockClear()
    await probe('/tmp/fixture.sock', [ROOT_PID])
    expect(psCalls()).toHaveLength(9)
  })

  it('re-reads the chain once the cache ages out', async () => {
    setPlatform('darwin')
    let now = 0
    const probe = createTmuxHostAttachmentProbe({ now: () => now })
    await probe('/tmp/fixture.sock', [ROOT_PID])
    now += 60_000
    run.mockClear()
    await probe('/tmp/fixture.sock', [ROOT_PID])
    expect(psCalls()).toHaveLength(9)
  })
})
