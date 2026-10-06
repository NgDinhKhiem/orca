import {
  dialog,
  type BrowserWindow,
  type MessageBoxOptions,
  type MessageBoxReturnValue
} from 'electron'
import { SSH_CREDENTIAL_TIMEOUT_MS } from '../ssh/ssh-connection-utils'
import type { HostKeyConfirmation, HostKeyConfirmRequest } from '../ssh/ssh-host-key-verifier'

type ShowMessageBox = (
  win: BrowserWindow,
  options: MessageBoxOptions
) => Promise<MessageBoxReturnValue>

const CANCEL_BUTTON = 0
const TRUST_BUTTON = 1

// Why a queue: startup restore can dial several unknown hosts at once; stacked modals invite a blind "Trust".
let pendingPrompt: Promise<unknown> = Promise.resolve()

/**
 * Asks the user to trust an unknown SSH host key, as OpenSSH's StrictHostKeyChecking=ask does.
 * Resolves `unavailable` when no window can show the prompt, so headless hosts fail closed.
 */
export function confirmUnknownHostKeyWithDialog(
  getMainWindow: () => BrowserWindow | null,
  request: HostKeyConfirmRequest,
  signal?: AbortSignal,
  showMessageBox: ShowMessageBox = (win, options) => dialog.showMessageBox(win, options)
): Promise<HostKeyConfirmation> {
  const prompt = async (): Promise<HostKeyConfirmation> => {
    if (signal?.aborted) {
      return 'declined'
    }
    const win = getMainWindow()
    if (!win || win.isDestroyed()) {
      return 'unavailable'
    }
    const timeout = AbortSignal.timeout(SSH_CREDENTIAL_TIMEOUT_MS)
    const dismiss = signal ? AbortSignal.any([signal, timeout]) : timeout
    const { response } = await showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancel', 'Trust and Connect'],
      defaultId: CANCEL_BUTTON,
      cancelId: CANCEL_BUTTON,
      noLink: true,
      title: 'Unknown SSH Host',
      message: `The authenticity of ${request.displayHost} (port ${request.port}) can't be established.`,
      detail: `${request.keyType} key fingerprint is ${request.fingerprint}.\n\nOnly trust this host if the fingerprint matches the one its administrator gave you. Orca remembers a trusted key and will refuse the host if it changes.`,
      signal: dismiss
    })
    return response === TRUST_BUTTON && !dismiss.aborted ? 'confirmed' : 'declined'
  }
  const result = pendingPrompt.then(prompt, prompt)
  pendingPrompt = result.catch(() => undefined)
  return result
}
