import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractClaudePtyResetMetadata } from './claude-pty-reset-parser'

// The pre-tokenizer pattern, kept as the equivalence oracle for relative resets.
const LEGACY_RELATIVE_RESET_RE =
  /^(?:\s*\d+\s*(?:d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?)\s*)+$/i
const LEGACY_RELATIVE_RESET_TOKEN_RE = /(\d+)\s*(d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?)/gi
const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000 }

function legacyRelativeDurationMs(description: string): number | null {
  if (!LEGACY_RELATIVE_RESET_RE.test(description)) {
    return null
  }
  let durationMs = 0
  for (const match of description.matchAll(LEGACY_RELATIVE_RESET_TOKEN_RE)) {
    durationMs += Number(match[1]) * UNIT_MS[match[2].toLowerCase()[0]]
  }
  return durationMs > 0 ? durationMs : null
}

function resetsAtFor(description: string): number | null {
  return extractClaudePtyResetMetadata(
    ['Current session', `Resets in ${description}`],
    (line) => line === 'Current session',
    () => false
  ).resetsAt
}

const NOW = new Date(2026, 9, 6, 12, 0, 0).getTime()

describe('claude PTY relative reset parsing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    '2h 30m',
    '2h10m',
    '5 days',
    '1 day 4 hours',
    '1d 2h 3m',
    '1d1h',
    '45 mins',
    '1 min',
    '10minutes',
    '1 minute',
    '1 hour',
    '3hrs',
    '3 hr',
    '12 d',
    '5 D 7 H',
    '0d 5m'
  ])('parses %s exactly as the legacy pattern did', (description) => {
    const legacy = legacyRelativeDurationMs(description)
    expect(legacy).not.toBeNull()
    expect(resetsAtFor(description)).toBe(NOW + (legacy ?? 0))
  })

  it.each(['0m', '2x', '1ms', '5', 'soon', '1d x', 'd1', '1 dayz'])(
    'rejects %s like the legacy pattern did',
    (description) => {
      expect(legacyRelativeDurationMs(description)).toBeNull()
      expect(resetsAtFor(description)).toBeNull()
    }
  )

  it('fails fast on a long run of relative tokens with a non-matching tail', () => {
    vi.useRealTimers()
    const description = `${'1d '.repeat(28)}x`
    const startedAt = performance.now()
    expect(resetsAtFor(description)).toBeNull()
    expect(performance.now() - startedAt).toBeLessThan(200)
  })

  it('caps the reset description taken from an unbroken PTY line', () => {
    vi.useRealTimers()
    const startedAt = performance.now()
    const metadata = extractClaudePtyResetMetadata(
      ['Current session', `Resets in 1h ${'(x'.repeat(32 * 1024)}`],
      (value) => value === 'Current session',
      () => false
    )
    expect(performance.now() - startedAt).toBeLessThan(200)
    expect(metadata.resetDescription?.startsWith('1h (x(x')).toBe(true)
    expect(metadata.resetDescription?.length ?? 0).toBeLessThanOrEqual(256)
  })
})
