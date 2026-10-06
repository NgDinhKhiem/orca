import { hashOrcaHookScriptContent } from '../../shared/orca-hook-trust'
import { store } from './worktrees-test-ipc-surface'

/** Records approval of exact orca.yaml setup content; create launches setup only for trusted content. */
export function trustOrcaYamlSetup(repoId: string, content: string): void {
  store.getUI.mockReturnValue({
    trustedOrcaHooks: {
      [repoId]: { setup: { contentHash: hashOrcaHookScriptContent(content), approvedAt: 1 } }
    }
  })
}
