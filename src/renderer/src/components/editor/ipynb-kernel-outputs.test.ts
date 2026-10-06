import { describe, expect, it } from 'vitest'
import type { KernelOutputType } from '../../../../shared/notebook-kernel-types'
import {
  applyKernelOutput,
  collapseCarriageReturns,
  toStoredOutputs,
  type LiveOutputs
} from './ipynb-kernel-outputs'

const EMPTY: LiveOutputs = { outputs: [], clearOnNextOutput: false }

function apply(messages: [KernelOutputType, Record<string, unknown>][]): LiveOutputs {
  return messages.reduce((live, [type, content]) => applyKernelOutput(live, type, content), EMPTY)
}

describe('collapseCarriageReturns', () => {
  it('keeps only the last rewrite of each line, like a terminal', () => {
    expect(collapseCarriageReturns('10%\r50%\r100%\ndone\n')).toBe('100%\ndone\n')
  })

  it('treats \\r\\n as a newline and keeps a trailing \\r for the next chunk', () => {
    expect(collapseCarriageReturns('a\r\nb')).toBe('a\nb')
    expect(collapseCarriageReturns('x\r1%\r')).toBe('1%\r')
  })
})

describe('applyKernelOutput', () => {
  it('merges consecutive chunks of one stream and collapses progress rewrites across them', () => {
    const live = apply([
      ['stream', { name: 'stdout', text: 'step 1' }],
      ['stream', { name: 'stdout', text: '\rstep 2' }],
      ['stream', { name: 'stderr', text: 'warn\n' }],
      ['stream', { name: 'stdout', text: 'end\n' }]
    ])
    expect(live.outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: 'step 2' },
      { output_type: 'stream', name: 'stderr', text: 'warn\n' },
      { output_type: 'stream', name: 'stdout', text: 'end\n' }
    ])
  })

  it('maps results, displays and errors to nbformat outputs', () => {
    const live = apply([
      ['execute_result', { execution_count: 3, data: { 'text/plain': '42' }, metadata: {} }],
      ['display_data', { data: { 'image/png': 'AAAA' }, metadata: { 'image/png': {} } }],
      ['error', { ename: 'ValueError', evalue: 'bad', traceback: ['tb'] }]
    ])
    expect(live.outputs).toEqual([
      {
        output_type: 'execute_result',
        execution_count: 3,
        data: { 'text/plain': '42' },
        metadata: {}
      },
      { output_type: 'display_data', data: { 'image/png': 'AAAA' }, metadata: { 'image/png': {} } },
      { output_type: 'error', ename: 'ValueError', evalue: 'bad', traceback: ['tb'] }
    ])
  })

  it('clears at once, or on the next output when asked to wait', () => {
    const cleared = apply([
      ['stream', { name: 'stdout', text: 'old' }],
      ['clear_output', { wait: false }]
    ])
    expect(cleared.outputs).toEqual([])

    const waiting = apply([
      ['stream', { name: 'stdout', text: 'old' }],
      ['clear_output', { wait: true }]
    ])
    expect(waiting.outputs).toHaveLength(1)
    const replaced = applyKernelOutput(waiting, 'stream', { name: 'stdout', text: 'new' })
    expect(replaced).toEqual({
      outputs: [{ output_type: 'stream', name: 'stdout', text: 'new' }],
      clearOnNextOutput: false
    })
  })

  it('updates a display in place by its display id, and stores it without the id', () => {
    const live = apply([
      [
        'display_data',
        { data: { 'text/plain': '0%' }, metadata: {}, transient: { display_id: 'p' } }
      ],
      ['display_data', { data: { 'text/plain': 'other' }, metadata: {} }],
      [
        'update_display_data',
        { data: { 'text/plain': '100%' }, metadata: {}, transient: { display_id: 'p' } }
      ]
    ])
    expect(toStoredOutputs(live.outputs)).toEqual([
      { output_type: 'display_data', data: { 'text/plain': '100%' }, metadata: {} },
      { output_type: 'display_data', data: { 'text/plain': 'other' }, metadata: {} }
    ])
  })
})

function seededRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

function streamText(chunks: string[]): string {
  const live = apply(chunks.map((text) => ['stream', { name: 'stdout', text }]))
  return live.outputs.length === 0 ? '' : String(live.outputs[0].text)
}

describe('stream chunk merging', () => {
  it('matches collapsing the whole text at once, however the stream is chunked', () => {
    const random = seededRandom(7)
    const alphabet = ['a', 'b', '\r', '\n', '\r\n']
    for (let trial = 0; trial < 5_000; trial += 1) {
      let raw = ''
      for (let length = Math.floor(random() * 30); length > 0; length -= 1) {
        raw += alphabet[Math.floor(random() * alphabet.length)]
      }
      const chunks: string[] = []
      for (let start = 0; start < raw.length;) {
        const end = start + 1 + Math.floor(random() * 4)
        chunks.push(raw.slice(start, end))
        start = end
      }
      expect(streamText(chunks), JSON.stringify(chunks)).toBe(collapseCarriageReturns(raw))
    }
  })

  it('handles CR split from its LF, and CR runs, at a chunk boundary', () => {
    expect(streamText(['50%\r', '\ndone'])).toBe('50%\ndone')
    expect(streamText(['b\r\r', '\r\n'])).toBe('b\n')
    expect(streamText(['10%\r', '\r', '90%\r', '100%\n'])).toBe('100%\n')
    expect(streamText(['keep\nx\r', 'y'])).toBe('keep\ny')
  })

  it('appends chunks in roughly linear time', () => {
    const time = (count: number): number => {
      const startedAt = performance.now()
      let live = EMPTY
      for (let index = 0; index < count; index += 1) {
        const text = index % 50 === 0 ? `${index}%\r` : 'a line of output\n'
        live = applyKernelOutput(live, 'stream', { name: 'stdout', text })
      }
      expect(String(live.outputs[0].text).length).toBeGreaterThan(count)
      return performance.now() - startedAt
    }
    time(2_000)
    const small = time(5_000)
    const large = time(20_000)
    // Linear growth is ~4x; quadratic is ~16x. The floor absorbs timer noise on tiny runs.
    expect(large / Math.max(small, 5)).toBeLessThan(10)
  })
})
