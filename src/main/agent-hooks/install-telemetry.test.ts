import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentHookInstallFailedSchema } from '../../shared/telemetry-daemon-event-schemas'

const { trackMock } = vi.hoisted(() => ({
  trackMock: vi.fn<(eventName: string, props: Record<string, unknown>) => void>()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))

import { recordManagedHookInstallFailure } from './install-telemetry'

function fsError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

function recordedProps(): Record<string, unknown> {
  expect(trackMock).toHaveBeenCalledTimes(1)
  const [eventName, props] = trackMock.mock.calls[0] ?? []
  expect(eventName).toBe('agent_hook_install_failed')
  return props ?? {}
}

describe('recordManagedHookInstallFailure', () => {
  beforeEach(() => {
    trackMock.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sends a classified error instead of the raw message, which can carry absolute paths', () => {
    recordManagedHookInstallFailure(
      'codex',
      fsError('EACCES', "EACCES: permission denied, open '/Users/alice/.codex/hooks.json'")
    )

    const props = recordedProps()
    expect(props).toEqual({ agent: 'codex', error_kind: 'permission_denied', error_code: 'EACCES' })
    expect(JSON.stringify(props)).not.toContain('alice')
    expect(agentHookInstallFailedSchema.safeParse(props).success).toBe(true)
  })

  it.each([
    [fsError('EPERM', 'C:\\Users\\bob\\x'), 'permission_denied', 'EPERM'],
    [fsError('ENOENT', '/home/c/x'), 'not_found', 'ENOENT'],
    [fsError('ENOTDIR', '/home/c/x'), 'not_found', 'ENOTDIR'],
    [fsError('EROFS', '/home/c/x'), 'read_only_filesystem', 'EROFS'],
    [fsError('ENOSPC', '/home/c/x'), 'disk_full', 'ENOSPC'],
    [fsError('EBUSY', '/home/c/x'), 'file_busy', 'EBUSY'],
    [fsError('EMFILE', '/home/c/x'), 'other_system_error', 'EMFILE'],
    [new SyntaxError('Unexpected token } in JSON at position 4'), 'invalid_config', undefined],
    [new Error('hooks entry for /home/c is not an array'), 'unknown', undefined],
    ['plain string failure at /home/c', 'unknown', undefined],
    [{ code: 'EACCES' }, 'permission_denied', 'EACCES'],
    [fsError('not a code /home/c', 'x'), 'unknown', undefined]
  ])('classifies %o as %s', (error, kind, code) => {
    recordManagedHookInstallFailure('cursor', error)

    const props = recordedProps()
    expect(props).toEqual({
      agent: 'cursor',
      error_kind: kind,
      ...(code ? { error_code: code } : {})
    })
    expect(agentHookInstallFailedSchema.safeParse(props).success).toBe(true)
  })

  it('keeps raw error text off the wire at the schema level', () => {
    expect(
      agentHookInstallFailedSchema.safeParse({
        agent: 'codex',
        error_kind: 'unknown',
        error_message: 'open /Users/alice/secret'
      }).success
    ).toBe(false)
  })

  it('swallows telemetry failures', () => {
    trackMock.mockImplementationOnce(() => {
      throw new Error('telemetry failed')
    })

    expect(() => recordManagedHookInstallFailure('cursor', { code: 'EACCES' })).not.toThrow()
  })
})
