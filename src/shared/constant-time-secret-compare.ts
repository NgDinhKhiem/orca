import { createHash, timingSafeEqual } from 'node:crypto'

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/**
 * `presented === expected` for bearer secrets, without a timing side channel.
 * Why hash first: timingSafeEqual throws on a length mismatch, and an early
 * length check would leak the secret's length; fixed-size digests avoid both.
 */
export function secretsMatch(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string') {
    return false
  }
  return timingSafeEqual(digest(presented), digest(expected))
}
