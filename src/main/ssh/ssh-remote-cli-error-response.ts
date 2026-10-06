import type { RpcResponse } from '../runtime/rpc/core'

export function buildRemoteCliError(message: string, code = 'runtime_error'): RpcResponse {
  return {
    id: 'remote-cli-local',
    ok: false,
    error: { code, message },
    _meta: { runtimeId: 'unknown' }
  }
}

/** A command the SSH bridge refuses before running anything, shaped like a CLI failure. */
export function refusedRemoteCliResult(
  message: string,
  json: boolean,
  code = 'unsupported_over_ssh'
): { stdout: string; stderr: string; exitCode: number } {
  if (json) {
    return {
      stdout: `${JSON.stringify(buildRemoteCliError(message, code), null, 2)}\n`,
      stderr: '',
      exitCode: 1
    }
  }
  return { stdout: '', stderr: `${message}\n`, exitCode: 1 }
}
