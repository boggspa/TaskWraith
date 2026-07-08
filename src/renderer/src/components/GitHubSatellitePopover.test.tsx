import { describe, expect, it } from 'vitest'
import { buildSatellitePopoverModel, repoNameFromRemote } from './GitHubSatellitePopover'
import type {
  GitCiStatusSummary,
  GitPrSummary,
  GitRepositorySnapshot
} from '../../../main/services/GitService'

const remote = {
  remoteUrl: 'https://github.com/acme/app.git',
  commit: 'abc123'
} as GitRepositorySnapshot

describe('repoNameFromRemote', () => {
  it('parses https, ssh, bare and trailing-slash remotes', () => {
    expect(repoNameFromRemote('https://github.com/acme/app.git')).toBe('acme/app')
    expect(repoNameFromRemote('git@github.com:acme/app.git')).toBe('acme/app')
    expect(repoNameFromRemote('https://github.com/acme/app')).toBe('acme/app')
    expect(repoNameFromRemote('https://github.com/acme/app/')).toBe('acme/app')
  })

  it('returns undefined when there is no remote', () => {
    expect(repoNameFromRemote(undefined)).toBeUndefined()
    expect(repoNameFromRemote('')).toBeUndefined()
  })
})

describe('buildSatellitePopoverModel', () => {
  it('builds the PR block from the summary + snapshot', () => {
    const pr = {
      number: 75,
      state: 'OPEN',
      url: 'https://gh/pr/75',
      headRefName: 'feat/x',
      baseRefName: 'main',
      mergeStateStatus: 'CLEAN'
    } as GitPrSummary
    const model = buildSatellitePopoverModel(pr, null, remote)
    expect(model.repoName).toBe('acme/app')
    expect(model.pr).toMatchObject({
      numberLabel: '#75',
      tone: 'ready', // CLEAN → ready
      head: 'feat/x',
      base: 'main',
      mergeState: 'CLEAN',
      url: 'https://gh/pr/75'
    })
  })

  it('summarises CI checks with counts and a failing tone', () => {
    const pr = {
      number: 75,
      state: 'OPEN',
      url: 'u',
      checks: [
        { name: 'build', status: 'completed', conclusion: 'success' },
        { name: 'test', status: 'completed', conclusion: 'failure' }
      ]
    } as GitPrSummary
    const model = buildSatellitePopoverModel(pr, null, remote)
    expect(model.ci).toBeTruthy()
    expect(model.ci?.tone).toBe('danger')
    expect(model.ci?.statusLabel).toBe('CI failing')
    expect(model.ci?.counts).toEqual({ pass: 1, fail: 1, pending: 0 })
    expect(model.ci?.checks).toHaveLength(2)
  })

  it('prefers the live ciStatus classification for the overall tone', () => {
    const pr = {
      number: 75,
      state: 'OPEN',
      url: 'u',
      checks: [{ name: 'test', status: 'completed', conclusion: 'failure' }]
    } as GitPrSummary
    const ci = {
      status: 'passed',
      checks: [],
      runs: [{ id: 1, conclusion: 'success' }],
      failedLogs: []
    } as unknown as GitCiStatusSummary
    const model = buildSatellitePopoverModel(pr, ci, remote)
    expect(model.ci?.tone).toBe('success')
    expect(model.ci?.statusLabel).toBe('CI passed')
  })

  it('returns empty pr/ci when there is nothing to show', () => {
    const model = buildSatellitePopoverModel(null, null, null)
    expect(model.pr).toBeNull()
    expect(model.ci).toBeNull()
    expect(model.repoName).toBeUndefined()
  })
})
