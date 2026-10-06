import type {
  CreateWorktreeResult,
  WorktreeSetupApproval
} from '../../../../../../shared/worktree/create-types'

/** Turns a host's withheld worktree setup into a launchable result once the user approves the
 *  worktree's own content; a declined or failed prompt leaves setup and tab commands off. */
export async function resolveWorktreeSetupApproval(
  result: CreateWorktreeResult,
  confirm: (approval: WorktreeSetupApproval) => Promise<'run' | 'skip'>
): Promise<CreateWorktreeResult> {
  const { setupApproval, ...rest } = result
  if (!setupApproval) {
    return result
  }
  let decision: 'run' | 'skip'
  try {
    decision = await confirm(setupApproval)
  } catch (error) {
    console.error('Failed to confirm worktree setup content:', error)
    decision = 'skip'
  }
  if (decision !== 'run') {
    return rest
  }
  return {
    ...rest,
    ...(setupApproval.setup ? { setup: setupApproval.setup } : {}),
    ...(rest.defaultTabs && setupApproval.runDefaultTabCommands
      ? { defaultTabs: { ...rest.defaultTabs, runCommands: true } }
      : {})
  }
}
