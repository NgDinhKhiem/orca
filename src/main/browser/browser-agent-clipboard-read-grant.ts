// Why: clipboard-read is granted only to the guest an agent-browser `clipboard read` is in flight
// for, so ordinary pages can no longer silently read the user's clipboard.
const inFlightReadsByWebContentsId = new Map<number, number>()
// Why: a hung debugger command must not leave the page holding clipboard access indefinitely.
const MAX_GRANT_MS = 30_000

/** Opens a clipboard-read grant for one guest; the returned release is idempotent. */
export function beginAgentClipboardRead(webContentsId: number): () => void {
  inFlightReadsByWebContentsId.set(
    webContentsId,
    (inFlightReadsByWebContentsId.get(webContentsId) ?? 0) + 1
  )
  let released = false
  const release = (): void => {
    if (released) {
      return
    }
    released = true
    clearTimeout(timer)
    const remaining = (inFlightReadsByWebContentsId.get(webContentsId) ?? 1) - 1
    if (remaining > 0) {
      inFlightReadsByWebContentsId.set(webContentsId, remaining)
    } else {
      inFlightReadsByWebContentsId.delete(webContentsId)
    }
  }
  const timer = setTimeout(release, MAX_GRANT_MS)
  timer.unref?.()
  return release
}

export function hasAgentClipboardReadGrant(webContentsId: number | undefined): boolean {
  return webContentsId !== undefined && inFlightReadsByWebContentsId.has(webContentsId)
}

/** True for the CDP evaluate agent-browser issues for `clipboard read`. */
export function isAgentClipboardReadEvaluate(
  method: string,
  params: Record<string, unknown> | undefined
): boolean {
  const expression = params?.expression
  return (
    method === 'Runtime.evaluate' &&
    typeof expression === 'string' &&
    expression.includes('navigator.clipboard.read')
  )
}
