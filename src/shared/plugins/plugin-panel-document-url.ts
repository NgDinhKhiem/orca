/**
 * Plugin panel documents are served from this scheme on desktop instead of
 * `srcdoc`: a srcdoc (or data:/blob:) frame inherits the app document's CSP,
 * whose `script-src 'self'` would block the panel shell and plugin scripts.
 * A protocol response carries only its own CSP header.
 */
export const PLUGIN_PANEL_DOCUMENT_SCHEME = 'orca-plugin-panel'

const DOCUMENT_URL_PREFIX = `${PLUGIN_PANEL_DOCUMENT_SCHEME}://document/`
const DOCUMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function buildPluginPanelDocumentUrl(documentId: string): string {
  return `${DOCUMENT_URL_PREFIX}${documentId}`
}

export function parsePluginPanelDocumentId(url: string): string | null {
  if (!url.startsWith(DOCUMENT_URL_PREFIX)) {
    return null
  }
  const documentId = url.slice(DOCUMENT_URL_PREFIX.length)
  return DOCUMENT_ID_PATTERN.test(documentId) ? documentId : null
}
