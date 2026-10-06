import { afterEach, describe, expect, it, vi } from 'vitest'
import { quoteCliCommandArgument } from './shell-command-quote'

describe('quoteCliCommandArgument', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('leaves simple selectors unquoted', () => {
    expect(quoteCliCommandArgument('com.apple.finder')).toBe('com.apple.finder')
  })

  it('quotes values with spaces for the current platform shell', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    expect(quoteCliCommandArgument('Text Editor')).toBe("'Text Editor'")

    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    expect(quoteCliCommandArgument('Text Editor')).toBe('"Text Editor"')
  })
})

describe('quoteCliCommandArgument on Windows', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Why: `\"` flips cmd.exe's quote parity, so a pasted `&` would run as a command.
  it.each([
    ['a quote followed by a cmd operator', 'say "hi" & calc', '"say ""hi"" & calc"'],
    ['an environment-variable reference', '100%USERPROFILE%', '"100"^%"USERPROFILE"^%""'],
    ['a trailing backslash', 'C:\\dir with space\\', '"C:\\dir with space\\\\"'],
    ['a pipe and redirect', 'a|b>c', '"a|b>c"']
  ])('quotes %s for cmd.exe', (_label, value, expected) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    expect(quoteCliCommandArgument(value)).toBe(expected)
  })
})
