/* eslint-disable no-control-regex -- the legacy oracles terminate on control bytes. */
import { describe, expect, it } from 'vitest'
import {
  findPathExtensionMatchEnds,
  findSlashExtensionPathMatches
} from './terminal-output-path-extension-scan'

const LEGACY_SLASH_EXTENSION_RE = /\/[^\r\n\x1b"'<>]*\.[A-Za-z0-9_+-]+(?:[#:\s][^\r\n\x1b"'<>]*)?/g
const LEGACY_EXTENSION_END_RE =
  /.+?\.[A-Za-z0-9_+-]+(?:#L\d+(?:C\d+)?|(?::\d+)?(?::\d+)?)?(?=\s+|$)/gi

function legacySlashMatches(line: string): { index: number; text: string }[] {
  return [...line.matchAll(LEGACY_SLASH_EXTENSION_RE)].map((match) => ({
    index: match.index,
    text: match[0]
  }))
}

function legacyExtensionEnds(value: string): number[] {
  return [...value.matchAll(LEGACY_EXTENSION_END_RE)].map((match) => match.index + match[0].length)
}

const CORPUS: readonly string[] = [
  '',
  'no paths here',
  '/Users/me/project/src/index.ts',
  'Wrote /tmp/orca/report.md and /tmp/orca/out.json',
  'error at /home/u/app/src/main.rs:42:7 in fn',
  'see /repo/docs/guide.md#L12C3 for details',
  'see /repo/docs/guide.md#l12c3 for details',
  'open file:///C:/Users/me/a.txt now',
  '"/quoted/path/file.tsx" <tag> \'single/q.py\'',
  '  /var/log/app.log: permission denied',
  '\u001b[32m/usr/local/bin/node.exe\u001b[0m',
  '/a.b/c',
  '/a.b /c.d',
  '/a/b/c',
  '/a.b:12: warning',
  '/a.b:12:x',
  '/a.b#Lx',
  '/a.b#L12Cx tail',
  '/a.tar.gz, done.',
  'C:\\Users\\me\\proj\\file.cs(12,3): error',
  'diff --git a/src/x.ts b/src/x.ts',
  '/path/with spaces/and.dots in/the.name end',
  '/π/ünïcödé/файл.txt',
  'line\u2028/after/terminator.md',
  '/x.y\u00a0next',
  '..//.././/.x',
  '/.hidden',
  '/a. b'
]

function seededLine(seed: number, length: number): string {
  const alphabet = [
    '/',
    '.',
    'a',
    'Z',
    '9',
    '_',
    '-',
    ' ',
    '\t',
    '#',
    'L',
    'C',
    ':',
    '1',
    '"',
    '<',
    '\u001b',
    '\u2028',
    'x',
    '\\'
  ]
  let state = seed
  let out = ''
  for (let index = 0; index < length; index += 1) {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296
    out += alphabet[state % alphabet.length]
  }
  return out
}

describe('findSlashExtensionPathMatches', () => {
  it.each(CORPUS.map((line, index) => [index, line] as const))(
    'matches the legacy regex on corpus entry %i',
    (_index, line) => {
      expect(findSlashExtensionPathMatches(line)).toEqual(legacySlashMatches(line))
    }
  )

  it('matches the legacy regex on random lines', () => {
    for (let seed = 1; seed <= 2_000; seed += 1) {
      const line = seededLine(seed, 48)
      expect(findSlashExtensionPathMatches(line)).toEqual(legacySlashMatches(line))
    }
  })

  it('stays linear on a long run of slashes with no extension', () => {
    const line = '/'.repeat(4096)
    const startedAt = performance.now()
    for (let index = 0; index < 16; index += 1) {
      findSlashExtensionPathMatches(line)
    }
    expect(performance.now() - startedAt).toBeLessThan(50)
  })
})

describe('findPathExtensionMatchEnds', () => {
  it.each(CORPUS.map((line, index) => [index, line] as const))(
    'matches the legacy regex on corpus entry %i',
    (_index, line) => {
      expect(findPathExtensionMatchEnds(line)).toEqual(legacyExtensionEnds(line))
    }
  )

  it('matches the legacy regex on random candidates', () => {
    for (let seed = 1; seed <= 2_000; seed += 1) {
      const value = seededLine(seed * 7, 48)
      expect(findPathExtensionMatchEnds(value)).toEqual(legacyExtensionEnds(value))
    }
  })
})
