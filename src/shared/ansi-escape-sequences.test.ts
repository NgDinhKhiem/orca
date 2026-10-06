/* eslint-disable no-control-regex -- the reference patterns match terminal control bytes. */
import { describe, expect, it } from 'vitest'
import { stripAnsiEscapeSequences } from './ansi-escape-sequences'

// The pre-scanner patterns, kept here as the equivalence oracle.
const LEGACY_OSC = /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c)/g
const LEGACY_STRING = /(?:\u001b[P_^X]|\u0090|\u0098|\u009e|\u009f)[\s\S]*?(?:\u001b\\|\u009c)/g
const LEGACY_CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g
const LEGACY_ESCAPE = /\u001b[ -/]*[0-~]/g

function legacyStrip(value: string): string {
  return value
    .replace(LEGACY_OSC, '')
    .replace(LEGACY_STRING, '')
    .replace(LEGACY_CSI, '')
    .replace(LEGACY_ESCAPE, '')
}

const ESC = '\u001b'
const BEL = '\u0007'
const ST = `${ESC}\\`

const CORPUS: readonly string[] = [
  '',
  'plain text\twith tab\r\nand lines\n',
  `${ESC}]0;window title${BEL}after`,
  `${ESC}]8;;https://example.com${ST}link${ESC}]8;;${ST}`,
  `\u009d0;eight-bit title\u009cvisible`,
  `\u009d0;eight-bit with bel${BEL}visible`,
  `before${ESC}]9;4;1;50${BEL}${ESC}[32mgreen${ESC}[0m after`,
  `${ESC}Pq#0;2;0;0;0${ST}sixel gone`,
  `${ESC}_Gf=100;payload${ST}apc gone`,
  `${ESC}^privacy${ST}pm gone`,
  `${ESC}Xsos${ST}sos gone`,
  `\u0090dcs8\u009cdone \u0098sos8\u009c \u009eprivacy8\u009c \u009fapc8\u009c end`,
  // OSC carrying a DCS introducer: the OSC pass must consume it first.
  `${ESC}]0;${ESC}Pinner${BEL}tail${ST}`,
  // DCS terminated only by BEL is not a string terminator for DCS.
  `${ESC}Pbody${BEL}still dcs${ST}after`,
  // Unterminated sequences fall through to the generic escape pass.
  `keep ${ESC}]0;unterminated title`,
  `keep \u009d unterminated eight-bit`,
  `keep ${ESC}Punterminated dcs`,
  `${ESC}]0;ok${BEL}mid ${ESC}]0;dangling`,
  `${ESC}]${ESC}]${ESC}]${BEL}x`,
  `${ESC}]${ESC}\\${ESC}]${ESC}`,
  `${ESC}(B${ESC}c${ESC}7text${ESC}8`,
  `${ESC}[1;31;42mmulti${ESC}[0K\u009b2Jcsi8`,
  `emoji 👍 ${ESC}]0;ti👍tle${BEL} done`,
  `${ESC}]0;title${ESC}`
]

function randomEscapeSoup(seed: number, length: number): string {
  const alphabet = [
    ESC,
    ']',
    '[',
    '\\',
    'P',
    '_',
    '^',
    'X',
    BEL,
    '\u009c',
    '\u009d',
    '\u0090',
    '\u0098',
    '\u009b',
    '\u009e',
    '\u009f',
    'a',
    '0',
    ';',
    'm',
    '\n'
  ]
  let state = seed
  let out = ''
  for (let i = 0; i < length; i += 1) {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296
    out += alphabet[state % alphabet.length]
  }
  return out
}

describe('stripAnsiEscapeSequences', () => {
  it.each(CORPUS.map((value, index) => [index, value] as const))(
    'matches the legacy regex pipeline on corpus entry %i',
    (_index, value) => {
      expect(stripAnsiEscapeSequences(value)).toBe(legacyStrip(value))
    }
  )

  it('matches the legacy regex pipeline on random escape soup', () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const value = randomEscapeSoup(seed, 64)
      expect(stripAnsiEscapeSequences(value)).toBe(legacyStrip(value))
    }
  })

  it('strips terminated 7-bit and 8-bit OSC/DCS sequences', () => {
    expect(stripAnsiEscapeSequences(`a${ESC}]0;t${BEL}b\u009d0;t\u009cc${ESC}Pq${ST}d`)).toBe(
      'abcd'
    )
  })

  it('stays linear on repeated unterminated OSC introducers', () => {
    const value = `${ESC}]`.repeat(64 * 1024)
    const startedAt = performance.now()
    stripAnsiEscapeSequences(value)
    expect(performance.now() - startedAt).toBeLessThan(200)
  })

  it('stays linear on repeated unterminated 8-bit OSC and DCS introducers', () => {
    const value = '\u009d\u0090'.repeat(64 * 1024)
    const startedAt = performance.now()
    stripAnsiEscapeSequences(value)
    expect(performance.now() - startedAt).toBeLessThan(200)
  })

  it('stays linear on repeated unterminated DCS introducers', () => {
    const value = `${ESC}P`.repeat(64 * 1024)
    const startedAt = performance.now()
    stripAnsiEscapeSequences(value)
    expect(performance.now() - startedAt).toBeLessThan(200)
  })
})
