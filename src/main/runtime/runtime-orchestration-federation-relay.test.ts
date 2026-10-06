import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { syncFederatedDispatch } = vi.hoisted(() => ({ syncFederatedDispatch: vi.fn() }))
vi.mock('./orchestration/federation-sync', () => ({ syncFederatedDispatch }))
vi.mock('./orchestration/federation-ack-checkpoints', () => ({
  clearFederationAckCheckpoints: vi.fn(),
  releaseFederationAckCheckpoint: vi.fn()
}))

import { RuntimeOrchestrationFederation } from './runtime-orchestration-federation'

type Row = { dispatch_id: string; environment_id: string }

function setup(rows: Row[]) {
  const eligible = new Set(rows.map((row) => row.dispatch_id))
  const active = [...rows]
  const db = {
    listActiveFederatedDispatches: () => active.filter((row) => eligible.has(row.dispatch_id)),
    isFederatedDispatchRelayEligible: (dispatchId: string) => eligible.has(dispatchId),
    findNextTerminalFederatedDispatchPendingAcknowledgment: () => undefined
  }
  const runtime = {
    getOrchestrationDb: () => db,
    syncOrchestrationFederatedDispatch: vi.fn(async () => {})
  }
  const federation = new RuntimeOrchestrationFederation(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the relay only reads the orchestration db and sync hook stubbed above.
    runtime as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: relay polling never calls the transport directly; it only checks presence.
    {} as never
  )
  return {
    federation,
    retire: (dispatchId: string) => eligible.delete(dispatchId),
    add: (row: Row) => {
      active.push(row)
      eligible.add(row.dispatch_id)
    }
  }
}

function syncCallsFor(dispatchId: string): number {
  return syncFederatedDispatch.mock.calls.filter(([, id]) => id === dispatchId).length
}

describe('RuntimeOrchestrationFederation relay polling', () => {
  let federation: RuntimeOrchestrationFederation | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    syncFederatedDispatch.mockReset()
    syncFederatedDispatch.mockResolvedValue({ imported: 0, acknowledgedThrough: 0 })
  })

  afterEach(() => {
    federation?.stopRelay()
    federation = undefined
    vi.useRealTimers()
  })

  it('runs one timer per environment, not one per dispatch', async () => {
    const f = setup([
      { dispatch_id: 'a1', environment_id: 'env-a' },
      { dispatch_id: 'a2', environment_id: 'env-a' },
      { dispatch_id: 'b1', environment_id: 'env-b' }
    ])
    federation = f.federation
    f.federation.ensureRelay()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(2)
    expect(['a1', 'a2', 'b1'].map(syncCallsFor)).toEqual([1, 1, 1])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(['a1', 'a2', 'b1'].map(syncCallsFor)).toEqual([2, 2, 2])
  })

  it('backs off exponentially while every pull for an environment fails, capped at 30 s', async () => {
    syncFederatedDispatch.mockRejectedValue(new Error('environment unreachable'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = setup([{ dispatch_id: 'a1', environment_id: 'env-a' }])
    federation = f.federation
    f.federation.ensureRelay()
    await vi.advanceTimersByTimeAsync(120_000)
    // 0, 1, 3, 7, 15, 31, 61, 91 s: far below the 121 pulls a fixed 1 s interval makes.
    expect(syncCallsFor('a1')).toBeLessThanOrEqual(10)
    expect(syncCallsFor('a1')).toBeGreaterThanOrEqual(6)
    const before = syncCallsFor('a1')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(syncCallsFor('a1')).toBe(before + 1)
  })

  it('returns to the 1 s cadence after a successful pull', async () => {
    syncFederatedDispatch.mockRejectedValue(new Error('environment unreachable'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = setup([{ dispatch_id: 'a1', environment_id: 'env-a' }])
    federation = f.federation
    f.federation.ensureRelay()
    await vi.advanceTimersByTimeAsync(120_000)
    syncFederatedDispatch.mockResolvedValue({ imported: 0, acknowledgedThrough: 0 })
    await vi.advanceTimersByTimeAsync(30_000)
    const recovered = syncCallsFor('a1')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(syncCallsFor('a1')).toBe(recovered + 5)
  })

  it('drops retired dispatches and stops the environment timer once none remain', async () => {
    const f = setup([
      { dispatch_id: 'a1', environment_id: 'env-a' },
      { dispatch_id: 'a2', environment_id: 'env-a' }
    ])
    federation = f.federation
    f.federation.ensureRelay()
    await vi.advanceTimersByTimeAsync(0)
    f.retire('a1')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(syncCallsFor('a1')).toBe(1)
    expect(syncCallsFor('a2')).toBe(4)
    f.retire('a2')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('pulls a dispatch added to an already-polled environment immediately', async () => {
    const f = setup([{ dispatch_id: 'a1', environment_id: 'env-a' }])
    federation = f.federation
    f.federation.ensureRelay()
    await vi.advanceTimersByTimeAsync(0)
    f.add({ dispatch_id: 'a2', environment_id: 'env-a' })
    f.federation.ensureRelay()
    await vi.advanceTimersByTimeAsync(0)
    expect(syncCallsFor('a2')).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
  })
})
