import { existsSync, readFileSync, renameSync } from 'node:fs'
import type * as fs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PLUGIN_STORAGE_TOTAL_MAX_BYTES,
  PLUGIN_STORAGE_VALUE_MAX_BYTES
} from '../../shared/plugins/plugin-host-api'
import { setAppEnvironment } from '../../shared/app-environment'
import { PluginDataRecordFileRegistry, pluginDataRecordFiles } from './plugin-data-record-file'
import { PluginSecretsStore } from './plugin-secrets-store'
import { pluginDataDir, PluginKvStore } from './plugin-storage-store'

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>()
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    renameSync: vi.fn(actual.renameSync)
  }
})

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8').slice('encrypted:'.length)
  }
}))

const roots: string[] = []
const pluginKey = 'acme.demo'

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-data-'))
  roots.push(root)
  return root
}

const callsFor = (mock: unknown, file: string): number =>
  vi.mocked(mock as typeof readFileSync).mock.calls.filter(([path]) => String(path) === file).length
const renamesTo = (file: string): number =>
  vi.mocked(renameSync).mock.calls.filter(([, target]) => String(target) === file).length

afterEach(async () => {
  pluginDataRecordFiles.flushAll()
  for (const root of roots.splice(0)) {
    pluginDataRecordFiles.discardUnder(pluginDataDir(root, pluginKey))
    await rm(root, { recursive: true, force: true })
  }
  vi.mocked(readFileSync).mockClear()
  vi.mocked(renameSync).mockClear()
})

describe('plugin KV storage', () => {
  it('serves repeated reads from memory across per-request store objects', async () => {
    const root = await tempRoot()
    const file = join(root, pluginKey, 'storage.json')
    new PluginKvStore(root, pluginKey, 'storage.json').set('counter', 1)
    pluginDataRecordFiles.flushAll()
    vi.mocked(readFileSync).mockClear()

    for (let request = 0; request < 5; request++) {
      expect(new PluginKvStore(root, pluginKey, 'storage.json').get('counter')).toBe(1)
    }
    expect(callsFor(readFileSync, file)).toBe(0)
  })

  it('coalesces a burst of writes into one compact file write', async () => {
    const root = await tempRoot()
    const file = join(root, pluginKey, 'storage.json')
    for (let index = 0; index < 20; index++) {
      expect(
        new PluginKvStore(root, pluginKey, 'storage.json').set(`key-${index}`, { index })
      ).toEqual({
        ok: true
      })
    }
    pluginDataRecordFiles.flushAll()
    expect(renamesTo(file)).toBe(1)
    const text = readFileSync(file, 'utf8')
    expect(text).not.toContain('\n')
    expect(JSON.parse(text)).toMatchObject({ 'key-0': { index: 0 }, 'key-19': { index: 19 } })
  })

  it('returns a fresh copy so callers cannot mutate the cached value', async () => {
    const root = await tempRoot()
    const store = new PluginKvStore(root, pluginKey, 'storage.json')
    store.set('nested', { list: [1] })
    const first = store.get('nested') as { list: number[] }
    first.list.push(2)
    expect(store.get('nested')).toEqual({ list: [1] })
  })

  it('still enforces the total size limit without changing stored data', async () => {
    const root = await tempRoot()
    const store = new PluginKvStore(root, pluginKey, 'storage.json')
    const chunk = 'x'.repeat(PLUGIN_STORAGE_VALUE_MAX_BYTES - 16)
    let accepted = 0
    for (
      let index = 0;
      index * PLUGIN_STORAGE_VALUE_MAX_BYTES <= PLUGIN_STORAGE_TOTAL_MAX_BYTES;
      index++
    ) {
      if (store.set(`chunk-${index}`, chunk).ok) {
        accepted++
      }
    }
    const result = store.set('one-more', chunk)
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('exceeds') })
    expect(store.keys()).toHaveLength(accepted)
    pluginDataRecordFiles.flushAll()
    const file = join(root, pluginKey, 'storage.json')
    expect(Buffer.byteLength(readFileSync(file, 'utf8'))).toBeLessThanOrEqual(
      PLUGIN_STORAGE_TOTAL_MAX_BYTES
    )
  })

  it('does not resurrect a removed plugin data dir with a pending write', async () => {
    const root = await tempRoot()
    new PluginKvStore(root, pluginKey, 'storage.json').set('pending', true)
    pluginDataRecordFiles.discardUnder(pluginDataDir(root, pluginKey))
    await rm(join(root, pluginKey), { recursive: true, force: true })
    pluginDataRecordFiles.flushAll()
    expect(existsSync(join(root, pluginKey))).toBe(false)
    expect(new PluginKvStore(root, pluginKey, 'storage.json').get('pending')).toBeUndefined()
  })
})

describe('plugin secrets', () => {
  it('reads the vault once and writes each change through compactly', async () => {
    const root = await tempRoot()
    const file = join(root, pluginKey, 'secrets.json.enc')
    expect(new PluginSecretsStore(root, pluginKey).set('token', 'secret')).toEqual({
      ok: true,
      value: true
    })
    // Written through: a lost secret would be a silent credential loss.
    expect(renamesTo(file)).toBe(1)
    expect(readFileSync(file, 'utf8')).not.toContain('\n')
    vi.mocked(readFileSync).mockClear()
    for (let request = 0; request < 5; request++) {
      expect(new PluginSecretsStore(root, pluginKey).get('token')).toEqual({
        ok: true,
        value: 'secret'
      })
    }
    expect(callsFor(readFileSync, file)).toBe(0)
  })
})

describe('plugin data quit flush', () => {
  it('persists pending writes from will-quit, then writes later changes straight through', async () => {
    const root = await tempRoot()
    const file = join(root, pluginKey, 'storage.json')
    const quitHandlers: (() => void)[] = []
    setAppEnvironment({
      getPath: () => root,
      getAppPath: () => root,
      getVersion: () => '0.0.0',
      isPackaged: () => false,
      onWillQuit: (handler) => quitHandlers.push(handler),
      exit: () => {},
      getAppMetrics: () => []
    })
    const registry = new PluginDataRecordFileRegistry()
    const format = { prefix: '{', suffix: '}', entriesOf: () => ({}) }
    const errors = { unreadable: 'unreadable', keyLimit: 'keys', sizeLimit: 'size' }
    registry.get(file, format, 'debounced').set('before-quit', '1', errors)
    expect(existsSync(file)).toBe(false)

    quitHandlers.forEach((handler) => handler())
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'before-quit': 1 })

    registry.get(file, format, 'debounced').set('after-quit', '2', errors)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'before-quit': 1, 'after-quit': 2 })
  })
})
