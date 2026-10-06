// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resourceMemoryPollIntervalMs,
  useResourceMemoryPolling
} from './use-resource-memory-polling'

let visibility: DocumentVisibilityState = 'visible'

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.useFakeTimers()
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('resourceMemoryPollIntervalMs', () => {
  it('polls Windows no faster than every five seconds', () => {
    expect(
      resourceMemoryPollIntervalMs('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/38')
    ).toBeGreaterThanOrEqual(5_000)
    expect(resourceMemoryPollIntervalMs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(
      2_000
    )
    expect(resourceMemoryPollIntervalMs('Mozilla/5.0 (X11; Linux x86_64)')).toBe(2_000)
  })
})

describe('useResourceMemoryPolling', () => {
  it('fetches on open and then on the interval', () => {
    const fetchSnapshot = vi.fn(async () => {})
    renderHook(() => useResourceMemoryPolling({ open: true, fetchSnapshot, intervalMs: 5_000 }))
    expect(fetchSnapshot).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(15_000)
    expect(fetchSnapshot).toHaveBeenCalledTimes(4)
  })

  it('does not poll while the window is hidden and catches up when shown', () => {
    const fetchSnapshot = vi.fn(async () => {})
    renderHook(() => useResourceMemoryPolling({ open: true, fetchSnapshot, intervalMs: 5_000 }))
    fetchSnapshot.mockClear()
    setVisibility('hidden')
    vi.advanceTimersByTime(60_000)
    expect(fetchSnapshot).not.toHaveBeenCalled()
    setVisibility('visible')
    expect(fetchSnapshot).toHaveBeenCalledTimes(1)
  })

  it('stops polling when the popover closes', () => {
    const fetchSnapshot = vi.fn(async () => {})
    const { rerender } = renderHook(
      ({ open }) => useResourceMemoryPolling({ open, fetchSnapshot, intervalMs: 5_000 }),
      { initialProps: { open: true } }
    )
    rerender({ open: false })
    fetchSnapshot.mockClear()
    vi.advanceTimersByTime(30_000)
    setVisibility('hidden')
    setVisibility('visible')
    expect(fetchSnapshot).not.toHaveBeenCalled()
  })
})
