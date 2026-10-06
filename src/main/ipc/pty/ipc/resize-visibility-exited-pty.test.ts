import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setPtyHostBindings, type PtyIpcSurface } from '../../pty-host-bindings'
import { createPtyIpcSession } from '../session'
import { finalizePtyExitForRenderer } from '../delivery/exit'
import {
  activeRendererPtys,
  isRendererPtyRecentlyExited,
  rendererVisibilityKnownPtys,
  visibleRendererPtys
} from '../delivery/visibility-state'
import { ptyOwnership } from '../provider/ownership-state'
import { installPtyResizeVisibilityIpc } from './resize-visibility'

type Listener = (event: null, args: unknown) => void

function install(): Map<string, Listener> {
  const listeners = new Map<string, Listener>()
  const ipc: PtyIpcSurface = {
    handle: () => {},
    on: (channel, listener) => {
      listeners.set(channel, (_event, args) =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the visibility and active handlers never read the event.
        listener(null as never, args)
      )
    },
    removeHandler: () => {},
    removeAllListeners: () => {}
  }
  setPtyHostBindings({ ipc })
  const session = createPtyIpcSession({})
  session.syncPtyBackgroundedDelivery = () => {}
  installPtyResizeVisibilityIpc(session)
  return listeners
}

/** What every exit path does: provider teardown clears the sets, then the renderer is told. */
function exitPty(id: string): void {
  ptyOwnership.delete(id)
  visibleRendererPtys.delete(id)
  rendererVisibilityKnownPtys.delete(id)
  activeRendererPtys.delete(id)
  finalizePtyExitForRenderer(createPtyIpcSession({}), { id, code: 0 })
}

function sizes(): number[] {
  return [visibleRendererPtys.size, rendererVisibilityKnownPtys.size, activeRendererPtys.size]
}

describe('renderer visibility reports after PTY exit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    for (const id of ['pty-a', 'pty-b']) {
      ptyOwnership.delete(id)
      visibleRendererPtys.delete(id)
      rendererVisibilityKnownPtys.delete(id)
      activeRendererPtys.delete(id)
    }
    setPtyHostBindings({})
    vi.useRealTimers()
  })

  it('does not re-add a PTY whose visibility report lands after its exit', () => {
    const listeners = install()
    const baseline = sizes()
    ptyOwnership.set('pty-a', null)
    listeners.get('pty:setRendererPtyVisible')?.(null, { id: 'pty-a', visible: true })
    listeners.get('pty:setActiveRendererPty')?.(null, { id: 'pty-a', active: true })
    exitPty('pty-a')

    listeners.get('pty:setRendererPtyVisible')?.(null, { id: 'pty-a', visible: true })
    listeners.get('pty:setActiveRendererPty')?.(null, { id: 'pty-a', active: true })

    expect(sizes()).toEqual(baseline)
    // The tombstone itself is bounded: it expires after the late-report window.
    vi.advanceTimersByTime(30_000)
    expect(isRendererPtyRecentlyExited('pty-a')).toBe(false)
  })

  it('accepts reports again once the same id is respawned', () => {
    const listeners = install()
    exitPty('pty-b')
    ptyOwnership.set('pty-b', null)

    listeners.get('pty:setRendererPtyVisible')?.(null, { id: 'pty-b', visible: false })

    expect(rendererVisibilityKnownPtys.has('pty-b')).toBe(true)
  })
})
