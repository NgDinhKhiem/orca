// Why: each attachment probe spawns tmux plus a `ps` per pid on macOS, so an attachment
// that has not changed for a while is re-checked less often; a change or a hook resets it.
const ACTIVE_REFRESH_MS = 1000
const SETTLING_REFRESH_MS = 2000
const IDLE_REFRESH_MS = 5000
const UNCHANGED_REFRESHES_BEFORE_SETTLING = 10
const UNCHANGED_REFRESHES_BEFORE_IDLE = 20

export function tmuxAttachmentRefreshDelayMs(unchangedRefreshes: number): number {
  if (unchangedRefreshes < UNCHANGED_REFRESHES_BEFORE_SETTLING) {
    return ACTIVE_REFRESH_MS
  }
  return unchangedRefreshes < UNCHANGED_REFRESHES_BEFORE_IDLE
    ? SETTLING_REFRESH_MS
    : IDLE_REFRESH_MS
}

type TmuxAttachmentState = { paneKey: string; selection?: string; publication?: string }

/** What a refresh can change: which inner pane each outer pane projects, and what it published. */
function tmuxAttachmentFingerprint(outers: Iterable<TmuxAttachmentState>): string {
  return [...outers]
    .map((outer) => `${outer.paneKey}\0${outer.selection ?? ''}\0${outer.publication ?? ''}`)
    .join('\n')
}

/** Self-rescheduling refresh loop: 1 s while attachments change, backing off to 5 s when idle. */
export class TmuxAttachmentRefreshTimer {
  private timer: ReturnType<typeof setTimeout> | undefined
  private delayMs = ACTIVE_REFRESH_MS
  private unchangedRefreshes = 0

  constructor(
    private readonly source: {
      refresh: () => Promise<void>
      hasWork: () => boolean
      attachments: () => Iterable<TmuxAttachmentState>
    }
  ) {}

  /** A hook arrived: the user is active here, so return to the fast cadence. */
  noteActivity(): void {
    this.unchangedRefreshes = 0
    if (!this.timer || this.delayMs > ACTIVE_REFRESH_MS) {
      this.arm()
    }
  }

  /** Counts a refresh toward the backoff unless it changed an attachment. */
  async track(work: Promise<void>): Promise<void> {
    const before = tmuxAttachmentFingerprint(this.source.attachments())
    await work
    const changed = tmuxAttachmentFingerprint(this.source.attachments()) !== before
    this.unchangedRefreshes = changed ? 0 : this.unchangedRefreshes + 1
  }

  stop(): void {
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private arm(): void {
    this.stop()
    if (!this.source.hasWork()) {
      return
    }
    this.delayMs = tmuxAttachmentRefreshDelayMs(this.unchangedRefreshes)
    const timer = setTimeout(() => {
      if (this.timer !== timer) {
        return
      }
      this.timer = undefined
      void this.source.refresh().finally(() => {
        if (!this.timer) {
          this.arm()
        }
      })
    }, this.delayMs)
    timer.unref?.()
    this.timer = timer
  }
}
