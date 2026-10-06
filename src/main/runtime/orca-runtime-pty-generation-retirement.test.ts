import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

type RuntimeInternals = {
  ptyLifecycleGenerationById: Map<string, number>
  agentPromptExplicitStatusFloorByPtyId: Map<string, number>
  dropDisconnectedPtyRecord: (ptyId: string) => void
  getPtyLifecycleGeneration: (ptyId: string) => number
}

function internals(runtime: OrcaRuntimeService): RuntimeInternals {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these protected members exist on OrcaRuntimeService; the test reads them to measure retention.
  return runtime as unknown as RuntimeInternals
}

describe('PTY lifecycle generation retention', () => {
  it('does not re-create generation entries when an exited PTY record is pruned', () => {
    const runtime = new OrcaRuntimeService()
    const state = internals(runtime)
    const baseline = {
      generations: state.ptyLifecycleGenerationById.size,
      floors: state.agentPromptExplicitStatusFloorByPtyId.size
    }

    for (let index = 0; index < 50; index += 1) {
      const ptyId = `pty-${index}`
      state.getPtyLifecycleGeneration(ptyId)
      runtime.onPtyExit(ptyId, 0)
      state.dropDisconnectedPtyRecord(ptyId)
    }

    expect(state.ptyLifecycleGenerationById.size).toBe(baseline.generations)
    expect(state.agentPromptExplicitStatusFloorByPtyId.size).toBe(baseline.floors)
  })

  it('still invalidates the generation a pruned PTY was captured under', () => {
    const runtime = new OrcaRuntimeService()
    const state = internals(runtime)
    const captured = state.getPtyLifecycleGeneration('pty-live')

    state.dropDisconnectedPtyRecord('pty-live')

    expect(state.ptyLifecycleGenerationById.get('pty-live')).not.toBe(captured)
    expect(state.getPtyLifecycleGeneration('pty-live')).not.toBe(captured)
  })
})
