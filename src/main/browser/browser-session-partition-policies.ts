import { session } from 'electron'
import type { Session } from 'electron'
import type { BrowserSessionProfile } from '../../shared/browser-workspace-types'
import { browserManager } from './browser-manager'
import { clearProxySessionCredentials } from '../network/proxy-settings'
import {
  applyProxyToBrowserSession,
  invalidateBrowserSessionProxyApplication
} from './browser-session-proxy'
import { hasSystemMediaAccess, requestSystemMediaAccess } from './browser-media-access'
import { isAutoGrantedBrowserSessionPermission } from './browser-session-permission-policy'
import { hasAgentClipboardReadGrant } from './browser-agent-clipboard-read-grant'
import {
  forgetBrowserMediaConsent,
  hasBrowserMediaConsent,
  requestBrowserMediaConsent
} from './browser-media-permission-consent'
import { installBrowserSessionUserAgentPolicy } from './browser-session-ua'
import { getBrowserProcessUserAgentIdentity } from './browser-process-user-agent'
import {
  allowsBrowserWebAuthnPermission,
  clearBrowserWebAuthnAccessHandlers,
  installBrowserWebAuthnAccessHandlers
} from './browser-webauthn-access'
import { noticeDocPreviewDownloadBlocked } from './doc-preview-download-block-notice'

// Why: one shared installer keeps every partition's deny-by-default permission/download policies from drifting apart.
const configuredPartitions = new Set<string>()
const userAgentPolicyDisposerBySession = new WeakMap<Session, () => void>()

export function retireBrowserSessionUserAgentPolicy(sess: Session): void {
  const dispose = userAgentPolicyDisposerBySession.get(sess)
  if (!dispose) {
    return
  }
  userAgentPolicyDisposerBySession.delete(sess)
  dispose()
}

function configureBrowserSessionUserAgentPolicy(sess: Session, installExceptions: boolean): void {
  sess.setUserAgent(getBrowserProcessUserAgentIdentity().userAgent)
  if (!installExceptions) {
    retireBrowserSessionUserAgentPolicy(sess)
    return
  }
  if (userAgentPolicyDisposerBySession.has(sess)) {
    return
  }
  userAgentPolicyDisposerBySession.set(
    sess,
    installBrowserSessionUserAgentPolicy(sess, (request) =>
      browserManager.resolveBrowserGuestRequestUserAgent(request)
    )
  )
}

/** Drop only the installer memo; retired-session guards remain fail-closed. */
export function forgetBrowserSessionPartitionConfiguration(partition: string): void {
  configuredPartitions.delete(partition)
}
const handleWillDownload = (
  _event: Electron.Event,
  item: Electron.DownloadItem,
  webContents: Electron.WebContents
): void => {
  browserManager.handleGuestWillDownload({ guestWebContentsId: webContents.id, item })
}

/**
 * Why a second listener instead of a branch inside the shared one: `will-download` is a session
 * event that names no partition, so the only place the decision can be keyed by partition is which
 * listener that partition's session got. A workspace-document guest has no page of its own to
 * attribute a download to, so routing one lands it in this desktop's Downloads folder under a
 * remote-authored name that nothing in the UI accounts for.
 */
const handleDeniedWillDownload = (
  event: Electron.Event,
  _item: Electron.DownloadItem,
  webContents: Electron.WebContents
): void => {
  event.preventDefault()
  // The page gets nothing back; the reader gets a sentence, or a pressed button just does nothing.
  noticeDocPreviewDownloadBlocked(webContents)
}

function resolvePermissionNoticeUrl(
  webContents: Electron.WebContents,
  details: Electron.PermissionRequest | undefined
): string {
  const requestingUrl = details?.requestingUrl
  if (!requestingUrl) {
    return webContents.getURL()
  }
  try {
    return new URL(requestingUrl).origin === 'null' ? '' : requestingUrl
  } catch {
    return ''
  }
}

/** `route` hands the item to the owning page's download flow; `deny` cancels it before it starts. */
export type BrowserPartitionDownloadPolicy = 'route' | 'deny'
export type BrowserPartitionPermissionPolicy = 'browser' | 'deny'

// Why async despite no await: the user agent policy is configured before the first suspension, and
// getBrowserProcessUserAgentIdentity throws when the process identity was never initialized. Callers
// report failure through the promise (`void install(...).catch(...)`), so a synchronous throw would
// escape every one of them and gate browser-session startup on bookkeeping that is allowed to fail.
export async function installBrowserSessionPartitionPolicies(
  profile: BrowserSessionProfile,
  options: {
    downloads?: BrowserPartitionDownloadPolicy
    permissions?: BrowserPartitionPermissionPolicy
    applyAppWideProxy?: boolean
    userAgentExceptions?: boolean
  } = {}
): Promise<void> {
  const { partition } = profile
  const sess = session.fromPartition(partition)
  configureBrowserSessionUserAgentPolicy(sess, options.userAgentExceptions !== false)
  // Why: route partitions own a SOCKS transport policy that the app proxy must not overwrite.
  const proxyReady = (
    options.applyAppWideProxy === false ? Promise.resolve() : applyProxyToBrowserSession(sess)
  ).catch((error: unknown) => {
    clearProxySessionCredentials(sess)
    throw error
  })
  if (configuredPartitions.has(partition)) {
    return proxyReady
  }

  browserManager.installCertificateRequestGuard(sess)
  if (options?.permissions === 'deny') {
    sess.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    sess.setPermissionCheckHandler(() => false)
    clearBrowserWebAuthnAccessHandlers(sess)
  } else {
    sess.setPermissionRequestHandler((webContents, permission, callback, details) => {
      // Why: media needs the user's per-origin consent first, then macOS TCC; denying at the session
      // layer after both would throw NotAllowedError even though the user granted Camera/Mic.
      if (permission === 'media') {
        // Capture before async handling; opaque frames cannot be attributed to a named site.
        const rawUrl = resolvePermissionNoticeUrl(webContents, details)
        const mediaDetails = details as Electron.MediaAccessPermissionRequest | undefined
        void requestBrowserMediaConsent({
          partition,
          guest: webContents,
          rawUrl,
          mediaTypes: mediaDetails?.mediaTypes ?? []
        })
          .then((consented) => consented && requestSystemMediaAccess(mediaDetails))
          .then(
            (granted) => {
              if (!granted) {
                browserManager.notifyPermissionDenied({
                  guestWebContentsId: webContents.id,
                  permission,
                  rawUrl
                })
              }
              callback(granted)
            },
            (error: unknown) => {
              console.error('[permissions] Browser media access failed:', error)
              browserManager.notifyPermissionDenied({
                guestWebContentsId: webContents.id,
                permission,
                rawUrl
              })
              callback(false)
            }
          )
        return
      }
      if (permission === 'clipboard-read' && hasAgentClipboardReadGrant(webContents.id)) {
        callback(true)
        return
      }
      const allowed = isAutoGrantedBrowserSessionPermission(permission)
      if (!allowed) {
        const rawUrl = resolvePermissionNoticeUrl(webContents, details)
        browserManager.notifyPermissionDenied({
          guestWebContentsId: webContents.id,
          permission,
          rawUrl
        })
      }
      callback(allowed)
    })
    sess.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
      if (permission === 'media') {
        return (
          hasSystemMediaAccess(details?.mediaType) &&
          hasBrowserMediaConsent(
            partition,
            details?.securityOrigin || requestingOrigin,
            details?.mediaType
          )
        )
      }
      if (permission === 'clipboard-read') {
        return hasAgentClipboardReadGrant(webContents?.id)
      }
      if (allowsBrowserWebAuthnPermission(permission, details)) {
        return true
      }
      return isAutoGrantedBrowserSessionPermission(permission)
    })
    installBrowserWebAuthnAccessHandlers(sess)
  }
  sess.setDisplayMediaRequestHandler((_request, callback) => {
    callback({ video: undefined, audio: undefined })
  })
  sess.removeListener('will-download', handleWillDownload)
  sess.removeListener('will-download', handleDeniedWillDownload)
  sess.on(
    'will-download',
    options?.downloads === 'deny' ? handleDeniedWillDownload : handleWillDownload
  )
  configuredPartitions.add(partition)
  return proxyReady
}

export function clearBrowserSessionPartitionPolicies(partition: string, sess: Session): void {
  // Why: the Electron Session survives partition deletion; clear callbacks/listeners so removed profiles don't retain closures.
  invalidateBrowserSessionProxyApplication(sess)
  retireBrowserSessionUserAgentPolicy(sess)
  configuredPartitions.delete(partition)
  forgetBrowserMediaConsent(partition)
  browserManager.removeCertificateRequestGuard(sess)
  sess.removeListener('will-download', handleWillDownload)
  sess.removeListener('will-download', handleDeniedWillDownload)
  clearBrowserWebAuthnAccessHandlers(sess)
  sess.setPermissionRequestHandler(null)
  sess.setPermissionCheckHandler(null)
  sess.setDisplayMediaRequestHandler(null)
}
