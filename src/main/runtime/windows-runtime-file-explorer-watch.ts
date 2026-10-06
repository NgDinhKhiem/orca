import { watch as watchFs, type FSWatcher } from 'node:fs'
import type { FsChangeEvent } from '../../shared/filesystem-entry-types'
import { PhysicalExitTracker } from '../../shared/physical-exit-tracker'
import { WATCHER_IGNORE_DIRS } from '../ipc/filesystem-watcher-ignore'
import { WatcherProcessFailure } from '../ipc/parcel-watcher-process-failure'
import {
  normalizeRuntimeWatcherRoot,
  WINDOWS_RUNTIME_FILE_WATCH_CLOSE_DEADLINE_MS,
  WINDOWS_RUNTIME_FILE_WATCH_DEBOUNCE_MS
} from './runtime-file-commands-mobile-file-list-limit'

type WindowsRuntimeWatchSubscriber = {
  rootPath: string
  callback: (events: FsChangeEvent[]) => void
  onTerminalError: (error: Error) => void
}

const IGNORED_WATCH_DIR_NAMES = new Set(WATCHER_IGNORE_DIRS)

const sharedWatchesByRoot = new Map<string, SharedWindowsRuntimeWatch>()

export function isIgnoredWindowsRuntimeWatchFilename(filename: string | null): boolean {
  // Why: a null filename cannot be attributed to a directory, so it must still refresh.
  if (!filename) {
    return false
  }
  return filename.split(/[\\/]/).some((segment) => IGNORED_WATCH_DIR_NAMES.has(segment))
}

function deliverToSubscriber(rootPath: string, deliver: () => void): void {
  try {
    deliver()
  } catch (err) {
    // Why: one subscriber's failure must not starve the others sharing this watcher.
    console.error('[runtime-files.watch] Windows watcher subscriber error', { rootPath, err })
  }
}

class SharedWindowsRuntimeWatch {
  readonly subscribers = new Set<WindowsRuntimeWatchSubscriber>()
  private readonly key: string
  private readonly rootPath: string
  private readonly watcher: FSWatcher
  private readonly physicalClose = new PhysicalExitTracker()
  private timer: ReturnType<typeof setTimeout> | null = null
  private closeStarted = false

  constructor(key: string, rootPath: string) {
    this.key = key
    this.rootPath = rootPath
    // Why: Parcel's Watchman probe can crash the headless server on Windows; use a conservative overflow refresh instead.
    this.watcher = watchFs(rootPath, { recursive: true }, (_eventType, filename) => {
      if (!isIgnoredWindowsRuntimeWatchFilename(filename)) {
        this.scheduleOverflow()
      }
    })
    this.watcher.once('close', this.onClose)
    this.watcher.on('error', this.onError)
  }

  /** Returns true when the caller was the last subscriber and now owns closing the watcher. */
  release(subscriber: WindowsRuntimeWatchSubscriber): boolean {
    this.subscribers.delete(subscriber)
    if (this.subscribers.size > 0) {
      return false
    }
    this.forgetSharedEntry()
    this.clearTimer()
    return true
  }

  async close(): Promise<void> {
    this.clearTimer()
    if (!this.closeStarted) {
      try {
        this.watcher.close()
      } catch (err) {
        console.error('[runtime-files.watch] Windows watcher close error', {
          rootPath: this.rootPath,
          err
        })
        throw err
      }
      this.closeStarted = true
    }
    try {
      await this.physicalClose.waitForExit(
        WINDOWS_RUNTIME_FILE_WATCH_CLOSE_DEADLINE_MS,
        () => new Error('Windows watcher did not close before deletion deadline')
      )
    } catch (error) {
      // Why: late Windows close still owns native dir handles; expose its completion so cleanup retains then clears the root.
      throw new WatcherProcessFailure(
        error instanceof Error ? error.message : String(error),
        'supervisor',
        'process_unavailable',
        this.physicalClose.exitedPromise
      )
    }
  }

  private forgetSharedEntry(): void {
    if (sharedWatchesByRoot.get(this.key) === this) {
      sharedWatchesByRoot.delete(this.key)
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private scheduleOverflow(): void {
    if (this.subscribers.size === 0) {
      return
    }
    this.clearTimer()
    this.timer = setTimeout(this.emitOverflow, WINDOWS_RUNTIME_FILE_WATCH_DEBOUNCE_MS)
  }

  private readonly emitOverflow = (): void => {
    this.timer = null
    for (const subscriber of Array.from(this.subscribers)) {
      if (this.subscribers.has(subscriber)) {
        deliverToSubscriber(subscriber.rootPath, () =>
          subscriber.callback([{ kind: 'overflow', absolutePath: subscriber.rootPath }])
        )
      }
    }
  }

  private readonly onClose = (): void => {
    this.watcher.removeListener('error', this.onError)
    this.physicalClose.markExited()
  }

  private readonly onError = (err: Error): void => {
    console.error('[runtime-files.watch] Windows watcher error', { rootPath: this.rootPath, err })
    this.clearTimer()
    this.watcher.removeListener('close', this.onClose)
    this.watcher.removeListener('error', this.onError)
    // Why: Node nulls FSWatcher's native handle on error without a close event; treat the error as physical-exit proof.
    this.physicalClose.markExited()
    // Why: the dead watcher keeps its subscribers until they unsubscribe; new subscribers need a live one.
    this.forgetSharedEntry()
    for (const subscriber of Array.from(this.subscribers)) {
      if (this.subscribers.has(subscriber)) {
        deliverToSubscriber(subscriber.rootPath, () =>
          subscriber.callback([{ kind: 'overflow', absolutePath: subscriber.rootPath }])
        )
        deliverToSubscriber(subscriber.rootPath, () => subscriber.onTerminalError(err))
      }
    }
  }
}

export function watchWindowsRuntimeFileExplorer(
  rootPath: string,
  callback: (events: FsChangeEvent[]) => void,
  onTerminalError: (error: Error) => void
): () => Promise<void> {
  // Why: one recursive fs.watch per root; each one holds native handles over the whole tree.
  const key = normalizeRuntimeWatcherRoot(rootPath)
  let shared = sharedWatchesByRoot.get(key)
  if (!shared) {
    shared = new SharedWindowsRuntimeWatch(key, rootPath)
    sharedWatchesByRoot.set(key, shared)
  }
  const owner = shared
  const subscriber: WindowsRuntimeWatchSubscriber = { rootPath, callback, onTerminalError }
  owner.subscribers.add(subscriber)
  let released = false
  let ownsClose = false

  return async () => {
    if (!released) {
      released = true
      ownsClose = owner.release(subscriber)
    }
    // Why: only the last subscriber closes; retries re-enter close() so a failed native close can be retried.
    if (ownsClose) {
      await owner.close()
    }
  }
}
