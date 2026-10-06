import { cancelUnreadResponseBody } from '../lib/unread-response-body'

type FetchImplementation = (url: string, init?: RequestInit) => Promise<Response>

const MAX_REDIRECTS = 20
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie']
// Fetch spec: headers describing a request body that a method change drops.
const BODY_HEADERS = ['content-encoding', 'content-language', 'content-location', 'content-type']

function rewritesToGet(status: number, method: string): boolean {
  return (
    (status === 303 && method !== 'GET' && method !== 'HEAD') ||
    ((status === 301 || status === 302) && method === 'POST')
  )
}

/**
 * Follows redirects itself so credential headers never reach another origin.
 * Why: Electron's net.fetch (Chromium) keeps Authorization on a cross-origin
 * redirect; undici strips it. The fetch implementation must honor
 * `redirect: 'manual'` by returning the 3xx response with its Location header.
 */
export async function fetchWithCredentialScopedRedirects(
  fetchImplementation: FetchImplementation,
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  if (init.redirect === 'manual' || init.redirect === 'error') {
    return fetchImplementation(url, init)
  }
  const headers = new Headers(init.headers)
  let currentUrl = new URL(url)
  let method = (init.method ?? 'GET').toUpperCase()
  let body = init.body
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetchImplementation(currentUrl.toString(), {
      ...init,
      method,
      body,
      headers,
      redirect: 'manual'
    })
    const location = response.headers.get('location')
    if (!REDIRECT_STATUSES.has(response.status) || location === null) {
      return response
    }
    await cancelUnreadResponseBody(response)
    if (redirects >= MAX_REDIRECTS) {
      throw new TypeError('Too many redirects')
    }
    const nextUrl = new URL(location, currentUrl)
    if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
      throw new TypeError(`Refusing to follow a redirect to ${nextUrl.protocol}`)
    }
    if (rewritesToGet(response.status, method)) {
      method = 'GET'
      body = undefined
      for (const name of BODY_HEADERS) {
        headers.delete(name)
      }
    } else if (body instanceof ReadableStream) {
      throw new TypeError('Cannot replay a streamed request body across a redirect')
    }
    if (nextUrl.origin !== currentUrl.origin) {
      for (const name of CREDENTIAL_HEADERS) {
        headers.delete(name)
      }
    }
    currentUrl = nextUrl
  }
}
