import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'

export type CookieImportCommandConsent = 'confirmed' | 'declined' | 'unavailable'

/**
 * Asks the user before a runtime command (an agent in a terminal, a script) copies every cookie
 * from their real browser into an Orca profile. Settings and paired-client UI imports skip this:
 * the user already clicked Import there.
 */
export async function confirmCookieImportFromCommand(args: {
  window: BrowserWindow | null
  browserLabel: string
  sourceProfileName: string
  targetProfileLabel: string
}): Promise<CookieImportCommandConsent> {
  // Why: headless hosts have nobody to ask, so a command-initiated import fails closed.
  if (!args.window || args.window.isDestroyed()) {
    return 'unavailable'
  }
  const buttons = ['Import', 'Cancel']
  const { response } = await dialog.showMessageBox(args.window, {
    type: 'warning',
    buttons,
    defaultId: 1,
    cancelId: 1,
    message: `A command wants to import your ${args.browserLabel} cookies into the Orca browser profile "${args.targetProfileLabel}".`,
    detail: `This copies the sign-ins from the "${args.sourceProfileName}" ${args.browserLabel} profile. Only allow it if you started this import.`
  })
  return buttons[response] === 'Import' ? 'confirmed' : 'declined'
}
