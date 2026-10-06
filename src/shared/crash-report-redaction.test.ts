import { describe, expect, it } from 'vitest'
import { BENIGN_TEXTS, CREDENTIAL_LEAK_CASES } from './credential-leak-fixtures.test-fixtures'
import { sanitizeCrashReportString } from './crash-report-redaction'

describe('sanitizeCrashReportString credential coverage', () => {
  it.each(CREDENTIAL_LEAK_CASES)('redacts $label', ({ text, secret }) => {
    const sanitized = sanitizeCrashReportString(text, 1_000)
    expect(sanitized).not.toContain(secret)
    expect(sanitizeCrashReportString(sanitized, 1_000)).toBe(sanitized)
  })

  it.each(BENIGN_TEXTS)('leaves ordinary text unchanged: %s', (text) => {
    expect(sanitizeCrashReportString(text, 1_000)).toBe(text)
  })

  it('still redacts paths before secrets', () => {
    expect(sanitizeCrashReportString('open /home/ada/.config/orca failed')).toBe(
      'open [redacted-path] failed'
    )
  })
})
