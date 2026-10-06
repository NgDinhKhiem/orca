import { BrowserWindow, dialog } from 'electron'
import type { WebContents } from 'electron'

type MediaKind = 'audio' | 'video'

// Why session-scoped: a camera/microphone grant should not outlive the run that granted it
// without a settings surface to revoke it from. Keyed per profile partition and origin.
const decisionsByPartitionOrigin = new Map<string, Map<MediaKind, boolean>>()
const pendingPrompts = new Map<string, Promise<boolean>>()

function decisionKey(partition: string, origin: string): string {
  return `${partition}\n${origin}`
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'
  )
}

/** The origin a media grant may be keyed on, or null for opaque and non-secure origins. */
export function mediaConsentOrigin(rawUrl: string | undefined): string | null {
  if (!rawUrl) {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  if (parsed.origin === 'null') {
    return null
  }
  if (parsed.protocol === 'https:') {
    return parsed.origin
  }
  return parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname) ? parsed.origin : null
}

function isMediaKind(value: string): value is MediaKind {
  return value === 'audio' || value === 'video'
}

export function hasBrowserMediaConsent(
  partition: string,
  rawOrigin: string | undefined,
  mediaType: string | undefined
): boolean {
  const origin = mediaConsentOrigin(rawOrigin)
  if (!origin || !mediaType || !isMediaKind(mediaType)) {
    return false
  }
  return decisionsByPartitionOrigin.get(decisionKey(partition, origin))?.get(mediaType) === true
}

// Why: only a guest docked in a visible Orca window can be asked about; offscreen (headless serve)
// guests have no one to answer, so they fail closed.
function consentParentWindow(guest: WebContents): BrowserWindow | null {
  const host = guest.hostWebContents
  if (!host) {
    return null
  }
  const window = BrowserWindow.fromWebContents(host)
  return window && !window.isDestroyed() ? window : null
}

function describeDevices(kinds: MediaKind[]): string {
  if (kinds.length === 2) {
    return 'camera and microphone'
  }
  return kinds[0] === 'video' ? 'camera' : 'microphone'
}

export async function requestBrowserMediaConsent(args: {
  partition: string
  guest: WebContents
  rawUrl: string
  mediaTypes: readonly string[]
}): Promise<boolean> {
  const origin = mediaConsentOrigin(args.rawUrl)
  const kinds = [...new Set(args.mediaTypes)].filter(isMediaKind).sort()
  if (!origin || kinds.length === 0) {
    return false
  }
  const key = decisionKey(args.partition, origin)
  const remembered = decisionsByPartitionOrigin.get(key)
  if (kinds.some((kind) => remembered?.get(kind) === false)) {
    return false
  }
  if (kinds.every((kind) => remembered?.get(kind) === true)) {
    return true
  }
  const window = consentParentWindow(args.guest)
  if (!window) {
    return false
  }
  const promptKey = `${key}\n${kinds.join(',')}`
  const pending = pendingPrompts.get(promptKey)
  if (pending) {
    return pending
  }
  const prompt = (async (): Promise<boolean> => {
    const buttons = ['Allow', 'Block']
    const { response } = await dialog.showMessageBox(window, {
      type: 'question',
      buttons,
      defaultId: 1,
      cancelId: 1,
      message: `${origin} wants to use your ${describeDevices(kinds)}.`,
      detail: 'Orca remembers this choice for this browser profile until Orca quits.'
    })
    const allowed = buttons[response] === 'Allow'
    const decisions = decisionsByPartitionOrigin.get(key) ?? new Map<MediaKind, boolean>()
    for (const kind of kinds) {
      decisions.set(kind, allowed)
    }
    decisionsByPartitionOrigin.set(key, decisions)
    return allowed
  })()
  pendingPrompts.set(promptKey, prompt)
  try {
    return await prompt
  } finally {
    pendingPrompts.delete(promptKey)
  }
}

export function forgetBrowserMediaConsent(partition: string): void {
  for (const key of decisionsByPartitionOrigin.keys()) {
    if (key.startsWith(`${partition}\n`)) {
      decisionsByPartitionOrigin.delete(key)
    }
  }
}
