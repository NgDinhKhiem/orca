import type { OrcaHooks, PersistedTrustedOrcaHookRepo } from './orca-yaml-hook-types'
import { sha256 } from './sha256'

/** Trust a creating client already holds for a repo's shared setup commands. Sent on create
 *  because a paired client's trust store lives on the client, not on the host that runs setup. */
export type OrcaSetupTrustGrant = {
  /** Hash of setup content the user approved for this repo. */
  contentHash?: string
  /** The user trusts every orca.yaml command in this repo. */
  repoWide?: boolean
}

/** The text a setup trust prompt shows and hashes: shared setup plus every defaultTabs command. */
export function getOrcaSetupTrustContent(hooks: OrcaHooks | null | undefined): string {
  const defaultTabCommands = (hooks?.defaultTabs ?? [])
    .map((tab, index) => {
      const command = tab.command?.trim()
      if (!command) {
        return null
      }
      const label = tab.title ? ` ${tab.title}` : ''
      return `# defaultTabs[${index + 1}]${label}\n${command}`
    })
    .filter((entry): entry is string => entry !== null)
  return [hooks?.scripts?.setup?.trim(), ...defaultTabCommands].filter(Boolean).join('\n\n')
}

/** SHA-256 hex of the trimmed script; the digest every trust store entry is keyed by. */
export function hashOrcaHookScriptContent(content: string): string {
  const digest = sha256(new TextEncoder().encode(content.trim()))
  let hex = ''
  for (const byte of digest) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

export function isOrcaSetupContentTrusted(
  contentHash: string,
  stored: PersistedTrustedOrcaHookRepo | undefined,
  grant: OrcaSetupTrustGrant | undefined
): boolean {
  return (
    Boolean(stored?.all) ||
    grant?.repoWide === true ||
    stored?.setup?.contentHash === contentHash ||
    grant?.contentHash === contentHash
  )
}
