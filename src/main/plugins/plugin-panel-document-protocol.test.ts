import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, protocolHandleMock, isProtocolHandledMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  protocolHandleMock: vi.fn(),
  isProtocolHandledMock: vi.fn(() => false)
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock },
  protocol: { handle: protocolHandleMock, isProtocolHandled: isProtocolHandledMock }
}))

import {
  createPluginPanelDocumentResponse,
  createPluginPanelDocumentStore,
  registerPluginPanelDocumentHandlers
} from './plugin-panel-document-protocol'
import { PLUGIN_PANEL_CSP } from '../../shared/plugins/plugin-panel-shell'
import {
  PLUGIN_PANEL_DOCUMENT_SCHEME,
  parsePluginPanelDocumentId
} from '../../shared/plugins/plugin-panel-document-url'

describe('createPluginPanelDocumentStore', () => {
  it('serves a published document at an unguessable panel URL', () => {
    const store = createPluginPanelDocumentStore()
    const url = store.publish(7, '<h1>panel</h1>')

    expect(url.startsWith(`${PLUGIN_PANEL_DOCUMENT_SCHEME}://document/`)).toBe(true)
    expect(parsePluginPanelDocumentId(url)).not.toBeNull()
    expect(store.read(url)).toBe('<h1>panel</h1>')
    expect(store.publish(7, '<h1>panel</h1>')).not.toBe(url)
  })

  it('releases only documents the owner published', () => {
    const store = createPluginPanelDocumentStore()
    const url = store.publish(7, 'a')

    store.release(8, url)
    expect(store.read(url)).toBe('a')
    store.release(7, url)
    expect(store.read(url)).toBeNull()
  })

  it('drops every document of a destroyed owner', () => {
    const store = createPluginPanelDocumentStore()
    const first = store.publish(7, 'a')
    const second = store.publish(7, 'b')
    const other = store.publish(9, 'c')

    store.releaseOwner(7)
    expect(store.read(first)).toBeNull()
    expect(store.read(second)).toBeNull()
    expect(store.read(other)).toBe('c')
  })

  it('evicts an owner’s oldest documents beyond the cap', () => {
    const store = createPluginPanelDocumentStore({ maxDocumentsPerOwner: 2 })
    const first = store.publish(7, 'a')
    const second = store.publish(7, 'b')
    const third = store.publish(7, 'c')

    expect(store.read(first)).toBeNull()
    expect(store.read(second)).toBe('b')
    expect(store.read(third)).toBe('c')
  })

  it('rejects documents that are not strings or are too large', () => {
    const store = createPluginPanelDocumentStore({ maxDocumentLength: 4 })
    expect(() => store.publish(7, 12)).toThrow()
    expect(() => store.publish(7, '12345')).toThrow()
  })

  it('reads nothing for foreign or malformed URLs', () => {
    const store = createPluginPanelDocumentStore()
    store.publish(7, 'a')
    expect(store.read('orca-plugin-panel://document/../../etc/passwd')).toBeNull()
    expect(store.read('https://example.com/')).toBeNull()
  })
})

describe('createPluginPanelDocumentResponse', () => {
  it('serves HTML under the panel CSP and never caches it', async () => {
    const response = createPluginPanelDocumentResponse('<p>hi</p>')

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Security-Policy')).toBe(PLUGIN_PANEL_CSP)
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    await expect(response.text()).resolves.toBe('<p>hi</p>')
  })

  it('answers unknown documents with 404', () => {
    expect(createPluginPanelDocumentResponse(null).status).toBe(404)
  })
})

describe('registerPluginPanelDocumentHandlers', () => {
  beforeEach(() => {
    handleMock.mockReset()
    protocolHandleMock.mockReset()
  })

  function getHandler(channel: string): (...args: unknown[]) => unknown {
    const call = handleMock.mock.calls.find((entry: unknown[]) => entry[0] === channel)
    const handler: unknown = call?.[1]
    if (typeof handler !== 'function') {
      throw new Error(`${channel} not registered`)
    }
    return (...args: unknown[]) => Reflect.apply(handler, undefined, args)
  }

  it('publishes per sender and serves through the protocol handler', async () => {
    registerPluginPanelDocumentHandlers()
    const destroyedListeners: (() => void)[] = []
    const sender = {
      id: 42,
      once: (eventName: string, listener: () => void) => {
        if (eventName === 'destroyed') {
          destroyedListeners.push(listener)
        }
      }
    }
    const url = getHandler('plugins:publishPanelDocument')({ sender }, '<p>panel</p>')
    expect(typeof url).toBe('string')

    const serve: unknown = protocolHandleMock.mock.calls[0]?.[1]
    if (typeof serve !== 'function') {
      throw new Error('protocol handler not installed')
    }
    expect(protocolHandleMock.mock.calls[0]?.[0]).toBe(PLUGIN_PANEL_DOCUMENT_SCHEME)
    const response: unknown = await Reflect.apply(serve, undefined, [new Request(String(url))])
    if (!(response instanceof Response)) {
      throw new Error('protocol handler did not answer')
    }
    await expect(response.text()).resolves.toBe('<p>panel</p>')

    getHandler('plugins:publishPanelDocument')({ sender }, '<p>second</p>')
    expect(destroyedListeners).toHaveLength(1)
    destroyedListeners[0]?.()
    const afterDestroy: unknown = await Reflect.apply(serve, undefined, [new Request(String(url))])
    expect(afterDestroy instanceof Response && afterDestroy.status).toBe(404)
  })
})
