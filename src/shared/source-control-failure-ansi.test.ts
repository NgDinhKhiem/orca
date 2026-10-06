/* eslint-disable no-control-regex -- the legacy oracle matches terminal control bytes. */
import { describe, expect, it } from 'vitest'
import {
  hasExpandedCommitFailureDetails,
  summarizeCommitFailure
} from './source-control-commit-failure'
import { sanitizePushFailureDetails, summarizePushFailure } from './source-control-push-failure'

// The ansi-regex@4.1.0 shape both modules used before, kept as the equivalence oracle.
const LEGACY_ANSI_PATTERN =
  /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g
const LEGACY_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

function legacyNormalize(raw: string): string {
  return raw
    .replace(LEGACY_ANSI_PATTERN, '')
    .replace(/\r\n?/g, '\n')
    .replace(LEGACY_CONTROL_PATTERN, '')
    .trim()
}

const ESC = '\u001b'
const ST = `${ESC}\\`

// Real-looking hook/git output: SGR colors, erase-line, cursor moves, OSC titles, charset.
const HOOK_OUTPUT_CORPUS: readonly string[] = [
  `${ESC}[31merror${ESC}[39m: failed to push some refs to 'origin'`,
  `${ESC}[1m${ESC}[33m⚠${ESC}[39m${ESC}[22m lint-staged could not find any staged files`,
  `${ESC}[2K${ESC}[1G${ESC}[32m✔${ESC}[39m Preparing lint-staged...`,
  `${ESC}[38;5;208mwarning${ESC}[0m src/a.ts:12:3 no-unused-vars`,
  `${ESC}[38;2;255;0;0mtruecolor${ESC}[0m\r\nnext line\rprogress`,
  `${ESC}]0;husky${'\u0007'}husky - pre-commit hook exited with code 1`,
  `${ESC}(Bplain charset${ESC}[m`,
  `${ESC}[?25l${ESC}[?25hcursor toggles`,
  `${ESC}[3A${ESC}[10Cmoved\ttabbed`,
  '\u009b31mcsi8\u009b0m tail',
  'no escapes at all, just text'
]

describe('source-control failure ANSI stripping', () => {
  it.each(HOOK_OUTPUT_CORPUS.map((raw, index) => [index, raw] as const))(
    'strips corpus entry %i exactly as the legacy ansi-regex pipeline did',
    (_index, raw) => {
      expect(sanitizePushFailureDetails(raw)).toBe(legacyNormalize(raw))
      // Commit normalisation is private; "no expanded details" means it equals the oracle.
      expect(hasExpandedCommitFailureDetails(raw, legacyNormalize(raw))).toBe(false)
    }
  )

  it('removes an OSC 8 hyperlink whole instead of leaking its URL tail', () => {
    const raw = `${ESC}]8;;https://example.com/rule${ST}no-unused-vars${ESC}]8;;${ST}`
    expect(sanitizePushFailureDetails(raw)).toBe('no-unused-vars')
  })

  it('stays linear on a CSI introducer followed by a long parameter run (commit)', () => {
    const raw = `${ESC}[${';'.repeat(32 * 1024)}`
    const startedAt = performance.now()
    summarizeCommitFailure(raw)
    expect(performance.now() - startedAt).toBeLessThan(200)
  })

  it('stays linear on a CSI introducer followed by a long parameter run (push)', () => {
    const raw = `${ESC}[${';'.repeat(32 * 1024)}`
    const startedAt = performance.now()
    summarizePushFailure(raw)
    expect(performance.now() - startedAt).toBeLessThan(200)
  })
})
