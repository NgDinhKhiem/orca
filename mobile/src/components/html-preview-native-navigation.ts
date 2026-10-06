import { isAllowedMarkdownLinkUrl } from './pr-sidebar/markdown-link-scheme'

/**
 * The artifact is agent-produced and untrusted, and nothing in the preview needs a script: no
 * injected bridge, no `onMessage`. The web sibling's sandbox refuses scripts too.
 */
export const MOBILE_HTML_PREVIEW_JAVASCRIPT_ENABLED = false

/** The fields of react-native-webview's `ShouldStartLoadRequest` this policy reads. */
export type HtmlPreviewNavigationRequest = {
  url: string
  isTopFrame?: boolean
  /** iOS only; Android leaves it unset. */
  navigationType?: string
}

export type HtmlPreviewNavigationDecision = {
  loadInPlace: boolean
  openExternally: string | null
}

const BLOCKED: HtmlPreviewNavigationDecision = { loadInPlace: false, openExternally: null }

function isInlineDocumentUrl(url: string): boolean {
  return url === 'about:blank' || url.startsWith('data:')
}

/**
 * Only the inline document loads in place, and only a user's tap on a top-frame link to a safe
 * scheme leaves the app. Subframes, redirects, refreshes and form posts are dropped silently so an
 * artifact cannot launch an arbitrary URL scheme (tel:, itms-services:, app deep links) on view.
 */
export function decideHtmlPreviewNavigation(
  request: HtmlPreviewNavigationRequest
): HtmlPreviewNavigationDecision {
  // Why: iOS names a tap `click`; Android reports no type, so its top-frame requests (taps,
  // or a meta refresh) still pass only the scheme allowlist below.
  const isUserTap = request.navigationType === undefined || request.navigationType === 'click'
  if (isInlineDocumentUrl(request.url)) {
    return request.navigationType === 'click'
      ? BLOCKED
      : { loadInPlace: true, openExternally: null }
  }
  if (request.isTopFrame !== true || !isUserTap || !isAllowedMarkdownLinkUrl(request.url)) {
    return BLOCKED
  }
  return { loadInPlace: false, openExternally: request.url }
}
