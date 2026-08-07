import { execFileSync } from 'child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitService } from './GitService'
import {
  parseGitGrepTrackedLines,
  parseNonNegativeGitCount,
  summarizeGitCommitActivity
} from './GitWorkspaceStats'

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

describe('GitWorkspaceStats', () => {
  const tempPaths: string[] = []

  afterEach(() => {
    for (const path of tempPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  it('parses bounded activity and NUL-delimited tracked line counts', () => {
    expect(parseNonNegativeGitCount('42\n')).toBe(42)
    expect(parseNonNegativeGitCount('-1')).toBeNull()
    expect(parseGitGrepTrackedLines('README.md\u00005\nsrc/a.ts\u000012\n')).toBe(17)
    expect(
      summarizeGitCommitActivity({
        stdout: '2026-08-03\n2026-08-03\n2026-08-01\n',
        totalCommits: 3,
        observedAt: '2026-08-03T18:00:00.000Z'
      })
    ).toEqual({
      activeDays: 2,
      historySpanDays: 3,
      commitsPerActiveDay: 1.5,
      historyTruncated: false
    })
  })

  it('spans to the newest sampled commit when it post-dates the observation date', () => {
    // Git emits commit days in the committer's local calendar while observedAt
    // is UTC — in the hour after local midnight (or with future-timezone
    // committers) the newest commit day post-dates the observation day.
    expect(
      summarizeGitCommitActivity({
        stdout: '2026-08-05\n2026-08-05\n',
        totalCommits: 2,
        observedAt: '2026-08-04T23:15:00.000Z'
      })
    ).toEqual({
      activeDays: 1,
      historySpanDays: 1,
      commitsPerActiveDay: 2,
      historyTruncated: false
    })
  })

  it('marks activity aggregates partial when the history sample is bounded', () => {
    expect(
      summarizeGitCommitActivity({
        stdout: '2026-08-03\n2026-08-02\n2026-08-01\n',
        totalCommits: 12,
        observedAt: '2026-08-03T18:00:00.000Z',
        sampleLimit: 2
      })
    ).toEqual({
      activeDays: 2,
      historySpanDays: null,
      commitsPerActiveDay: null,
      historyTruncated: true
    })
  })

  it('collects coherent local-only repository facts without fetching or mutating', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'taskwraith-workspace-stats-')))
    tempPaths.push(repo)
    runGit(repo, ['init', '-b', 'main'])
    runGit(repo, ['config', 'user.name', 'TaskWraith Test'])
    runGit(repo, ['config', 'user.email', 'taskwraith@example.test'])
    writeFileSync(join(repo, 'README.md'), 'one\n\nthree\n')
    runGit(repo, ['add', 'README.md'])
    runGit(repo, ['commit', '-m', 'Initial commit'])
    runGit(repo, ['tag', 'v0.1.0'])
    writeFileSync(join(repo, 'code.ts'), 'alpha\nbeta\n')
    runGit(repo, ['add', 'code.ts'])
    runGit(repo, ['commit', '-m', 'Add code'])
    runGit(repo, ['branch', 'feature/local'])

    const result = await new GitService().workspaceStats(repo)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toMatchObject({
      coherent: true,
      totalCommits: 2,
      localBranchCount: 2,
      attachedWorktreeCount: 1,
      trackedLines: 5,
      activeDays: 1,
      historyTruncated: false,
      latestTag: 'v0.1.0',
      commitsSinceLatestTag: 1
    })
    expect(realpathSync(result.data.repoRoot)).toBe(realpathSync(repo))
    expect(result.data.historySpanDays).toBeGreaterThanOrEqual(1)
    expect(result.data.commitsPerActiveDay).toBe(2)
    expect(result.data.latestCommit?.subject).toBe('Add code')
    expect(runGit(repo, ['status', '--porcelain'])).toBe('')
    expect(runGit(repo, ['remote'])).toBe('')
  })
})
