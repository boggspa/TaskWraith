import { execFileSync, spawnSync } from 'child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GitService,
  parseBranchList,
  parseDiffNumstat,
  parseStatusPorcelainZ,
  parseWorktreeList,
  type GitCommandRunner
} from './GitService'
import {
  gitCommandEnvironment,
  hardenedGitCommandArgs,
  isSafeExternalGitPushUrl,
  unsafeRepositoryPushConfigKeys
} from './GitCommandSecurity'

const WORKTREE_LIFECYCLE_TIMEOUT_MS = 20_000

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function removeTempDirectory(path: string): void {
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 5 : 0,
    retryDelay: 100
  })
}

function comparablePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
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
  let worktreeCleanupPaths: string[]

  beforeEach(() => {
    repo = createRepo()
    extraTempPaths = []
    worktreeCleanupPaths = []
  })

  afterEach(() => {
    for (const worktreePath of worktreeCleanupPaths) {
      if (!existsSync(repo) || !existsSync(worktreePath)) continue
      try {
        runGit(repo, ['worktree', 'remove', '--force', worktreePath])
      } catch {
        // Preserve the test failure; retrying directory removal below is still worthwhile.
      }
    }
    removeTempDirectory(repo)
    for (const tempPath of extraTempPaths) {
      removeTempDirectory(tempPath)
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

  it('prefixes every Git invocation with non-executable repository config overrides', () => {
    const args = hardenedGitCommandArgs('/usr/bin/git', ['status', '--porcelain'])

    expect(args).toEqual(
      expect.arrayContaining([
        'core.fsmonitor=false',
        expect.stringMatching(/^core\.hooksPath=/),
        expect.stringMatching(/^core\.attributesFile=/),
        'diff.external=',
        'credential.helper=',
        'credential.interactive=never',
        'core.sshCommand=ssh',
        'protocol.ext.allow=never',
        'commit.gpgSign=false',
        'push.gpgSign=false'
      ])
    )
    expect(args.slice(-2)).toEqual(['status', '--porcelain'])
    expect(hardenedGitCommandArgs('gh', ['status'])).toEqual(['status'])
  })

  it('builds a scrubbed Git environment and re-adds only the safe prompt control', () => {
    const env = gitCommandEnvironment(
      'git',
      {
        SAFE_OVERRIDE: 'yes',
        GIT_WORK_TREE: '/hostile/worktree',
        gIt_Object_Directory: '/hostile/objects'
      },
      {
        PATH: '/usr/bin',
        GIT_DIR: '/hostile/git-dir',
        Git_Config_Parameters: 'hostile',
        GITHUB_TOKEN: 'secret',
        SSH_ASKPASS: '/hostile/askpass'
      }
    )

    expect(env).toMatchObject({
      PATH: '/usr/bin',
      SAFE_OVERRIDE: 'yes',
      GIT_TERMINAL_PROMPT: '0'
    })
    expect(Object.keys(env).filter((key) => key.toUpperCase().startsWith('GIT_'))).toEqual([
      'GIT_TERMINAL_PROMPT'
    ])
    expect(env).not.toHaveProperty('GITHUB_TOKEN')
    expect(env).not.toHaveProperty('SSH_ASKPASS')
    expect(gitCommandEnvironment('gh', { GH_PROMPT_DISABLED: '0' }, {})).toEqual({
      GH_PROMPT_DISABLED: '1'
    })
  })

  it('classifies external push URLs and executable repository transport config', () => {
    expect(isSafeExternalGitPushUrl('https://github.com/acme/repo.git')).toBe(true)
    expect(isSafeExternalGitPushUrl('ssh://git@github.com/acme/repo.git')).toBe(true)
    expect(isSafeExternalGitPushUrl('git@github.com:acme/repo.git')).toBe(true)
    expect(isSafeExternalGitPushUrl('/tmp/local.git')).toBe(false)
    expect(isSafeExternalGitPushUrl('file:///tmp/local.git')).toBe(false)
    expect(isSafeExternalGitPushUrl('ext::sh -c touch /tmp/pwned')).toBe(false)
    expect(
      unsafeRepositoryPushConfigKeys([
        'remote.origin.receivepack',
        'url.file:///tmp/.insteadOf',
        'remote.origin.url'
      ])
    ).toEqual(['remote.origin.receivepack', 'url.file:///tmp/.insteadOf'])
  })

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

  it('parses branch and worktree porcelain for picker UI', () => {
    expect(
      parseBranchList('main\torigin/main\t/repo\nfeature/new\t\t/repo-worktrees/feature\n', 'main')
    ).toEqual([
      {
        name: 'main',
        isCurrent: true,
        isRemote: false,
        upstream: 'origin/main',
        worktreePath: '/repo'
      },
      {
        name: 'feature/new',
        isCurrent: false,
        isRemote: false,
        worktreePath: '/repo-worktrees/feature'
      }
    ])

    expect(
      parseWorktreeList(
        'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo-worktrees/feature\nHEAD def456\nbranch refs/heads/feature/new\n',
        '/repo'
      )
    ).toEqual([
      { path: '/repo', branch: 'main', head: 'abc123', isCurrent: true },
      {
        path: '/repo-worktrees/feature',
        branch: 'feature/new',
        head: 'def456',
        isCurrent: false
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

  it('strips inherited Git routing variables before invoking the default runner', async () => {
    const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_COUNT'] as const
    const previous = new Map(keys.map((key) => [key, process.env[key]]))
    process.env.GIT_DIR = join(repo, 'hostile-git-dir')
    process.env.GIT_WORK_TREE = join(repo, 'hostile-work-tree')
    process.env.GIT_CONFIG_COUNT = '1'
    try {
      const result = await new GitService().snapshot(repo)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data.repoRoot).toBe(repo)
      expect(result.data.branch).toBe('main')
    } finally {
      for (const key of keys) {
        const value = previous.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('disables a repository-local core.fsmonitor hook during automatic status', async () => {
    const marker = join(repo, 'fsmonitor-executed')
    const monitor = join(repo, 'hostile-fsmonitor.sh')
    writeFileSync(monitor, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`)
    chmodSync(monitor, 0o755)
    runGit(repo, ['config', 'core.fsmonitor', monitor])

    const result = await new GitService().snapshot(repo)

    expect(result.ok).toBe(true)
    expect(existsSync(marker)).toBe(false)
  })

  it('fails closed before repository-local clean filters can run', async () => {
    const marker = join(repo, 'filter-executed')
    const filter = join(repo, 'hostile-filter.sh')
    writeFileSync(filter, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\ncat\n`)
    chmodSync(filter, 0o755)
    writeFileSync(join(repo, '.gitattributes'), 'README.md filter=hostile\n')
    runGit(repo, ['config', 'filter.hostile.clean', filter])

    const result = await new GitService().snapshot(repo)

    expect(result).toEqual({
      ok: false,
      error: 'Repository-local Git filter commands are not executed by TaskWraith (filter.hostile.clean).'
    })
    expect(existsSync(marker)).toBe(false)
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

  it('lists, creates, and checks out local branches with a dirty checkout guard', async () => {
    const service = new GitService()

    const created = await service.createBranch({
      repoPath: repo,
      branch: 'feature/task',
      from: 'main'
    })
    expect(created.ok).toBe(true)

    const branches = await service.listBranches(repo)
    expect(branches.ok).toBe(true)
    if (!branches.ok) return
    expect(branches.data.branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'main', isCurrent: true }),
        expect.objectContaining({ name: 'feature/task', isCurrent: false })
      ])
    )

    writeFileSync(join(repo, 'dirty.txt'), 'dirty\n')
    await expect(service.checkoutBranch({ repoPath: repo, branch: 'feature/task' })).resolves.toEqual({
      ok: false,
      error: 'Commit, stash, or discard current changes before checking out another branch.'
    })
    rmSync(join(repo, 'dirty.txt'), { force: true })

    const checkout = await service.checkoutBranch({ repoPath: repo, branch: 'feature/task' })
    expect(checkout.ok).toBe(true)
    if (!checkout.ok) return
    expect(checkout.data.branch).toBe('feature/task')
  })

  it('creates, lists, selects, and removes an isolated worktree', async () => {
    const service = new GitService()
    const target = join(tmpdir(), `taskwraith-worktree-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    extraTempPaths.push(target)
    worktreeCleanupPaths.push(target)

    const created = await service.createWorktree({
      repoPath: repo,
      path: target,
      branch: 'feature/isolated'
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const gitTargetRoot = runGit(target, ['rev-parse', '--show-toplevel']).trim()
    expect(comparablePath(created.data.repoRoot)).toBe(comparablePath(gitTargetRoot))
    expect(created.data.branch).toBe('feature/isolated')

    const listed = await service.listWorktrees(repo)
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    const comparableWorktrees = listed.data.worktrees.map((worktree) => ({
      ...worktree,
      path: comparablePath(worktree.path)
    }))
    expect(comparableWorktrees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: comparablePath(repo), branch: 'main', isCurrent: true }),
        expect.objectContaining({
          path: comparablePath(gitTargetRoot),
          branch: 'feature/isolated',
          isCurrent: false
        })
      ])
    )

    const selected = await service.selectWorktree({ repoPath: repo, path: gitTargetRoot })
    expect(selected.ok).toBe(true)
    if (!selected.ok) return
    expect(selected.data.branch).toBe('feature/isolated')

    const removed = await service.removeWorktree({ repoPath: repo, path: gitTargetRoot })
    expect(removed.ok).toBe(true)
  }, WORKTREE_LIFECYCLE_TIMEOUT_MS)

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

  it('rejects executable local transport config for an externally granted repository', async () => {
    addBareRemote()
    const marker = join(repo, 'receive-pack-ran')
    runGit(repo, [
      'config',
      'remote.origin.receivepack',
      `sh -c 'touch ${marker}'`
    ])

    const result = await new GitService().push({
      repoPath: repo,
      externalRepository: true
    })

    expect(result).toMatchObject({ ok: false })
    if (result.ok) return
    expect(result.error).toContain('remote.origin.receivepack')
    expect(existsSync(marker)).toBe(false)
  })

  it('rejects local-file remotes for an externally granted repository', async () => {
    addBareRemote()

    const result = await new GitService().push({
      repoPath: repo,
      externalRepository: true
    })

    expect(result).toEqual({
      ok: false,
      error: 'Externally granted repositories can push only to explicit HTTPS or SSH remotes.'
    })
  })

  it('rejects repository-local URL rewrites before an external push', async () => {
    addBareRemote()
    runGit(repo, ['remote', 'set-url', 'origin', 'https://github.com/acme/repo.git'])
    runGit(repo, ['config', 'url.file:///tmp/redirect/.insteadOf', 'https://github.com/'])

    const result = await new GitService().push({
      repoPath: repo,
      externalRepository: true
    })

    expect(result).toMatchObject({ ok: false })
    if (result.ok) return
    expect(result.error).toContain('url.file:///tmp/redirect/.insteadof')
  })

  it('pins the receive-pack executable for ordinary pushes', async () => {
    addBareRemote()
    writeFileSync(join(repo, 'push.txt'), 'push\n')
    runGit(repo, ['add', 'push.txt'])
    runGit(repo, ['commit', '-m', 'Push test'])

    const result = await new GitService().push({ repoPath: repo })

    expect(result.ok).toBe(true)
    expect(runGit(repo, ['status', '--short'])).toBe('')
  }, 30_000)

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

  it('reads CI status through gh, redacts failed logs, and returns repair guardrails', async () => {
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ scripts: { ci: 'npm run test', test: 'vitest run' } })
    )
    const calls: Array<{ command: string; args: string[]; cwd: string; env?: Record<string, string> }> = []
    const runner: GitCommandRunner = async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd, env: options.env })
      if (command === 'gh') {
        if (args.join(' ') === 'auth status') {
          return { stdout: 'Logged in to github.com\n', stderr: '', code: 0 }
        }
        if (args[0] === 'pr' && args[1] === 'view') {
          return {
            stdout: JSON.stringify({
              number: 42,
              url: 'https://github.com/boggspa/TaskWraith/pull/42',
              state: 'OPEN',
              isDraft: false,
              headRefName: 'main',
              headRefOid: '0123456789abcdef0123456789abcdef01234567',
              baseRefName: 'master',
              mergeStateStatus: 'BLOCKED',
              statusCheckRollup: [
                {
                  name: 'test',
                  status: 'COMPLETED',
                  conclusion: 'FAILURE',
                  detailsUrl: 'https://github.com/boggspa/TaskWraith/actions/runs/99'
                }
              ]
            }),
            stderr: '',
            code: 0
          }
        }
        if (args[0] === 'run' && args[1] === 'list') {
          return {
            stdout: JSON.stringify([
              {
                databaseId: 99,
                displayTitle: 'CI',
                workflowName: 'Test',
                status: 'completed',
                conclusion: 'failure',
                headSha: '0123456789abcdef0123456789abcdef01234567',
                event: 'pull_request',
                url: 'https://github.com/boggspa/TaskWraith/actions/runs/99',
                createdAt: '2026-07-05T18:00:00Z',
                updatedAt: '2026-07-05T18:03:00Z'
              }
            ]),
            stderr: '',
            code: 0
          }
        }
        if (args[0] === 'run' && args[1] === 'view') {
          return {
            stdout:
              'test\tFAIL src/main/example.test.ts\nAuthorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz123456\nError: expected true to be false\n',
            stderr: '',
            code: 0
          }
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

    const result = await new GitService({ run: runner }).ciStatus({
      repoPath: repo,
      includeFailedLogs: true,
      repairAttempt: 1,
      maxRepairPushes: 3
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.status).toBe('failed')
    expect(result.data.binding.pr?.number).toBe(42)
    expect(result.data.runs[0]).toMatchObject({ id: 99, conclusion: 'failure' })
    expect(result.data.failedLogs[0]?.log).toContain('[redacted]')
    expect(result.data.failedLogs[0]?.log).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456')
    expect(result.data.failedLogs[0]?.hints).toEqual(
      expect.arrayContaining([
        expect.stringContaining('FAIL src/main/example.test.ts'),
        'Error: expected true to be false'
      ])
    )
    expect(result.data.localVerification.recommendedCommands).toEqual(['npm run ci', 'npm run test'])
    expect(result.data.repairLoop).toMatchObject({
      repairAttempt: 1,
      maxRepairPushes: 3,
      shouldStop: false,
      requireLocalVerification: true,
      nextSuggestedAction: 'repair_and_test_before_push'
    })
    expect(calls.find((call) => call.command === 'gh')?.env).toEqual({ GH_PROMPT_DISABLED: '1' })
  })

  // `autoMergeRequest` is how a PR reports "accepted for merge, not landed
  // yet" (merge queue / auto-merge armed) — the sidebar's orange state.
  it('requests autoMergeRequest and collapses it to a boolean on the PR summary', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'tw-git-automerge-'))
    spawnSync('git', ['init'], { cwd: repo })
    const prViewArgs: string[][] = []
    const runner: GitCommandRunner = async (command, args, options) => {
      if (command === 'gh') {
        if (args.join(' ') === 'auth status') {
          return { stdout: 'Logged in to github.com\n', stderr: '', code: 0 }
        }
        if (args[0] === 'pr' && args[1] === 'view') {
          prViewArgs.push(args)
          return {
            stdout: JSON.stringify({
              number: 7,
              state: 'OPEN',
              mergeStateStatus: 'CLEAN',
              autoMergeRequest: { enabledAt: '2026-07-27T10:00:00Z', mergeMethod: 'SQUASH' }
            }),
            stderr: '',
            code: 0
          }
        }
        if (args[0] === 'run') return { stdout: '[]', stderr: '', code: 0 }
      }
      const git = spawnSync(command, args, {
        cwd: options.cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      })
      return { stdout: git.stdout || '', stderr: git.stderr || '', code: git.status ?? 0 }
    }

    const result = await new GitService({ run: runner }).ciStatus({ repoPath: repo })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(prViewArgs[0]?.join(' ')).toContain('autoMergeRequest')
    expect(result.data.binding.pr?.autoMergeEnabled).toBe(true)
  })

  it('leaves autoMergeEnabled unset when auto-merge is not armed', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'tw-git-no-automerge-'))
    spawnSync('git', ['init'], { cwd: repo })
    const runner: GitCommandRunner = async (command, args, options) => {
      if (command === 'gh') {
        if (args.join(' ') === 'auth status') {
          return { stdout: 'Logged in to github.com\n', stderr: '', code: 0 }
        }
        if (args[0] === 'pr' && args[1] === 'view') {
          return {
            stdout: JSON.stringify({ number: 7, state: 'OPEN', autoMergeRequest: null }),
            stderr: '',
            code: 0
          }
        }
        if (args[0] === 'run') return { stdout: '[]', stderr: '', code: 0 }
      }
      const git = spawnSync(command, args, {
        cwd: options.cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      })
      return { stdout: git.stdout || '', stderr: git.stderr || '', code: git.status ?? 0 }
    }

    const result = await new GitService({ run: runner }).ciStatus({ repoPath: repo })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.binding.pr?.autoMergeEnabled).toBeUndefined()
  })

  it('returns a blocked CI status when gh is not authenticated', async () => {
    const result = await new GitService({
      run: async (command, args, options) => {
        if (command === 'gh') {
          return { stdout: '', stderr: 'You are not logged into any GitHub hosts', code: 1 }
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
    }).ciStatus({ repoPath: repo })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.status).toBe('blocked')
    expect(result.data.warnings[0]).toContain('not logged')
    expect(result.data.repairLoop.nextSuggestedAction).toBe('ask_user')
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

  it(
    'captures a candidate worktree patch (tracked edits AND untracked files) and applies it to the primary tree uncommitted',
    async () => {
      const service = new GitService()
      const created = await service.createWorktree({
        repoPath: repo,
        name: 'candidate-a',
        branch: 'taskwraith/fanout-candidate-a'
      })
      expect(created.ok).toBe(true)
      if (!created.ok) return
      const worktreePath = created.data.repoRoot
      worktreeCleanupPaths.push(worktreePath)

      writeFileSync(join(worktreePath, 'README.md'), 'initial\ncandidate change\n')
      writeFileSync(join(worktreePath, 'brand-new.txt'), 'untracked content\n')

      const capture = await service.captureWorktreePatch({ worktreePath })
      expect(capture.ok).toBe(true)
      if (!capture.ok) return
      expect(capture.data.clean).toBe(false)
      expect(capture.data.totals.files).toBe(2)
      const paths = capture.data.numstat.map((entry) => entry.path).sort()
      expect(paths).toEqual(['README.md', 'brand-new.txt'])

      const verifiedTargetPaths = [join(repo, 'README.md'), join(repo, 'brand-new.txt')]
      await expect(
        service.inspectPatchApplication({
          repoPath: repo,
          patch: capture.data.patch,
          verifiedTargetPaths
        })
      ).resolves.toMatchObject({ ok: true, data: { state: 'applicable' } })
      const applied = await service.applyPatchToRepository({
        repoPath: repo,
        patch: capture.data.patch,
        verifiedTargetPaths
      })
      expect(applied.ok).toBe(true)
      if (!applied.ok) return
      await expect(
        service.inspectPatchApplication({
          repoPath: repo,
          patch: capture.data.patch,
          verifiedTargetPaths
        })
      ).resolves.toMatchObject({ ok: true, data: { state: 'already-applied' } })
      // Winner lands as ordinary uncommitted changes — nothing auto-committed.
      expect(applied.data.counts.changed).toBe(2)
      expect(runGit(repo, ['log', '--oneline']).trim().split('\n')).toHaveLength(1)
      expect(runGit(repo, ['status', '--porcelain'])).toContain('brand-new.txt')
    },
    WORKTREE_LIFECYCLE_TIMEOUT_MS
  )

  it(
    'reports a clean capture for an untouched candidate worktree',
    async () => {
      const service = new GitService()
      const created = await service.createWorktree({
        repoPath: repo,
        name: 'candidate-clean',
        branch: 'taskwraith/fanout-candidate-clean'
      })
      expect(created.ok).toBe(true)
      if (!created.ok) return
      worktreeCleanupPaths.push(created.data.repoRoot)

      const capture = await service.captureWorktreePatch({ worktreePath: created.data.repoRoot })
      expect(capture.ok).toBe(true)
      if (!capture.ok) return
      expect(capture.data.clean).toBe(true)
      expect(capture.data.totals).toEqual({ files: 0, insertions: 0, deletions: 0 })
    },
    WORKTREE_LIFECYCLE_TIMEOUT_MS
  )

  it(
    'refuses to apply a drifted patch by default without touching the working tree',
    async () => {
      const service = new GitService()
      const created = await service.createWorktree({
        repoPath: repo,
        name: 'candidate-drift',
        branch: 'taskwraith/fanout-candidate-drift'
      })
      expect(created.ok).toBe(true)
      if (!created.ok) return
      worktreeCleanupPaths.push(created.data.repoRoot)

      writeFileSync(join(created.data.repoRoot, 'README.md'), 'initial\nfrom candidate\n')
      const capture = await service.captureWorktreePatch({ worktreePath: created.data.repoRoot })
      expect(capture.ok).toBe(true)
      if (!capture.ok) return

      // The primary tree drifts incompatibly before adjudication.
      writeFileSync(join(repo, 'README.md'), 'rewritten upstream\n')
      const applied = await service.applyPatchToRepository({
        repoPath: repo,
        patch: capture.data.patch
      })
      expect(applied.ok).toBe(false)
      if (applied.ok) return
      expect(applied.error).toContain('no longer applies cleanly')
      // Refusal must not have mutated the drifted file.
      expect(runGit(repo, ['status', '--porcelain']).trim()).toBe('M README.md')
      expect(runGit(repo, ['diff', '--', 'README.md'])).not.toContain('from candidate')
    },
    WORKTREE_LIFECYCLE_TIMEOUT_MS
  )

  it(
    'refuses a candidate patch whose targets differ from its verified lock capabilities',
    async () => {
      const service = new GitService()
      const created = await service.createWorktree({
        repoPath: repo,
        name: 'candidate-capability-mismatch',
        branch: 'taskwraith/fanout-candidate-capability-mismatch'
      })
      expect(created.ok).toBe(true)
      if (!created.ok) return
      worktreeCleanupPaths.push(created.data.repoRoot)

      writeFileSync(join(created.data.repoRoot, 'README.md'), 'initial\ncandidate change\n')
      const capture = await service.captureWorktreePatch({ worktreePath: created.data.repoRoot })
      expect(capture.ok).toBe(true)
      if (!capture.ok) return

      const applied = await service.applyPatchToRepository({
        repoPath: repo,
        patch: capture.data.patch,
        verifiedTargetPaths: [join(repo, 'different.txt')]
      })

      expect(applied).toMatchObject({
        ok: false,
        error: expect.stringContaining('freshly verified lock capabilities')
      })
      expect(runGit(repo, ['status', '--porcelain']).trim()).toBe('')
    },
    WORKTREE_LIFECYCLE_TIMEOUT_MS
  )

  it(
    'rejects an empty candidate patch instead of silently no-opping',
    async () => {
      const result = await new GitService().applyPatchToRepository({ repoPath: repo, patch: '   ' })
      expect(result).toEqual({
        ok: false,
        error: 'The candidate patch is empty; nothing to apply.'
      })
    },
    WORKTREE_LIFECYCLE_TIMEOUT_MS
  )

  it(
    'deletes a candidate branch after its worktree is removed, and refuses the checked-out branch',
    async () => {
      const service = new GitService()
      const created = await service.createWorktree({
        repoPath: repo,
        name: 'candidate-del',
        branch: 'taskwraith/fanout-candidate-del'
      })
      expect(created.ok).toBe(true)
      if (!created.ok) return

      const checkedOut = await service.deleteBranch({
        repoPath: repo,
        branch: 'taskwraith/fanout-candidate-del',
        force: true
      })
      expect(checkedOut.ok).toBe(false)

      const removed = await service.removeWorktree({
        repoPath: repo,
        path: created.data.repoRoot,
        force: true
      })
      expect(removed.ok).toBe(true)

      const deleted = await service.deleteBranch({
        repoPath: repo,
        branch: 'taskwraith/fanout-candidate-del',
        force: true
      })
      expect(deleted).toEqual({ ok: true, data: { branch: 'taskwraith/fanout-candidate-del' } })
      expect(runGit(repo, ['branch', '--list', 'taskwraith/fanout-candidate-del']).trim()).toBe('')
    },
    WORKTREE_LIFECYCLE_TIMEOUT_MS
  )
})

describe('parseDiffNumstat', () => {
  it('parses counts, binary markers, and rename display paths', () => {
    const entries = parseDiffNumstat(
      ['12\t3\tsrc/app.ts', '-\t-\tassets/logo.png', '1\t0\tdir/{old.ts => new.ts}', '', 'garbage-line'].join('\n')
    )
    expect(entries).toEqual([
      { path: 'src/app.ts', insertions: 12, deletions: 3, binary: false },
      { path: 'assets/logo.png', insertions: null, deletions: null, binary: true },
      { path: 'dir/{old.ts => new.ts}', insertions: 1, deletions: 0, binary: false }
    ])
  })

  it('returns an empty list for empty output', () => {
    expect(parseDiffNumstat('')).toEqual([])
    expect(parseDiffNumstat('\n\n')).toEqual([])
  })
})
