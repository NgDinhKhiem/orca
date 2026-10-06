import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeBrowserCommandHost } from './orca-runtime-browser'

const mocks = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  importCookiesFromBrowser: vi.fn(),
  updateProfileSource: vi.fn()
}))

vi.mock('electron', () => ({
  dialog: { showMessageBox: mocks.showMessageBox },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn() }
}))

vi.mock('../browser/browser-session-registry', () => ({
  browserSessionRegistry: {
    getProfile: vi.fn((id: string) =>
      id === 'work'
        ? { id: 'work', scope: 'isolated', partition: 'persist:work', label: 'Work', source: null }
        : null
    ),
    updateProfileSource: mocks.updateProfileSource
  }
}))

vi.mock('../browser/browser-cookie-import', () => ({
  detectInstalledBrowsers: () => [
    {
      family: 'chrome',
      label: 'Google Chrome',
      cookiesPath: '/cookies',
      profiles: [{ directory: 'Default', name: 'Person 1' }],
      selectedProfile: 'Default'
    }
  ],
  importCookiesFromBrowser: mocks.importCookiesFromBrowser,
  selectBrowserProfile: vi.fn()
}))

const windowStub = { isDestroyed: () => false }

function createHost(window: unknown): RuntimeBrowserCommandHost {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: profile import reads only getAvailableAuthoritativeWindow from the host.
  return {
    getAvailableAuthoritativeWindow: vi.fn(() => window)
  } as unknown as RuntimeBrowserCommandHost
}

function answerImportPrompt(label: 'Import' | 'Cancel'): void {
  mocks.showMessageBox.mockImplementation(
    async (_window: unknown, options: { buttons: string[] }) => ({
      response: options.buttons.indexOf(label)
    })
  )
}

const params = { profileId: 'work', browserFamily: 'chrome' }

describe('browserProfileImportFromBrowser consent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.importCookiesFromBrowser.mockResolvedValue({ ok: true, summary: { totalCookies: 3 } })
  })

  it('does not read real-browser cookies when the user cancels a runtime-command import', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    answerImportPrompt('Cancel')

    const result = await new RuntimeBrowserCommands(
      createHost(windowStub)
    ).browserProfileImportFromBrowser(params)

    expect(result).toMatchObject({ ok: false })
    expect(mocks.importCookiesFromBrowser).not.toHaveBeenCalled()
    const options = mocks.showMessageBox.mock.calls[0]?.[1] as { message: string; detail: string }
    expect(`${options.message} ${options.detail}`).toContain('Google Chrome')
    expect(`${options.message} ${options.detail}`).toContain('Work')
  })

  it('fails closed without prompting when no Orca window can ask', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    answerImportPrompt('Import')

    const result = await new RuntimeBrowserCommands(
      createHost(null)
    ).browserProfileImportFromBrowser(params)

    expect(result).toMatchObject({ ok: false })
    expect(mocks.showMessageBox).not.toHaveBeenCalled()
    expect(mocks.importCookiesFromBrowser).not.toHaveBeenCalled()
  })

  it('imports after the user confirms', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    answerImportPrompt('Import')

    const result = await new RuntimeBrowserCommands(
      createHost(windowStub)
    ).browserProfileImportFromBrowser(params)

    expect(result).toMatchObject({ ok: true, profileId: 'work' })
    expect(mocks.importCookiesFromBrowser).toHaveBeenCalledOnce()
  })

  it('does not prompt again for an import a paired Orca client started from its UI', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')

    const result = await new RuntimeBrowserCommands(
      createHost(null)
    ).browserProfileImportFromBrowser(params, { pairedDeviceId: 'device-a' })

    expect(result).toMatchObject({ ok: true })
    expect(mocks.showMessageBox).not.toHaveBeenCalled()
  })
})
