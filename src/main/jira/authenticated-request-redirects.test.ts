import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setMainHttpClient } from '../network/http-client'
import { jiraRequest, jiraRequestBinary, type JiraClientForSite } from './authenticated-request'

vi.mock('../network/proxy-settings', () => ({
  ensureElectronProxyFromEnvironment: vi.fn(async () => undefined)
}))

type SeenRequest = { url: string; method: string; authorization: string | null }

const SITE = 'https://example.atlassian.net'
const client: JiraClientForSite = {
  site: {
    id: 'site-1',
    siteUrl: SITE,
    email: 'ada@example.com',
    displayName: 'Ada',
    accountId: 'account-1'
  },
  authorization: 'Basic c2VjcmV0'
}

/** Mimics Electron's net.fetch, which (unlike undici) keeps Authorization on cross-origin redirects. */
function installChromiumLikeClient(routes: Record<string, () => Response>): SeenRequest[] {
  const seen: SeenRequest[] = []
  setMainHttpClient({
    proxySession: () => null,
    fetch: async (url, init) => {
      let current = url
      for (let hop = 0; hop < 5; hop += 1) {
        seen.push({
          url: current,
          method: init?.method ?? 'GET',
          authorization: new Headers(init?.headers).get('authorization')
        })
        const route = routes[current]
        if (!route) {
          throw new Error(`unexpected request to ${current}`)
        }
        const response = route()
        const location = response.headers.get('location')
        if (!location || response.status < 300 || response.status > 399) {
          return response
        }
        if (init?.redirect === 'manual') {
          return response
        }
        current = new URL(location, current).toString()
      }
      throw new Error('too many redirects')
    }
  })
  return seen
}

function redirect(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } })
}

describe('Jira requests across redirects', () => {
  beforeEach(() => {
    setMainHttpClient(null)
  })

  afterEach(() => {
    setMainHttpClient(null)
  })

  it('drops the Jira credential when an attachment redirects to another origin', async () => {
    const seen = installChromiumLikeClient({
      [`${SITE}/rest/api/3/attachment/content/1`]: () =>
        redirect(303, 'https://media.example.net/file/1?token=signed'),
      'https://media.example.net/file/1?token=signed': () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
    })

    const result = await jiraRequestBinary(client, '/rest/api/3/attachment/content/1')

    expect(new Uint8Array(result.data)).toEqual(new Uint8Array([1, 2, 3]))
    expect(seen).toEqual([
      {
        url: `${SITE}/rest/api/3/attachment/content/1`,
        method: 'GET',
        authorization: 'Basic c2VjcmV0'
      },
      { url: 'https://media.example.net/file/1?token=signed', method: 'GET', authorization: null }
    ])
  })

  it('drops the Jira credential on a 307 to another origin while keeping the method', async () => {
    const seen = installChromiumLikeClient({
      [`${SITE}/rest/api/3/issue`]: () => redirect(307, 'https://attacker.example.net/collect'),
      'https://attacker.example.net/collect': () => Response.json({ id: '1' })
    })

    await jiraRequest(client, '/rest/api/3/issue', { method: 'POST', body: '{}' })

    expect(seen.map(({ method, authorization }) => ({ method, authorization }))).toEqual([
      { method: 'POST', authorization: 'Basic c2VjcmV0' },
      { method: 'POST', authorization: null }
    ])
  })

  it('keeps the credential across a same-origin redirect', async () => {
    const seen = installChromiumLikeClient({
      [`${SITE}/rest/api/3/myself`]: () => redirect(302, '/rest/api/3/myself/'),
      [`${SITE}/rest/api/3/myself/`]: () => Response.json({ accountId: 'account-1' })
    })

    await expect(jiraRequest(client, '/rest/api/3/myself')).resolves.toEqual({
      accountId: 'account-1'
    })
    expect(seen.map((request) => request.authorization)).toEqual([
      'Basic c2VjcmV0',
      'Basic c2VjcmV0'
    ])
  })
})
