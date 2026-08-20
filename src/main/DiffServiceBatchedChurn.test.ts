/**
 * `getWorkspaceDiff` must not read per-file churn with per-file subprocesses.
 *
 * Measured 2026-08-20 on this repo: the pair of `diff --numstat` spawns that
 * `countGitFileDiffLines` issued cost ~50 ms of BLOCKED main thread per file,
 * and the clean-tree floor matched the with-content cost — the expense is git
 * process STARTUP, so only issuing fewer spawns moves it.
 *
 * The assertion counts SYNCHRONOUS git spawns rather than wall time: wall time
 * is a flaky thing to gate on, and "how many subprocesses does main block on"
 * is the property that actually regressed. The batch runs through the async
 * `spawn` path, so a correct implementation contributes zero sync numstat
 * spawns no matter how many files changed.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, it, expect, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ syncGitArgs: [] as string[][] }))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    spawnSync: (command: string, args: string[], options: unknown) => {
      if (command === 'git' && Array.isArray(args)) mocks.syncGitArgs.push([...args])
      return (actual.spawnSync as (...a: unknown[]) => unknown)(command, args, options)
    }
  }
})

const { getWorkspaceDiff } = await import('./DiffService')
const { spawnSync } = await import('child_process')

function git(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' })
  expect(r.status, r.stderr || r.stdout).toBe(0)
}

function repoWithModifiedFiles(fileCount: number): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-batched-churn-'))
  const repo = path.join(base, 'repo')
  fs.mkdirSync(repo)
  git(repo, ['init'])
  git(repo, ['config', 'user.email', 'test@example.invalid'])
  git(repo, ['config', 'user.name', 'TaskWraith Test'])
  for (let i = 0; i < fileCount; i++) {
    fs.writeFileSync(path.join(repo, `f${i}.txt`), 'base\n'.repeat(4))
  }
  git(repo, ['add', '.'])
  git(repo, ['commit', '-m', 'base'])
  for (let i = 0; i < fileCount; i++) {
    fs.writeFileSync(path.join(repo, `f${i}.txt`), 'base\n'.repeat(4) + 'added\n')
  }
  return repo
}

describe('getWorkspaceDiff — batched churn', () => {
  it('issues no per-file numstat subprocess, however many files changed', async () => {
    const repo = repoWithModifiedFiles(6)
    mocks.syncGitArgs.length = 0

    const result = await getWorkspaceDiff(repo)

    expect(result.type).toBe('changes')
    const numstatSpawns = mocks.syncGitArgs.filter((a) => a.includes('--numstat'))
    expect(numstatSpawns).toEqual([])
    fs.rmSync(path.dirname(repo), { recursive: true, force: true })
  })

  it('does not let sync spawn count grow with the number of changed files', async () => {
    const small = repoWithModifiedFiles(2)
    mocks.syncGitArgs.length = 0
    await getWorkspaceDiff(small)
    const forTwo = mocks.syncGitArgs.filter((a) => a.includes('--numstat')).length

    const large = repoWithModifiedFiles(8)
    mocks.syncGitArgs.length = 0
    await getWorkspaceDiff(large)
    const forEight = mocks.syncGitArgs.filter((a) => a.includes('--numstat')).length

    // Pre-batch this was 4 vs 16. The point is the slope, not the constant.
    expect(forEight).toBe(forTwo)
    fs.rmSync(path.dirname(small), { recursive: true, force: true })
    fs.rmSync(path.dirname(large), { recursive: true, force: true })
  })

  it('reports the same totals the staged+unstaged pair produced', async () => {
    // `diff HEAD` collapses index and worktree; the pair summed them. A file
    // carrying BOTH is the case where a wrong batch would under-report.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-batched-churn-sum-'))
    const repo = path.join(base, 'repo')
    fs.mkdirSync(repo)
    git(repo, ['init'])
    git(repo, ['config', 'user.email', 'test@example.invalid'])
    git(repo, ['config', 'user.name', 'TaskWraith Test'])
    fs.writeFileSync(path.join(repo, 'both.txt'), 'a\nb\nc\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-m', 'base'])

    fs.writeFileSync(path.join(repo, 'both.txt'), 'a\nb\nc\nstaged\n')
    git(repo, ['add', 'both.txt'])
    fs.writeFileSync(path.join(repo, 'both.txt'), 'a\nb\nc\nstaged\nunstaged\n')

    const result = await getWorkspaceDiff(repo)
    expect(result.type).toBe('changes')
    const summary = result.summaries?.find((s) => s.path === 'both.txt')
    expect(summary).toBeDefined()
    expect(summary?.additions).toBe(2)
    expect(summary?.deletions).toBe(0)
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('falls back to per-file counting when there is no HEAD to diff against', async () => {
    // Unborn HEAD: the batch fails, and every file must still get its numbers.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-batched-churn-unborn-'))
    const repo = path.join(base, 'repo')
    fs.mkdirSync(repo)
    git(repo, ['init'])
    git(repo, ['config', 'user.email', 'test@example.invalid'])
    git(repo, ['config', 'user.name', 'TaskWraith Test'])
    fs.writeFileSync(path.join(repo, 'new.txt'), 'one\ntwo\n')

    const result = await getWorkspaceDiff(repo)

    expect(result.type).toBe('changes')
    expect(result.summaries?.some((s) => s.path === 'new.txt')).toBe(true)
    fs.rmSync(base, { recursive: true, force: true })
  })
})
