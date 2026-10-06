// Linear replacements for two path regexes on the PTY hot path. Each mirrors its
// regex exactly (see the equivalence tests); the regexes backtracked quadratically
// because every start position rescanned to the end of the line.

const DOT = 0x2e
const SLASH = '/'

/** `[^\r\n\x1b"'<>]` */
function isPathTextChar(code: number): boolean {
  return (
    code !== 0x0d &&
    code !== 0x0a &&
    code !== 0x1b &&
    code !== 0x22 &&
    code !== 0x27 &&
    code !== 0x3c &&
    code !== 0x3e
  )
}

/** `[A-Za-z0-9_+-]` */
function isExtensionChar(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x5f ||
    code === 0x2b ||
    code === 0x2d
  )
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39
}

/** Code units that the regex `.` refuses to match. */
function isLineTerminator(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029
}

function isRegexWhitespace(value: string, index: number): boolean {
  return index < value.length && /\s/.test(value[index])
}

function skipWhile(value: string, from: number, accept: (code: number) => boolean): number {
  let index = from
  while (index < value.length && accept(value.charCodeAt(index))) {
    index += 1
  }
  return index
}

export type SlashExtensionPathMatch = { index: number; text: string }

/**
 * Same matches as `line.matchAll(/\/[^\r\n\x1b"'<>]*\.[A-Za-z0-9_+-]+(?:[#:\s][^\r\n\x1b"'<>]*)?/g)`.
 * The greedy body always reaches the last `.ext` of its run of path text, so a run
 * yields at most one match and is scanned at most twice.
 */
export function findSlashExtensionPathMatches(line: string): SlashExtensionPathMatch[] {
  const matches: SlashExtensionPathMatch[] = []
  let searchFrom = 0
  while (searchFrom < line.length) {
    const slash = line.indexOf(SLASH, searchFrom)
    if (slash === -1) {
      break
    }
    const runEnd = skipWhile(line, slash + 1, isPathTextChar)
    let dot = -1
    for (let index = runEnd - 2; index > slash; index -= 1) {
      if (line.charCodeAt(index) === DOT && isExtensionChar(line.charCodeAt(index + 1))) {
        dot = index
        break
      }
    }
    if (dot === -1) {
      // No later slash in this run can reach a dot either.
      searchFrom = runEnd
      continue
    }
    let end = skipWhile(line, dot + 1, isExtensionChar)
    if (end < runEnd && (line[end] === '#' || line[end] === ':' || isRegexWhitespace(line, end))) {
      end = runEnd
    }
    matches.push({ index: slash, text: line.slice(slash, end) })
    searchFrom = end
  }
  return matches
}

/** `(?=\s+|$)` */
function isExtensionMatchBoundary(value: string, index: number): boolean {
  return index === value.length || isRegexWhitespace(value, index)
}

/** End of `\.[A-Za-z0-9_+-]+(?:#L\d+(?:C\d+)?|(?::\d+)?(?::\d+)?)?(?=\s+|$)` (flag i) at `dot`, else -1. */
function extensionMatchEnd(value: string, dot: number): number {
  const extensionEnd = skipWhile(value, dot + 1, isExtensionChar)
  if (extensionEnd === dot + 1) {
    return -1
  }
  const marker = value[extensionEnd]
  if (
    marker === '#' &&
    (value[extensionEnd + 1] === 'L' || value[extensionEnd + 1] === 'l') &&
    isDigit(value.charCodeAt(extensionEnd + 2))
  ) {
    const lineEnd = skipWhile(value, extensionEnd + 2, isDigit)
    const column = value[lineEnd]
    if ((column === 'C' || column === 'c') && isDigit(value.charCodeAt(lineEnd + 1))) {
      const columnEnd = skipWhile(value, lineEnd + 1, isDigit)
      return isExtensionMatchBoundary(value, columnEnd) ? columnEnd : -1
    }
    return isExtensionMatchBoundary(value, lineEnd) ? lineEnd : -1
  }
  if (marker === ':' && isDigit(value.charCodeAt(extensionEnd + 1))) {
    const lineEnd = skipWhile(value, extensionEnd + 1, isDigit)
    if (value[lineEnd] === ':' && isDigit(value.charCodeAt(lineEnd + 1))) {
      const columnEnd = skipWhile(value, lineEnd + 1, isDigit)
      return isExtensionMatchBoundary(value, columnEnd) ? columnEnd : -1
    }
    return isExtensionMatchBoundary(value, lineEnd) ? lineEnd : -1
  }
  return isExtensionMatchBoundary(value, extensionEnd) ? extensionEnd : -1
}

/**
 * End offsets of `value.matchAll(/.+?\.[A-Za-z0-9_+-]+(?:#L\d+(?:C\d+)?|(?::\d+)?(?::\d+)?)?(?=\s+|$)/gi)`.
 * Whether a dot ends a match does not depend on where the match started, so each
 * dot is tested once instead of once per start position.
 */
export function findPathExtensionMatchEnds(value: string): number[] {
  const ends: number[] = []
  let dot = 1
  while (dot < value.length) {
    if (isLineTerminator(value.charCodeAt(dot - 1))) {
      // `.+?` cannot cross it, so no match may start at or before it.
      dot += 1
      continue
    }
    const end = value.charCodeAt(dot) === DOT ? extensionMatchEnd(value, dot) : -1
    if (end === -1) {
      dot += 1
      continue
    }
    ends.push(end)
    // The next match starts at `end` and needs one char before its dot.
    dot = end + 1
  }
  return ends
}
