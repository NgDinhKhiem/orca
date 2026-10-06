import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserSessionProfile } from '../../shared/browser-workspace-types'

const mocks = vi.hoisted(() => ({
  handleGuestWillDownload: vi.fn(),
  noticeDocPreviewDownloadBlocked: vi.fn(),
  clearBrowserWebAuthnAccessHandlers: vi.fn(),
  installBrowserWebAuthnAccessHandlers: vi.fn(),
  // Why default true: Windows/Linux have no OS media gate, so this models the platform where the bug lived.
  systemMediaGranted: true,
  showMessageBox: vi.fn(),
  fromWebContents: vi.fn()
}))

type WillDownloadListener = (
  event: { preventDefault: () => void },
  item: { id: string },
  webContents: { id: number }
) => void

type FakeSession = {
  listeners: WillDownloadListener[]
  on: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
  getUserAgent: () => string
  setUserAgent: ReturnType<typeof vi.fn>
  setPermissionRequestHandler: ReturnType<typeof vi.fn>
  setPermissionCheckHandler: ReturnType<typeof vi.fn>
  setDisplayMediaRequestHandler: ReturnType<typeof vi.fn>
}

const sessionsByPartition = new Map<string, FakeSession>()

function fakeSession(): FakeSession {
  const listeners: WillDownloadListener[] = []
  return {
    listeners,
    on: vi.fn((event: string, listener: WillDownloadListener) => {
      if (event === 'will-download') {
        listeners.push(listener)
      }
    }),
    removeListener: vi.fn((event: string, listener: WillDownloadListener) => {
      if (event !== 'will-download') {
        return
      }
      const index = listeners.indexOf(listener)
      if (index !== -1) {
        listeners.splice(index, 1)
      }
    }),
    getUserAgent: () => 'Mozilla/5.0 Orca',
    setUserAgent: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn()
  }
}

vi.mock('electron', () => ({
  dialog: { showMessageBox: mocks.showMessageBox },
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  session: {
    fromPartition: (partition: string) => {
      const existing = sessionsByPartition.get(partition)
      if (existing) {
        return existing
      }
      const created = fakeSession()
      sessionsByPartition.set(partition, created)
      return created
    }
  }
}))
vi.mock('./browser-manager', () => ({
  browserManager: {
    handleGuestWillDownload: mocks.handleGuestWillDownload,
    installCertificateRequestGuard: vi.fn(),
    removeCertificateRequestGuard: vi.fn(),
    notifyPermissionDenied: vi.fn()
  }
}))
vi.mock('./doc-preview-download-block-notice', () => ({
  noticeDocPreviewDownloadBlocked: mocks.noticeDocPreviewDownloadBlocked
}))
vi.mock('./browser-media-access', () => ({
  hasSystemMediaAccess: () => mocks.systemMediaGranted,
  requestSystemMediaAccess: async () => mocks.systemMediaGranted
}))
vi.mock('./browser-session-ua', () => ({
  installBrowserSessionUserAgentPolicy: vi.fn(() => vi.fn())
}))
vi.mock('./browser-process-user-agent', () => ({
  getBrowserProcessUserAgentIdentity: () => ({ mode: 'clean', userAgent: 'Mozilla/5.0 Orca' })
}))
vi.mock('./browser-webauthn-access', () => ({
  allowsBrowserWebAuthnPermission: () => false,
  clearBrowserWebAuthnAccessHandlers: mocks.clearBrowserWebAuthnAccessHandlers,
  installBrowserWebAuthnAccessHandlers: mocks.installBrowserWebAuthnAccessHandlers
}))

type PartitionPolicyInstaller = (
  profile: BrowserSessionProfile,
  options?: { downloads?: 'route' | 'deny'; permissions?: 'browser' | 'deny' }
) => void

// Why imported per test rather than at the top: the installer remembers which partitions it has
// already configured in module state, so a shared import would make the second test's install a
// no-op and leave it reading the first test's listener.
async function loadInstaller(): Promise<PartitionPolicyInstaller> {
  const module = await import('./browser-session-partition-policies')
  return module.installBrowserSessionPartitionPolicies
}

function profileFor(partition: string): BrowserSessionProfile {
  return {
    id: partition,
    scope: 'isolated',
    partition,
    label: partition,
    source: null
  }
}

/** Fires the partition's real `will-download` listener and reports what it decided. */
function fireWillDownload(partition: string): { cancelled: boolean } {
  const sess = sessionsByPartition.get(partition)
  if (!sess || sess.listeners.length !== 1) {
    throw new Error(`expected exactly one will-download listener on ${partition}`)
  }
  let cancelled = false
  sess.listeners[0]({ preventDefault: () => (cancelled = true) }, { id: 'item-1' }, { id: 42 })
  return { cancelled }
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionsByPartition.clear()
  vi.resetModules()
  mocks.systemMediaGranted = true
  mocks.fromWebContents.mockImplementation(() => ({ isDestroyed: () => false }))
})

describe('partition download policy', () => {
  // The presence half: without it, a deny assertion passes for a partition that installed no
  // listener at all, and would keep passing if the whole download path were removed.
  it('routes a download on a partition that did not ask for the deny', async () => {
    const install = await loadInstaller()
    install(profileFor('persist:browsing-1'))

    expect(fireWillDownload('persist:browsing-1').cancelled).toBe(false)
    expect(mocks.handleGuestWillDownload).toHaveBeenCalledWith(
      expect.objectContaining({ guestWebContentsId: 42 })
    )
  })

  it('cancels a download on a partition that asked for the deny, routing nothing', async () => {
    const install = await loadInstaller()
    install(profileFor('orca-doc-preview'), { downloads: 'deny' })

    expect(fireWillDownload('orca-doc-preview').cancelled).toBe(true)
    expect(mocks.handleGuestWillDownload).not.toHaveBeenCalled()
  })

  // Why in the same run as the routing test above: a refusal the reader cannot see is a pressed
  // button that does nothing, and a notice on the routing partition would announce a download that
  // is about to arrive normally.
  it('tells the reader about the refusal, and only on the partition that refused', async () => {
    const install = await loadInstaller()
    install(profileFor('orca-doc-preview'), { downloads: 'deny' })
    install(profileFor('persist:browsing-1'))

    fireWillDownload('persist:browsing-1')
    expect(mocks.noticeDocPreviewDownloadBlocked).not.toHaveBeenCalled()

    fireWillDownload('orca-doc-preview')
    expect(mocks.noticeDocPreviewDownloadBlocked).toHaveBeenCalledWith(
      expect.objectContaining({ id: 42 })
    )
  })

  // Why both partitions in one run: the listener is module state shared across sessions, so a deny
  // installed for one partition must not follow the next partition that installs after it.
  it('keeps each partition on its own decision', async () => {
    const install = await loadInstaller()
    install(profileFor('orca-doc-preview'), { downloads: 'deny' })
    install(profileFor('persist:browsing-1'))

    expect(fireWillDownload('orca-doc-preview').cancelled).toBe(true)
    expect(fireWillDownload('persist:browsing-1').cancelled).toBe(false)
    expect(mocks.handleGuestWillDownload).toHaveBeenCalledTimes(1)
  })
})

describe('partition permission policy', () => {
  it('keeps ordinary browser partitions on the browser permission policy', async () => {
    const install = await loadInstaller()
    install(profileFor('persist:browsing-1'))

    expect(mocks.installBrowserWebAuthnAccessHandlers).toHaveBeenCalledWith(
      sessionsByPartition.get('persist:browsing-1')
    )
    expect(mocks.clearBrowserWebAuthnAccessHandlers).not.toHaveBeenCalled()
  })

  it('denies every request and check on a strict partition without WebAuthn handlers', async () => {
    const install = await loadInstaller()
    install(profileFor('orca-doc-preview'), { permissions: 'deny' })
    const sess = sessionsByPartition.get('orca-doc-preview')
    if (!sess) {
      throw new Error('Expected the preview session')
    }
    const requestHandler = sess.setPermissionRequestHandler.mock.calls[0]?.[0] as (
      webContents: Electron.WebContents,
      permission: string,
      callback: (allowed: boolean) => void
    ) => void
    const checkHandler = sess.setPermissionCheckHandler.mock.calls[0]?.[0] as (
      webContents: Electron.WebContents,
      permission: string
    ) => boolean
    const displayMediaHandler = sess.setDisplayMediaRequestHandler.mock.calls[0]?.[0] as (
      request: Electron.DisplayMediaRequestHandlerHandlerRequest,
      callback: (streams: { video?: Electron.WebFrameMain; audio?: 'loopback' }) => void
    ) => void

    for (const permission of ['media', 'clipboard-read', 'notifications', 'fullscreen']) {
      let decision: boolean | null = null
      requestHandler({} as Electron.WebContents, permission, (allowed) => (decision = allowed))
      expect(decision).toBe(false)
      expect(checkHandler({} as Electron.WebContents, permission)).toBe(false)
    }
    expect(mocks.installBrowserWebAuthnAccessHandlers).not.toHaveBeenCalled()
    expect(mocks.clearBrowserWebAuthnAccessHandlers).toHaveBeenCalledWith(sess)
    let displayMediaDecision: { video?: Electron.WebFrameMain; audio?: 'loopback' } | null = null
    displayMediaHandler({} as Electron.DisplayMediaRequestHandlerHandlerRequest, (decision) => {
      displayMediaDecision = decision
    })
    expect(displayMediaDecision).toEqual({ video: undefined, audio: undefined })
  })
})

type RequestHandler = (
  webContents: unknown,
  permission: string,
  callback: (allowed: boolean) => void,
  details?: Record<string, unknown>
) => void
type CheckHandler = (
  webContents: unknown,
  permission: string,
  requestingOrigin: string,
  details?: Record<string, unknown>
) => boolean

async function installBrowserPartition(
  partition: string
): Promise<{ request: RequestHandler; check: CheckHandler }> {
  const install = await loadInstaller()
  install(profileFor(partition))
  const sess = sessionsByPartition.get(partition)
  if (!sess) {
    throw new Error(`Expected session for ${partition}`)
  }
  return {
    request: sess.setPermissionRequestHandler.mock.calls[0]?.[0] as RequestHandler,
    check: sess.setPermissionCheckHandler.mock.calls[0]?.[0] as CheckHandler
  }
}

function guestAt(url: string, id = 7): Record<string, unknown> {
  return { id, getURL: () => url, hostWebContents: { id: 1 } }
}

function requestDecision(
  request: RequestHandler,
  guest: unknown,
  permission: string,
  details?: Record<string, unknown>
): Promise<boolean> {
  return new Promise((resolve) => request(guest, permission, resolve, details))
}

function answerMediaPrompt(label: 'Allow' | 'Block'): void {
  mocks.showMessageBox.mockImplementation(
    async (_window: unknown, options: { buttons: string[] }) => ({
      response: options.buttons.indexOf(label)
    })
  )
}

describe('partition media consent', () => {
  it('asks before granting a site the camera, and honours Block', async () => {
    const { request, check } = await installBrowserPartition('persist:browsing-1')
    answerMediaPrompt('Block')

    const granted = await requestDecision(request, guestAt('https://meet.example/room'), 'media', {
      mediaTypes: ['video']
    })

    expect(granted).toBe(false)
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)
    const options = mocks.showMessageBox.mock.calls[0]?.[1] as { message: string }
    expect(options.message).toContain('https://meet.example')
    expect(options.message).toContain('camera')
    expect(
      check(null, 'media', 'https://meet.example', {
        mediaType: 'video',
        securityOrigin: 'https://meet.example/'
      })
    ).toBe(false)
  })

  it('remembers Allow per origin and per profile', async () => {
    const { request, check } = await installBrowserPartition('persist:browsing-1')
    answerMediaPrompt('Allow')
    const guest = guestAt('https://meet.example/room')

    expect(await requestDecision(request, guest, 'media', { mediaTypes: ['audio'] })).toBe(true)
    expect(await requestDecision(request, guest, 'media', { mediaTypes: ['audio'] })).toBe(true)
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)
    expect(
      check(null, 'media', 'https://meet.example', {
        mediaType: 'audio',
        securityOrigin: 'https://meet.example/'
      })
    ).toBe(true)
    // Microphone consent does not cover the camera.
    expect(
      check(null, 'media', 'https://meet.example', {
        mediaType: 'video',
        securityOrigin: 'https://meet.example/'
      })
    ).toBe(false)
    expect(
      check(null, 'media', 'https://other.example', {
        mediaType: 'audio',
        securityOrigin: 'https://other.example/'
      })
    ).toBe(false)

    const other = await installBrowserPartition('persist:browsing-2')
    answerMediaPrompt('Block')
    expect(await requestDecision(other.request, guest, 'media', { mediaTypes: ['audio'] })).toBe(
      false
    )
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(2)
  })

  it.each(['http://evil.example/', 'file:///C:/page.html', 'about:blank'])(
    'denies %s without prompting',
    async (url) => {
      const { request } = await installBrowserPartition('persist:browsing-1')
      answerMediaPrompt('Allow')

      expect(await requestDecision(request, guestAt(url), 'media', { mediaTypes: ['video'] })).toBe(
        false
      )
      expect(mocks.showMessageBox).not.toHaveBeenCalled()
    }
  )

  it('allows plain-http localhost after consent', async () => {
    const { request } = await installBrowserPartition('persist:browsing-1')
    answerMediaPrompt('Allow')

    expect(
      await requestDecision(request, guestAt('http://localhost:5173/'), 'media', {
        mediaTypes: ['video']
      })
    ).toBe(true)
  })

  it('fails closed for a headless guest with no window to ask in', async () => {
    const { request } = await installBrowserPartition('persist:browsing-1')
    answerMediaPrompt('Allow')
    const offscreenGuest = { id: 9, getURL: () => 'https://meet.example/' }

    expect(await requestDecision(request, offscreenGuest, 'media', { mediaTypes: ['video'] })).toBe(
      false
    )
    expect(mocks.showMessageBox).not.toHaveBeenCalled()
  })
})

describe('partition clipboard-read policy', () => {
  it('denies clipboard-read to ordinary pages but keeps sanitized write', async () => {
    const { request, check } = await installBrowserPartition('persist:browsing-1')
    const guest = guestAt('https://evil.example/')

    expect(await requestDecision(request, guest, 'clipboard-read')).toBe(false)
    expect(check(guest, 'clipboard-read', 'https://evil.example')).toBe(false)
    expect(await requestDecision(request, guest, 'clipboard-sanitized-write')).toBe(true)
  })

  it('grants clipboard-read only to the page an agent clipboard read is in flight for', async () => {
    const { request, check } = await installBrowserPartition('persist:browsing-1')
    const { beginAgentClipboardRead } = await import('./browser-agent-clipboard-read-grant')
    const agentPage = guestAt('https://app.example/', 11)
    const otherPage = guestAt('https://evil.example/', 12)

    const release = beginAgentClipboardRead(11)
    expect(await requestDecision(request, agentPage, 'clipboard-read')).toBe(true)
    expect(check(agentPage, 'clipboard-read', 'https://app.example')).toBe(true)
    expect(await requestDecision(request, otherPage, 'clipboard-read')).toBe(false)
    release()

    expect(await requestDecision(request, agentPage, 'clipboard-read')).toBe(false)
    expect(check(agentPage, 'clipboard-read', 'https://app.example')).toBe(false)
  })
})
