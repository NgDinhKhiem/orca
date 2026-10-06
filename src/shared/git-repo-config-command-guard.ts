import { findGitSubcommandIndex } from './git-command-classification'

/**
 * An opened folder's `.git/config` can name a `core.fsmonitor` command that Git
 * runs on any index read, so every Orca-spawned Git disables it on the command
 * line, which outranks repo config.
 *
 * Why an empty value rather than `false`: Git before 2.36 reads the key as a
 * hook path (empty means off, `false` would run a program named `false`), and
 * Git 2.36+ parses empty as boolean false. `-c` works on every Git version,
 * unlike GIT_CONFIG_COUNT (2.31+).
 */
export const GIT_FSMONITOR_DISABLED_ARGS = ['-c', 'core.fsmonitor='] as const

function setsFsmonitor(configArg: string | undefined): boolean {
  return configArg !== undefined && /^core\.fsmonitor(=|$)/i.test(configArg)
}

/** Prefix the fsmonitor guard ahead of any leading global options, unless a caller already set it. */
export function withGitRepoConfigCommandGuard(args: readonly string[]): string[] {
  const subcommandIndex = findGitSubcommandIndex(args)
  const globalOptionsEnd = subcommandIndex === -1 ? args.length : subcommandIndex
  for (let index = 0; index < globalOptionsEnd; index += 1) {
    if (args[index] === '-c' && setsFsmonitor(args[index + 1])) {
      return [...args]
    }
  }
  return [...GIT_FSMONITOR_DISABLED_ARGS, ...args]
}
