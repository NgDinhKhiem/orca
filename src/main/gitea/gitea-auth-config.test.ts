import { describe, expect, it } from 'vitest'
import { giteaAuthHeadersForUrl, isGiteaTokenAllowedForUrl } from './gitea-auth-config'

describe('isGiteaTokenAllowedForUrl', () => {
  const https = { apiBaseUrl: 'https://git.example.com/code/api/v1', token: 'secret' }
  const http = { apiBaseUrl: 'http://git.internal:3000/api/v1', token: 'secret' }

  it.each([
    ['same https origin', https, 'https://git.example.com/code/api/v1/repos/a/b/pulls', true],
    ['same origin, other path', https, 'https://git.example.com/api/v1/user', true],
    ['host differs only by case', https, 'https://GIT.example.com/code/api/v1/user', true],
    ['different host', https, 'https://attacker.example.net/code/api/v1/user', false],
    ['subdomain of configured host', https, 'https://evil.git.example.com/api/v1/user', false],
    ['http downgrade of configured https', https, 'http://git.example.com/code/api/v1/user', false],
    ['different port', https, 'https://git.example.com:8443/code/api/v1/user', false],
    ['user-configured http origin', http, 'http://git.internal:3000/api/v1/user', true],
    ['https on user-configured http host', http, 'https://git.internal:3000/api/v1/user', false],
    ['no configured base URL', { apiBaseUrl: null, token: 'secret' }, 'https://x.test/', false],
    ['no token', { apiBaseUrl: https.apiBaseUrl, token: null }, https.apiBaseUrl, false],
    ['unparseable request URL', https, 'not a url', false]
  ])('%s', (_label, config, requestUrl, expected) => {
    expect(isGiteaTokenAllowedForUrl(requestUrl, config)).toBe(expected)
    expect(giteaAuthHeadersForUrl(requestUrl, config)).toEqual(
      expected ? { Authorization: 'token secret' } : {}
    )
  })
})
