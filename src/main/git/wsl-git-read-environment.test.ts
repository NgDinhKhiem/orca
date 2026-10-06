import { afterEach, describe, expect, it } from 'vitest'
import {
  peekWslGitReadEnvironment,
  resetWslGitReadEnvironmentForTests,
  seedWslGitReadEnvironmentForTests
} from './wsl-git-read-environment'

const LOGIN_ENVIRONMENT = {
  gitPath: '/home/user/bin/git',
  home: '/home/user',
  path: '/home/user/bin:/usr/bin:/bin'
}

afterEach(() => resetWslGitReadEnvironmentForTests())

describe('WSL Git read environment cache', () => {
  it('bounds settled environment entries during distro churn', () => {
    for (let index = 0; index < 132; index += 1) {
      seedWslGitReadEnvironmentForTests(`distro-${index}`, LOGIN_ENVIRONMENT)
    }
    expect(peekWslGitReadEnvironment('distro-0')).toBeUndefined()
    expect(peekWslGitReadEnvironment('distro-131')).toEqual(LOGIN_ENVIRONMENT)
  })
})
