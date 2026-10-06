import { describe, expect, it } from 'vitest'
import { secretsMatch } from './constant-time-secret-compare'

describe('secretsMatch', () => {
  it.each([
    ['identical secrets', 'a1b2c3d4', 'a1b2c3d4', true],
    ['same length, different content', 'a1b2c3d4', 'a1b2c3d5', false],
    ['shorter presented value', 'a1b2c3d', 'a1b2c3d4', false],
    ['longer presented value', 'a1b2c3d4e', 'a1b2c3d4', false],
    ['empty presented value', '', 'a1b2c3d4', false],
    ['non-ASCII equal', 'clé-🔑', 'clé-🔑', true],
    ['non-ASCII prefix collision', 'clé', 'clé', false]
  ])('%s', (_label, presented, expected, match) => {
    expect(secretsMatch(presented, expected)).toBe(match)
  })

  it.each([undefined, null, 42, ['a1b2c3d4'], { toString: () => 'a1b2c3d4' }])(
    'rejects a non-string presented value: %o',
    (presented) => {
      expect(secretsMatch(presented, 'a1b2c3d4')).toBe(false)
    }
  )

  it('matches like === for two empty strings so call sites keep their semantics', () => {
    expect(secretsMatch('', '')).toBe(true)
  })
})
