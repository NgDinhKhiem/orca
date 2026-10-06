import type { RuntimeWorktreeCreateResult } from '../../shared/runtime-types'

export function printSetupApprovalWarning(
  result: Pick<RuntimeWorktreeCreateResult, 'setupApproval' | 'worktree'>,
  json: boolean
): void {
  if (json || !result.setupApproval) {
    return
  }
  // Why: the CLI cannot show the script, so it names the file and the explicit opt-in instead.
  console.error(
    `warning: orca.yaml setup/defaultTabs commands in ${result.worktree.path} were not run because this exact content is not approved for the repository. Review that orca.yaml, then pass --setup run to run it on create, or approve it in Orca.`
  )
}
