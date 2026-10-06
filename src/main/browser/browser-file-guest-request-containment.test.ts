import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  shouldBlockFileGuestRequest,
  type FileGuestRequestDetails
} from './browser-file-guest-request-containment'

const root = mkdtempSync(join(tmpdir(), 'orca-file-guest-unit-'))
const site = join(root, 'site')
mkdirSync(join(site, 'assets'), { recursive: true })
writeFileSync(join(site, 'index.html'), '<!doctype html>')
writeFileSync(join(site, 'assets', 'app.js'), '')
writeFileSync(join(root, 'secret.txt'), 'secret')
const documentUrl = pathToFileURL(join(site, 'index.html')).toString()

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function request(
  url: string,
  overrides: Partial<{ topUrl: string; resourceType: string }> = {}
): FileGuestRequestDetails {
  const topUrl = overrides.topUrl ?? documentUrl
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the containment reads only url, resourceType, frame.top.url and webContents.getURL.
  return {
    url,
    resourceType: overrides.resourceType ?? 'xhr',
    frame: { top: { url: topUrl } },
    webContents: { isDestroyed: () => false, getURL: () => topUrl }
  } as unknown as FileGuestRequestDetails
}

describe('shouldBlockFileGuestRequest', () => {
  it('has no opinion about pages that are not local files', async () => {
    expect(
      await shouldBlockFileGuestRequest(
        request('https://a.example/x', { topUrl: 'https://b.example/' })
      )
    ).toBe(false)
  })

  it.each(['https://evil.example/beacon', 'ws://127.0.0.1:9/', 'ftp://evil.example/'])(
    'blocks %s from a local page',
    async (url) => {
      expect(await shouldBlockFileGuestRequest(request(url))).toBe(true)
    }
  )

  it('blocks network requests from frames nested in a local page', async () => {
    expect(
      await shouldBlockFileGuestRequest(
        request('https://evil.example/', { resourceType: 'subFrame' })
      )
    ).toBe(true)
  })

  it('lets the user follow a top-level link out of the document', async () => {
    expect(
      await shouldBlockFileGuestRequest(
        request('https://docs.example/', { resourceType: 'mainFrame' })
      )
    ).toBe(false)
  })

  it('allows inline data and blob URLs', async () => {
    expect(await shouldBlockFileGuestRequest(request('data:image/png;base64,AA=='))).toBe(false)
    expect(await shouldBlockFileGuestRequest(request('blob:file:///abc'))).toBe(false)
  })

  it('allows files inside the document folder and blocks files outside it', async () => {
    const asset = pathToFileURL(join(site, 'assets', 'app.js')).toString()
    expect(await shouldBlockFileGuestRequest(request(`${asset}?v=1`))).toBe(false)
    const secret = pathToFileURL(join(root, 'secret.txt')).toString()
    expect(await shouldBlockFileGuestRequest(request(secret))).toBe(true)
  })

  it('blocks a sibling symlink that points outside the document folder', async (context) => {
    const link = join(site, 'linked-secret.txt')
    try {
      symlinkSync(join(root, 'secret.txt'), link, 'file')
    } catch {
      // Windows without Developer Mode cannot create symlinks; the realpath check is still covered on POSIX CI.
      context.skip()
    }
    expect(await shouldBlockFileGuestRequest(request(pathToFileURL(link).toString()))).toBe(true)
  })
})
