import { join } from 'node:path'
import { safeStorage } from 'electron'
import {
  PLUGIN_STORAGE_KEY_LIMIT,
  PLUGIN_STORAGE_TOTAL_MAX_BYTES
} from '../../shared/plugins/plugin-host-api'
import {
  pluginDataRecordFiles,
  type PluginDataRecordFile,
  type PluginDataRecordFormat
} from './plugin-data-record-file'
import { pluginDataDir } from './plugin-storage-store'

/**
 * Per-plugin secret vault, following the repo's safeStorage-backed
 * credential-file pattern (versioned envelope + base64 ciphertext via the
 * atomic secure-file writer). No plaintext fallback: when OS encryption is
 * unavailable, writes fail loudly instead of silently downgrading — plugin
 * secrets are API-token grade.
 */

const SECRETS_FORMAT = 'electron-safe-storage-v1'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `{ version: 1, format, ciphertexts: { key: base64 ciphertext } }`, written compactly. */
const SECRETS_RECORD_FORMAT: PluginDataRecordFormat = {
  prefix: `{"version":1,"format":"${SECRETS_FORMAT}","ciphertexts":{`,
  suffix: '}}',
  entriesOf: (parsed) =>
    isRecord(parsed) &&
    parsed.version === 1 &&
    parsed.format === SECRETS_FORMAT &&
    isRecord(parsed.ciphertexts)
      ? parsed.ciphertexts
      : null
}

export type PluginSecretsResult<T> = { ok: true; value: T } | { ok: false; error: string }

const UNREADABLE_VAULT_ERROR = 'secret vault exists but could not be read; refusing to overwrite it'

const SECRETS_WRITE_ERRORS = {
  unreadable: UNREADABLE_VAULT_ERROR,
  keyLimit: `secret vault exceeds the ${PLUGIN_STORAGE_KEY_LIMIT}-key limit`,
  sizeLimit: `secret vault exceeds ${PLUGIN_STORAGE_TOTAL_MAX_BYTES} bytes`
}

export class PluginSecretsStore {
  private readonly filePath: string

  constructor(pluginsDataDir: string, qualifiedKey: string) {
    this.filePath = join(pluginDataDir(pluginsDataDir, qualifiedKey), 'secrets.json.enc')
  }

  // Why written through, not debounced: secret writes are rare user actions, and losing one to a
  // crash inside the debounce window would silently drop a credential.
  private file(): PluginDataRecordFile {
    return pluginDataRecordFiles.get(this.filePath, SECRETS_RECORD_FORMAT, 'immediate')
  }

  get(key: string): PluginSecretsResult<string | null> {
    const entries = this.file().read()
    if (!entries) {
      return { ok: false, error: UNREADABLE_VAULT_ERROR }
    }
    const stored = entries.get(key)
    const ciphertext: unknown = stored === undefined ? undefined : JSON.parse(stored)
    if (typeof ciphertext !== 'string') {
      return { ok: true, value: null }
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'OS-backed encryption is unavailable' }
    }
    try {
      return { ok: true, value: safeStorage.decryptString(Buffer.from(ciphertext, 'base64')) }
    } catch {
      return { ok: false, error: 'failed to decrypt stored secret' }
    }
  }

  set(key: string, value: string): PluginSecretsResult<true> {
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'OS-backed encryption is unavailable; secret not stored' }
    }
    const file = this.file()
    if (!file.read()) {
      return { ok: false, error: UNREADABLE_VAULT_ERROR }
    }
    const ciphertext = safeStorage.encryptString(value).toString('base64')
    const written = file.set(key, JSON.stringify(ciphertext), SECRETS_WRITE_ERRORS)
    return written.ok ? { ok: true, value: true } : written
  }

  delete(key: string): void {
    this.file().delete(key)
  }
}
