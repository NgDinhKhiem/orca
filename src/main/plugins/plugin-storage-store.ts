import { join } from 'node:path'
import { isQualifiedPluginKey } from '../../shared/plugins/plugin-manifest'
import {
  PLUGIN_STORAGE_KEY_LIMIT,
  PLUGIN_STORAGE_TOTAL_MAX_BYTES,
  PLUGIN_STORAGE_VALUE_MAX_BYTES
} from '../../shared/plugins/plugin-host-api'
import {
  pluginDataRecordFiles,
  type PluginDataRecordFile,
  type PluginDataRecordFormat
} from './plugin-data-record-file'

/**
 * Per-plugin JSON key-value persistence backing both `storage.*` (plugin
 * data) and `settings.*` (settings:own). Each plugin's data lives in its OWN
 * file under `<userData>/plugins-data/<publisher>.<id>/` — never a shared
 * namespaced blob, so one plugin's path can never resolve into another's.
 * Adapted from community PR #5801's per-plugin settings store.
 */

const UNREADABLE_STORE_ERROR = 'storage file exists but could not be read; refusing to overwrite it'

export function pluginDataDir(pluginsDataDir: string, qualifiedKey: string): string {
  if (!isQualifiedPluginKey(qualifiedKey)) {
    throw new Error(`unsafe plugin key: ${qualifiedKey}`)
  }
  return join(pluginsDataDir, qualifiedKey)
}

export type PluginKvWriteResult = { ok: true } | { ok: false; error: string }

const KV_RECORD_FORMAT: PluginDataRecordFormat = {
  prefix: '{',
  suffix: '}',
  entriesOf: (parsed) =>
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : null
}

const KV_WRITE_ERRORS = {
  unreadable: UNREADABLE_STORE_ERROR,
  keyLimit: `storage exceeds the ${PLUGIN_STORAGE_KEY_LIMIT}-key limit`,
  sizeLimit: `storage exceeds ${PLUGIN_STORAGE_TOTAL_MAX_BYTES} bytes`
}

/** A handle onto the process-wide cache for one plugin file; cheap enough to build per request. */
export class PluginKvStore {
  private readonly filePath: string

  constructor(
    pluginsDataDir: string,
    qualifiedKey: string,
    fileName: 'storage.json' | 'settings.json'
  ) {
    this.filePath = join(pluginDataDir(pluginsDataDir, qualifiedKey), fileName)
  }

  private file(): PluginDataRecordFile {
    return pluginDataRecordFiles.get(this.filePath, KV_RECORD_FORMAT, 'debounced')
  }

  get(key: string): unknown {
    const json = this.file().read()?.get(key)
    // Parsed per call, as the file read was: callers can never mutate the cached value.
    return json === undefined ? undefined : JSON.parse(json)
  }

  getAll(): Record<string, unknown> {
    const entries = this.file().read() ?? new Map<string, string>()
    return Object.fromEntries([...entries].map(([key, json]) => [key, JSON.parse(json)]))
  }

  keys(): string[] {
    // Through an object so key order matches the parsed file's (integer-like keys first).
    return Object.keys(
      Object.fromEntries([...(this.file().read()?.keys() ?? [])].map((key) => [key, 0]))
    )
  }

  set(key: string, value: unknown): PluginKvWriteResult {
    let serialized: string
    try {
      serialized = JSON.stringify(value)
    } catch {
      return { ok: false, error: 'value is not JSON-serializable' }
    }
    if (serialized === undefined) {
      return { ok: false, error: 'value is not JSON-serializable' }
    }
    if (Buffer.byteLength(serialized, 'utf8') > PLUGIN_STORAGE_VALUE_MAX_BYTES) {
      return { ok: false, error: `value exceeds ${PLUGIN_STORAGE_VALUE_MAX_BYTES} bytes` }
    }
    return this.file().set(key, serialized, KV_WRITE_ERRORS)
  }

  delete(key: string): void {
    this.file().delete(key)
  }
}
