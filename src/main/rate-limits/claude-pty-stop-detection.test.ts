import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClaudePtyUsageParser from './claude-pty-usage-parser'

const { resolveClaudeCommandMock, spawnMock, strippedChars } = vi.hoisted(() => ({
  resolveClaudeCommandMock: vi.fn(),
  spawnMock: vi.fn(),
  strippedChars: { total: 0 }
}))

vi.mock('../codex-cli/command', () => ({
  resolveClaudeCommand: resolveClaudeCommandMock
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock
}))

vi.mock('./claude-pty-usage-parser', async (importOriginal) => {
  const actual = await importOriginal<typeof ClaudePtyUsageParser>()
  return {
    ...actual,
    stripTerminalControlSequences: (output: string) => {
      strippedChars.total += output.length
      return actual.stripTerminalControlSequences(output)
    }
  }
})

import { fetchViaPty } from './claude-pty'

function makeMockTerm(): {
  onData: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  emitData: (data: string) => void
} {
  let dataHandler: ((data: string) => void) | null = null
  return {
    onData: vi.fn((handler: (data: string) => void) => {
      dataHandler = handler
      return { dispose: vi.fn() }
    }),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
    write: vi.fn(),
    kill: vi.fn(),
    emitData: (data: string) => dataHandler?.(data)
  }
}

async function startProbe(): Promise<{
  term: ReturnType<typeof makeMockTerm>
  settled: () => boolean
  result: ReturnType<typeof fetchViaPty>
}> {
  const term = makeMockTerm()
  spawnMock.mockReturnValue(term)
  let isSettled = false
  const result = fetchViaPty()
  void result.then(() => {
    isSettled = true
  })
  // Past the startup delay, so `/usage` has been sent and stop detection is live.
  await vi.advanceTimersByTimeAsync(2_000)
  return { term, settled: () => isSettled, result }
}

describe('fetchViaPty stop detection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    strippedChars.total = 0
    resolveClaudeCommandMock.mockReturnValue('claude')
  })

  it('strips each chunk once instead of re-stripping the accumulated buffer', async () => {
    const { term, result } = await startProbe()
    const chunk = `${'\u001b[2K\u001b[1Gloading usage '.repeat(40)}\r\n`
    let emitted = 0
    for (let i = 0; i < 300; i += 1) {
      term.emitData(chunk)
      emitted += chunk.length
    }

    // One pass for the stream plus one for the per-chunk prompt checks.
    expect(strippedChars.total).toBeLessThan(emitted * 3)
    await vi.advanceTimersByTimeAsync(25_000)
    await result
  })

  it('detects a stop label whose CSI sequence is split across chunks', async () => {
    const { term, settled, result } = await startProbe()
    term.emitData('Current \u001b[3')
    term.emitData('1msession\r12% used\r')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(settled()).toBe(true)
    await expect(result).resolves.toMatchObject({ status: 'ok', session: { usedPercent: 12 } })
  })

  it('detects a stop label whose OSC title is split across chunks', async () => {
    const { term, settled, result } = await startProbe()
    term.emitData('Current \u001b]0;Claude Co')
    term.emitData('de\u001b')
    term.emitData('\\session\r12% used\r')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(settled()).toBe(true)
    await expect(result).resolves.toMatchObject({ status: 'ok', session: { usedPercent: 12 } })
  })

  it('detects a stop label split across plain-text chunks', async () => {
    const { term, settled, result } = await startProbe()
    term.emitData('Current ses')
    term.emitData('sion\r40% used\r')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(settled()).toBe(true)
    await expect(result).resolves.toMatchObject({ status: 'ok', session: { usedPercent: 40 } })
  })

  it('detects a stop label that arrived before /usage was sent', async () => {
    const term = makeMockTerm()
    spawnMock.mockReturnValue(term)
    let isSettled = false
    const result = fetchViaPty()
    void result.then(() => {
      isSettled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    term.emitData('Current session\r12% used\r')
    await vi.advanceTimersByTimeAsync(2_000)
    // Detection runs on the next chunk after `/usage` is sent, over everything seen so far.
    term.emitData(' ')
    await vi.advanceTimersByTimeAsync(2_000)

    expect(isSettled).toBe(true)
    await expect(result).resolves.toMatchObject({ status: 'ok' })
  })
})
