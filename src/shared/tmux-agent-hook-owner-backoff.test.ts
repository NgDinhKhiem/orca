import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentStatusStore } from './agent-status-store'
import type { ProcessTableRow } from './process-table-snapshot'
import { TmuxAgentHookOwner, type TmuxManagedPty } from './tmux-agent-hook-owner'

const paneKey = '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222'
const root: TmuxManagedPty = {
  pid: 100,
  incarnation: 'first',
  scope: {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'workspace',
    workspaceKind: 'folder'
  }
}
const rows: ProcessTableRow[] = [
  {
    pid: 100,
    ppid: 1,
    pgid: 100,
    tpgid: 101,
    tty: 'pts/1',
    stat: 'S',
    startTime: 'root',
    command: '/bin/bash'
  },
  {
    pid: 101,
    ppid: 100,
    pgid: 101,
    tpgid: 101,
    tty: 'pts/1',
    stat: 'S+',
    startTime: 'client',
    command: '/usr/bin/tmux attach'
  }
]

let owner: TmuxAgentHookOwner | undefined

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  owner?.stop()
  owner = undefined
  vi.useRealTimers()
})

function setup() {
  let selected = '%0'
  const store = createAgentStatusStore({ epoch: 'tmux-backoff', mode: 'authority' })
  const publish = vi.fn()
  const probe = vi.fn(async () => ({ clients: [{ pid: 101, pane: selected }], rows }))
  owner = new TmuxAgentHookOwner({
    store: () => store,
    getRoot: async () => root,
    publish,
    unavailable: vi.fn(),
    probe
  })
  const ingest = (pane: string) =>
    owner!.ingest(
      'opencode',
      {
        paneKey,
        worktreeId: 'workspace',
        tmux: { socket: '/tmp/test.sock', pane },
        payload: { hook_event_name: 'SessionBusy', prompt: `work in ${pane}` }
      },
      'dev'
    )
  return {
    probe,
    publish,
    ingest,
    select: (pane: string) => {
      selected = pane
    }
  }
}

describe('tmux attachment polling backoff', () => {
  it('backs off probing while the attachment stays unchanged', async () => {
    const f = setup()
    await f.ingest('%0')
    f.probe.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)
    // A fixed 1 s interval probes 60 times; the backoff settles at 5 s.
    expect(f.probe.mock.calls.length).toBeLessThanOrEqual(30)
    expect(f.probe.mock.calls.length).toBeGreaterThanOrEqual(15)
  })

  it('still follows a pane switch within the capped interval after a long idle', async () => {
    const f = setup()
    await f.ingest('%0')
    await f.ingest('%1')
    await vi.advanceTimersByTimeAsync(120_000)
    const before = f.publish.mock.calls.length
    f.select('%1')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(f.publish.mock.calls.length).toBe(before + 1)
    expect(f.publish.mock.lastCall?.[0].payload.prompt).toBe('work in %1')
  })

  it('returns to one-second probing after the attachment changes', async () => {
    const f = setup()
    await f.ingest('%0')
    await f.ingest('%1')
    await vi.advanceTimersByTimeAsync(120_000)
    f.select('%1')
    await vi.advanceTimersByTimeAsync(5_000)
    f.probe.mockClear()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(f.probe.mock.calls.length).toBeGreaterThanOrEqual(4)
  })

  it('stops polling once the last pane is cleared', async () => {
    const f = setup()
    await f.ingest('%0')
    owner!.clearPane(paneKey)
    f.probe.mockClear()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.probe).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
