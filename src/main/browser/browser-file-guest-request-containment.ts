import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export type FileGuestRequestDetails = Pick<
  Electron.OnBeforeRequestListenerDetails,
  'url' | 'resourceType' | 'frame' | 'webContents'
>

// Why the top frame: an about:srcdoc or blob: child of a file:// page would otherwise escape.
function topDocumentUrl(details: FileGuestRequestDetails): string | null {
  try {
    const topUrl = details.frame?.top?.url
    if (topUrl) {
      return topUrl
    }
  } catch {
    // A disposed frame throws on access; fall back to the guest's committed URL.
  }
  try {
    const guest = details.webContents
    return guest && !guest.isDestroyed() ? guest.getURL() : null
  } catch {
    return null
  }
}

function filePathFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:') {
      return null
    }
    parsed.search = ''
    parsed.hash = ''
    return fileURLToPath(parsed)
  } catch {
    return null
  }
}

async function isInsideDirectory(directory: string, target: string): Promise<boolean> {
  try {
    // Why realpath both: a sibling symlink must not reach outside the document's folder.
    const [realDirectory, realTarget] = await Promise.all([realpath(directory), realpath(target)])
    const fromDirectory = relative(realDirectory, realTarget)
    return fromDirectory === '' || (!fromDirectory.startsWith('..') && !isAbsolute(fromDirectory))
  } catch {
    return false
  }
}

/**
 * A local HTML file opened in a browser tab runs in a profile that holds the user's cookies, and
 * Electron lets file:// pages read other file:// URLs. Contain such a page to its own folder and
 * keep it off the network, like the orca-preview:// document preview. Top-level navigations stay
 * allowed so the user can still follow a link out of the document.
 */
export function shouldBlockFileGuestRequest(
  details: FileGuestRequestDetails
): boolean | Promise<boolean> {
  const documentUrl = topDocumentUrl(details)
  const documentPath = documentUrl ? filePathFromUrl(documentUrl) : null
  if (!documentPath || details.resourceType === 'mainFrame') {
    return false
  }
  if (
    details.url.startsWith('data:') ||
    details.url.startsWith('blob:') ||
    details.url.startsWith('devtools://')
  ) {
    return false
  }
  const targetPath = filePathFromUrl(details.url)
  if (!targetPath) {
    return true
  }
  return isInsideDirectory(dirname(documentPath), targetPath).then((inside) => !inside)
}
