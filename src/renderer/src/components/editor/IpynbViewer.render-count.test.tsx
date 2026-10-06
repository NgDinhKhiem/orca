// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { IpynbCell } from './ipynb-parse'

const { sourceRenders, sourceChanges } = vi.hoisted(() => {
  // The kernel session subscribes to kernel frames when it loads.
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { notebook: { onKernelFrame: () => () => {} } }
  })
  return {
    sourceRenders: new Map<string, number>(),
    sourceChanges: new Map<string, (source: string) => void>()
  }
})

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/store', () => {
  const state = { editorFontZoomLevel: 0, worktreesByRepo: {} }
  const useAppStore = (selector: (value: typeof state) => unknown) => selector(state)
  useAppStore.subscribe = () => () => {}
  return { useAppStore }
})
vi.mock('@/store/slices/worktree-helpers', () => ({ findWorktreeById: () => null }))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutKeyDetails: () => ({ keys: [], doubleTap: false })
}))
vi.mock('./IpynbKernelToolbar', () => ({ IpynbKernelToolbar: () => null }))
vi.mock('./useIpynbScrollRestoration', () => ({ useIpynbScrollRestoration: () => {} }))
vi.mock('./IpynbCellEditor', () => ({
  IpynbMarkdownCell: () => null,
  IpynbCellSource: ({
    cell,
    source,
    onChange
  }: {
    cell: IpynbCell
    source: string
    onChange: (source: string) => void
  }) => {
    const id = cell.id ?? ''
    sourceRenders.set(id, (sourceRenders.get(id) ?? 0) + 1)
    sourceChanges.set(id, onChange)
    return <pre>{source}</pre>
  }
}))

import IpynbViewer from './IpynbViewer'

function notebookContent(): string {
  return `${JSON.stringify(
    {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { language_info: { name: 'python' } },
      cells: ['a', 'b', 'c'].map((id) => ({
        id,
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        outputs: [],
        source: [`${id} = 1`]
      }))
    },
    null,
    1
  )}\n`
}

function Harness(): React.JSX.Element {
  const [content, setContent] = useState(notebookContent)
  return (
    <IpynbViewer
      content={content}
      fileId="file"
      filePath="/nb.ipynb"
      worktreeId="wt"
      scrollCacheKey="nb"
      onContentChange={setContent}
      onDirtyStateHint={() => {}}
      onSave={async () => true}
    />
  )
}

function rendersSince(before: Map<string, number>): Record<string, number> {
  return Object.fromEntries(
    ['a', 'b', 'c'].map((id) => [id, (sourceRenders.get(id) ?? 0) - (before.get(id) ?? 0)])
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  sourceRenders.clear()
  sourceChanges.clear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('notebook editor rendering', () => {
  it('re-renders only the edited cell while typing and when the edit is committed', () => {
    const { container } = render(<Harness />, { wrapper: TooltipProvider })
    expect(container.textContent).toContain('b = 1')

    const beforeTyping = new Map(sourceRenders)
    act(() => sourceChanges.get('b')?.('b = 2'))
    expect(rendersSince(beforeTyping)).toEqual({ a: 0, b: 1, c: 0 })

    const beforeCommit = new Map(sourceRenders)
    act(() => vi.advanceTimersByTime(400))
    expect(container.textContent).toContain('b = 2')
    expect(rendersSince(beforeCommit).a).toBe(0)
    expect(rendersSince(beforeCommit).c).toBe(0)
  })
})
