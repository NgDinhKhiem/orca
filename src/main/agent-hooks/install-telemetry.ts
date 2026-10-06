import type { HookInstallAgent } from '../../shared/telemetry-events'
import type { AgentHookInstallErrorKind } from '../../shared/telemetry-daemon-event-schemas'
import { track } from '../telemetry/client'

const ERRNO_CODE = /^E[A-Z0-9]{1,15}$/

const KIND_BY_ERRNO_CODE: Readonly<Record<string, AgentHookInstallErrorKind>> = {
  EACCES: 'permission_denied',
  EPERM: 'permission_denied',
  ENOENT: 'not_found',
  ENOTDIR: 'not_found',
  EROFS: 'read_only_filesystem',
  ENOSPC: 'disk_full',
  EDQUOT: 'disk_full',
  EBUSY: 'file_busy'
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined
  }
  const code = error.code
  return typeof code === 'string' && ERRNO_CODE.test(code) ? code : undefined
}

function classifyInstallError(error: unknown): {
  error_kind: AgentHookInstallErrorKind
  error_code?: string
} {
  const code = errnoCode(error)
  if (code) {
    return { error_kind: KIND_BY_ERRNO_CODE[code] ?? 'other_system_error', error_code: code }
  }
  // A hand-edited config the installer cannot parse.
  return { error_kind: error instanceof SyntaxError ? 'invalid_config' : 'unknown' }
}

export function recordManagedHookInstallFailure(agent: HookInstallAgent, error: unknown): void {
  try {
    track('agent_hook_install_failed', { agent, ...classifyInstallError(error) })
  } catch (telemetryError) {
    console.error('[agent-hooks] Failed to record install-failure telemetry:', telemetryError)
  }
}
