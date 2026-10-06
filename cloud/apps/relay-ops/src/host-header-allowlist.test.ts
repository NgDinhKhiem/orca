import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { hostHeaderAllowlist, relayOpsAllowedHosts } from './host-header-allowlist.js'

function dashboard(allowed: ReadonlySet<string>): Hono {
  const app = new Hono()
  app.use('*', hostHeaderAllowlist(allowed))
  app.get('/api/snapshot', (context) => context.json({ ok: true }))
  return app
}

async function snapshot(app: Hono, host: string | undefined): Promise<number> {
  const response = await app.request('http://placeholder/api/snapshot', {
    headers: host === undefined ? {} : { host }
  })
  return response.status
}

describe('relay ops host header allowlist', () => {
  it('serves the loopback names on the bound port', async () => {
    const app = dashboard(relayOpsAllowedHosts(2455, undefined))

    expect(await snapshot(app, '127.0.0.1:2455')).toBe(200)
    expect(await snapshot(app, 'localhost:2455')).toBe(200)
    expect(await snapshot(app, 'LOCALHOST:2455')).toBe(200)
  })

  it('refuses a rebinding page whose name resolves to loopback', async () => {
    const app = dashboard(relayOpsAllowedHosts(2455, undefined))

    expect(await snapshot(app, 'attacker.example:2455')).toBe(403)
    expect(await snapshot(app, 'attacker.example')).toBe(403)
    expect(await snapshot(app, '127.0.0.1:9999')).toBe(403)
    expect(await snapshot(app, '127.0.0.1')).toBe(403)
    expect(await snapshot(app, undefined)).toBe(403)
  })

  it('admits operator-configured names such as a Tailscale Serve host', async () => {
    const app = dashboard(
      relayOpsAllowedHosts(2455, ' ops-box.tailnet.ts.net , Other.Example:8443 ,')
    )

    expect(await snapshot(app, 'ops-box.tailnet.ts.net')).toBe(200)
    expect(await snapshot(app, 'other.example:8443')).toBe(200)
    expect(await snapshot(app, 'ops-box.tailnet.ts.net.attacker.example')).toBe(403)
  })
})
