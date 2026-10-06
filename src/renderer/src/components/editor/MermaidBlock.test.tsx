// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (_id: string, source: string) => {
    if (source.includes('invalid')) {
      throw new Error('Parse error on line 2')
    }
    return { svg: `<svg><text>rendered: ${source}</text></svg>` }
  })
}))
vi.mock('mermaid', () => ({ default: mermaid }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import MermaidBlock from './MermaidBlock'

/** Runs the debounce timer and lets the serialized mermaid render settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  mermaid.render.mockClear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('MermaidBlock', () => {
  it('recovers from a syntax error once the diagram becomes valid', async () => {
    const { container, rerender } = render(
      <MermaidBlock content={'graph TD\n  A --> invalid'} isDark={false} />
    )
    await settle()
    expect(screen.getByText(/Parse error on line 2/)).toBeTruthy()
    expect(container.textContent).not.toContain('rendered:')

    rerender(<MermaidBlock content={'graph TD\n  A --> B'} isDark={false} />)
    await settle()
    expect(container.textContent).toContain('rendered:')
    expect(screen.queryByText(/Parse error/)).toBeNull()
  })

  it('renders once after content stops changing, not on every streamed update', async () => {
    const { container, rerender } = render(<MermaidBlock content="graph TD" isDark={false} />)
    await settle()
    mermaid.render.mockClear()

    for (const content of ['graph TD\n  A', 'graph TD\n  A -->', 'graph TD\n  A --> B']) {
      rerender(<MermaidBlock content={content} isDark={false} />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50)
      })
    }
    await settle()
    expect(mermaid.render).toHaveBeenCalledTimes(1)
    expect(mermaid.render.mock.calls[0]?.[1]).toBe('graph TD\n  A --> B')
    expect(container.textContent).toContain('A --> B')
  })
})
