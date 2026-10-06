import { mapSettledWithConcurrency } from '../../shared/map-with-concurrency'
import { isGitRepoAsync } from '../git/repo'
import { awaitWindowsHostGitEnvironmentReady } from '../git/runner'

// Why: an import of up to 500 selected repos used to run one synchronous `git rev-parse`
// per repo on the main thread; a few async probes at a time keep it responsive while
// git admission control still bounds the process fan-out.
const NESTED_REPO_PROBE_CONCURRENCY = 6

export type LocalNestedRepoProbes = {
  /** Verdict for the path at `index`; rethrows that probe's failure. */
  isGitRepo: (index: number) => boolean
}

export async function probeLocalNestedRepos(
  repoPaths: readonly string[]
): Promise<LocalNestedRepoProbes> {
  const settled = await mapSettledWithConcurrency(
    repoPaths,
    NESTED_REPO_PROBE_CONCURRENCY,
    async (repoPath) => {
      await awaitWindowsHostGitEnvironmentReady({ cwd: repoPath })
      return isGitRepoAsync(repoPath)
    }
  )
  return {
    isGitRepo: (index) => {
      const probe = settled[index]
      if (probe?.status === 'fulfilled') {
        return probe.value
      }
      throw probe?.reason ?? new Error('nested_repo_probe_missing')
    }
  }
}
