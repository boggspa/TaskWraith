import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitService, type GitCommandRunner, type GitRepositorySnapshot } from './GitService'
import {
  manageGitPullRequest,
  parseGitPullRequestList,
  readGitPullRequestWorkspace,
  type GitPullRequestWorkflowContext
} from './GitPullRequestWorkflow'

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function removePath(path: string): void {
  rmSync(path, { recursive: true, force: true })
}

function snapshot(overrides: Partial<GitRepositorySnapshot> = {}): GitRepositorySnapshot {
  return {
    requestedPath: '/repo',
    repoRoot: '/repo',
    branch: 'master',
    commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    detached: false,
    upstream: 'origin/master',
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

function ghPr(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 42,
    title: 'Grouped commits',
    body: 'A focused request',
    url: 'https://github.com/example/repo/pull/42',
    state: 'OPEN',
    isDraft: true,
    headRefName: 'pr/grouped-commits',
    headRefOid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    baseRefName: 'master',
    mergeStateStatus: 'CLEAN',
    updatedAt: '2026-08-12T00:00:00Z',
    statusCheckRollup: [],
    ...overrides
  })
}

describe('Git pull request workflow', () => {
  let repo: string
  let remote: string

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'taskwraith-pr-workflow-')))
    remote = realpathSync(mkdtempSync(join(tmpdir(), 'taskwraith-pr-remote-')))
    runGit(repo, ['init', '-b', 'master'])
    runGit(repo, ['config', 'user.name', 'TaskWraith Test'])
    runGit(repo, ['config', 'user.email', 'taskwraith@example.test'])
    writeFileSync(join(repo, 'README.md'), 'base\n')
    runGit(repo, ['add', 'README.md'])
    runGit(repo, ['commit', '-m', 'Base'])
    runGit(remote, ['init', '--bare'])
    runGit(repo, ['remote', 'add', 'origin', remote])
    runGit(repo, ['push', '-u', 'origin', 'master'])
  })

  afterEach(() => {
    removePath(repo)
    removePath(remote)
  })

  function appendCommit(path: string, content: string, subject: string): string {
    writeFileSync(join(repo, path), content)
    runGit(repo, ['add', path])
    runGit(repo, ['commit', '-m', subject])
    return runGit(repo, ['rev-parse', 'HEAD']).trim()
  }

  function runnerWithGh(options: { failCreate?: boolean } = {}): {
    run: GitCommandRunner
    calls: Array<{ command: string; args: string[]; cwd: string }>
  } {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = []
    const run: GitCommandRunner = async (command, args, commandOptions) => {
      calls.push({ command, args, cwd: commandOptions.cwd })
      if (command === 'gh') {
        if (args[0] === 'pr' && args[1] === 'create') {
          return options.failCreate
            ? { stdout: '', stderr: 'GitHub rejected the request', code: 1 }
            : {
                stdout: 'https://github.com/example/repo/pull/42\n',
                stderr: '',
                code: 0
              }
        }
        if (args[0] === 'pr' && args[1] === 'view') {
          const head = runGit(repo, ['rev-parse', 'refs/heads/pr/grouped-commits']).trim()
          return { stdout: ghPr({ headRefOid: head }), stderr: '', code: 0 }
        }
        return { stdout: '', stderr: 'Unexpected gh command', code: 1 }
      }
      const result = spawnSync(command, args, {
        cwd: commandOptions.cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      })
      return {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        code: result.status ?? 0
      }
    }
    return { run, calls }
  }

  it('assembles arbitrary commits in an isolated worktree without leaving master', async () => {
    const first = appendCommit('one.txt', 'one\n', 'First selected')
    appendCommit('two.txt', 'two\n', 'Not selected')
    const third = appendCommit('three.txt', 'three\n', 'Third selected')
    const masterHead = runGit(repo, ['rev-parse', 'HEAD']).trim()
    const { run, calls } = runnerWithGh()

    const result = await new GitService({ run, timeoutMs: 20_000 }).createCommitGroupPullRequest({
      repoPath: repo,
      commits: [third, first],
      branch: 'pr/grouped-commits',
      baseBranch: 'master',
      title: 'Grouped commits',
      body: 'A focused request',
      draft: true
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.commitHashes).toEqual([first, third])
    expect(result.data.pullRequest).toMatchObject({ number: 42, isDraft: true })
    expect(runGit(repo, ['branch', '--show-current']).trim()).toBe('master')
    expect(runGit(repo, ['rev-parse', 'HEAD']).trim()).toBe(masterHead)
    expect(runGit(repo, ['status', '--porcelain'])).toBe('')
    expect(
      runGit(repo, [
        'log',
        '--reverse',
        '--format=%s',
        'origin/master..refs/remotes/origin/pr/grouped-commits'
      ])
        .trim()
        .split('\n')
    ).toEqual(['First selected', 'Third selected'])
    expect(runGit(repo, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1)
    expect(calls.find((call) => call.command === 'gh' && call.args[1] === 'create')?.args).toEqual(
      expect.arrayContaining([
        '--head',
        'pr/grouped-commits',
        '--base',
        'master',
        '--title',
        'Grouped commits',
        '--draft'
      ])
    )
  }, 30_000)

  it('rolls back its local and remote branch if GitHub creation fails', async () => {
    const commit = appendCommit('one.txt', 'one\n', 'Selected')
    const { run } = runnerWithGh({ failCreate: true })

    const result = await new GitService({ run, timeoutMs: 20_000 }).createCommitGroupPullRequest({
      repoPath: repo,
      commits: [commit],
      branch: 'pr/grouped-commits',
      baseBranch: 'master',
      title: 'Grouped commits'
    })

    expect(result).toMatchObject({ ok: false, error: 'GitHub rejected the request' })
    expect(runGit(repo, ['branch', '--list', 'pr/grouped-commits']).trim()).toBe('')
    expect(
      runGit(repo, ['ls-remote', '--heads', 'origin', 'refs/heads/pr/grouped-commits']).trim()
    ).toBe('')
    expect(runGit(repo, ['branch', '--show-current']).trim()).toBe('master')
    expect(runGit(repo, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1)
  }, 30_000)

  it('reads repository defaults and full lifecycle fields from GitHub', async () => {
    const run = vi.fn<GitCommandRunner>(async (_command, args) => {
      if (args[0] === 'repo') {
        return {
          stdout: JSON.stringify({ defaultBranchRef: { name: 'trunk' } }),
          stderr: '',
          code: 0
        }
      }
      return { stdout: `[${ghPr()}]`, stderr: '', code: 0 }
    })
    const context: GitPullRequestWorkflowContext = {
      repoRoot: '/repo',
      snapshot: snapshot(),
      run,
      timeoutMs: 500
    }

    const result = await readGitPullRequestWorkspace(context)

    expect(result).toMatchObject({
      available: true,
      defaultBaseBranch: 'trunk',
      pullRequests: [
        {
          number: 42,
          title: 'Grouped commits',
          body: 'A focused request',
          updatedAt: '2026-08-12T00:00:00Z'
        }
      ]
    })
    expect(
      parseGitPullRequestList(`[${ghPr({ autoMergeRequest: { enabledAt: 'now' } })}]`)[0]
    ).toMatchObject({ autoMergeEnabled: true })
  })

  it('maps ready, draft, edit, close, reopen, and guarded merge actions to gh', async () => {
    const mutationCalls: string[][] = []
    let viewCount = 0
    const run = vi.fn<GitCommandRunner>(async (command, args) => {
      if (command === 'git') return { stdout: '', stderr: '', code: 0 }
      if (args[0] === 'pr' && args[1] === 'view') {
        viewCount += 1
        return {
          stdout: ghPr({
            isDraft: viewCount < 3,
            headRefOid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
          }),
          stderr: '',
          code: 0
        }
      }
      mutationCalls.push(args)
      return { stdout: '', stderr: '', code: 0 }
    })
    const context: GitPullRequestWorkflowContext = {
      repoRoot: '/repo',
      snapshot: snapshot(),
      run,
      timeoutMs: 500
    }

    await manageGitPullRequest(context, {
      pullRequestNumber: 42,
      lifecycle: { action: 'mark-ready' }
    })
    await manageGitPullRequest(context, {
      pullRequestNumber: 42,
      lifecycle: { action: 'convert-to-draft' }
    })
    await manageGitPullRequest(context, {
      pullRequestNumber: 42,
      lifecycle: { action: 'edit', title: 'New title', body: '', baseBranch: 'trunk' }
    })
    await manageGitPullRequest(context, {
      pullRequestNumber: 42,
      lifecycle: { action: 'close' }
    })
    await manageGitPullRequest(context, {
      pullRequestNumber: 42,
      lifecycle: { action: 'reopen' }
    })
    await manageGitPullRequest(context, {
      pullRequestNumber: 42,
      lifecycle: {
        action: 'merge',
        strategy: 'squash',
        expectedHeadSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      }
    })

    expect(mutationCalls).toEqual([
      ['pr', 'ready', '42'],
      ['pr', 'ready', '42', '--undo'],
      ['pr', 'edit', '42', '--title', 'New title', '--body', '', '--base', 'trunk'],
      ['pr', 'close', '42'],
      ['pr', 'reopen', '42'],
      [
        'pr',
        'merge',
        '42',
        '--squash',
        '--match-head-commit',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      ]
    ])
  })
})
