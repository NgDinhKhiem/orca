import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { DOC_PREVIEW_LINK_CLICK_CHANNEL } from '../../shared/doc-preview-scheme'

/**
 * Defence in depth for every ipcMain channel: only Orca's own windows (main and
 * dashboard pop-out) running the app document in their top frame may call main.
 * Guests cannot reach ipcRenderer today; this keeps a compromised guest or a
 * future preload slip from inheriting the whole privileged IPC surface.
 */

const trustedAppWebContentsIds = new Set<number>()

/** Marks a window that loads Orca's app document with the full preload. */
export function registerTrustedAppWebContents(webContents: { id: number }): void {
  // Why: webContents ids are never reused, so stale ids cannot match a new sender.
  trustedAppWebContentsIds.add(webContents.id)
}

export type AppDocumentLocation = {
  /** Directory holding the built renderer HTML entries. */
  rendererDirectory: string
  /** The electron-vite dev server; null in packaged and built runs. */
  devServerUrl: string | null
}

const APP_DOCUMENT_FILE_NAMES = ['index.html', 'popout.html']

function comparablePath(pathValue: string): string {
  const resolved = resolve(pathValue)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function parseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl)
  } catch {
    return null
  }
}

export function isAppDocumentUrl(rawUrl: string, location: AppDocumentLocation): boolean {
  const url = parseUrl(rawUrl)
  if (!url) {
    return false
  }
  const devServer = location.devServerUrl ? parseUrl(location.devServerUrl) : null
  if (devServer && url.origin === devServer.origin) {
    return true
  }
  if (url.protocol !== 'file:') {
    return false
  }
  let documentPath: string
  try {
    documentPath = comparablePath(fileURLToPath(url))
  } catch {
    return false
  }
  // Why: pathname only — reloads may keep a query or hash on the same document.
  return APP_DOCUMENT_FILE_NAMES.some(
    (fileName) => comparablePath(resolve(location.rendererDirectory, fileName)) === documentPath
  )
}

/** The parts of an Electron IPC event the trust check reads. */
export type IpcSenderIdentity = {
  sender: { id: number; isDestroyed(): boolean; mainFrame: unknown }
  senderFrame: { url: string } | null
}

function readSenderFrame(event: IpcSenderIdentity): IpcSenderIdentity['senderFrame'] {
  try {
    return event.senderFrame
  } catch {
    // Why: Electron can throw for a frame disposed while the message was queued.
    return null
  }
}

export function isTrustedAppIpcSender(
  event: IpcSenderIdentity,
  location: AppDocumentLocation
): boolean {
  const { sender } = event
  if (!trustedAppWebContentsIds.has(sender.id) || sender.isDestroyed()) {
    return false
  }
  const senderFrame = readSenderFrame(event)
  // Why: the preload only runs in the top frame; subframe or disposed-frame senders are not Orca.
  if (!senderFrame || senderFrame !== sender.mainFrame) {
    return false
  }
  return isAppDocumentUrl(senderFrame.url, location)
}

export type TrustedIpcSenderGateOptions = {
  isTrustedSender: (event: IpcSenderIdentity) => boolean
  /** Channels that guests may send; each must validate its own sender. */
  untrustedSenderChannels: ReadonlySet<string>
}

type InvokeListener = (event: IpcMainInvokeEvent, ...args: any[]) => unknown
type MessageListener = (event: IpcMainEvent, ...args: any[]) => void

const gatedIpcMains = new WeakSet<object>()

export function installTrustedIpcSenderGate(
  ipcMain: IpcMain,
  options: TrustedIpcSenderGateOptions
): void {
  if (gatedIpcMains.has(ipcMain)) {
    return
  }
  gatedIpcMains.add(ipcMain)
  const warnedChannels = new Set<string>()
  const gatedMessageListeners = new WeakMap<MessageListener, Map<string, MessageListener>>()

  const isAllowed = (channel: string, event: IpcSenderIdentity): boolean => {
    if (options.isTrustedSender(event)) {
      return true
    }
    if (!warnedChannels.has(channel)) {
      warnedChannels.add(channel)
      console.warn(`[ipc] Refused ${channel} from an untrusted sender`)
    }
    return false
  }

  const gateInvoke =
    (channel: string, listener: InvokeListener): InvokeListener =>
    (event, ...args) => {
      if (!isAllowed(channel, event)) {
        throw new Error(`Refused ${channel}: untrusted sender`)
      }
      return listener(event, ...args)
    }

  const gateMessage = (channel: string, listener: MessageListener): MessageListener => {
    if (options.untrustedSenderChannels.has(channel)) {
      return listener
    }
    let byChannel = gatedMessageListeners.get(listener)
    if (!byChannel) {
      byChannel = new Map()
      gatedMessageListeners.set(listener, byChannel)
    }
    const existing = byChannel.get(channel)
    if (existing) {
      return existing
    }
    const gated: MessageListener = (event, ...args) => {
      if (!isAllowed(channel, event)) {
        // Why: a refused sendSync caller would otherwise block until it times out.
        event.returnValue = null
        return
      }
      listener(event, ...args)
    }
    byChannel.set(channel, gated)
    return gated
  }

  const handle = ipcMain.handle.bind(ipcMain)
  const handleOnce = ipcMain.handleOnce.bind(ipcMain)
  const on = ipcMain.on.bind(ipcMain)
  const prependListener = ipcMain.prependListener.bind(ipcMain)
  const removeListener = ipcMain.removeListener.bind(ipcMain)

  ipcMain.handle = (channel, listener) => {
    handle(
      channel,
      options.untrustedSenderChannels.has(channel) ? listener : gateInvoke(channel, listener)
    )
  }
  ipcMain.handleOnce = (channel, listener) => {
    handleOnce(
      channel,
      options.untrustedSenderChannels.has(channel) ? listener : gateInvoke(channel, listener)
    )
  }
  // Why: EventEmitter.once/prependOnceListener delegate to these, so they are gated too.
  ipcMain.on = (channel, listener) => on(channel, gateMessage(channel, listener))
  ipcMain.addListener = ipcMain.on
  ipcMain.prependListener = (channel, listener) =>
    prependListener(channel, gateMessage(String(channel), listener))
  // Why: callers remove listeners by the reference they registered.
  ipcMain.removeListener = (channel, listener) =>
    removeListener(channel, gatedMessageListeners.get(listener)?.get(channel) ?? listener)
  ipcMain.off = ipcMain.removeListener
}

/** Gates Orca's real ipcMain; only the doc-preview guest link channel stays open. */
export function installAppIpcSenderGate(ipcMain: IpcMain, location: AppDocumentLocation): void {
  installTrustedIpcSenderGate(ipcMain, {
    isTrustedSender: (event) => isTrustedAppIpcSender(event, location),
    // Why: the doc-preview guest preload sends this; reportDocPreviewLinkClick checks the guest.
    untrustedSenderChannels: new Set([DOC_PREVIEW_LINK_CLICK_CHANNEL])
  })
}
