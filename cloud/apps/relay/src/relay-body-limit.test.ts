import { RELAY_PROTOCOL_LIMITS } from '@orca-cloud/relay-contract'
import { describe, expect, it, vi } from 'vitest'
import type { RelayConfig } from './config.js'

const fakes = vi.hoisted(() => ({
  verifyRelayToken: vi.fn(async (token: string) => ({ sub: 'user-1', relayHostId: token }))
}))

vi.mock('./relay-token-verifier.js', () => ({
  createRelayTokenVerifier: () => fakes.verifyRelayToken,
  readBearer: (value: string | undefined) => value?.replace(/^Bearer /, '') ?? null
}))

import { createRelayApp } from './app.js'

const HOST = 'aaaaaaaaaaaaaaaa'
const OVERSIZED_PAD = 'x'.repeat(RELAY_PROTOCOL_LIMITS.maxHttpBodyBytes * 4)

// A streamed body carries no Content-Length, which is what a chunked upload looks like.
function streamedRequest(body: string, headers: Record<string, string> = {}): RequestInit {
  const bytes = new TextEncoder().encode(body)
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 1024) {
          controller.enqueue(bytes.slice(offset, offset + 1024))
        }
        controller.close()
      }
    }),
    duplex: 'half'
  }
}

function createApp() {
  const resolveResume = vi.fn(async () => ({ userId: 'user-1', relayDeviceId: 'device-1' }))
  const assign = vi.fn()
  const resolve = vi.fn(async () => assignment())
  const drain = vi.fn()
  const app = createRelayApp(config(), {
    store: { resolveResume } as never,
    assignments: { assign, resolve } as never,
    drain,
    ready: vi.fn(async () => true)
  })
  return { app, resolveResume, assign, drain }
}

describe('relay request body limit', () => {
  it('rejects an oversized chunked resolve body before parsing it', async () => {
    const { app, resolveResume } = createApp()
    const body = JSON.stringify({
      v: 1,
      relayHostId: HOST,
      resumeToken: Buffer.alloc(32, 1).toString('base64url'),
      pad: OVERSIZED_PAD
    })

    const response = await app.request('/v1/resolve', streamedRequest(body))

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'request_too_large' })
    expect(resolveResume).not.toHaveBeenCalled()
  })

  it('rejects an oversized chunked assign body', async () => {
    const { app, assign } = createApp()
    const body = JSON.stringify({ v: 1, relayHostId: HOST, pad: OVERSIZED_PAD })

    const response = await app.request(
      '/v1/assign',
      streamedRequest(body, { authorization: `Bearer ${HOST}` })
    )

    expect(response.status).toBe(413)
    expect(assign).not.toHaveBeenCalled()
  })

  it('rejects an oversized chunked admin body', async () => {
    const { app, drain } = createApp()

    const response = await app.request(
      '/v1/admin/drain',
      streamedRequest(JSON.stringify({ v: 1, graceMs: 0, pad: OVERSIZED_PAD }))
    )

    expect(response.status).toBe(413)
    expect(drain).not.toHaveBeenCalled()
  })

  it('still serves a chunked body inside the limit', async () => {
    const { app, resolveResume } = createApp()
    const body = JSON.stringify({
      v: 1,
      relayHostId: HOST,
      resumeToken: Buffer.alloc(32, 1).toString('base64url')
    })

    const response = await app.request('/v1/resolve', streamedRequest(body))

    expect(response.status).toBe(200)
    expect(resolveResume).toHaveBeenCalledTimes(1)
  })

  it('keeps rejecting a declared oversized length', async () => {
    const { app, resolveResume } = createApp()

    const response = await app.request('/v1/resolve', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(RELAY_PROTOCOL_LIMITS.maxHttpBodyBytes + 1)
      },
      body: 'x'.repeat(RELAY_PROTOCOL_LIMITS.maxHttpBodyBytes + 1)
    })

    expect(response.status).toBe(413)
    expect(resolveResume).not.toHaveBeenCalled()
  })
})

function assignment() {
  return {
    userId: 'user-1',
    relayHostId: HOST,
    cellId: 'cell-a',
    cellUrl: 'https://cell-a.relay.example.test',
    assignmentEpoch: 1,
    leaseExpiresAt: Date.now() + 300_000
  }
}

function config(): RelayConfig {
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
    dataDir: './data'
  }
}
