/**
 * What an `orca` command run on an SSH host may do on the Orca client it proxies to.
 *
 * The SSH shim runs the client's CLI against the client's runtime, so an SSH host is a separate,
 * less-trusted principal: it gets the agent-to-agent control plane and read-only answers, never
 * local terminals, worktrees, repos, the browser or the desktop. Matched as command-path prefixes;
 * `src/cli/ssh-cli-bridge-allowlist.test.ts` checks this list against the real command specs.
 */
export const SSH_CLI_BRIDGE_ALLOWED_COMMANDS: readonly (readonly string[])[] = [
  ['status'],
  ['skills', 'list'],
  ['skills', 'get'],
  ['skills', 'show'],
  // Worker contract: heartbeats, reports, questions and follow-ups. Their caller identity is
  // already bound to the SSH attachment by the orchestration runtime.
  ['orchestration', 'send'],
  ['orchestration', 'check'],
  ['orchestration', 'ask'],
  ['orchestration', 'reply'],
  ['orchestration', 'inbox'],
  ['orchestration', 'request-show'],
  ['orchestration', 'dispatch-show'],
  // Scoped in main to terminals whose execution host is the calling SSH target.
  ['terminal', 'list'],
  // Documented for SSH agents (skill-guides/orca-linear.md); local body files are refused.
  ['linear']
]

/** Runs only in main's in-process bridge, where the result can be scoped to the caller's host. */
export const SSH_CLI_BRIDGE_CALLER_SCOPED_COMMANDS: readonly (readonly string[])[] = [
  ['terminal', 'list']
]

/** Flags that pick which machine executes a command; an SSH caller never chooses that. */
export const SSH_CLI_BRIDGE_RETARGET_FLAGS: readonly string[] = [
  'host',
  'environment',
  'pairing-code',
  'on'
]
