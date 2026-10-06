import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  writeSecureFile,
  hardenExistingSecureFile,
  isUnreadableError
} from '../../shared/secure-file'
import { removeStaleDurableWriteTempFiles } from '../durable-file-write'
import type { MobileNotificationEvent } from './runtime-mobile-notification-controller'

export type DeliveredNotificationIdentity = {
  notificationId: string
  notificationEpoch: string
  notificationSeq: number
}
type RecordEntry = DeliveredNotificationIdentity & { dismissedThrough: number; expiresAt: number }
const LIMIT = 4096
const RETENTION_MS = 7 * 86400_000
const STALE_WRITE_TEMP_AGE_MS = 86400_000
// Why: each write is a whole-file rewrite (and icacls spawns on Windows); bursts share one.
const WRITE_DEBOUNCE_MS = 1000

export class MobileNotificationDismissalStore {
  private readonly path: string
  private entries: RecordEntry[] = []
  private unreadable = false
  private dirty = false
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  constructor(userDataPath: string) {
    this.path = join(userDataPath, 'mobile-notification-dismissals.json')
    // Why: a write killed between writeFile and rename (e.g. a hung icacls, #20497) orphans its temp forever.
    void removeStaleDurableWriteTempFiles(this.path, { minimumAgeMs: STALE_WRITE_TEMP_AGE_MS })
    try {
      hardenExistingSecureFile(this.path)
      const value: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      if (Array.isArray(value)) {
        this.entries = value.filter(isEntry).slice(-LIMIT)
      }
    } catch (error) {
      this.unreadable = isUnreadableError(error)
      // Missing history cannot establish that a delivered alert was dismissed.
    }
  }

  record(
    event: MobileNotificationEvent & { notificationEpoch: string; notificationSeq: number }
  ): void {
    if (!event.notificationId) {
      return
    }
    const now = Date.now()
    const kept = this.entries.filter((entry) => entry.expiresAt > now)
    const same = (entry: RecordEntry) =>
      entry.notificationId === event.notificationId &&
      entry.notificationEpoch === event.notificationEpoch
    let next: RecordEntry[]
    if (event.type === 'notification') {
      next = [
        ...kept.filter((entry) => !same(entry)),
        {
          notificationId: event.notificationId,
          notificationEpoch: event.notificationEpoch,
          notificationSeq: event.notificationSeq,
          dismissedThrough: kept.find(same)?.dismissedThrough ?? -1,
          expiresAt: now + RETENTION_MS
        }
      ]
    } else {
      next = kept
        .filter((entry) => !same(entry))
        .map((entry) =>
          entry.notificationId === event.notificationId
            ? { ...entry, dismissedThrough: entry.notificationSeq, expiresAt: now + RETENTION_MS }
            : entry
        )
      next.push({
        notificationId: event.notificationId,
        notificationEpoch: event.notificationEpoch,
        notificationSeq: event.notificationSeq,
        dismissedThrough: event.notificationSeq,
        expiresAt: now + RETENTION_MS
      })
    }
    next = next.slice(-LIMIT)
    this.entries = next
    if (!this.unreadable) {
      this.scheduleWrite()
    }
  }

  /** Writes a pending change now; the owner calls this on quit. */
  flush(): void {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    if (!this.dirty) {
      return
    }
    try {
      writeSecureFile(this.path, JSON.stringify(this.entries))
      this.dirty = false
    } catch (error) {
      // Kept dirty: the next record or the quit flush retries.
      console.warn('[mobile-notifications] failed to persist dismissals:', error)
    }
  }

  private scheduleWrite(): void {
    this.dirty = true
    if (this.writeTimer !== null) {
      return
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      this.flush()
    }, WRITE_DEBOUNCE_MS)
    this.writeTimer.unref?.()
  }

  reconcile(delivered: readonly DeliveredNotificationIdentity[]): DeliveredNotificationIdentity[] {
    const now = Date.now()
    return delivered.filter((item) =>
      this.entries.some(
        (entry) =>
          entry.dismissedThrough >= 0 &&
          entry.expiresAt > now &&
          entry.notificationId === item.notificationId &&
          entry.notificationEpoch === item.notificationEpoch &&
          entry.dismissedThrough >= item.notificationSeq
      )
    )
  }
}

function isEntry(value: unknown): value is RecordEntry {
  if (!value || typeof value !== 'object') {
    return false
  }
  const item = value as RecordEntry
  return (
    typeof item.notificationId === 'string' &&
    item.notificationId.length > 0 &&
    typeof item.notificationEpoch === 'string' &&
    item.notificationEpoch.length > 0 &&
    Number.isSafeInteger(item.notificationSeq) &&
    item.notificationSeq >= 0 &&
    Number.isSafeInteger(item.dismissedThrough) &&
    item.dismissedThrough >= -1 &&
    Number.isFinite(item.expiresAt)
  )
}
