import { describe, expect, it } from 'vitest'

import type { GitPrSummary } from '../../../main/services/GitService'
import {
  githubWatchDisabledReason,
  isGithubCliMissingReason,
  watchedPrDescriptorFromGitHubUrl,
  watchedPrDescriptorsMatch
} from './watchedPrUi'

const pr = (overrides: Partial<GitPrSummary> = {}): GitPrSummary =>
  ({
    number: 42,
    url: 'https://github.com/boggspa/TaskWraith/pull/42',
    state: 'OPEN',
    ...overrides
  }) as GitPrSummary

describe('watchedPrUi', () => {
  it('builds the persisted descriptor only from a matching GitHub pull-request URL', () => {
    expect(
      watchedPrDescriptorFromGitHubUrl({
        chatId: ' chat-1 ',
        workspacePath: ' /repo ',
        pr: pr()
      })
    ).toEqual({
      chatId: 'chat-1',
      workspacePath: '/repo',
      owner: 'boggspa',
      repo: 'TaskWraith',
      prNumber: 42
    })
  })

  it('rejects non-GitHub, malformed, and mismatched pull-request URLs', () => {
    const base = { chatId: 'chat-1', workspacePath: '/repo' }
    expect(
      watchedPrDescriptorFromGitHubUrl({
        ...base,
        pr: pr({ url: 'https://example.com/boggspa/TaskWraith/pull/42' })
      })
    ).toBeNull()
    expect(
      watchedPrDescriptorFromGitHubUrl({
        ...base,
        pr: pr({ url: 'https://github.com/boggspa/TaskWraith/issues/42' })
      })
    ).toBeNull()
    expect(
      watchedPrDescriptorFromGitHubUrl({
        ...base,
        pr: pr({ url: 'https://github.com/boggspa/TaskWraith/pull/99' })
      })
    ).toBeNull()
  })

  it('maps GitHub CLI failures to calm actionable watch reasons', () => {
    expect(githubWatchDisabledReason('GitHub CLI is not authenticated')).toContain('gh auth login')
    expect(githubWatchDisabledReason('gh is not installed or not on PATH')).toContain(
      "isn't installed"
    )
    expect(githubWatchDisabledReason('No pull request found for the current branch')).toBe(
      'No open pull request to watch.'
    )
    expect(githubWatchDisabledReason(new Error('opaque failure'))).toContain(
      'check GitHub CLI'
    )
  })

  it('matches every authorization-bearing descriptor field', () => {
    const descriptor = {
      chatId: 'chat-1',
      workspacePath: '/repo',
      owner: 'boggspa',
      repo: 'TaskWraith',
      prNumber: 42
    }
    expect(watchedPrDescriptorsMatch(descriptor, { ...descriptor })).toBe(true)
    expect(watchedPrDescriptorsMatch(descriptor, { ...descriptor, prNumber: 43 })).toBe(false)
    expect(watchedPrDescriptorsMatch(descriptor, null)).toBe(false)
  })

  it('identifies only the missing-binary reason as an install candidate', () => {
    // The install affordance must never appear for an authenticated-but-absent
    // PR, or for a gh that is present and merely unauthenticated: those need
    // completely different fixes, and offering "Install" would be wrong advice.
    expect(isGithubCliMissingReason(githubWatchDisabledReason('gh: command not found'))).toBe(true)
    expect(
      isGithubCliMissingReason(githubWatchDisabledReason('gh is not installed or not on PATH.'))
    ).toBe(true)
    expect(isGithubCliMissingReason(githubWatchDisabledReason('gh: not authenticated'))).toBe(false)
    expect(isGithubCliMissingReason(githubWatchDisabledReason('no open pull request'))).toBe(false)
    expect(isGithubCliMissingReason(githubWatchDisabledReason('detached HEAD'))).toBe(false)
    expect(isGithubCliMissingReason(null)).toBe(false)
    expect(isGithubCliMissingReason(undefined)).toBe(false)
    expect(isGithubCliMissingReason('')).toBe(false)
  })
})
