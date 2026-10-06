import { describe, expect, it } from 'vitest'
import { buildAiVaultResumeCommand } from './ai-vault-resume-command'

function legacyCommand(cwd: string, sessionId: string): string {
  return buildAiVaultResumeCommand({ agent: 'claude', sessionId, cwd, platform: 'win32' })
}

describe('Windows resume-command quoting', () => {
  it('keeps the historical doubled-quote wrapper for plain values', () => {
    expect(legacyCommand("C:\\Users\\alice\\it's (x)", 'abc-123')).toBe(
      'cmd /d /s /c "cd /d ""C:\\Users\\alice\\it\'s (x)"" && claude --resume ""abc-123"""'
    )
  })

  // Why: inside the doubled wrapper the nested cmd reads `""` as an empty pair, so these
  // characters ran as commands (cmd) or expanded (`$(...)` in PowerShell) before the fix.
  it.each([
    ['ampersand in cwd', 'C:\\R&D\\app', 'abc', `cd /d "C:\\R&D\\app" && claude --resume "abc"`],
    [
      'ampersand in session id',
      'C:\\repo',
      'x&calc',
      `cd /d "C:\\repo" && claude --resume "x&calc"`
    ],
    ['caret in cwd', 'C:\\a^b', 'abc', `cd /d "C:\\a^b" && claude --resume "abc"`],
    [
      'percent in cwd',
      'C:\\100%USERNAME%',
      'abc',
      `cd /d "C:\\100"^%"USERNAME"^%"" && claude --resume "abc"`
    ],
    [
      'quote in session id',
      'C:\\repo',
      'x"&calc',
      `cd /d "C:\\repo" && claude --resume "x""&calc"`
    ],
    [
      'PowerShell subexpression in session id',
      'C:\\repo',
      '$(calc)',
      `cd /d "C:\\repo" && claude --resume "$(calc)"`
    ],
    [
      'single quote alongside a metacharacter',
      "C:\\it's&x",
      'abc',
      `cd /d "C:\\it''s&x" && claude --resume "abc"`
    ]
  ])('puts %s in a PowerShell literal with cmd-quoted values', (_label, cwd, id, inner) => {
    expect(legacyCommand(cwd, id)).toBe(`cmd /d /v:off /s /c '${inner}'`)
  })

  it('protects percent signs when typing straight into cmd', () => {
    expect(
      buildAiVaultResumeCommand({
        agent: 'claude',
        sessionId: '%PATH%',
        cwd: 'C:\\100%x',
        platform: 'win32',
        shell: 'cmd'
      })
    ).toBe('cd /d "C:\\100"^%"x" && claude --resume ""^%"PATH"^%""')
  })
})
