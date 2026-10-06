import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import type { Repo } from '../../shared/repo-types'
import { getEffectiveHooks, loadHooks, runHook } from '../hooks'
import { createSetupRunnerScript, resolveSetupRunnerShell } from '../worktree-runner-script'
import { getDefaultTabsLaunch, shouldRunSetupForCreate } from '../effective-hook-config'
import {
  isExplicitCliSetupRun,
  readTrustedOrcaHooks,
  resolveWorktreeSetupContentTrust,
  withholdUntrustedWorktreeSetup,
  type TrustedOrcaHooksSource
} from '../worktree-setup-content-trust'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import type { RuntimeStore } from './runtime-store-contract'

export async function prepareRuntimeLocalWorktreeSetup(args: {
  request: RuntimeManagedWorktreeCreateArgs
  repo: Repo
  worktreePath: string
  settings: ReturnType<RuntimeStore['getSettings']>
  runtimeTarget: { wslDistro?: string } | undefined
  shouldUseSetupRunner: boolean
  trustStore: TrustedOrcaHooksSource | undefined
  warning?: string
}): Promise<{
  setup?: CreateWorktreeResult['setup']
  defaultTabs?: CreateWorktreeResult['defaultTabs']
  setupApproval?: CreateWorktreeResult['setupApproval']
  warning?: string
  effectiveDecision: 'run' | 'skip' | 'inherit'
  hookFound: boolean
  shouldRunSetup: boolean
  didStartInProcessSetupHook: boolean
}> {
  const { request, repo, worktreePath, settings } = args
  let warning = args.warning
  let setup: CreateWorktreeResult['setup']
  const yamlHooks = loadHooks(worktreePath)
  const hooks = getEffectiveHooks(repo, worktreePath)
  const effectiveDecision = request.runHooks ? 'run' : (request.setupDecision ?? 'inherit')
  // Why: trust is checked against the worktree's own orca.yaml, the content that would run.
  const trust = resolveWorktreeSetupContentTrust({
    repo,
    worktreeHooks: yamlHooks,
    trustedOrcaHooks: readTrustedOrcaHooks(args.trustStore),
    grant: request.setupTrust,
    explicitCliRun: isExplicitCliSetupRun(effectiveDecision, request.cliProvenance)
  })
  let defaultTabs: CreateWorktreeResult['defaultTabs']
  try {
    defaultTabs = getDefaultTabsLaunch(yamlHooks, repo, effectiveDecision)
  } catch (error) {
    console.warn(`[hooks] default tab commands skipped for ${worktreePath}:`, error)
    defaultTabs = yamlHooks?.defaultTabs
      ? { tabs: yamlHooks.defaultTabs, runCommands: false }
      : undefined
  }
  const policyRunsSetup = Boolean(
    hooks?.scripts.setup && shouldRunSetupForCreate(repo, effectiveDecision)
  )
  let didStartInProcessSetupHook = false
  if (policyRunsSetup && hooks?.scripts.setup) {
    if (args.shouldUseSetupRunner) {
      try {
        setup = createSetupRunnerScript(
          repo,
          worktreePath,
          hooks.scripts.setup,
          args.runtimeTarget,
          resolveSetupRunnerShell(settings),
          yamlHooks?.setupAgentStartupPolicy
        )
      } catch (error) {
        console.error(`[hooks] Failed to prepare setup runner for ${worktreePath}:`, error)
      }
    } else if (trust.trusted) {
      didStartInProcessSetupHook = true
      void runHook('setup', worktreePath, repo, worktreePath, args.runtimeTarget).then((result) => {
        if (!result.success) {
          console.error(`[hooks] setup hook failed for ${worktreePath}:`, result.output)
        }
      })
    }
  } else if (hooks?.scripts.setup && effectiveDecision !== 'skip') {
    const skipped = `orca.yaml setup hook skipped for ${worktreePath}; pass --setup run to run it.`
    warning = warning ? `${warning} Also ${skipped}` : skipped
    console.warn(`[hooks] ${skipped}`)
  }
  const gated = withholdUntrustedWorktreeSetup(trust, { setup, defaultTabs })
  // Why: an in-process hook has no runner to hand back, so its approval carries content only.
  const setupApproval =
    gated.setupApproval ??
    (policyRunsSetup && !args.shouldUseSetupRunner && !trust.trusted
      ? {
          scriptContent: trust.scriptContent,
          contentHash: trust.contentHash,
          runDefaultTabCommands: false
        }
      : undefined)
  return {
    ...(gated.setup ? { setup: gated.setup } : {}),
    ...(gated.defaultTabs ? { defaultTabs: gated.defaultTabs } : {}),
    ...(setupApproval ? { setupApproval } : {}),
    ...(warning ? { warning } : {}),
    effectiveDecision,
    hookFound: Boolean(hooks?.scripts.setup),
    shouldRunSetup: policyRunsSetup && trust.trusted,
    didStartInProcessSetupHook
  }
}
