// @ts-nocheck -- mechanically split class members.
import { RuntimeBrowserCommandsWithBrowserTabSetProfile } from './runtime-browser-commands-browser-tab-set-profile'
import type {
  BrowserProfileClearDefaultCookiesResult,
  BrowserProfileImportFromBrowserResult
} from '../../shared/runtime-types'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import {
  detectInstalledBrowsers,
  importCookiesFromBrowser,
  selectBrowserProfile
} from '../browser/browser-cookie-import'
import { confirmCookieImportFromCommand } from '../browser/browser-cookie-import-command-consent'

export class RuntimeBrowserCommandsWithBrowserProfileImportFromBrowser extends RuntimeBrowserCommandsWithBrowserTabSetProfile {
  async browserProfileImportFromBrowser(
    params: {
      profileId: string
      browserFamily: string
      browserProfile?: string
      supportsPartitionSkippedCookies?: true
    },
    caller?: { pairedDeviceId?: string }
  ): Promise<BrowserProfileImportFromBrowserResult> {
    const profile = browserSessionRegistry.getProfile(params.profileId)
    if (!profile) {
      return { ok: false, reason: 'Session profile not found.' }
    }
    if (
      params.browserProfile &&
      (/[/\\]/.test(params.browserProfile) || params.browserProfile.includes('..'))
    ) {
      return { ok: false, reason: 'Invalid browser profile name.' }
    }

    const browsers = detectInstalledBrowsers()
    let browser = browsers.find((candidate) => candidate.family === params.browserFamily)
    if (!browser) {
      return { ok: false, reason: 'Browser not found on this system.' }
    }

    if (params.browserProfile && params.browserProfile !== browser.selectedProfile) {
      const reselected = selectBrowserProfile(browser, params.browserProfile)
      if (!reselected) {
        return {
          ok: false,
          reason: `No cookies database found for profile "${params.browserProfile}".`
        }
      }
      browser = reselected
    }

    const profileName =
      browser.profiles.find((candidate) => candidate.directory === browser.selectedProfile)?.name ??
      browser.selectedProfile
    // Why: any runtime-token holder can call this; only a paired client's UI already carries the user's click.
    if (!caller?.pairedDeviceId) {
      const consent = await confirmCookieImportFromCommand({
        window: this.host.getAvailableAuthoritativeWindow(),
        browserLabel: browser.label,
        sourceProfileName: profileName,
        targetProfileLabel: profile.label
      })
      if (consent !== 'confirmed') {
        return {
          ok: false,
          reason:
            consent === 'declined'
              ? 'The cookie import was cancelled in Orca.'
              : 'Cookie import from a command needs confirmation in an open Orca window. Import from Settings instead.'
        }
      }
    }

    const result = await importCookiesFromBrowser(browser, profile.partition, {
      canReportPartitionSkippedCookies: params.supportsPartitionSkippedCookies === true
    })
    if (!result.ok) {
      return result
    }

    browserSessionRegistry.updateProfileSource(params.profileId, {
      browserFamily: browser.family,
      profileName,
      importedAt: Date.now()
    })
    return { ...result, profileId: params.profileId }
  }

  async browserProfileClearDefaultCookies(): Promise<BrowserProfileClearDefaultCookiesResult> {
    return { cleared: await browserSessionRegistry.clearDefaultSessionCookies() }
  }
}
