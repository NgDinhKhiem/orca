/* eslint-disable no-control-regex -- these patterns exist to match terminal control bytes. */

/** CSI sequences (colors, cursor moves, `\u001b[0K` erase-to-EOL). */
export const CSI_SEQUENCE_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g
/** Remaining two/three-byte escape sequences (charset selection, RIS, ...). */
export const ESCAPE_SEQUENCE_PATTERN = /\u001b[ -/]*[0-~]/g
/** C0/C1 control bytes except tab, line feed and carriage return. */
export const TERMINAL_CONTROL_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

const ESC = 0x1b
const BEL = 0x07
const BACKSLASH = 0x5c
const C1_STRING_TERMINATOR = 0x9c

/** OSC title/progress frames, 7-bit (ESC ]) and 8-bit (U+009D) introducers. */
function oscIntroducerLength(value: string, index: number): number {
  const code = value.charCodeAt(index)
  if (code === 0x9d) {
    return 1
  }
  return code === ESC && value.charCodeAt(index + 1) === 0x5d ? 2 : 0
}

/** OSC ends at BEL, ESC \ or the C1 string terminator. */
function oscTerminatorLength(value: string, index: number): number {
  const code = value.charCodeAt(index)
  if (code === BEL || code === C1_STRING_TERMINATOR) {
    return 1
  }
  return code === ESC && value.charCodeAt(index + 1) === BACKSLASH ? 2 : 0
}

/** DCS/APC/PM/SOS string sequences: ESC P/_/^/X or their C1 forms. */
function stringIntroducerLength(value: string, index: number): number {
  const code = value.charCodeAt(index)
  if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
    return 1
  }
  if (code !== ESC) {
    return 0
  }
  const next = value.charCodeAt(index + 1)
  return next === 0x50 || next === 0x5f || next === 0x5e || next === 0x58 ? 2 : 0
}

/** DCS-family strings end only at ST (ESC \ or U+009C), never BEL. */
function stringTerminatorLength(value: string, index: number): number {
  const code = value.charCodeAt(index)
  if (code === C1_STRING_TERMINATOR) {
    return 1
  }
  return code === ESC && value.charCodeAt(index + 1) === BACKSLASH ? 2 : 0
}

/**
 * Remove every introducer..terminator span, shortest match first, in one pass.
 * Why: the equivalent lazy regex rescans to end of input from every unterminated
 * introducer, which is quadratic on hostile CI logs. Once one introducer finds no
 * terminator no later one can either, so the remainder is kept verbatim exactly
 * as the regex left it (the generic escape pass then eats a 7-bit introducer).
 */
function removeTerminatedSequences(
  value: string,
  introducerLength: (value: string, index: number) => number,
  terminatorLength: (value: string, index: number) => number
): string {
  let output = ''
  let copiedThrough = 0
  let index = 0
  while (index < value.length) {
    const introducer = introducerLength(value, index)
    if (introducer === 0) {
      index += 1
      continue
    }
    let bodyIndex = index + introducer
    let terminator = 0
    while (bodyIndex < value.length) {
      terminator = terminatorLength(value, bodyIndex)
      if (terminator > 0) {
        break
      }
      bodyIndex += 1
    }
    if (terminator === 0) {
      break
    }
    output += value.slice(copiedThrough, index)
    index = bodyIndex + terminator
    copiedThrough = index
  }
  return copiedThrough === 0 ? value : output + value.slice(copiedThrough)
}

/**
 * Remove ANSI escape sequences while preserving text, tabs and line breaks.
 * Ordering matters: OSC/string sequences must be consumed before the generic
 * escape pattern, which would otherwise eat only their introducer.
 */
export function stripAnsiEscapeSequences(value: string): string {
  const withoutOsc = removeTerminatedSequences(value, oscIntroducerLength, oscTerminatorLength)
  return removeTerminatedSequences(withoutOsc, stringIntroducerLength, stringTerminatorLength)
    .replace(CSI_SEQUENCE_PATTERN, '')
    .replace(ESCAPE_SEQUENCE_PATTERN, '')
}
