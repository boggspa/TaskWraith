import { execFileSync, spawnSync } from 'child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitService, parseStatusPorcelainZ, type GitCommandRunner } from './GitService'

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function createRepo(): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'taskwraith-git-service-')))
  runGit(repo, ['init', '-b', 'main'])
  runGit(repo, ['config', 'user.name', 'TaskWraith Test'])
  runGit(repo, ['config', 'user.email', 'taskwraith@example.test'])
  writeFileSync(join(repo, 'README.md'), 'initial\n')
  runGit(repo, ['add', 'README.md'])
  runGit(repo, ['commit', '-m', 'Initial commit'])
  return runGit(repo, ['rev-parse', '--show-toplevel']).trim()
}

describe('GitService', () => {
  let repo: string
  let extraTempPaths: string[]

  beforeEach(() => {
    repo = createRepo()
    extraTempPaths = []
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    for (const tempPath of extraTempPaths) {
      rmSync(tempPath, { recursive: true, force: true })
    }
  })

  function addBareRemote(): string {
    const remote = realpathSync(mkdtempSync(join(tmpdir(), 'taskwraith-git-remote-')))
    extraTempPaths.push(remote)
    runGit(remote, ['init', '--bare'])
    runGit(repo, ['remote', 'add', 'origin', remote])
    runGit(repo, ['push', '-u', 'origin', 'main'])
    return remote
  }

  it('parses porcelain status records', () => {
    expect(parseStatusPorcelainZ(' M README.md\0?? new file.txt\0')).toEqual([
      {
        path: 'README.md',
        index: ' ',
        workingTree: 'M',
        kind: 'modified',
        staged: false,
        unstaged: true
      },
      {
        path: 'new file.txt',
        index: '?',
        workingTree: '?',
        kind: 'untracked',
        staged: false,
        unstaged: true
      }
    ])
  })

  it('resolves the repository root from a nested directory', async () => {
    const nested = join(repo, 'src', 'feature')
    mkdirSync(nested, { recursive: true })

    const result = await new GitService().snapshot(nested)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.repoRoot).toBe(repo)
    expect(result.data.requestedPath).toBe(nested)
    expect(result.data.branch).toBe('main')
    expect(result.data.clean).toBe(true)
  })

  it('reports changed and untracked files', async () => {
    writeFileSync(join(repo, 'README.md'), 'changed\n')
    writeFileSync(join(repo, 'new.txt'), 'new\n')

    const result = await new GitService().snapshot(repo)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.counts.changed).toBe(2)
    expect(result.data.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'README.md', kind: 'modified', unstaged: true }),
        expect.objectContaining({ path: 'new.txt', kind: 'untracked', unstaged: true })
      ])
    )
  })

  it('stages selected paths without staging every file', async () => {
    writeFileSync(join(repo, 'one.txt'), 'one\n')
    writeFileSync(join(repo, 'two.txt'), 'two\n')

    const result = await new GitService().stage({ repoPath: repo, paths: ['one.txt'] })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'one.txt', staged: true }),
        expect.objectContaining({ path: 'two.txt', kind: 'untracked', staged: false })
      ])
    )
  })

  it('stages selected paths relative to the requested workspace subdirectory', async () => {
    const workspace = join(repo, 'packages', 'app')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'App.tsx'), '<App />\n')

    const result = await new GitService().stage({ repoPath: workspace, paths: ['App.tsx'] })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'packages/app/App.tsx', staged: true })
      ])
    )
  })

  it('unstages selected paths without unstaging every file', async () => {
    writeFileSync(join(repo, 'one.txt'), 'one\n')
    writeFileSync(join(repo, 'two.txt'), 'two\n')
    const service = new GitService()
    const stageResult = await service.stage({ repoPath: repo, all: true })
    expect(stageResult.ok).toBe(true)

    const result = await service.unstage({ repoPath: repo, paths: ['one.txt'] })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'one.txt', staged: false, unstaged: true }),
        expect.objectContaining({ path: 'two.txt', staged: true })
      ])
    )
  })

  it('rejects staging paths that escape the repository', async () => {
    writeFileSync(join(repo, 'safe.txt'), 'safe\n')
    const service = new GitService()

    const traversal = await service.stage({ repoPath: repo, paths: ['../outside.txt'] })
    const absolute = await service.stage({ repoPath: repo, paths: [join(repo, 'safe.txt')] })

    expect(traversal).toEqual({
      ok: false,
      error: 'Stage paths must stay inside the repository.'
    })
    expect(absolute).toEqual({
      ok: false,
      error: 'Stage paths must be relative to the repository.'
    })
    expect(runGit(repo, ['diff', '--cached', '--name-only']).trim()).toBe('')
  })

  it('commits staged changes and returns a clean snapshot', async () => {
    writeFileSync(join(repo, 'committed.txt'), 'committed\n')
    const service = new GitService()
    const stageResult = await service.stage({ repoPath: repo, all: true })
    expect(stageResult.ok).toBe(true)

    const commitResult = await service.commit({ repoPath: repo, message: 'Add committed file' })

    expect(commitResult.ok).toBe(true)
    if (!commitResult.ok) return
    expect(commitResult.data.clean).toBe(true)
    expect(runGit(repo, ['log', '-1', '--pretty=%s']).trim()).toBe('Add committed file')
  })

  it('refuses to commit with no staged changes', async () => {
    const result = await new GitService().commit({ repoPath: repo, message: 'Nothing staged' })

    expect(result).toEqual({ ok: false, error: 'No staged changes to commit.' })
  })

  it('refuses to push a branch with no remote', async () => {
    const result = await new GitService().push({ repoPath: repo })

    expect(result).toEqual({
      ok: false,
      error: 'No git remote is configured. Add a remote before pushing.'
    })
  })

  it('refuses to push from a detached HEAD', async () => {
    addBareRemote()
    runGit(repo, ['checkout', '--detach', 'HEAD'])

    const result = await new GitService().push({ repoPath: repo })

    expect(result).toEqual({
      ok: false,
      error: 'Cannot push from a detached HEAD. Create or switch to a branch first.'
    })
  })

  it('runs gh pr create from the resolved repository root', async () => {
    addBareRemote()
    const nested = join(repo, 'nested')
    mkdirSync(nested, { recursive: true })
    const calls: Array<{
      command: string
      args: string[]
      cwd: string
      env?: Record<string, string>
    }> = []
    const runner: GitCommandRunner = async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd, env: options.env })
      if (command === 'gh') {
        if (args.includes('view')) {
          return {
            stdout: '',
            stderr: 'no pull requests found for branch "main"',
            code: 1
          }
        }
        return {
          stdout: 'https://github.com/boggspa/TaskWraith/pull/42\n',
          stderr: '',
          code: 0
        }
      }
      const result = spawnSync(command, args, {
        cwd: options.cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      })
      return {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        code: result.status ?? 0
      }
    }

    const result = await new GitService({ run: runner }).createPullRequest({
      repoPath: nested,
      draft: true
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.url).toBe('https://github.com/boggspa/TaskWraith/pull/42')
    expect(calls.find((call) => call.command === 'gh' && call.args.includes('create'))).toEqual({
      command: 'gh',
      args: ['pr', 'create', '--fill', '--draft'],
      cwd: repo,
      env: { GH_PROMPT_DISABLED: '1' }
    })
  })

  it('reports PR readiness when the branch needs to be pushed first', async () => {
    addBareRemote()
    writeFileSync(join(repo, 'ahead.txt'), 'ahead\n')
    runGit(repo, ['add', 'ahead.txt'])
    runGit(repo, ['commit', '-m', 'Ahead commit'])

    const result = await new GitService({
      run: async (command, args, options) => {
        if (command === 'gh') {
          return {
            stdout: '',
            stderr: 'no pull requests found for branch "main"',
            code: 1
          }
        }
        const git = spawnSync(command, args, {
          cwd: options.cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe']
        })
        return {
          stdout: git.stdout || '',
          stderr: git.stderr || '',
          code: git.status ?? 0
        }
      }
    }).pullRequestReadiness(repo)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.canCreatePullRequest).toBe(false)
    expect(result.data.shouldPushFirst).toBe(true)
    expect(result.data.reason).toBe('Push the current branch before creating a pull request.')
  })

  it('reports an existing pull request as not creatable', async () => {
    addBareRemote()
    const result = await new GitService({
      run: async (command, args, options) => {
        if (command === 'gh') {
          return {
            stdout: JSON.stringify({
              number: 42,
              url: 'https://github.com/boggspa/TaskWraith/pull/42',
              state: 'OPEN',
              isDraft: false,
              headRefName: 'main',
              baseRefName: 'master',
              statusCheckRollup: []
            }),
            stderr: '',
            code: 0
          }
        }
        const git = spawnSync(command, args, {
          cwd: options.cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe']
        })
        return {
          stdout: git.stdout || '',
          stderr: git.stderr || '',
          code: git.status ?? 0
        }
      }
    }).pullRequestReadiness(repo)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.canCreatePullRequest).toBe(false)
    expect(result.data.existingPullRequest?.url).toBe('https://github.com/boggspa/TaskWraith/pull/42')
    expect(result.data.reason).toBe('This branch already has a pull request.')
  })

  it('refuses PR creation before the current branch is pushed', async () => {
    addBareRemote()
    writeFileSync(join(repo, 'ahead-pr.txt'), 'ahead\n')
    runGit(repo, ['add', 'ahead-pr.txt'])
    runGit(repo, ['commit', '-m', 'Ahead PR commit'])

    const result = await new GitService().createPullRequest({ repoPath: repo })

    expect(result).toEqual({
      ok: false,
      error: 'Push the current branch before creating a pull request.'
    })
  })
})
