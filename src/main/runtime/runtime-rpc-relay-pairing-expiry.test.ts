import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { PENDING_DEVICE_TTL_MS } from './device-registry'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

describe('mobile pairing offer after the pending token expires', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('mints a new credential and queues the expired Relay binding for revoke', async () => {
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath: mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-expiry-')),
      enableWebSocket: true,
      wsPort: 0
    })
    const onDeviceRevokeQueued = vi.fn()
    server.setMobileRelayPairingProvider({
      createPairingRelay: async (relayDeviceId) => ({
        relay: {
          v: 1,
          directorUrl: 'https://relay.example.com',
          cellUrl: 'https://cell.example.com',
          assignmentEpoch: 7,
          relayHostId: 'AbCdEf0123_-xyZ9',
          inviteToken: 'A'.repeat(43),
          inviteExpiresAt: Date.now() + 60_000,
          e2eeFraming: 2
        },
        binding: {
          relayHostId: 'AbCdEf0123_-xyZ9',
          relayDeviceId,
          ownerIdentityKey: 'user\0profile\0org'
        }
      }),
      onDeviceRevokeQueued,
      getEndpoints: vi.fn(),
      provisionRelay: vi.fn()
    })

    await server.start()
    try {
      const first = await server.createMobilePairingOffer({ address: '100.64.1.20' })
      if (!first.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      const registry = server.getDeviceRegistry()
      const firstDevice = registry?.getDevice(first.deviceId)
      expect(firstDevice?.relayBinding).toBeTruthy()

      const realNow = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(realNow + PENDING_DEVICE_TTL_MS + 1)

      expect(registry?.validateToken(firstDevice!.token)).toBeNull()
      const second = await server.createMobilePairingOffer({ address: '100.64.1.20' })
      if (!second.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      expect(second.deviceId).not.toBe(first.deviceId)
      expect(registry?.getDevice(first.deviceId)).toBeNull()
      expect(onDeviceRevokeQueued).toHaveBeenCalledWith(
        expect.objectContaining(firstDevice!.relayBinding)
      )
    } finally {
      await server.stop()
    }
  })
})
