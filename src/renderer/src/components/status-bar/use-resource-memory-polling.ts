import { useEffect } from 'react'

const DEFAULT_POLL_MS = 2_000
// Why: each Windows sweep forks PowerShell for a ~700 ms Get-CimInstance scan (the native
// process table has no commit or CPU counters), so poll it less often than `ps`.
const WINDOWS_POLL_MS = 5_000

export function resourceMemoryPollIntervalMs(userAgent: string): number {
  const isMac = userAgent.includes('Mac')
  return !isMac && userAgent.includes('Windows') ? WINDOWS_POLL_MS : DEFAULT_POLL_MS
}

/** Poll the memory snapshot while the popover is open and the window is visible. */
export function useResourceMemoryPolling({
  open,
  fetchSnapshot,
  intervalMs
}: {
  open: boolean
  fetchSnapshot: () => Promise<void>
  intervalMs: number
}): void {
  useEffect(() => {
    if (!open) {
      return
    }
    void fetchSnapshot()
    // Why: an open popover in a hidden or minimized window has no reader for fresh numbers.
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') {
        void fetchSnapshot()
      }
    }, intervalMs)
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        void fetchSnapshot()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [open, fetchSnapshot, intervalMs])
}
