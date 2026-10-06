import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DeviceRegistry, PENDING_DEVICE_TTL_MS } from './device-registry'

function userDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'orca-device-expiry-'))
}

function manualClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return {
    now: () => current,
    advance: (ms) => {
      current += ms
    }
  }
}

describe('DeviceRegistry pending pairing expiry', () => {
  it('uses a 15 minute TTL', () => {
    expect(PENDING_DEVICE_TTL_MS).toBe(15 * 60 * 1000)
  })

  it('keeps re-advertising a fresh pending token inside the TTL', () => {
    const clock = manualClock()
    const registry = new DeviceRegistry(userDataDir(), { now: clock.now })
    const first = registry.getOrCreatePendingDevice('phone', 'mobile')

    clock.advance(PENDING_DEVICE_TTL_MS - 1)

    expect(registry.getOrCreatePendingDevice('phone', 'mobile').token).toBe(first.token)
    expect(registry.validateToken(first.token)?.deviceId).toBe(first.deviceId)
  })

  it('replaces an expired never-seen token on the next request and refuses it at auth', () => {
    const clock = manualClock()
    const dir = userDataDir()
    const registry = new DeviceRegistry(dir, { now: clock.now })
    const stale = registry.getOrCreatePendingDevice('phone', 'mobile')

    clock.advance(PENDING_DEVICE_TTL_MS + 1)

    expect(registry.validateToken(stale.token)).toBeNull()
    const fresh = registry.getOrCreatePendingDevice('phone', 'mobile')
    expect(fresh.token).not.toBe(stale.token)
    expect(registry.getDevice(stale.deviceId)).toBeNull()
    expect(registry.validateToken(fresh.token)?.deviceId).toBe(fresh.deviceId)
    // The replacement is durable, so a restart cannot resurrect the stale token.
    expect(new DeviceRegistry(dir, { now: clock.now }).validateToken(stale.token)).toBeNull()
  })

  it('reports whether a pending entry has expired', () => {
    const clock = manualClock()
    const registry = new DeviceRegistry(userDataDir(), { now: clock.now })
    const pending = registry.getOrCreatePendingDevice('phone', 'mobile')

    expect(registry.isPendingDeviceExpired(pending)).toBe(false)
    clock.advance(PENDING_DEVICE_TTL_MS + 1)
    expect(registry.isPendingDeviceExpired(pending)).toBe(true)
  })

  it('never expires a device that has already paired', () => {
    const clock = manualClock()
    const registry = new DeviceRegistry(userDataDir(), { now: clock.now })
    const paired = registry.getOrCreatePendingDevice('phone', 'mobile')
    clock.advance(1_000)
    registry.updateLastSeen(paired.deviceId)

    clock.advance(30 * 24 * 60 * 60 * 1000)

    expect(registry.validateToken(paired.token)?.deviceId).toBe(paired.deviceId)
    const nextPending = registry.getOrCreatePendingDevice('second phone', 'mobile')
    expect(nextPending.deviceId).not.toBe(paired.deviceId)
    expect(registry.getDevice(paired.deviceId)).not.toBeNull()
    expect(registry.isPendingDeviceExpired(registry.getDevice(paired.deviceId)!)).toBe(false)
  })

  it('leaves other scopes alone when replacing an expired pending entry', () => {
    const clock = manualClock()
    const registry = new DeviceRegistry(userDataDir(), { now: clock.now })
    const runtimePending = registry.getOrCreatePendingDevice('cli', 'runtime')
    clock.advance(PENDING_DEVICE_TTL_MS + 1)

    registry.getOrCreatePendingDevice('phone', 'mobile')

    expect(registry.getDevice(runtimePending.deviceId)).not.toBeNull()
  })

  it('rejects tokens of a different length or content without throwing', () => {
    const registry = new DeviceRegistry(userDataDir())
    const device = registry.addDevice('phone', 'mobile')

    expect(registry.validateToken('')).toBeNull()
    expect(registry.validateToken(device.token.slice(0, -1))).toBeNull()
    expect(registry.validateToken(`${device.token}0`)).toBeNull()
    expect(registry.validateToken(device.token.replace(/.$/, 'x'))).toBeNull()
    expect(registry.validateToken(device.token)?.deviceId).toBe(device.deviceId)
  })
})
