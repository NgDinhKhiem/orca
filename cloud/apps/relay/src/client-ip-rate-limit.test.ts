import { describe, expect, it } from 'vitest'
import { ClientIpRateLimiter, readForwardedClientIp } from './client-ip-rate-limit.js'

describe('forwarded client address', () => {
  it('takes the last hop on Cloud Run, whatever the caller prepended', () => {
    expect(readForwardedClientIp('203.0.113.7', 0)).toBe('203.0.113.7')
    expect(readForwardedClientIp('198.51.100.1, 198.51.100.2, 203.0.113.7', 0)).toBe(
      '203.0.113.7'
    )
  })

  it('takes the hop before the load balancer behind the GCE HTTPS proxy', () => {
    // GFE appends <client>, <load balancer> after anything the caller sent.
    expect(readForwardedClientIp('203.0.113.7, 34.111.0.1', 1)).toBe('203.0.113.7')
    expect(readForwardedClientIp('198.51.100.1,198.51.100.2, 203.0.113.7, 34.111.0.1', 1)).toBe(
      '203.0.113.7'
    )
  })

  it('reads repeated headers as one chain', () => {
    expect(readForwardedClientIp(['198.51.100.1', '203.0.113.7, 34.111.0.1'], 1)).toBe(
      '203.0.113.7'
    )
  })

  it('trusts nothing in a chain shorter than the proxy depth', () => {
    expect(readForwardedClientIp(undefined, 0)).toBeUndefined()
    expect(readForwardedClientIp('', 0)).toBeUndefined()
    expect(readForwardedClientIp(' , ', 0)).toBeUndefined()
    expect(readForwardedClientIp('203.0.113.7', 1)).toBeUndefined()
  })
})

describe('client address rate limiter', () => {
  it('refills each address independently', () => {
    let now = 0
    const limiter = new ClientIpRateLimiter({ capacity: 2, windowMs: 60_000, now: () => now })

    expect(limiter.allow('203.0.113.7')).toBe(true)
    expect(limiter.allow('203.0.113.7')).toBe(true)
    expect(limiter.allow('203.0.113.7')).toBe(false)
    expect(limiter.allow('203.0.113.8')).toBe(true)
    now = 30_000
    expect(limiter.allow('203.0.113.7')).toBe(true)
    expect(limiter.allow('203.0.113.7')).toBe(false)
  })

  it('bounds the addresses it remembers', () => {
    const limiter = new ClientIpRateLimiter({ capacity: 1, maxTrackedIps: 2, now: () => 0 })

    limiter.allow('a')
    limiter.allow('b')
    limiter.allow('c')

    expect(limiter.trackedIpCount()).toBe(2)
    // The oldest entry was evicted, so it starts over with a full bucket.
    expect(limiter.allow('a')).toBe(true)
  })
})
