import { describe, expect, it, vi } from 'vitest'
import type { GitCommandRunner, GitRepositorySnapshot } from './GitService'
import {
  MAX_GIT_UNPUSHED_COMMIT_PAGE_SIZE,
  normalizeGitUnpushedCommitPage,
  parseGitUnpushedCommitLog,
  readGitUnpushedCommitStack
} from './GitCommitStack'

function snapshot(overrides: Partial<GitRepositorySnapshot> = {}): GitRepositorySnapshot {
  return {
    requestedPath: '/repo',
    repoRoot: '/repo',
    branch: 'feature/commits',
    commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    detached: false,
    upstream: 'origin/feature/commits',
    remoteName: 'origin',
    remoteUrl: 'git@github.com:example/repo.git',
    ahead: 2,
    behind: 0,
    files: [],
    counts: { changed: 0, staged: 0, unstaged: 0, untracked: 0 },
    clean: true,
    mergeState: null,
    conflicts: 0,
    lineStats: { additions: 0, deletions: 0 },
    ...overrides
  }
}

function record(input: {
  hash: string
  parents?: string
  author?: string
  email?: string
  date?: string
  subject?: string
  stats?: string[]
}): string {
  return [
    `\u001e${input.hash}`,
    input.parents || '',
    input.author || 'A Person',
    input.email || 'person@example.test',
    input.date || '2026-08-12T01:00:00+01:00',
    input.subject || 'A commit',
    `\n${(input.stats || []).join('\u0000')}`
  ].join('\u0000')
}

describe('parseGitUnpushedCommitLog', () => {
  it('parses ordered commit metadata and sums text, binary, and rename numstats', () => {
    const output = [
      record({
        hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        parents: '1111111111111111111111111111111111111111',
        subject: 'Newest commit',
        stats: ['4\t2\tsrc/a.ts', '-\t-\tasset.png', '3\t1\t', 'old.ts', 'new.ts']
      }),
      record({
        hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        parents:
          '2222222222222222222222222222222222222222 3333333333333333333333333333333333333333',
        author: 'Second Author',
        email: 'second@example.test',
        subject: 'Merge a useful branch',
        stats: ['10\t0\tsrc/b.ts']
      })
    ].join('')

    expect(parseGitUnpushedCommitLog(output)).toEqual([
      {
        hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        parents: ['1111111111111111111111111111111111111111'],
        subject: 'Newest commit',
        author: {
          name: 'A Person',
          email: 'person@example.test',
          authoredAt: '2026-08-12T01:00:00+01:00'
        },
        filesChanged: 3,
        additions: 7,
        deletions: 3
      },
      {
        hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        parents: [
          '2222222222222222222222222222222222222222',
          '3333333333333333333333333333333333333333'
        ],
        subject: 'Merge a useful branch',
        author: {
          name: 'Second Author',
          email: 'second@example.test',
          authoredAt: '2026-08-12T01:00:00+01:00'
        },
        filesChanged: 1,
        additions: 10,
        deletions: 0
      }
    ])
  })

  it('ignores malformed records without losing valid neighbors', () => {
    const valid = record({ hash: 'cccccccccccccccccccccccccccccccccccccccc' })
    expect(parseGitUnpushedCommitLog(`\u001enot-a-hash\u0000bad${valid}`)).toHaveLength(1)
  })
})

describe('readGitUnpushedCommitStack', () => {
  it('compares a tracked checkout with its upstream', async () => {
    const run = vi.fn<GitCommandRunner>().mockResolvedValue({
      stdout: record({ hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
      stderr: '',
      code: 0
    })

    const result = await readGitUnpushedCommitStack({
      repoRoot: '/repo',
      snapshot: snapshot(),
      run,
      timeoutMs: 1234,
      now: () => new Date('2026-08-12T00:00:00.000Z')
    })

    expect(result).toMatchObject({
      repoRoot: '/repo',
      branch: 'feature/commits',
      upstream: 'origin/feature/commits',
      comparison: 'upstream',
      observedAt: '2026-08-12T00:00:00.000Z'
    })
    expect(result.commits).toHaveLength(1)
    expect(run).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['@{u}..HEAD', '--numstat', '-z']),
      { cwd: '/repo', timeoutMs: 1234 }
    )
  })

  it('uses every remote-tracking ref as the publication boundary before first push', async () => {
    const run = vi.fn<GitCommandRunner>().mockResolvedValue({ stdout: '', stderr: '', code: 0 })

    const result = await readGitUnpushedCommitStack({
      repoRoot: '/repo',
      snapshot: snapshot({ upstream: undefined, ahead: 0 }),
      run,
      timeoutMs: 500
    })

    expect(result.comparison).toBe('remote-refs')
    expect(run.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['HEAD', '--not', '--remotes']))
  })

  it('reads a bounded newest-first page and exposes the next offset', async () => {
    const run = vi.fn<GitCommandRunner>().mockResolvedValue({
      stdout: [
        record({ hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
        record({ hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
        record({ hash: 'cccccccccccccccccccccccccccccccccccccccc' })
      ].join(''),
      stderr: '',
      code: 0
    })

    const result = await readGitUnpushedCommitStack({
      repoRoot: '/repo',
      snapshot: snapshot(),
      run,
      timeoutMs: 500,
      page: { offset: 50, limit: 2 }
    })

    expect(result.commits.map((commit) => commit.hash)).toEqual([
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    ])
    expect(result.page).toEqual({ offset: 50, limit: 2, hasMore: true, nextOffset: 52 })
    expect(run.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(['--max-count=3', '--skip=50', '@{u}..HEAD'])
    )
  })

  it('clamps renderer-provided page values before building Git arguments', () => {
    expect(normalizeGitUnpushedCommitPage({ offset: -12, limit: Number.MAX_SAFE_INTEGER })).toEqual({
      offset: 0,
      limit: MAX_GIT_UNPUSHED_COMMIT_PAGE_SIZE
    })
    expect(normalizeGitUnpushedCommitPage({})).toEqual({ offset: 0, limit: 50 })
  })

  it('surfaces Git failures without returning a misleading empty stack', async () => {
    const run = vi.fn<GitCommandRunner>().mockResolvedValue({
      stdout: '',
      stderr: 'bad revision',
      code: 128
    })

    await expect(
      readGitUnpushedCommitStack({
        repoRoot: '/repo',
        snapshot: snapshot(),
        run,
        timeoutMs: 500
      })
    ).rejects.toThrow('bad revision')
  })
})
