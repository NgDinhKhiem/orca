import { toSshExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type { RuntimeTerminalListResult } from '../../shared/runtime-terminal-contracts'
import type { RpcResponse } from '../runtime/rpc/core'
import { DEFAULT_TERMINAL_LIST_LIMIT } from '../runtime/orca-runtime-postlude'
import { RemoteCliArgumentError, type ParsedRemoteCli } from './ssh-remote-cli-argument-error'
import { optionalRemoteCliNumber, optionalRemoteCliString } from './ssh-remote-cli-args'
import type { SshCliRuntimeAuthority } from './ssh-remote-cli-host-passthrough'

/** `terminal list` for an SSH caller, answered only with terminals on that caller's SSH host. */
export async function listCallerSshHostTerminals(
  parsed: ParsedRemoteCli,
  runtimeAuthority: SshCliRuntimeAuthority | undefined,
  listTerminals: (params: Record<string, unknown>) => Promise<RpcResponse>
): Promise<RpcResponse> {
  if (!runtimeAuthority) {
    throw new RemoteCliArgumentError(
      'unsupported_over_ssh',
      "terminal list over SSH needs the calling SSH host's identity to scope the listing."
    )
  }
  const limit = optionalRemoteCliNumber(parsed.flags, 'limit') ?? DEFAULT_TERMINAL_LIST_LIMIT
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RemoteCliArgumentError('invalid_argument', 'Invalid value for --limit')
  }
  const response = await listTerminals({
    worktree: optionalRemoteCliString(parsed.flags, 'worktree'),
    // Why unbounded: the caller's own terminals may sit past the limit until scoped below.
    limit: Number.MAX_SAFE_INTEGER,
    // Why: agent JSON calls dominate; topology stays available through an explicit opt-in.
    includeVisualLayouts: !parsed.flags.has('json') || parsed.flags.has('include-visual-layouts')
  })
  if (!response.ok) {
    return response
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: terminal.list's handler returns RuntimeTerminalListResult.
  const listing = response.result as RuntimeTerminalListResult
  return {
    ...response,
    result: scopeTerminalListToHost(listing, toSshExecutionHostId(runtimeAuthority.targetId), limit)
  }
}

/**
 * Narrows a terminal listing to the SSH host that asked for it.
 *
 * A terminal with no `executionHostId` is dropped: a host that cannot name its execution host
 * cannot prove it is the caller's. The hosts filtered out stay named in `omittedHostIds`, so the
 * listing still admits what it did not cover.
 */
export function scopeTerminalListToHost(
  result: RuntimeTerminalListResult,
  hostId: ExecutionHostId,
  limit: number
): RuntimeTerminalListResult {
  const owned = result.terminals.filter((terminal) => terminal.executionHostId === hostId)
  const listed = owned.slice(0, limit)
  const ownedWorktreeIds = new Set(owned.map((terminal) => terminal.worktreeId))
  const listedWorktreeIds = new Set(listed.map((terminal) => terminal.worktreeId))
  const scoped: RuntimeTerminalListResult = {
    terminals: listed,
    totalCount: owned.length,
    truncated: owned.length > limit
  }
  if (result.visualLayouts) {
    scoped.visualLayouts = result.visualLayouts.filter((layout) =>
      listedWorktreeIds.has(layout.worktreeId)
    )
  }
  if (result.topologyRevisions) {
    scoped.topologyRevisions = Object.fromEntries(
      Object.entries(result.topologyRevisions).filter(([worktreeId]) =>
        ownedWorktreeIds.has(worktreeId)
      )
    )
  }
  if (result.hostScope) {
    const covered = result.hostScope.hostIds.filter((id) => id === hostId)
    scoped.hostScope = {
      hostIds: covered,
      omittedHostIds: [
        ...new Set([
          ...result.hostScope.omittedHostIds,
          ...result.hostScope.hostIds.filter((id) => id !== hostId)
        ])
      ]
    }
  }
  return scoped
}
