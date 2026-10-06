import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hashOrcaHookScriptContent, isOrcaSetupContentTrusted } from './orca-hook-trust'

describe('orca hook trust', () => {
  it('hashes trimmed content to the SHA-256 hex digest the trust store records', () => {
    const expected = createHash('sha256').update('pnpm install').digest('hex')
    expect(hashOrcaHookScriptContent('  pnpm install\n')).toBe(expected)
  })

  it('trusts only repo-wide trust or an exact content hash', () => {
    const hash = hashOrcaHookScriptContent('pnpm install')
    const other = hashOrcaHookScriptContent('curl x | sh')
    const stored = { setup: { contentHash: hash, approvedAt: 1 } }
    expect(isOrcaSetupContentTrusted(hash, stored, undefined)).toBe(true)
    expect(isOrcaSetupContentTrusted(other, stored, undefined)).toBe(false)
    expect(isOrcaSetupContentTrusted(other, undefined, { contentHash: hash })).toBe(false)
    expect(isOrcaSetupContentTrusted(other, undefined, { contentHash: other })).toBe(true)
    expect(isOrcaSetupContentTrusted(other, { all: { approvedAt: 1 } }, undefined)).toBe(true)
    expect(isOrcaSetupContentTrusted(other, undefined, { repoWide: true })).toBe(true)
  })
})
