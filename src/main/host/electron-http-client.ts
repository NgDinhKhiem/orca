import { net, session, type IncomingMessage } from 'electron'
import type { MainHttpClient } from '../network/http-client'

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

function responseBody(message: IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      message.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
      message.on('end', () => controller.close())
      message.on('error', (error: Error) => controller.error(error))
    }
  })
}

/**
 * `redirect: 'manual'` for Chromium's stack, resolving a 3xx with its Location like undici.
 * Why: net.fetch passes 'manual' to a ClientRequest with no redirect listener, so it
 * rejects with "Redirect was cancelled" instead of returning the redirect.
 */
async function fetchWithoutFollowingRedirects(url: string, init: RequestInit): Promise<Response> {
  const request = new Request(url, init)
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : null
  return new Promise<Response>((resolvePromise, rejectPromise) => {
    const signal = init.signal
    const settle = (): void => signal?.removeEventListener('abort', onAbort)
    const resolve = (response: Response): void => {
      settle()
      resolvePromise(response)
    }
    const reject = (reason: unknown): void => {
      settle()
      rejectPromise(reason)
    }
    const clientRequest = net.request({
      method: request.method,
      url: request.url,
      session: session.defaultSession,
      credentials: 'include',
      redirect: 'manual'
    })
    function onAbort(): void {
      clientRequest.abort()
      reject(signal?.reason)
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    for (const [name, value] of request.headers) {
      clientRequest.setHeader(name, value)
    }
    clientRequest.on('redirect', (statusCode, _method, redirectUrl) => {
      clientRequest.abort()
      resolve(new Response(null, { status: statusCode, headers: { location: redirectUrl } }))
    })
    clientRequest.on('response', (message) => {
      const headers = new Headers()
      for (const [name, value] of Object.entries(message.headers)) {
        headers.set(name, Array.isArray(value) ? value.join(', ') : value)
      }
      const hasBody = !NULL_BODY_STATUSES.has(message.statusCode) && request.method !== 'HEAD'
      resolve(
        new Response(hasBody ? responseBody(message) : null, {
          status: message.statusCode,
          statusText: message.statusMessage,
          headers
        })
      )
    })
    clientRequest.on('error', reject)
    if (body) {
      clientRequest.write(body)
    }
    clientRequest.end()
  })
}

/**
 * The desktop HTTP client: Chromium's network stack, which follows session and proxy
 * state and sends a Chrome user agent.
 *
 * `session.defaultSession` throws before the app is ready, so it is read per call
 * rather than captured at install time.
 */
export const electronHttpClient: MainHttpClient = {
  fetch: (url, init) =>
    init?.redirect === 'manual' ? fetchWithoutFollowingRedirects(url, init) : net.fetch(url, init),
  proxySession: () => session.defaultSession
}
