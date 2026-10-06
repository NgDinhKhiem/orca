import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

const WS_PATH_PREFIX = '/devtools/browser/'

/**
 * Capability gate for one CdpWsProxy: the CDP socket drives the guest page with the
 * user's cookies, so only a holder of the per-proxy secret URL may reach it.
 */
export class CdpWsProxyAccess {
  private readonly secret = randomBytes(32).toString('hex')

  webSocketUrl(port: number): string {
    return `ws://127.0.0.1:${port}${WS_PATH_PREFIX}${this.secret}`
  }

  isAuthorizedUpgrade(req: IncomingMessage, port: number): boolean {
    const url = req.url ?? ''
    return (
      this.isTrustedClientRequest(req, port) &&
      url.startsWith(WS_PATH_PREFIX) &&
      safeEqual(url.slice(WS_PATH_PREFIX.length), this.secret)
    )
  }

  /** Strips the `/<secret>` discovery prefix; null when the URL does not carry the secret. */
  discoveryPath(url: string | undefined): string | null {
    const prefix = `/${this.secret}`
    if (!url || url.length <= prefix.length || url[prefix.length] !== '/') {
      return null
    }
    return safeEqual(url.slice(0, prefix.length), prefix) ? url.slice(prefix.length) : null
  }

  // Why: agent-browser and Node CDP clients send no Origin; a browser page always does, and a
  // DNS-rebound page carries its own hostname in Host.
  isTrustedClientRequest(req: IncomingMessage, port: number): boolean {
    if (req.headers.origin !== undefined) {
      return false
    }
    const host = req.headers.host
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
