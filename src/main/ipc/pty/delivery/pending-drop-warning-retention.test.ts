import { describe, expect, it, vi } from 'vitest'
import { createPtyIpcSession } from '../session'
import { finalizePtyExitForRenderer } from './exit'
import { dropOversizedPendingPtyData, pendingDataCapChars } from './pending'

vi.mock('../../../crash-reporting/crash-breadcrumb-store', () => ({
  recordCrashBreadcrumb: vi.fn()
}))

function overflow(session: ReturnType<typeof createPtyIpcSession>, id: string): void {
  dropOversizedPendingPtyData(session, id, { data: 'x'.repeat(pendingDataCapChars(session) + 1) })
}

describe('pending output drop warning retention', () => {
  it('forgets the once-per-PTY drop warning when the PTY exits', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const send = vi.fn()
    const session = createPtyIpcSession({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exit finalization only calls isDestroyed() and webContents.send().
      mainWindow: { isDestroyed: () => false, webContents: { send } } as never
    })
    for (let index = 0; index < 20; index += 1) {
      const id = `pty-${index}`
      overflow(session, id)
      expect(session.pendingDataDropWarnedPtys.has(id)).toBe(true)
      finalizePtyExitForRenderer(session, { id, code: 0 })
    }
    expect(session.pendingDataDropWarnedPtys.size).toBe(0)
  })

  it('forgets it even when the renderer window is already gone', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const session = createPtyIpcSession({})
    overflow(session, 'pty-orphan')
    finalizePtyExitForRenderer(session, { id: 'pty-orphan', code: 0 })
    expect(session.pendingDataDropWarnedPtys.size).toBe(0)
  })
})
