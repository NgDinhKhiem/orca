import { existsSync, readFileSync, statSync } from 'node:fs'
import { sep } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { isUnreadableError, writeSecureFile } from '../../shared/secure-file'
import {
  PLUGIN_STORAGE_KEY_LIMIT,
  PLUGIN_STORAGE_TOTAL_MAX_BYTES
} from '../../shared/plugins/plugin-host-api'

/** Coalesces bursts of plugin writes; the quit flush and uninstall discard bound what it defers. */
export const PLUGIN_DATA_WRITE_DEBOUNCE_MS = 250

/**
 * The file is `prefix + "key":value,... + suffix`, i.e. compact JSON whose record entries are
 * kept pre-serialized, so a write never re-stringifies values and size checks stay O(1).
 */
export type PluginDataRecordFormat = {
  prefix: string
  suffix: string
  /** The entries of a well-formed file; null for a parsed file of the wrong shape. */
  entriesOf(parsed: unknown): Record<string, unknown> | null
}

export type PluginDataRecordWrite = { ok: true } | { ok: false; error: string }

export type PluginDataRecordErrors = {
  unreadable: string
  keyLimit: string
  sizeLimit: string
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

export class PluginDataRecordFile {
  /** key -> JSON text of the value; null until loaded. */
  private entries: Map<string, string> | null = null
  private entryBytes = 0
  private writeTimer: ReturnType<typeof setTimeout> | null = null
  private dirty = false

  constructor(
    readonly filePath: string,
    private readonly format: PluginDataRecordFormat,
    private readonly writeMode: 'debounced' | 'immediate',
    private readonly registry: PluginDataRecordFileRegistry
  ) {}

  /** null means the file exists and this process may not read it — which is never "empty". */
  read(): ReadonlyMap<string, string> | null {
    return this.load()
  }

  set(key: string, valueJson: string, errors: PluginDataRecordErrors): PluginDataRecordWrite {
    const entries = this.load()
    if (!entries) {
      return { ok: false, error: errors.unreadable }
    }
    const previous = entries.get(key)
    if (previous === undefined && entries.size >= PLUGIN_STORAGE_KEY_LIMIT) {
      return { ok: false, error: errors.keyLimit }
    }
    const nextEntryBytes =
      this.entryBytes -
      (previous === undefined ? 0 : this.entrySize(key, previous)) +
      this.entrySize(key, valueJson)
    if (
      this.fileSize(nextEntryBytes, entries.size + (previous === undefined ? 1 : 0)) >
      PLUGIN_STORAGE_TOTAL_MAX_BYTES
    ) {
      return { ok: false, error: errors.sizeLimit }
    }
    entries.set(key, valueJson)
    this.entryBytes = nextEntryBytes
    this.changed(() => {
      if (previous === undefined) {
        entries.delete(key)
      } else {
        entries.set(key, previous)
      }
      this.entryBytes = this.recount(entries)
    })
    return { ok: true }
  }

  delete(key: string): void {
    const entries = this.load()
    const previous = entries?.get(key)
    if (!entries || previous === undefined) {
      // Unreadable: rewriting what we could not read would drop every other key.
      return
    }
    entries.delete(key)
    this.entryBytes -= this.entrySize(key, previous)
    this.changed(() => {
      entries.set(key, previous)
      this.entryBytes = this.recount(entries)
    })
  }

  /** Writes a pending change now; failures stay pending for the next flush. */
  flush(): void {
    this.clearTimer()
    if (!this.dirty || !this.entries) {
      return
    }
    try {
      writeSecureFile(this.filePath, this.serialize(this.entries))
      this.dirty = false
    } catch (error) {
      console.error(`[plugins] failed to write ${this.filePath}:`, error)
    }
  }

  /** Drops the cache and any pending write; the plugin's data dir is being removed. */
  discard(): void {
    this.clearTimer()
    this.dirty = false
    this.entries = null
  }

  private changed(revert: () => void): void {
    this.dirty = true
    if (this.writeMode === 'immediate' || this.registry.writesThrough) {
      try {
        writeSecureFile(this.filePath, this.serialize(this.entries ?? new Map()))
        this.dirty = false
      } catch (error) {
        // Keep memory equal to disk so the caller's failure is the whole story.
        revert()
        this.dirty = false
        throw error
      }
      return
    }
    if (this.writeTimer === null) {
      this.writeTimer = setTimeout(() => {
        this.writeTimer = null
        this.flush()
      }, PLUGIN_DATA_WRITE_DEBOUNCE_MS)
      this.writeTimer.unref?.()
    }
  }

  private load(): Map<string, string> | null {
    if (this.entries) {
      return this.entries
    }
    let loaded = new Map<string, string>()
    try {
      if (
        existsSync(this.filePath) &&
        statSync(this.filePath).size <= PLUGIN_STORAGE_TOTAL_MAX_BYTES
      ) {
        const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
        const record = this.format.entriesOf(parsed)
        if (record) {
          loaded = new Map(
            Object.entries(record).map(([key, value]): [string, string] => [
              key,
              JSON.stringify(value)
            ])
          )
        }
      }
    } catch (error) {
      // Not cached: a denied read is retried, and must never be mistaken for an empty store.
      if (isUnreadableError(error)) {
        return null
      }
      // Corrupt files reset to empty rather than wedging the plugin.
    }
    this.entries = loaded
    this.entryBytes = this.recount(loaded)
    return loaded
  }

  private serialize(entries: ReadonlyMap<string, string>): string {
    const body = [...entries].map(([key, json]) => `${JSON.stringify(key)}:${json}`).join(',')
    return `${this.format.prefix}${body}${this.format.suffix}`
  }

  private entrySize(key: string, json: string): number {
    return byteLength(JSON.stringify(key)) + 1 + byteLength(json)
  }

  private recount(entries: ReadonlyMap<string, string>): number {
    let total = 0
    for (const [key, json] of entries) {
      total += this.entrySize(key, json)
    }
    return total
  }

  private fileSize(entryBytes: number, count: number): number {
    return (
      byteLength(this.format.prefix) +
      byteLength(this.format.suffix) +
      entryBytes +
      Math.max(0, count - 1)
    )
  }

  private clearTimer(): void {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
  }
}

export class PluginDataRecordFileRegistry {
  private readonly files = new Map<string, PluginDataRecordFile>()
  /** Set by the quit flush: nothing may be left on a timer once the process is exiting. */
  writesThrough = false
  private quitFlushInstalled = false

  get(
    filePath: string,
    format: PluginDataRecordFormat,
    writeMode: 'debounced' | 'immediate'
  ): PluginDataRecordFile {
    let file = this.files.get(filePath)
    if (!this.quitFlushInstalled && hasAppEnvironment()) {
      getAppEnvironment().onWillQuit(() => this.flushAll({ thenWriteThrough: true }))
      this.quitFlushInstalled = true
    }
    if (!file) {
      file = new PluginDataRecordFile(filePath, format, writeMode, this)
      this.files.set(filePath, file)
    }
    return file
  }

  flushAll(options: { thenWriteThrough?: boolean } = {}): void {
    if (options.thenWriteThrough) {
      this.writesThrough = true
    }
    for (const file of this.files.values()) {
      file.flush()
    }
  }

  /** Forgets every file under a plugin's data dir, cancelling its pending writes. */
  discardUnder(pluginDataDirectory: string): void {
    const prefix = pluginDataDirectory.endsWith(sep)
      ? pluginDataDirectory
      : `${pluginDataDirectory}${sep}`
    for (const [filePath, file] of this.files) {
      if (filePath.startsWith(prefix)) {
        file.discard()
        this.files.delete(filePath)
      }
    }
  }
}

/** One cache per plugin data file for the process: host-API calls build a store per request. */
export const pluginDataRecordFiles = new PluginDataRecordFileRegistry()
