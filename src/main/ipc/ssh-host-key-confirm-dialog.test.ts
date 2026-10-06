import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ dialog: { showMessageBox: vi.fn() } }))

import { confirmUnknownHostKeyWithDialog } from './ssh-host-key-confirm-dialog'

const REQUEST = {
  displayHost: 'build-01.example.com',
  port: 2222,
  keyType: 'ssh-ed25519',
  fingerprint: 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
}

function liveWindow(): BrowserWindow {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dialog only reads isDestroyed().
  return { isDestroyed: () => false } as unknown as BrowserWindow
}

function answering(response: number) {
  return vi.fn(
    async (_win: BrowserWindow, _options: MessageBoxOptions): Promise<MessageBoxReturnValue> => ({
      response,
      checkboxChecked: false
    })
  )
}

describe('confirmUnknownHostKeyWithDialog', () => {
  it('names the host, port, key type and SHA256 fingerprint, defaulting to cancel', async () => {
    const showMessageBox = answering(0)

    await confirmUnknownHostKeyWithDialog(liveWindow, REQUEST, undefined, showMessageBox)

    const options = showMessageBox.mock.calls[0]?.[1]
    const text = `${options?.message}\n${options?.detail}`
    expect(text).toContain('build-01.example.com')
    expect(text).toContain('2222')
    expect(text).toContain('ssh-ed25519')
    expect(text).toContain(REQUEST.fingerprint)
    expect(options?.defaultId).toBe(options?.cancelId)
  })

  it('confirms only when the user picks the trust button', async () => {
    const trustIndex = 1
    await expect(
      confirmUnknownHostKeyWithDialog(liveWindow, REQUEST, undefined, answering(trustIndex))
    ).resolves.toBe('confirmed')
    await expect(
      confirmUnknownHostKeyWithDialog(liveWindow, REQUEST, undefined, answering(0))
    ).resolves.toBe('declined')
  })

  it('reports unavailable without a window, so headless hosts fail closed', async () => {
    const showMessageBox = answering(1)
    await expect(
      confirmUnknownHostKeyWithDialog(() => null, REQUEST, undefined, showMessageBox)
    ).resolves.toBe('unavailable')
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('declines without showing anything once the connect attempt is cancelled', async () => {
    const showMessageBox = answering(1)
    await expect(
      confirmUnknownHostKeyWithDialog(liveWindow, REQUEST, AbortSignal.abort(), showMessageBox)
    ).resolves.toBe('declined')
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('shows one prompt at a time when several hosts connect together', async () => {
    let releaseFirst: (value: MessageBoxReturnValue) => void = () => {}
    const showMessageBox = vi
      .fn<(win: BrowserWindow, options: MessageBoxOptions) => Promise<MessageBoxReturnValue>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = resolve
          })
      )
      .mockResolvedValueOnce({ response: 1, checkboxChecked: false })

    const first = confirmUnknownHostKeyWithDialog(liveWindow, REQUEST, undefined, showMessageBox)
    const second = confirmUnknownHostKeyWithDialog(liveWindow, REQUEST, undefined, showMessageBox)
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledTimes(1))

    releaseFirst({ response: 0, checkboxChecked: false })

    await expect(first).resolves.toBe('declined')
    await expect(second).resolves.toBe('confirmed')
    expect(showMessageBox).toHaveBeenCalledTimes(2)
  })
})
