import { describe, expect, it, vi } from 'vitest'
import type { RelayAssignment } from './assignment-store.js'
import { RELAY_PUBLIC_RESOLVE_REQUESTS_PER_MINUTE_PER_IP, type RelayConfig } from './config.js'

const fakes = vi.hoisted(() => ({
  verifyRelayToken: vi.fn(async (token: string) => ({ sub: 'user-1', relayHostId: token }))
}))

vi.mock('./relay-token-verifier.js', () => ({
  createRelayTokenVerifier: () => fakes.verifyRelayToken,
  readBearer: (value: string | undefined) => value?.replace(/^Bearer /, '') ?? null
}))

import { createRelayApp } from './app.js'

const VICTIM = 'vvvvvvvvvvvvvvvv'
const GENUINE_FILL = 7

// Only the genuine token resolves; every other fill is an attacker's guess.
const resolveResume = (genuineFill = GENUINE_FILL) =>
  vi.fn(async (_relayHostId: string, token: string) =>
    token === Buffer.alloc(32, genuineFill).toString('base64url')
      ? { userId: 'user-1', relayDeviceId: 'device-1' }
      : null
  )

describe('unauthenticated resolve admission', () => {
  it('never displaces the host\'s own queued assignment', async () => {
    const pending = new Map<string, ReturnType<typeof deferred<RelayAssignment>>>()
    const assign = vi.fn(async ({ relayHostId }: { relayHostId: string }) => {
      const operation = deferred<RelayAssignment>()
      pending.set(relayHostId, operation)
      return await operation.promise
    })
    const app = createRelayApp(config(), {
      store: { resolveResume: resolveResume() } as never,
      assignments: { assign, resolve: vi.fn() } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true)
    })
    const busyA = app.request('/v1/assign', assignmentRequest('aaaaaaaaaaaaaaaa'))
    const busyB = app.request('/v1/assign', assignmentRequest('bbbbbbbbbbbbbbbb'))
    await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(2))
    const victim = app.request('/v1/assign', assignmentRequest(VICTIM))
    await settle()

    const forged = app.request('/v1/resolve', resolveRequest(VICTIM, 1))
    await settle()
    pending.get('aaaaaaaaaaaaaaaa')?.resolve(assignment('cell-a', 'aaaaaaaaaaaaaaaa'))
    expect((await busyA).status).toBe(200)
    expect((await forged).status).toBe(401)

    await vi.waitFor(() => expect(pending.has(VICTIM)).toBe(true))
    pending.get(VICTIM)?.resolve(assignment('cell-v', VICTIM))
    expect((await victim).status).toBe(200)
    pending.get('bbbbbbbbbbbbbbbb')?.resolve(assignment('cell-b', 'bbbbbbbbbbbbbbbb'))
    expect((await busyB).status).toBe(200)
  })

  it('never starts the host\'s resolve retry clock', async () => {
    const resolve = vi.fn(async () => assignment('cell-v', VICTIM))
    const app = createRelayApp(config(), {
      store: { resolveResume: resolveResume() } as never,
      assignments: { assign: vi.fn(), resolve } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true)
    })

    const forged = await app.request('/v1/resolve', resolveRequest(VICTIM, 1))
    const genuine = await app.request('/v1/resolve', resolveRequest(VICTIM, GENUINE_FILL))

    expect(forged.status).toBe(401)
    expect(genuine.status).toBe(200)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('throttles one client address however it forges the leading hops', async () => {
    const app = createRelayApp(config({ trustedProxyHops: 0 }), {
      store: { resolveResume: resolveResume() } as never,
      assignments: { assign: vi.fn(), resolve: vi.fn() } as never,
      drain: vi.fn(),
      ready: vi.fn(async () => true)
    })
    const statuses: number[] = []
    for (let index = 0; index < 200; index++) {
      const response = await app.request(
        '/v1/resolve',
        resolveRequest(VICTIM, 1, `198.51.100.${index % 250}, 203.0.113.7`)
      )
      statuses.push(response.status)
      if (response.status === 429) {
        expect(response.headers.get('retry-after')).toBe('5')
        break
      }
    }

    expect(statuses.indexOf(429)).toBe(RELAY_PUBLIC_RESOLVE_REQUESTS_PER_MINUTE_PER_IP)
    const otherClient = await app.request(
      '/v1/resolve',
      resolveRequest(VICTIM, 1, '203.0.113.7, 203.0.113.8')
    )
    expect(otherClient.status).toBe(401)
  })
})

function assignmentRequest(relayHostId: string): RequestInit {
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${relayHostId}`, 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, relayHostId })
  }
}

function resolveRequest(relayHostId: string, fill: number, forwardedFor?: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {})
    },
    body: JSON.stringify({
      v: 1,
      relayHostId,
      resumeToken: Buffer.alloc(32, fill).toString('base64url')
    })
  }
}

function assignment(cellId: string, relayHostId: string): RelayAssignment {
  return {
    userId: 'user-1',
    relayHostId,
    cellId,
    cellUrl: `https://${cellId}.relay.example.test`,
    assignmentEpoch: 1,
    leaseExpiresAt: Date.now() + 300_000
  }
}

// Lets every in-flight request reach its admission queue before the next step.
async function settle(): Promise<void> {
  await new Promise<void>((resolveTick) => setImmediate(resolveTick))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function config(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    port: 8080,
    publicUrl: 'https://relay.example.test',
    cellUrl: 'https://relay.example.test',
    authIssuer: 'https://auth.example.test',
    authAudience: 'orca-relay',
    jwksUrl: 'https://auth.example.test/jwks',
    assignmentSigningKey: new TextEncoder().encode('assignment-key-with-at-least-32-bytes'),
    role: 'director',
    cellId: 'director',
    cells: [],
    adminAudience: 'https://relay.example.test/v1/admin/drain',
    deployServiceAccount: 'deploy@example.test',
    runtimeServiceAccount: 'runtime@example.test',
    adminJwksUrl: 'https://auth.example.test/jwks',
    databasePoolMax: 3,
    publicAssignmentsEnabled: true,
    publicAssignmentConcurrency: 2,
    publicAssignmentQueueMax: 128,
    publicAssignmentWaitMs: 4_000,
    publicResolveConcurrency: 1,
    publicResolveWaitMs: 5_000,
    publicAssignmentRetryAfterSeconds: 5,
    dataDir: './data',
    ...overrides
  }
}
