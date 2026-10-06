import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetAzureDevOpsPreviewApiVersionCache,
  isAzureDevOpsCredentialAllowedForUrl,
  requestAzureDevOpsJson
} from './azure-devops-api-request'
import { parseAzureDevOpsRepoRef } from './repository-ref'

const OLD_ENV = process.env

describe('isAzureDevOpsCredentialAllowedForUrl', () => {
  it.each([
    ['dev.azure.com over https', null, 'https://dev.azure.com/acme/Project/_apis/x', true],
    ['organization.visualstudio.com', null, 'https://acme.visualstudio.com/Project/_apis/x', true],
    ['dev.azure.com over http', null, 'http://dev.azure.com/acme/Project/_apis/x', false],
    ['visualstudio.com over http', null, 'http://acme.visualstudio.com/_apis/x', false],
    ['look-alike suffix host', null, 'https://dev.azure.com.attacker.net/_apis/x', false],
    ['look-alike visualstudio host', null, 'https://acmevisualstudio.com/_apis/x', false],
    ['server remote without configured base', null, 'https://ado.corp.test/tfs/C/_apis/x', false],
    [
      'server under configured base origin',
      'https://ado.corp.test/tfs/C',
      'https://ado.corp.test/tfs/C/P/_apis/x',
      true
    ],
    [
      'other host than configured base',
      'https://ado.corp.test/tfs/C',
      'https://evil.test/_apis',
      false
    ],
    [
      'http downgrade of configured https base',
      'https://ado.corp.test',
      'http://ado.corp.test/_apis',
      false
    ],
    [
      'user-configured http base',
      'http://ado.corp.test:8080/tfs',
      'http://ado.corp.test:8080/tfs/_apis',
      true
    ],
    ['unparseable URL', 'https://ado.corp.test', 'not a url', false]
  ])('%s', (_label, configuredBase, requestUrl, expected) => {
    expect(isAzureDevOpsCredentialAllowedForUrl(requestUrl, configuredBase)).toBe(expected)
  })
})

describe('Azure DevOps credential scoping on requests', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV, ORCA_AZURE_DEVOPS_TOKEN: 'pat-token' }
    delete process.env.ORCA_AZURE_DEVOPS_API_BASE_URL
    delete process.env.ORCA_AZURE_DEVOPS_ACCESS_TOKEN
    _resetAzureDevOpsPreviewApiVersionCache()
  })

  afterEach(() => {
    process.env = OLD_ENV
    vi.unstubAllGlobals()
  })

  function captureAuthorization(): (string | null)[] {
    const seen: (string | null)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get('Authorization'))
        return Response.json({ id: 'repo-guid' })
      })
    )
    return seen
  }

  it('never sends the PAT to an arbitrary host whose remote path contains /_git/', async () => {
    const repo = parseAzureDevOpsRepoRef('https://attacker.example.net/x/Project/_git/repo')
    if (!repo) {
      throw new Error('expected an Azure DevOps Server ref')
    }
    const seen = captureAuthorization()

    await requestAzureDevOpsJson(repo, '/_apis/git/repositories/repo')

    expect(seen).toEqual([null])
  })

  it('sends the PAT to an Azure DevOps Server under the configured base URL', async () => {
    process.env.ORCA_AZURE_DEVOPS_API_BASE_URL = 'https://ado.corp.test/tfs/Collection'
    const repo = parseAzureDevOpsRepoRef('https://ado.corp.test/tfs/Collection/Project/_git/repo')
    if (!repo) {
      throw new Error('expected an Azure DevOps Server ref')
    }
    const seen = captureAuthorization()

    await requestAzureDevOpsJson(repo, '/_apis/git/repositories/repo')

    expect(seen).toEqual([expect.stringMatching(/^Basic /)])
  })

  it('sends the PAT to Azure DevOps Services without a configured base URL', async () => {
    const repo = parseAzureDevOpsRepoRef('https://dev.azure.com/acme/Project/_git/repo')
    if (!repo) {
      throw new Error('expected an Azure DevOps Services ref')
    }
    const seen = captureAuthorization()

    await requestAzureDevOpsJson(repo, '/_apis/git/repositories/repo')

    expect(seen).toEqual([expect.stringMatching(/^Basic /)])
  })

  it('does not send the PAT to a plain-http Azure DevOps Server remote', async () => {
    const repo = parseAzureDevOpsRepoRef('http://ado.corp.test/tfs/Collection/Project/_git/repo')
    if (!repo) {
      throw new Error('expected an Azure DevOps Server ref')
    }
    const seen = captureAuthorization()

    await requestAzureDevOpsJson(repo, '/_apis/git/repositories/repo')

    expect(seen).toEqual([null])
  })
})
