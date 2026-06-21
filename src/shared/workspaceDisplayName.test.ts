import { describe, expect, it } from 'vitest'
import {
  formatWorkspaceDisplayName,
  gitRemoteProjectName,
  resolveWorkspaceDisplayName
} from './workspaceDisplayName'

describe('workspaceDisplayName', () => {
  it('maps legacy AGBench labels to TaskWraith', () => {
    expect(formatWorkspaceDisplayName('AGBench')).toBe('TaskWraith')
    expect(formatWorkspaceDisplayName('agbench')).toBe('TaskWraith')
  })

  it('extracts project names from common git remote forms', () => {
    expect(gitRemoteProjectName('https://github.com/boggspa/TaskWraith.git')).toBe('TaskWraith')
    expect(gitRemoteProjectName('git@github.com:boggspa/TaskWraith.git')).toBe('TaskWraith')
    expect(gitRemoteProjectName('ssh://git@github.com/boggspa/TaskWraith.git')).toBe('TaskWraith')
  })

  it('uses the git remote project for default folder-derived workspace labels', () => {
    expect(
      resolveWorkspaceDisplayName({
        displayName: 'AGBench',
        path: '/Users/me/Documents/AGBench',
        remoteUrl: 'https://github.com/boggspa/TaskWraith.git'
      })
    ).toBe('TaskWraith')

    expect(
      resolveWorkspaceDisplayName({
        displayName: 'checkout-1',
        path: '/Users/me/Documents/checkout-1',
        remoteUrl: 'git@github.com:acme/api-service.git'
      })
    ).toBe('api-service')
  })

  it('preserves custom workspace labels over git-derived names', () => {
    expect(
      resolveWorkspaceDisplayName({
        displayName: 'Client demo',
        path: '/Users/me/Documents/checkout-1',
        remoteUrl: 'git@github.com:acme/api-service.git'
      })
    ).toBe('Client demo')
  })
})
