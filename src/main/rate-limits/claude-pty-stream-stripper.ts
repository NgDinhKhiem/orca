import { ownRetainedString } from '../../shared/own-retained-string'
import { stripTerminalControlSequences } from './claude-pty-usage-parser'

const ESC = '\u001b'
const BEL = '\u0007'
// A held-back sequence longer than this is released as text, as an unterminated one always was.
const MAX_PENDING_SEQUENCE_CHARS = 4096

/** Start of the trailing OSC/CSI/ESC that the next chunk could still complete, else -1. */
function findIncompleteTrailingSequenceStart(text: string): number {
  const lastOsc = text.lastIndexOf(`${ESC}]`)
  if (lastOsc !== -1) {
    const afterIntroducer = lastOsc + 2
    const bel = text.indexOf(BEL, afterIntroducer)
    const st = text.indexOf(`${ESC}\\`, afterIntroducer)
    if (bel === -1 && st === -1) {
      return lastOsc
    }
  }
  const lastEsc = text.lastIndexOf(ESC)
  if (lastEsc === -1 || lastEsc < lastOsc) {
    return -1
  }
  if (lastEsc === text.length - 1) {
    return lastEsc
  }
  if (text[lastEsc + 1] !== '[') {
    return -1
  }
  // Mirrors CSI_SEQUENCE_RE: [0-9;?]* then [ -/]* then one final byte in [@-~].
  let index = lastEsc + 2
  while (index < text.length && isCsiParameterChar(text.charCodeAt(index))) {
    index += 1
  }
  while (index < text.length && isCsiIntermediateChar(text.charCodeAt(index))) {
    index += 1
  }
  return index === text.length ? lastEsc : -1
}

function isCsiParameterChar(code: number): boolean {
  // 0-9, ';' and '?'
  return (code >= 0x30 && code <= 0x39) || code === 0x3b || code === 0x3f
}

function isCsiIntermediateChar(code: number): boolean {
  return code >= 0x20 && code <= 0x2f
}

/**
 * Strip PTY output chunk by chunk, holding back a sequence split across chunks.
 * Why: re-stripping the whole 100 KB buffer on every chunk made the usage probe
 * quadratic in its output.
 */
export function createClaudePtyStreamStripper(): { push: (chunk: string) => string } {
  let pending = ''
  return {
    push(chunk: string): string {
      const text = pending + chunk
      pending = ''
      const holdFrom = findIncompleteTrailingSequenceStart(text)
      if (holdFrom === -1 || text.length - holdFrom > MAX_PENDING_SEQUENCE_CHARS) {
        return stripTerminalControlSequences(text)
      }
      pending = ownRetainedString(text.slice(holdFrom))
      return stripTerminalControlSequences(text.slice(0, holdFrom))
    }
  }
}

// Longer than any stop label or Claude 2.1 panel header, including padded TUI whitespace.
const STOP_DETECTION_OVERLAP_CHARS = 4096

/**
 * Stripped output not yet searched for stop labels. Each search consumes it down to an
 * overlap tail, so a label or panel header straddling two chunks is still found.
 */
export function createClaudePtyStopDetectionBuffer(maxChars: number): {
  push: (chunk: string) => void
  takeUnsearched: () => string
} {
  const stripper = createClaudePtyStreamStripper()
  let unsearched = ''
  return {
    push(chunk) {
      unsearched += stripper.push(chunk)
      if (unsearched.length > maxChars) {
        unsearched = unsearched.slice(-maxChars)
      }
    },
    takeUnsearched() {
      const text = unsearched
      unsearched = ownRetainedString(text.slice(-STOP_DETECTION_OVERLAP_CHARS))
      return text
    }
  }
}
