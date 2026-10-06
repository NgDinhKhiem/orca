const DEFAULT_WINDOW_MS = 60_000
const DEFAULT_MAX_TRACKED_IPS = 10_000

// Mirrors apps/push/src/client-ip-rate-limit.ts; the two apps share no package to hold it.
// Read x-forwarded-for from the right: each trusted proxy appends what it saw, so
// everything left of the last trustedProxyHops + 1 entries is caller-written and
// can be forged per request. Cloud Run appends only the client (0 hops); the GCE
// HTTPS load balancer appends the client and then itself (1 hop). A chain too
// short for the depth is not trusted at all.
export function readForwardedClientIp(
  forwardedFor: string | readonly string[] | undefined,
  trustedProxyHops: number
): string | undefined {
  const joined = typeof forwardedFor === 'string' ? forwardedFor : (forwardedFor ?? []).join(',')
  const hops = joined
    .split(',')
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0)
  return hops[hops.length - 1 - trustedProxyHops]
}

export type ClientIpRateLimiterOptions = {
  capacity: number
  windowMs?: number
  maxTrackedIps?: number
  now?: () => number
}

type Bucket = { tokens: number; updatedAt: number }

// Per-instance token bucket: no database round trip, so capacity scales with instance count.
export class ClientIpRateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly capacity: number
  private readonly windowMs: number
  private readonly maxTrackedIps: number
  private readonly now: () => number

  constructor(options: ClientIpRateLimiterOptions) {
    this.capacity = options.capacity
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
    this.maxTrackedIps = options.maxTrackedIps ?? DEFAULT_MAX_TRACKED_IPS
    this.now = options.now ?? Date.now
  }

  allow(clientIp: string): boolean {
    const now = this.now()
    const tokens = this.tokensAt(this.buckets.get(clientIp), now)
    // Re-inserting keeps Map order least-recently-used first for eviction.
    this.buckets.delete(clientIp)
    this.buckets.set(clientIp, { tokens: tokens < 1 ? tokens : tokens - 1, updatedAt: now })
    if (this.buckets.size > this.maxTrackedIps) {
      const oldest = this.buckets.keys().next().value
      if (oldest !== undefined) this.buckets.delete(oldest)
    }
    return tokens >= 1
  }

  trackedIpCount(): number {
    return this.buckets.size
  }

  private tokensAt(bucket: Bucket | undefined, now: number): number {
    if (!bucket) return this.capacity
    const refilled = ((now - bucket.updatedAt) * this.capacity) / this.windowMs
    return Math.min(this.capacity, bucket.tokens + Math.max(0, refilled))
  }
}
