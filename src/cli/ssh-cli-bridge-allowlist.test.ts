import { describe, expect, it } from 'vitest'
import {
  SSH_CLI_BRIDGE_ALLOWED_COMMANDS,
  SSH_CLI_BRIDGE_RETARGET_FLAGS
} from '../shared/ssh-cli-bridge-allowlist'
import { CLI_GLOBAL_VALUE_FLAGS } from '../shared/cli-argument-boundary'
import { specPaths } from './command-spec'
import { COMMAND_SPECS } from './specs'

const startsWith = (path: readonly string[], prefix: readonly string[]): boolean =>
  prefix.length <= path.length && prefix.every((part, index) => path[index] === part)

const isAllowed = (path: readonly string[]): boolean =>
  SSH_CLI_BRIDGE_ALLOWED_COMMANDS.some((allowed) => startsWith(path, allowed))

// Why: the SSH bridge matches allowlisted paths as prefixes in main, which cannot import these specs.
describe('the SSH CLI bridge allowlist against the real command specs', () => {
  it('names only commands the CLI actually has', () => {
    for (const allowed of SSH_CLI_BRIDGE_ALLOWED_COMMANDS) {
      const exists = COMMAND_SPECS.some((spec) =>
        specPaths(spec).some((path) => startsWith(path, allowed))
      )
      expect(exists, allowed.join(' ')).toBe(true)
    }
  })

  // Positional normalization picks the first spec whose path prefixes the argv; a shorter,
  // non-allowlisted spec with positionals could otherwise claim an allowlisted invocation.
  it('cannot be resolved by the CLI into a command outside the allowlist', () => {
    for (const spec of COMMAND_SPECS) {
      for (const path of specPaths(spec)) {
        if (isAllowed(path)) {
          continue
        }
        for (const allowed of SSH_CLI_BRIDGE_ALLOWED_COMMANDS) {
          const isProperPrefix = path.length < allowed.length && startsWith(allowed, path)
          expect(
            isProperPrefix && (spec.positionalArgs?.length ?? 0) > 0,
            `${path.join(' ')} could absorb ${allowed.join(' ')}`
          ).toBe(false)
        }
      }
    }
  })

  it('refuses every global flag that selects another runtime', () => {
    for (const flag of CLI_GLOBAL_VALUE_FLAGS) {
      expect(SSH_CLI_BRIDGE_RETARGET_FLAGS).toContain(flag)
    }
    expect(SSH_CLI_BRIDGE_RETARGET_FLAGS).toContain('host')
  })

  it('does not allow any allowlisted command to take an execution-host flag', () => {
    for (const spec of COMMAND_SPECS) {
      if (!specPaths(spec).some(isAllowed)) {
        continue
      }
      for (const flag of spec.allowedFlags) {
        if (CLI_GLOBAL_VALUE_FLAGS.includes(flag)) {
          continue
        }
        expect(SSH_CLI_BRIDGE_RETARGET_FLAGS, `${spec.path.join(' ')} --${flag}`).not.toContain(
          flag
        )
      }
    }
  })
})
