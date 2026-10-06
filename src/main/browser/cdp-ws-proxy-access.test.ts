import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { request } from 'node:http'
import WebSocket from 'ws'
import { CdpWsProxy } from './cdp-ws-proxy'
import {
  connect,
  createMockWebContents,
  getSendCommandMethods,
  sendAndReceive,
  type MockWebContents
} from './cdp-ws-proxy-test-harness'
import { hasAgentClipboardReadGrant } from './browser-agent-clipboard-read-grant'

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() }
}))

type UpgradeOutcome = { upgraded: true } | { upgraded: false; status: number }

// Why: a raw handshake lets the test forge Host/Origin exactly as a hostile page or local process would.
function attemptUpgrade(
  port: number,
  path: string,
  headers: Record<string, string> = {}
): Promise<UpgradeOutcome> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...headers
      }
    })
    req.on('upgrade', (_res, socket) => {
      socket.destroy()
      resolve({ upgraded: true })
    })
    req.on('response', (res) => {
      res.resume()
      resolve({ upgraded: false, status: res.statusCode ?? 0 })
    })
    req.on('error', reject)
    req.end()
  })
}

function httpGet(
  port: number,
  path: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('CdpWsProxy access control', () => {
  let mock: MockWebContents
  let proxy: CdpWsProxy
  let endpoint: string
  let port: number

  beforeEach(async () => {
    mock = createMockWebContents()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock implements every WebContents member the proxy calls.
    proxy = new CdpWsProxy(mock.webContents as never, () => () => {})
    endpoint = await proxy.start()
    port = proxy.getPort()
  })

  afterEach(async () => {
    await proxy.stop()
  })

  it('returns a per-proxy secret websocket path from start()', async () => {
    expect(endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\da-f]{64}$/)

    const other = new CdpWsProxy(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock implements every WebContents member the proxy calls.
      createMockWebContents().webContents as never,
      () => () => {}
    )
    const otherEndpoint = await other.start()
    await other.stop()
    expect(new URL(otherEndpoint).pathname).not.toBe(new URL(endpoint).pathname)
  })

  it('refuses an unauthenticated client on the bare port before it reaches the debugger', async () => {
    const outcome = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      ws.on('open', () => {
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '1' } }))
        setTimeout(() => {
          ws.close()
          resolve('opened')
        }, 50)
      })
      ws.on('unexpected-response', (_req, res) => resolve(`rejected:${res.statusCode}`))
      ws.on('error', () => resolve('error'))
    })

    expect(outcome).toBe('rejected:403')
    expect(getSendCommandMethods(mock)).not.toContain('Runtime.evaluate')
  })

  it('refuses a wrong secret on the websocket path', async () => {
    const wrongSecret = `/devtools/browser/${'0'.repeat(64)}`
    expect(await attemptUpgrade(port, wrongSecret)).toEqual({ upgraded: false, status: 403 })
    expect(await attemptUpgrade(port, '/devtools/browser')).toEqual({
      upgraded: false,
      status: 403
    })
  })

  it('refuses any browser Origin even with the right secret', async () => {
    const path = new URL(endpoint).pathname
    expect(await attemptUpgrade(port, path, { Origin: 'https://evil.example' })).toEqual({
      upgraded: false,
      status: 403
    })
    expect(await attemptUpgrade(port, path, { Origin: 'null' })).toEqual({
      upgraded: false,
      status: 403
    })
  })

  it('refuses a rebound Host header even with the right secret', async () => {
    const path = new URL(endpoint).pathname
    expect(await attemptUpgrade(port, path, { Host: `evil.example:${port}` })).toEqual({
      upgraded: false,
      status: 403
    })
    expect(await attemptUpgrade(port, path, { Host: '127.0.0.1:1' })).toEqual({
      upgraded: false,
      status: 403
    })
  })

  it('accepts the secret path on localhost and 127.0.0.1 hosts', async () => {
    const path = new URL(endpoint).pathname
    expect(await attemptUpgrade(port, path, { Host: `localhost:${port}` })).toEqual({
      upgraded: true
    })
    expect(await attemptUpgrade(port, path)).toEqual({ upgraded: true })
  })

  it('does not let a refused connection displace the legitimate client', async () => {
    const client = await connect(endpoint)
    expect(await attemptUpgrade(port, '/')).toEqual({ upgraded: false, status: 403 })
    expect(
      await attemptUpgrade(port, new URL(endpoint).pathname, { Origin: 'https://evil.example' })
    ).toEqual({ upgraded: false, status: 403 })

    const response = await sendAndReceive(client, { id: 5, method: 'Target.getTargets' })
    expect(response.id).toBe(5)
    expect(client.readyState).toBe(WebSocket.OPEN)
    client.close()
  })

  it('does not publish the websocket URL on unauthenticated discovery endpoints', async () => {
    for (const path of ['/json/version', '/json/list', '/json']) {
      const res = await httpGet(port, path)
      expect(res.status).toBe(404)
      expect(res.body).not.toContain('ws://')
    }
  })

  it('serves discovery under the secret prefix with the full secret websocket URL', async () => {
    const secret = new URL(endpoint).pathname.split('/').at(-1)
    const version = await httpGet(port, `/${secret}/json/version`)
    expect(version.status).toBe(200)
    expect(JSON.parse(version.body).webSocketDebuggerUrl).toBe(endpoint)

    const list = await httpGet(port, `/${secret}/json/list`)
    expect(list.status).toBe(200)
    expect(JSON.parse(list.body)[0].webSocketDebuggerUrl).toBe(endpoint)

    const rebound = await httpGet(port, `/${secret}/json/version`, { Host: 'evil.example' })
    expect(rebound.status).toBe(403)
  })
})

describe('CdpWsProxy agent clipboard-read grant', () => {
  let mock: MockWebContents
  let proxy: CdpWsProxy
  let endpoint: string

  beforeEach(async () => {
    mock = createMockWebContents()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock implements every WebContents member the proxy calls.
    proxy = new CdpWsProxy(mock.webContents as never, () => () => {})
    endpoint = await proxy.start()
  })

  afterEach(async () => {
    await proxy.stop()
  })

  it('opens clipboard-read for this guest only while the agent read is in flight', async () => {
    const grantDuringCommand: Record<string, boolean> = {}
    mock.webContents.debugger.sendCommand.mockImplementation(async (method, params) => {
      grantDuringCommand[String(params?.expression)] = hasAgentClipboardReadGrant(
        mock.webContents.id
      )
      return { result: { type: 'string', value: method ?? '' } }
    })
    const client = await connect(endpoint)

    await sendAndReceive(client, {
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: 'navigator.clipboard.readText()', awaitPromise: true }
    })
    await sendAndReceive(client, {
      id: 2,
      method: 'Runtime.evaluate',
      params: { expression: 'document.title' }
    })

    expect(grantDuringCommand['navigator.clipboard.readText()']).toBe(true)
    expect(grantDuringCommand['document.title']).toBe(false)
    expect(hasAgentClipboardReadGrant(mock.webContents.id)).toBe(false)
    client.close()
  })
})
