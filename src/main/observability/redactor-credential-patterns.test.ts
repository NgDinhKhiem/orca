import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BENIGN_TEXTS,
  CREDENTIAL_LEAK_CASES
} from '../../shared/credential-leak-fixtures.test-fixtures'
import { redactAttributes, redactSpan, redactString, type RedactableSpan } from './redactor'

describe('redactString credential coverage', () => {
  it.each(CREDENTIAL_LEAK_CASES)('redacts $label', ({ text, secret }) => {
    const redacted = redactString(text)
    expect(redacted).not.toContain(secret)
    expect(redacted).toMatch(/\[redacted/)
    expect(redactString(redacted)).toBe(redacted)
  })

  it.each(BENIGN_TEXTS)('leaves ordinary text unchanged: %s', (text) => {
    expect(redactString(text)).toBe(text)
  })
})

describe('redactString home directory paths', () => {
  const home = homedir()

  it('replaces the home directory with ~ in free text such as git stderr', () => {
    const stderr = `fatal: not a git repository: ${join(home, 'clients', 'acme', 'repo')}`
    const redacted = redactString(stderr)
    expect(redacted).not.toContain(home)
    expect(redacted).toContain('~')
    expect(redactString(redacted)).toBe(redacted)
  })

  it('also catches the forward-slash spelling of a Windows home directory', () => {
    const forwardSlashed = `${home.replaceAll('\\', '/')}/project/file.ts`
    expect(redactString(`at main (${forwardSlashed}:1:2)`)).not.toContain(
      home.replaceAll('\\', '/')
    )
  })

  it('does not rewrite a sibling directory that only shares the home prefix', () => {
    const sibling = `${home}-backup${home.includes('\\') ? '\\' : '/'}notes`
    expect(redactString(sibling)).toBe(sibling)
  })
})

describe('span path attributes', () => {
  it('strips the home directory from cwd, worktree.path and the failed-git cause', () => {
    const cwd = join(homedir(), 'work', 'repo')
    const span: RedactableSpan = {
      name: 'git.exec',
      traceId: 't',
      spanId: 's',
      kind: 'internal',
      startTimeUnixNano: '0',
      endTimeUnixNano: '1',
      durationMs: 1,
      attributes: { cwd, 'git.subcommand': 'fetch' },
      events: [{ name: 'phase', timeUnixNano: '0', attributes: { 'worktree.path': cwd } }],
      exit: { _tag: 'Failure', cause: `Error: fatal: unable to access '${cwd}'` }
    }

    const redacted = redactSpan(span)

    expect(redacted.attributes).toEqual({
      cwd: join('~', 'work', 'repo'),
      'git.subcommand': 'fetch'
    })
    expect(redacted.events[0]?.attributes).toEqual({ 'worktree.path': join('~', 'work', 'repo') })
    expect(redacted.exit.cause).toBe(
      `Error: fatal: unable to access '${join('~', 'work', 'repo')}'`
    )
  })

  it('keeps paths outside the home directory as diagnostic data', () => {
    expect(redactAttributes({ cwd: '/srv/repos/orca' })).toEqual({ cwd: '/srv/repos/orca' })
  })
})
