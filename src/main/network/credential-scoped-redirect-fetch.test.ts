import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { fetchWithCredentialScopedRedirects } from './credential-scoped-redirect-fetch'

type SeenRequest = {
  url: string
  method: string
  authorization: string | null
  cookie: string | null
  contentType: string | null
  body: string | null
}

function redirect(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } })
}

/** A fetch that never follows redirects itself, recording what each hop carried. */
function recordingFetch(routes: Record<string, () => Response>): {
  seen: SeenRequest[]
  fetch: (url: string, init?: RequestInit) => Promise<Response>
} {
  const seen: SeenRequest[] = []
  return {
    seen,
    fetch: async (url, init) => {
      expect(init?.redirect).toBe('manual')
      const headers = new Headers(init?.headers)
      seen.push({
        url,
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization'),
        cookie: headers.get('cookie'),
        contentType: headers.get('content-type'),
        body: typeof init?.body === 'string' ? init.body : null
      })
      const route = routes[url]
      if (!route) {
        throw new Error(`unexpected request to ${url}`)
      }
      return route()
    }
  }
}

const CREDENTIALED = {
  headers: { Authorization: 'Basic c2VjcmV0', Cookie: 'sid=1', 'Content-Type': 'application/json' }
}

describe('fetchWithCredentialScopedRedirects', () => {
  it('strips credentials on a cross-origin hop and keeps them on a same-origin hop', async () => {
    const { seen, fetch } = recordingFetch({
      'https://a.test/start': () => redirect(302, '/next'),
      'https://a.test/next': () => redirect(302, 'https://b.test/final'),
      'https://b.test/final': () => Response.json({ ok: true })
    })

    const response = await fetchWithCredentialScopedRedirects(
      fetch,
      'https://a.test/start',
      CREDENTIALED
    )

    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(seen.map(({ url, authorization, cookie }) => ({ url, authorization, cookie }))).toEqual([
      { url: 'https://a.test/start', authorization: 'Basic c2VjcmV0', cookie: 'sid=1' },
      { url: 'https://a.test/next', authorization: 'Basic c2VjcmV0', cookie: 'sid=1' },
      { url: 'https://b.test/final', authorization: null, cookie: null }
    ])
  })

  it.each([
    ['https downgrade to http on the same host', 'http://a.test/x'],
    ['another port on the same host', 'https://a.test:8443/x'],
    ['a subdomain', 'https://evil.a.test/x']
  ])('treats %s as cross-origin', async (_label, target) => {
    const { seen, fetch } = recordingFetch({
      'https://a.test/start': () => redirect(307, target),
      [target]: () => new Response('ok')
    })

    await fetchWithCredentialScopedRedirects(fetch, 'https://a.test/start', CREDENTIALED)

    expect(seen[1]).toMatchObject({ url: target, authorization: null })
  })

  it.each([
    [303, 'PUT', 'GET'],
    [302, 'POST', 'GET'],
    [301, 'POST', 'GET'],
    [307, 'POST', 'POST'],
    [308, 'PUT', 'PUT'],
    [302, 'PUT', 'PUT']
  ])('follows a %i after %s as %s', async (status, method, expectedMethod) => {
    const { seen, fetch } = recordingFetch({
      'https://a.test/start': () => redirect(status, '/next'),
      'https://a.test/next': () => new Response('ok')
    })

    await fetchWithCredentialScopedRedirects(fetch, 'https://a.test/start', {
      ...CREDENTIALED,
      method,
      body: '{"a":1}'
    })

    const rewritten = expectedMethod === 'GET'
    expect(seen[1]).toMatchObject({
      method: expectedMethod,
      body: rewritten ? null : '{"a":1}',
      contentType: rewritten ? null : 'application/json',
      authorization: 'Basic c2VjcmV0'
    })
  })

  it('refuses non-http redirect targets and redirect loops', async () => {
    const toFile = recordingFetch({ 'https://a.test/start': () => redirect(302, 'file:///etc') })
    await expect(
      fetchWithCredentialScopedRedirects(toFile.fetch, 'https://a.test/start')
    ).rejects.toThrow('file:')

    const loop = recordingFetch({ 'https://a.test/start': () => redirect(302, '/start') })
    await expect(
      fetchWithCredentialScopedRedirects(loop.fetch, 'https://a.test/start')
    ).rejects.toThrow('Too many redirects')
    expect(loop.seen).toHaveLength(21)
  })

  it('passes through a caller that handles redirects itself', async () => {
    const response = await fetchWithCredentialScopedRedirects(
      async (_url, init) => {
        expect(init?.redirect).toBe('error')
        return new Response('direct')
      },
      'https://a.test/start',
      { redirect: 'error' }
    )
    await expect(response.text()).resolves.toBe('direct')
  })

  describe('with the Node fetch implementation and real servers', () => {
    const servers: Server[] = []

    afterEach(async () => {
      await Promise.all(
        servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
      )
    })

    async function listen(server: Server): Promise<string> {
      servers.push(server)
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('expected a TCP address')
      }
      return `http://127.0.0.1:${address.port}`
    }

    it('reads the manual 3xx Location from undici and strips credentials cross-origin', async () => {
      const received: (string | null)[] = []
      const target = await listen(
        createServer((req, res) => {
          received.push(req.headers.authorization ?? null)
          res.end('final')
        })
      )
      const origin = await listen(
        createServer((req, res) => {
          received.push(req.headers.authorization ?? null)
          res.writeHead(302, { location: `${target}/final` }).end()
        })
      )

      const response = await fetchWithCredentialScopedRedirects(
        (url, init) => globalThis.fetch(url, init),
        `${origin}/start`,
        { headers: { Authorization: 'token secret' } }
      )

      await expect(response.text()).resolves.toBe('final')
      expect(received).toEqual(['token secret', null])
    })
  })
})
