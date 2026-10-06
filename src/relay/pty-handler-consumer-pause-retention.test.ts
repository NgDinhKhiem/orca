import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))

vi.mock('node-pty', () => ({ spawn: mockPtySpawn }))
vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))
vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

import type { PtyHandler } from './pty-handler'
import {
  beginPtyHandlerTest,
  endPtyHandlerTest,
  type MockDispatcher
} from './pty-handler-test-harness'

function consumerPausedIds(handler: PtyHandler): Set<string> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reads the private pause set to measure retention.
  return (handler as unknown as { consumerPausedOutputPtys: Set<string> }).consumerPausedOutputPtys
}

describe('relay consumer delivery pause retention', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  it('ignores pause requests for PTYs that do not exist', () => {
    for (let index = 0; index < 50; index += 1) {
      handler.setConsumerDeliveryPaused(`missing-${index}`, true)
    }
    expect(consumerPausedIds(handler).size).toBe(0)
  })

  it('still pauses and resumes a live PTY', async () => {
    const { id } = (await dispatcher.callRequest('pty.spawn', {})) as { id: string }
    handler.setConsumerDeliveryPaused(id, true)
    expect(consumerPausedIds(handler).has(id)).toBe(true)
    expect(mockPtyInstance.pause).toHaveBeenCalledTimes(1)
    handler.setConsumerDeliveryPaused(id, false)
    expect(consumerPausedIds(handler).size).toBe(0)
  })
})
