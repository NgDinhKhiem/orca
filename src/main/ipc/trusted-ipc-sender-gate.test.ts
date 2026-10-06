import { EventEmitter } from 'node:events'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  installTrustedIpcSenderGate,
  isAppDocumentUrl,
  isTrustedAppIpcSender,
  registerTrustedAppWebContents,
  type AppDocumentLocation,
  type IpcSenderIdentity
} from './trusted-ipc-sender-gate'

/** Mirrors Electron's IpcMainImpl: an EventEmitter plus a handler map. */
class FakeIpcMain extends EventEmitter implements IpcMain {
  readonly _invokeHandlers = new Map<string, (...args: any[]) => unknown>()

  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
    if (this._invokeHandlers.has(channel)) {
      throw new Error(`second handler for ${channel}`)
    }
    this._invokeHandlers.set(channel, listener)
  }

  handleOnce(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown
  ): void {
    this.handle(channel, (event, ...args: any[]) => {
      this.removeHandler(channel)
      return listener(event, ...args)
    })
  }

  removeHandler(channel: string): void {
    this._invokeHandlers.delete(channel)
  }

  async invoke(channel: string, event: IpcSenderIdentity, ...args: unknown[]): Promise<unknown> {
    const handler = this._invokeHandlers.get(channel)
    if (!handler) {
      throw new Error(`no handler for ${channel}`)
    }
    return handler(event, ...args)
  }
}

const rendererDirectory = resolve('out', 'renderer')
const location: AppDocumentLocation = { rendererDirectory, devServerUrl: null }
const appDocumentUrl = pathToFileURL(join(rendererDirectory, 'index.html')).toString()

let nextWebContentsId = 1000

type FakeSenderEvent = IpcSenderIdentity & { returnValue?: unknown }

function createSender(options: { trusted: boolean; url?: string }): {
  sender: IpcSenderIdentity['sender'] & { destroyed: boolean }
  mainFrameEvent: () => FakeSenderEvent
  subframeEvent: () => FakeSenderEvent
} {
  const mainFrame = { url: options.url ?? appDocumentUrl }
  const sender = {
    id: nextWebContentsId++,
    destroyed: false,
    isDestroyed(): boolean {
      return sender.destroyed
    },
    mainFrame
  }
  if (options.trusted) {
    registerTrustedAppWebContents(sender)
  }
  return {
    sender,
    mainFrameEvent: () => ({ sender, senderFrame: mainFrame }),
    subframeEvent: () => ({ sender, senderFrame: { url: appDocumentUrl } })
  }
}

function installGate(exempt: string[] = []): FakeIpcMain {
  const ipcMain = new FakeIpcMain()
  installTrustedIpcSenderGate(ipcMain, {
    isTrustedSender: (event) => isTrustedAppIpcSender(event, location),
    untrustedSenderChannels: new Set(exempt)
  })
  return ipcMain
}

describe('isAppDocumentUrl', () => {
  it('accepts the built main and popout documents, ignoring query and hash', () => {
    expect(isAppDocumentUrl(appDocumentUrl, location)).toBe(true)
    expect(
      isAppDocumentUrl(pathToFileURL(join(rendererDirectory, 'popout.html')).toString(), location)
    ).toBe(true)
    expect(isAppDocumentUrl(`${appDocumentUrl}?prevented-unload=1#settings`, location)).toBe(true)
  })

  it('rejects other local files, guests and remote pages', () => {
    expect(
      isAppDocumentUrl(pathToFileURL(resolve('tmp', 'orca-export-1.html')).toString(), location)
    ).toBe(false)
    expect(
      isAppDocumentUrl(
        pathToFileURL(join(rendererDirectory, 'web-index.html')).toString(),
        location
      )
    ).toBe(false)
    expect(isAppDocumentUrl('orca-preview://grant/index.html', location)).toBe(false)
    expect(isAppDocumentUrl('https://example.com/index.html', location)).toBe(false)
    expect(isAppDocumentUrl('data:text/html,hi', location)).toBe(false)
    expect(isAppDocumentUrl('not a url', location)).toBe(false)
  })

  it('accepts the dev server origin only when one is configured', () => {
    const devLocation = { ...location, devServerUrl: 'http://localhost:5173' }
    expect(isAppDocumentUrl('http://localhost:5173/', devLocation)).toBe(true)
    expect(isAppDocumentUrl('http://localhost:5173/popout.html', devLocation)).toBe(true)
    expect(isAppDocumentUrl('http://localhost:5174/', devLocation)).toBe(false)
    expect(isAppDocumentUrl('http://localhost:5173/', location)).toBe(false)
  })

  it.runIf(process.platform === 'win32')(
    'compares Windows document paths case-insensitively',
    () => {
      expect(
        isAppDocumentUrl(appDocumentUrl.toUpperCase().replace('FILE:', 'file:'), location)
      ).toBe(true)
    }
  )
})

describe('isTrustedAppIpcSender', () => {
  it('trusts the main frame of a registered app window', () => {
    expect(isTrustedAppIpcSender(createSender({ trusted: true }).mainFrameEvent(), location)).toBe(
      true
    )
  })

  it('rejects unregistered webContents even on the app document', () => {
    expect(isTrustedAppIpcSender(createSender({ trusted: false }).mainFrameEvent(), location)).toBe(
      false
    )
  })

  it('rejects subframes and disposed frames of a trusted window', () => {
    const window = createSender({ trusted: true })
    expect(isTrustedAppIpcSender(window.subframeEvent(), location)).toBe(false)
    expect(isTrustedAppIpcSender({ sender: window.sender, senderFrame: null }, location)).toBe(
      false
    )
  })

  it('rejects a trusted window that is showing another document', () => {
    const window = createSender({ trusted: true, url: 'https://evil.example/' })
    expect(isTrustedAppIpcSender(window.mainFrameEvent(), location)).toBe(false)
  })

  it('rejects destroyed webContents', () => {
    const window = createSender({ trusted: true })
    window.sender.destroyed = true
    expect(isTrustedAppIpcSender(window.mainFrameEvent(), location)).toBe(false)
  })
})

describe('installTrustedIpcSenderGate', () => {
  it('runs handle() handlers for trusted senders and rejects others', async () => {
    const ipcMain = installGate()
    const handler = vi.fn((_event: unknown, value: number) => value * 2)
    ipcMain.handle('fs:readFile', handler)

    await expect(
      ipcMain.invoke('fs:readFile', createSender({ trusted: true }).mainFrameEvent(), 21)
    ).resolves.toBe(42)
    await expect(
      ipcMain.invoke('fs:readFile', createSender({ trusted: false }).mainFrameEvent(), 1)
    ).rejects.toThrow(/untrusted sender/i)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('passes the real event through to the handler', async () => {
    const ipcMain = installGate()
    const event = createSender({ trusted: true }).mainFrameEvent()
    const handler = vi.fn()
    ipcMain.handle('ui:consumePendingOpenSettings', handler)

    await ipcMain.invoke('ui:consumePendingOpenSettings', event)
    expect(handler).toHaveBeenCalledWith(event)
  })

  it('gates handleOnce() handlers', async () => {
    const ipcMain = installGate()
    const handler = vi.fn(() => 'ok')
    ipcMain.handleOnce('app:once', handler)

    await expect(
      ipcMain.invoke('app:once', createSender({ trusted: false }).mainFrameEvent())
    ).rejects.toThrow(/untrusted sender/i)
    expect(handler).not.toHaveBeenCalled()
  })

  it('ignores on() messages from untrusted senders and answers sync calls with null', () => {
    const ipcMain = installGate()
    const listener = vi.fn((event: FakeSenderEvent) => {
      event.returnValue = 'settings'
    })
    ipcMain.on('settings:get-sync', listener)

    const trustedEvent = createSender({ trusted: true }).mainFrameEvent()
    ipcMain.emit('settings:get-sync', trustedEvent)
    expect(trustedEvent.returnValue).toBe('settings')

    const untrustedEvent = createSender({ trusted: false }).mainFrameEvent()
    ipcMain.emit('settings:get-sync', untrustedEvent)
    expect(untrustedEvent.returnValue).toBeNull()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('gates once(), addListener() and prependListener() registrations', () => {
    const ipcMain = installGate()
    const listeners = [vi.fn(), vi.fn(), vi.fn()]
    ipcMain.once('a', listeners[0])
    ipcMain.addListener('b', listeners[1])
    ipcMain.prependListener('c', listeners[2])

    const untrusted = createSender({ trusted: false }).mainFrameEvent()
    for (const channel of ['a', 'b', 'c']) {
      ipcMain.emit(channel, untrusted)
    }
    for (const listener of listeners) {
      expect(listener).not.toHaveBeenCalled()
    }
  })

  it('removes listeners by their original reference', () => {
    const ipcMain = installGate()
    const listener = vi.fn()
    ipcMain.on('runtime:reply', listener)
    ipcMain.on('other:reply', listener)
    expect(ipcMain.listenerCount('runtime:reply')).toBe(1)

    ipcMain.removeListener('runtime:reply', listener)
    expect(ipcMain.listenerCount('runtime:reply')).toBe(0)
    expect(ipcMain.listenerCount('other:reply')).toBe(1)
    ipcMain.off('other:reply', listener)
    expect(ipcMain.listenerCount('other:reply')).toBe(0)
  })

  it('lets exempt channels reach their own sender checks', () => {
    const ipcMain = installGate(['docPreview:linkClick'])
    const listener = vi.fn()
    ipcMain.on('docPreview:linkClick', listener)

    const guestEvent = createSender({ trusted: false, url: 'orca-preview://grant/a.html' })
    ipcMain.emit('docPreview:linkClick', guestEvent.mainFrameEvent(), 'https://example.com')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does not double-wrap when installed twice', async () => {
    const ipcMain = new FakeIpcMain()
    const isTrustedSender = vi.fn(() => true)
    const options = { isTrustedSender, untrustedSenderChannels: new Set<string>() }
    installTrustedIpcSenderGate(ipcMain, options)
    installTrustedIpcSenderGate(ipcMain, options)
    ipcMain.handle('x', () => 1)

    await ipcMain.invoke('x', createSender({ trusted: true }).mainFrameEvent())
    expect(isTrustedSender).toHaveBeenCalledTimes(1)
  })
})
