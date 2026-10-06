export const SYNTHETIC_KILL_EXIT_DUPLICATE_WINDOW_MS = 30_000
// Why: kill switch — flip to disable producer flow control (pause/resume) without untangling the wiring.
export const PRODUCER_FLOW_CONTROL_ENABLED = true
// Why: mobile clients must mirror desktop PTY geometry even before the renderer can provide an xterm snapshot (e.g. right after tab creation).
export const ptySizes = new Map<string, { cols: number; rows: number }>()
// Why: the "recent user input" signal is PTY-scoped and must be cleared by every teardown path, incl. SSH/daemon shutdowns that skip the local exit listener.
export const lastInputAtByPty = new Map<string, number>()
export const interactiveOutputCharsByPty = new Map<string, number>()
export const activeRendererPtys = new Set<string>()
export const visibleRendererPtys = new Set<string>()
export const rendererVisibilityKnownPtys = new Set<string>()
// Why: a renderer visibility/active report can still be in flight when its PTY exits; teardown
// has already cleared the sets above, so applying the late report would re-add a dead id for good.
// Timestamps, not timers: exit must not leave a timer behind. Insertion order is exit order,
// so expired tombstones are always at the head and pruning stays O(1) amortized.
const RENDERER_PTY_EXIT_TOMBSTONE_MS = 30_000
const exitedRendererPtyTombstones = new Map<string, number>()

function pruneExpiredRendererPtyTombstones(now: number): void {
  for (const [id, exitedAt] of exitedRendererPtyTombstones) {
    if (now - exitedAt < RENDERER_PTY_EXIT_TOMBSTONE_MS) {
      return
    }
    exitedRendererPtyTombstones.delete(id)
  }
}

export function markRendererPtyExited(id: string): void {
  const now = Date.now()
  pruneExpiredRendererPtyTombstones(now)
  exitedRendererPtyTombstones.delete(id)
  exitedRendererPtyTombstones.set(id, now)
}

export function isRendererPtyRecentlyExited(id: string): boolean {
  pruneExpiredRendererPtyTombstones(Date.now())
  return exitedRendererPtyTombstones.has(id)
}
// Why null-init + wrapper fns: see debug.ts — rolldown const-folds `export let fn = noop` bridges (STA-5661).
let invalidatePendingPtyDrainPriorityImpl: ((id?: string, schedule?: boolean) => void) | null = null
let invalidatePendingPtyDrainPolicyImpl: ((id?: string, schedule?: boolean) => void) | null = null

export function invalidatePendingPtyDrainPriority(id?: string, schedule?: boolean): void {
  invalidatePendingPtyDrainPriorityImpl?.(id, schedule)
}

export function invalidatePendingPtyDrainPolicy(id?: string, schedule?: boolean): void {
  invalidatePendingPtyDrainPolicyImpl?.(id, schedule)
}
export const KEEP_HISTORY_STOP_SETTLE_MS = 1_000
export const KEEP_HISTORY_STOP_POLL_MS = 100
// Why: after daemon keep-tail thinning main's mirror holds only the kept tail, so recovery must keep consulting the daemon's complete model until exit.
export const providerSnapshotRequiredPtys = new Set<string>()

export function setInvalidatePendingPtyDrainPriority(
  fn: (id?: string, schedule?: boolean) => void
): void {
  invalidatePendingPtyDrainPriorityImpl = fn
}

export function setInvalidatePendingPtyDrainPolicy(
  fn: (id?: string, schedule?: boolean) => void
): void {
  invalidatePendingPtyDrainPolicyImpl = fn
}
