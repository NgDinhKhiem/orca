import { resolveHookCommandSourcePolicy } from '../shared/hook-command-source-policy'
import {
  getOrcaSetupTrustContent,
  hashOrcaHookScriptContent,
  isOrcaSetupContentTrusted,
  type OrcaSetupTrustGrant
} from '../shared/orca-hook-trust'
import type { OrcaHooks, PersistedTrustedOrcaHooks } from '../shared/orca-yaml-hook-types'
import type { Repo } from '../shared/repo-types'
import type { SetupDecision, WorktreeSetupApproval } from '../shared/worktree/create-types'
import type {
  WorktreeDefaultTabsLaunch,
  WorktreeSetupLaunch
} from '../shared/worktree/launch-types'

export type TrustedOrcaHooksSource = {
  getUI?: () => { trustedOrcaHooks?: PersistedTrustedOrcaHooks } | undefined
}

/** Trust the user recorded on this host; runtime stores without UI state have none. */
export function readTrustedOrcaHooks(
  store: TrustedOrcaHooksSource | undefined
): PersistedTrustedOrcaHooks {
  return store?.getUI?.()?.trustedOrcaHooks ?? {}
}

/** An explicit CLI `--setup run` / `--run-hooks` is the user's approval; the CLI cannot prompt. */
export function isExplicitCliSetupRun(
  setupDecision: SetupDecision | undefined,
  cliProvenance: { kind: string } | undefined
): boolean {
  return setupDecision === 'run' && cliProvenance?.kind === 'created-by-cli'
}

export type WorktreeSetupContentTrust =
  | { trusted: true }
  | { trusted: false; scriptContent: string; contentHash: string }

export function resolveWorktreeSetupContentTrust(args: {
  repo: Repo
  /** orca.yaml read from the NEW worktree: the content that would actually run. */
  worktreeHooks: OrcaHooks | null
  trustedOrcaHooks: PersistedTrustedOrcaHooks
  grant?: OrcaSetupTrustGrant
  explicitCliRun: boolean
}): WorktreeSetupContentTrust {
  const policy = resolveHookCommandSourcePolicy(args.repo.hookSettings?.commandSourcePolicy, {
    hasLocalScript: Boolean(args.repo.hookSettings?.scripts?.setup?.trim())
  })
  // Why: local-only never runs committed commands, and local scripts are user-authored.
  if (policy === 'local-only' || args.explicitCliRun) {
    return { trusted: true }
  }
  const scriptContent = getOrcaSetupTrustContent(args.worktreeHooks)
  if (!scriptContent) {
    return { trusted: true }
  }
  const contentHash = hashOrcaHookScriptContent(scriptContent)
  return isOrcaSetupContentTrusted(contentHash, args.trustedOrcaHooks[args.repo.id], args.grant)
    ? { trusted: true }
    : { trusted: false, scriptContent, contentHash }
}

export type GatedWorktreeSetupLaunch = {
  setup?: WorktreeSetupLaunch
  defaultTabs?: WorktreeDefaultTabsLaunch
  setupApproval?: WorktreeSetupApproval
}

/** Withholds setup and defaultTabs commands whose exact content is untrusted, handing them back
 *  as an approval request so the client can show the real content before anything runs. */
export function withholdUntrustedWorktreeSetup(
  trust: WorktreeSetupContentTrust,
  launch: { setup?: WorktreeSetupLaunch; defaultTabs?: WorktreeDefaultTabsLaunch }
): GatedWorktreeSetupLaunch {
  const runDefaultTabCommands = launch.defaultTabs?.runCommands === true
  if (trust.trusted || (!launch.setup && !runDefaultTabCommands)) {
    return {
      ...(launch.setup ? { setup: launch.setup } : {}),
      ...(launch.defaultTabs ? { defaultTabs: launch.defaultTabs } : {})
    }
  }
  return {
    ...(launch.defaultTabs ? { defaultTabs: { ...launch.defaultTabs, runCommands: false } } : {}),
    setupApproval: {
      scriptContent: trust.scriptContent,
      contentHash: trust.contentHash,
      ...(launch.setup ? { setup: launch.setup } : {}),
      runDefaultTabCommands
    }
  }
}
