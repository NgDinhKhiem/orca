/**
 * Deny-by-default gate for `orca` commands that arrive from an SSH host over the relay.
 *
 * The decision is made on this module's own parse, and the host CLI is then handed a canonical argv
 * (command path first, every flag as `--name` or `--name=value`) so it cannot resolve the same
 * tokens into a different command than the one checked here.
 */
import {
  SSH_CLI_BRIDGE_ALLOWED_COMMANDS,
  SSH_CLI_BRIDGE_CALLER_SCOPED_COMMANDS,
  SSH_CLI_BRIDGE_RETARGET_FLAGS
} from '../../shared/ssh-cli-bridge-allowlist'
import { tokenizeRemoteCliArgs } from './ssh-remote-cli-args'
import { SSH_LINEAR_STDIN_BODY_ONLY } from './ssh-remote-linear-write-support'

export type SshCliBridgeDecision =
  | {
      allowed: true
      argv: string[]
      /** `caller-ssh-host`: must run in-process so main can scope the answer to the caller. */
      scope?: 'caller-ssh-host'
    }
  | { allowed: false; message: string; code: 'unsupported_over_ssh' | 'invalid_argument' }

// Why: the host CLI dispatches these on raw argv before parsing, so even `--help` would launch them.
const RAW_ARGV_COMMANDS = new Set(['claude-teams', 'agent-teams-tmux'])

const startsWith = (path: readonly string[], prefix: readonly string[]): boolean =>
  prefix.length <= path.length && prefix.every((part, index) => path[index] === part)

export function evaluateSshCliBridgeRequest(argv: readonly string[]): SshCliBridgeDecision {
  const { commandPath, flagEntries } = tokenizeRemoteCliArgs(argv)
  const canonicalArgv = [
    ...commandPath,
    ...flagEntries.map(([name, value]) => (value === true ? `--${name}` : `--${name}=${value}`))
  ]
  const command = commandPath.join(' ')

  const retarget = flagEntries.find(([name]) => SSH_CLI_BRIDGE_RETARGET_FLAGS.includes(name))
  if (retarget) {
    return {
      allowed: false,
      code: 'unsupported_over_ssh',
      message: `\`--${retarget[0]}\` cannot retarget a command run from an SSH host; it always runs against the Orca client this host is connected to, scoped to this host.`
    }
  }

  const isHelp =
    commandPath.length === 0 ||
    commandPath[0] === 'help' ||
    flagEntries.some(([name]) => name === 'help')
  if (isHelp && !RAW_ARGV_COMMANDS.has(commandPath[0] ?? '')) {
    return { allowed: true, argv: canonicalArgv }
  }

  if (!SSH_CLI_BRIDGE_ALLOWED_COMMANDS.some((allowed) => startsWith(commandPath, allowed))) {
    return {
      allowed: false,
      code: 'unsupported_over_ssh',
      message: `orca ${command} is not available from an SSH host. Over SSH, orca can message other agents (orchestration send/check/ask/reply), report status, list this host's terminals, read skill guides and use Linear. Run other commands on the Orca client machine.`
    }
  }

  const localBodyFile = flagEntries.find(([name, value]) => name === 'body-file' && value !== '-')
  if (localBodyFile) {
    return { allowed: false, code: 'invalid_argument', message: SSH_LINEAR_STDIN_BODY_ONLY }
  }

  const callerScoped = SSH_CLI_BRIDGE_CALLER_SCOPED_COMMANDS.some((scoped) =>
    startsWith(commandPath, scoped)
  )
  return {
    allowed: true,
    argv: canonicalArgv,
    ...(callerScoped ? { scope: 'caller-ssh-host' as const } : {})
  }
}
