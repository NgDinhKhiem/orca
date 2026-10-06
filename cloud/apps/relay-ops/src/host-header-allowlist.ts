import type { MiddlewareHandler } from 'hono'

// Why: a DNS-rebinding page reaches the loopback listener under its own name, so the
// browser's same-origin rule lets it read /api/snapshot unless the Host is checked.
export function relayOpsAllowedHosts(
  port: number,
  extraHosts: string | undefined
): ReadonlySet<string> {
  const configured = (extraHosts ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0)
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...configured])
}

export function hostHeaderAllowlist(allowed: ReadonlySet<string>): MiddlewareHandler {
  return async (context, next) => {
    const host = context.req.header('host')?.trim().toLowerCase()
    if (host === undefined || !allowed.has(host)) {
      return context.json({ error: 'Host not allowed' }, 403)
    }
    await next()
    return
  }
}
