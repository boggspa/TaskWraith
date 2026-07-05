import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'path'
import { scrubCliEnv } from '../CliEnvSecurity'

const DEFAULT_TIMEOUT_MS = 30_000

export interface GitCommandResult {
  stdout: string
  stderr: string
  code: number
}

export interface GitCommandOptions {
  cwd: string
  timeoutMs?: number
  env?: Record<string, string>
}

export interface GitCommandRunner {
  (command: string, args: string[], options: GitCommandOptions): Promise<GitCommandResult>
}

export interface GitFileStatus {
  path: string
  originalPath?: string
  index: string
  workingTree: string
  kind: 'created' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted' | 'ignored'
  staged: boolean
  unstaged: boolean
}

/** An in-progress multi-step git operation that leaves the worktree mid-state. */
export type GitMergeState = 'merge' | 'rebase' | 'cherry-pick' | null

export interface GitRepositorySnapshot {
  requestedPath: string
  repoRoot: string
  branch?: string
  commit?: string
  detached: boolean
  upstream?: string
  remoteName?: string
  remoteUrl?: string
  ahead: number
  behind: number
  files: GitFileStatus[]
  counts: {
    changed: number
    staged: number
    unstaged: number
    untracked: number
  }
  clean: boolean
  /** In-progress merge/rebase/cherry-pick, or null for a normal tree. */
  mergeState: GitMergeState
  /** Number of unmerged (conflicted) files in the worktree. */
  conflicts: number
  /** Added/deleted lines vs HEAD (tracked changes; untracked-file lines excluded). */
  lineStats: { additions: number; deletions: number }
}

export interface GitPrSummary {
  number?: number
  url?: string
  state?: string
  isDraft?: boolean
  headRefName?: string
  headRefOid?: string
  baseRefName?: string
  mergeStateStatus?: string
  checks?: Array<{
    name?: string
    status?: string
    conclusion?: string
    url?: string
  }>
}

export type GitCiStatusKind = 'passed' | 'failed' | 'pending' | 'blocked' | 'unknown'

export interface GitCiRunSummary {
  id: number
  name?: string
  workflowName?: string
  status?: string
  conclusion?: string
  headSha?: string
  event?: string
  url?: string
  createdAt?: string
  updatedAt?: string
}

export interface GitCiFailedLog {
  runId: number
  name?: string
  exitCode: number
  timedOut: boolean
  log: string
  hints: string[]
  stderr?: string
}

export interface GitCiLocalVerification {
  recommendedCommands: string[]
  source: 'package_json' | 'swift_package' | 'generic'
}

export interface GitCiStatusInput {
  repoPath: string
  pr?: string | number
  branch?: string
  commitSha?: string
  includeFailedLogs?: boolean
  maxRuns?: number
  maxFailedLogs?: number
  maxLogChars?: number
  repairAttempt?: number
  maxRepairPushes?: number
}

export interface GitCiStatusSummary {
  status: GitCiStatusKind
  binding: {
    pr?: GitPrSummary
    branch?: string
    commitSha?: string
    currentBranch?: string
    currentHeadSha?: string
  }
  checks: NonNullable<GitPrSummary['checks']>
  runs: GitCiRunSummary[]
  failedLogs: GitCiFailedLog[]
  localVerification: GitCiLocalVerification
  repairLoop: {
    repairAttempt: number
    maxRepairPushes: number
    shouldStop: boolean
    requireLocalVerification: boolean
    nextSuggestedAction:
      | 'done'
      | 'wait_for_ci'
      | 'repair_and_test_before_push'
      | 'inspect'
      | 'ask_user'
  }
  warnings: string[]
}

export interface GitPrReadiness {
  snapshot: GitRepositorySnapshot
  existingPullRequest?: GitPrSummary
  canCreatePullRequest: boolean
  shouldPushFirst: boolean
  reason?: string
  warnings: string[]
}

export type GitResult<T> = { ok: true; data: T } | { ok: false; error: string; stderr?: string }

export interface GitBranchInfo {
  name: string
  isCurrent: boolean
  isRemote?: boolean
  upstream?: string
  worktreePath?: string
}

export interface GitBranchList {
  repoRoot: string
  currentBranch?: string
  branches: GitBranchInfo[]
}

export interface GitWorktreeInfo {
  path: string
  branch?: string
  head?: string
  isCurrent: boolean
  isBare?: boolean
  detached?: boolean
}

export interface GitWorktreeList {
  repoRoot: string
  worktrees: GitWorktreeInfo[]
}

export interface GitStageInput {
  repoPath: string
  paths?: string[]
  all?: boolean
  update?: boolean
  patch?: string
}

export interface GitUnstageInput {
  repoPath: string
  paths?: string[]
}

export interface GitCommitInput {
  repoPath: string
  message: string
}

export interface GitPushInput {
  repoPath: string
  setUpstream?: boolean
  remote?: string
}

export interface GitCreatePrInput {
  repoPath: string
  title?: string
  body?: string
  draft?: boolean
}

export interface GitBranchInput {
  repoPath: string
  branch: string
}

export interface GitCreateBranchInput extends GitBranchInput {
  from?: string
}

export interface GitCreateWorktreeInput {
  repoPath: string
  name?: string
  branch?: string
  path?: string
}

export interface GitRemoveWorktreeInput {
  repoPath: string
  path: string
  force?: boolean
}

export interface GitSelectWorktreeInput {
  repoPath: string
  path: string
}

export class GitService {
  private run: GitCommandRunner
  private timeoutMs: number

  constructor(options: { run?: GitCommandRunner; timeoutMs?: number } = {}) {
    this.run = options.run || runCommand
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS
  }

  async snapshot(inputPath: string): Promise<GitResult<GitRepositorySnapshot>> {
    try {
      return { ok: true, data: await this.buildSnapshot(inputPath) }
    } catch (error) {
      return failure(error)
    }
  }

  async stage(input: GitStageInput): Promise<GitResult<GitRepositorySnapshot>> {
    try {
      const repo = await this.resolveRepository(input.repoPath)
      const paths = sanitizeRepoPaths(
        input.paths,
        repo.repoRoot,
        await pathBaseForRepoPaths(repo.requestedPath)
      )
      if (input.patch && input.patch.trim()) {
        return {
          ok: false,
          error: 'Patch staging is not available through the desktop Git service yet.'
        }
      }
      if (input.all) {
        await this.mustRun('git', ['add', '-A'], repo.repoRoot)
      } else if (input.update) {
        await this.mustRun('git', ['add', '-u'], repo.repoRoot)
      } else if (paths.length > 0) {
        await this.mustRun('git', ['add', '--', ...paths], repo.repoRoot)
      } else {
        return { ok: false, error: 'Choose files to stage or pass all=true.' }
      }
      return { ok: true, data: await this.buildSnapshot(repo.repoRoot) }
    } catch (error) {
      return failure(error)
    }
  }

  async unstage(input: GitUnstageInput): Promise<GitResult<GitRepositorySnapshot>> {
    try {
      const repo = await this.resolveRepository(input.repoPath)
      const paths = sanitizeRepoPaths(
        input.paths,
        repo.repoRoot,
        await pathBaseForRepoPaths(repo.requestedPath)
      )
      if (paths.length === 0) {
        return { ok: false, error: 'Choose files to unstage.' }
      }
      await this.mustRun('git', ['reset', '--', ...paths], repo.repoRoot)
      return { ok: true, data: await this.buildSnapshot(repo.repoRoot) }
    } catch (error) {
      return failure(error)
    }
  }

  async commit(input: GitCommitInput): Promise<GitResult<GitRepositorySnapshot>> {
    try {
      const message = input.message.trim()
      if (!message) return { ok: false, error: 'Commit message is required.' }
      const repo = await this.resolveRepository(input.repoPath)
      const staged = await this.run('git', ['diff', '--cached', '--quiet'], {
        cwd: repo.repoRoot,
        timeoutMs: this.timeoutMs
      })
      if (staged.code === 0) return { ok: false, error: 'No staged changes to commit.' }
      await this.mustRun('git', ['commit', '-m', message], repo.repoRoot)
      return { ok: true, data: await this.buildSnapshot(repo.repoRoot) }
    } catch (error) {
      return failure(error)
    }
  }

  async push(input: GitPushInput): Promise<GitResult<GitRepositorySnapshot>> {
    try {
      const snapshot = await this.buildSnapshot(input.repoPath)
      if (snapshot.detached || !snapshot.branch) {
        return { ok: false, error: 'Cannot push from a detached HEAD. Create or switch to a branch first.' }
      }
      if (!snapshot.remoteUrl && !input.remote?.trim()) {
        return { ok: false, error: 'No git remote is configured. Add a remote before pushing.' }
      }
      const remote = input.remote?.trim() || snapshot.remoteName || 'origin'
      const args =
        snapshot.upstream && !input.setUpstream
          ? ['push']
          : ['push', '-u', remote, snapshot.branch]
      await this.mustRun('git', args, snapshot.repoRoot)
      return { ok: true, data: await this.buildSnapshot(snapshot.repoRoot) }
    } catch (error) {
      return failure(error)
    }
  }

  async listBranches(inputPath: string): Promise<GitResult<GitBranchList>> {
    try {
      const repo = await this.resolveRepository(inputPath)
      const current = await this.run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
        cwd: repo.repoRoot,
        timeoutMs: this.timeoutMs
      })
      const result = await this.mustRun(
        'git',
        ['for-each-ref', '--format=%(refname:short)%09%(upstream:short)%09%(worktreepath)', 'refs/heads'],
        repo.repoRoot
      )
      const currentBranch = current.code === 0 ? current.stdout.trim() : undefined
      return {
        ok: true,
        data: {
          repoRoot: repo.repoRoot,
          currentBranch,
          branches: parseBranchList(result.stdout, currentBranch)
        }
      }
    } catch (error) {
      return failure(error)
    }
  }

  async createBranch(input: GitCreateBranchInput): Promise<GitResult<GitRepositorySnapshot>> {
    try {
      const repo = await this.resolveRepository(input.repoPath)
      const branch = await this.assertBranchName(repo.repoRoot, input.branch)
      const from = sanitizeStartPoint(input.from)
      await this.mustRun('git', ['branch', branch, ...(from ? [from] : [])], repo.repoRoot)
      return { ok: true, data: await this.buildSnapshot(repo.repoRoot) }
    } catch (error) {
      return failure(error)
    }
  }

  async checkoutBranch(input: GitBranchInput): Promise<GitResult<GitRepositorySnapshot>> {
    try {
      const snapshot = await this.buildSnapshot(input.repoPath)
      if (!snapshot.clean) {
        return {
          ok: false,
          error: 'Commit, stash, or discard current changes before checking out another branch.'
        }
      }
      const branch = await this.assertBranchName(snapshot.repoRoot, input.branch)
      await this.mustRun('git', ['checkout', branch], snapshot.repoRoot)
      return { ok: true, data: await this.buildSnapshot(snapshot.repoRoot) }
    } catch (error) {
      return failure(error)
    }
  }

  async listWorktrees(inputPath: string): Promise<GitResult<GitWorktreeList>> {
    try {
      const repo = await this.resolveRepository(inputPath)
      const result = await this.mustRun('git', ['worktree', 'list', '--porcelain'], repo.repoRoot)
      return {
        ok: true,
        data: {
          repoRoot: repo.repoRoot,
          worktrees: parseWorktreeList(result.stdout, repo.repoRoot)
        }
      }
    } catch (error) {
      return failure(error)
    }
  }

  async createWorktree(input: GitCreateWorktreeInput): Promise<GitResult<GitRepositorySnapshot>> {
    try {
      const repo = await this.resolveRepository(input.repoPath)
      const branch = input.branch?.trim()
        ? await this.assertBranchName(repo.repoRoot, input.branch)
        : undefined
      const targetPath = resolveWorktreeTargetPath(repo.repoRoot, input)
      const args = ['worktree', 'add']
      if (branch) {
        const exists = await this.branchExists(repo.repoRoot, branch)
        if (!exists) args.push('-b', branch)
        args.push(targetPath, exists ? branch : 'HEAD')
      } else {
        args.push(targetPath)
      }
      await this.mustRun('git', args, repo.repoRoot)
      return { ok: true, data: await this.buildSnapshot(targetPath) }
    } catch (error) {
      return failure(error)
    }
  }

  async removeWorktree(input: GitRemoveWorktreeInput): Promise<GitResult<GitRepositorySnapshot>> {
    try {
      const repo = await this.resolveRepository(input.repoPath)
      const rawPath = String(input.path || '').trim()
      if (!rawPath) return { ok: false, error: 'Worktree path is required.' }
      const targetPath = resolve(rawPath)
      if (targetPath === repo.repoRoot) {
        return { ok: false, error: 'The primary repository worktree cannot be removed here.' }
      }
      if (!input.force) {
        const targetSnapshot = await this.snapshot(targetPath)
        if (targetSnapshot.ok && !targetSnapshot.data.clean) {
          return {
            ok: false,
            error: 'Worktree has local changes. Commit, stash, or pass force=true before removing it.'
          }
        }
      }
      await this.mustRun(
        'git',
        ['worktree', 'remove', ...(input.force ? ['--force'] : []), targetPath],
        repo.repoRoot
      )
      return { ok: true, data: await this.buildSnapshot(repo.repoRoot) }
    } catch (error) {
      return failure(error)
    }
  }

  async selectWorktree(input: GitSelectWorktreeInput): Promise<GitResult<GitRepositorySnapshot>> {
    return this.snapshot(input.path)
  }

  async createPullRequest(input: GitCreatePrInput): Promise<GitResult<GitPrSummary>> {
    try {
      const snapshot = await this.buildSnapshot(input.repoPath)
      if (snapshot.detached || !snapshot.branch) {
        return { ok: false, error: 'Cannot create a pull request from a detached HEAD.' }
      }
      if (!snapshot.remoteUrl) {
        return { ok: false, error: 'No git remote is configured. Add and push to a remote before creating a pull request.' }
      }
      if (!snapshot.upstream || snapshot.ahead > 0) {
        return { ok: false, error: 'Push the current branch before creating a pull request.' }
      }
      const existingPr = await this.readPullRequestSummary(snapshot.repoRoot)
      if (existingPr.ok && existingPr.summary?.url) {
        return { ok: false, error: 'This branch already has a pull request.', stderr: existingPr.summary.url }
      }
      const args = ['pr', 'create']
      const title = input.title?.trim() || ''
      const body = input.body?.trim() || ''
      if (title) args.push('--title', title)
      if (body) args.push('--body', body)
      if (!title && !body) args.push('--fill')
      if (input.draft) args.push('--draft')

      const result = await this.runGh(args, snapshot.repoRoot)
      if (result.code !== 0) {
        return {
          ok: false,
          error: result.stderr.trim() || result.stdout.trim() || '`gh pr create` failed.',
          stderr: result.stderr.trim() || undefined
        }
      }
      return {
        ok: true,
        data: {
          url: result.stdout.trim().match(/https?:\/\/[^\s]+/)?.[0],
          headRefName: snapshot.branch
        }
      }
    } catch (error) {
      return failure(error)
    }
  }

  async pullRequestStatus(inputPath: string): Promise<GitResult<GitPrSummary>> {
    try {
      const snapshot = await this.buildSnapshot(inputPath)
      if (snapshot.detached || !snapshot.branch) {
        return { ok: false, error: 'Cannot read pull request status from a detached HEAD.' }
      }
      const existingPr = await this.readPullRequestSummary(snapshot.repoRoot)
      if (!existingPr.ok) {
        return {
          ok: false,
          error: existingPr.error,
          stderr: existingPr.stderr
        }
      }
      if (!existingPr.summary) {
        return { ok: false, error: 'No pull request found for the current branch.' }
      }
      return { ok: true, data: existingPr.summary }
    } catch (error) {
      return failure(error)
    }
  }

  async ciStatus(input: GitCiStatusInput): Promise<GitResult<GitCiStatusSummary>> {
    try {
      const repo = await this.resolveRepository(input.repoPath)
      const snapshot = await this.buildSnapshot(repo.repoRoot)
      const maxRuns = clampInteger(input.maxRuns, 10, 1, 50)
      const maxFailedLogs = clampInteger(input.maxFailedLogs, 2, 0, 10)
      const maxLogChars = clampInteger(input.maxLogChars, 20_000, 1_000, 100_000)
      const repairAttempt = clampInteger(input.repairAttempt, 0, 0, 1_000)
      const maxRepairPushes = clampInteger(input.maxRepairPushes, 3, 1, 20)

      const auth = await this.runGh(['auth', 'status'], repo.repoRoot)
      if (auth.code !== 0) {
        return {
          ok: true,
          data: {
            status: 'blocked',
            binding: {
              branch: snapshot.branch,
              commitSha: snapshot.commit,
              currentBranch: snapshot.branch,
              currentHeadSha: snapshot.commit
            },
            checks: [],
            runs: [],
            failedLogs: [],
            localVerification: await detectCiLocalVerification(repo.repoRoot),
            repairLoop: ciRepairLoop('blocked', repairAttempt, maxRepairPushes),
            warnings: [
              auth.stderr.trim() ||
                auth.stdout.trim() ||
                'GitHub CLI is not authenticated or is unavailable.'
            ]
          }
        }
      }

      const requestedBranch = input.branch?.trim()
      const branch = requestedBranch ? await this.assertBranchName(repo.repoRoot, requestedBranch) : snapshot.branch
      const currentHeadSha = await this.readHeadSha(repo.repoRoot)
      const requestedSha = sanitizeCommitSha(input.commitSha)
      const prSelector = sanitizeGhSelector(input.pr)
      const prResult = await this.readPullRequestSummary(
        repo.repoRoot,
        prSelector || branch || undefined
      )
      const pr = prResult.ok ? prResult.summary : undefined
      const effectiveBranch = branch || pr?.headRefName
      const effectiveSha = requestedSha || pr?.headRefOid || currentHeadSha
      const runArgs = [
        'run',
        'list',
        '--limit',
        String(maxRuns),
        '--json',
        'databaseId,displayTitle,status,conclusion,workflowName,headSha,event,url,createdAt,updatedAt'
      ]
      if (effectiveBranch) runArgs.push('--branch', effectiveBranch)
      if (effectiveSha) runArgs.push('--commit', effectiveSha)
      const runResult = await this.runGh(runArgs, repo.repoRoot)
      if (runResult.code !== 0) {
        return {
          ok: true,
          data: {
            status: 'blocked',
            binding: {
              ...(pr ? { pr } : {}),
              branch: effectiveBranch,
              commitSha: effectiveSha,
              currentBranch: snapshot.branch,
              currentHeadSha
            },
            checks: pr?.checks ?? [],
            runs: [],
            failedLogs: [],
            localVerification: await detectCiLocalVerification(repo.repoRoot),
            repairLoop: ciRepairLoop('blocked', repairAttempt, maxRepairPushes),
            warnings: [
              runResult.stderr.trim() || runResult.stdout.trim() || '`gh run list` failed.'
            ]
          }
        }
      }

      const runs = parseGhRunList(runResult.stdout)
      const failedRuns = runs.filter(isFailedCiRun)
      const failedLogs =
        input.includeFailedLogs && maxFailedLogs > 0
          ? await this.readFailedCiLogs(repo.repoRoot, failedRuns.slice(0, maxFailedLogs), maxLogChars)
          : []
      const checks = pr?.checks ?? []
      const status = classifyCiStatus(runs, checks, repairAttempt, maxRepairPushes)
      const warnings: string[] = []
      if (!pr && prResult.ok) warnings.push('No pull request found for the selected branch.')
      if (!prResult.ok) warnings.push(prResult.error)
      if (runs.length === 0) warnings.push('No GitHub Actions runs matched the selected branch/SHA.')

      return {
        ok: true,
        data: {
          status,
          binding: {
            ...(pr ? { pr } : {}),
            branch: effectiveBranch,
            commitSha: effectiveSha,
            currentBranch: snapshot.branch,
            currentHeadSha
          },
          checks,
          runs,
          failedLogs,
          localVerification: await detectCiLocalVerification(repo.repoRoot),
          repairLoop: ciRepairLoop(status, repairAttempt, maxRepairPushes),
          warnings
        }
      }
    } catch (error) {
      return failure(error)
    }
  }

  async pullRequestReadiness(inputPath: string): Promise<GitResult<GitPrReadiness>> {
    try {
      const snapshot = await this.buildSnapshot(inputPath)
      const warnings: string[] = []
      let existingPullRequest: GitPrSummary | undefined
      if (!snapshot.detached && snapshot.branch && snapshot.remoteUrl) {
        const existingPr = await this.readPullRequestSummary(snapshot.repoRoot)
        if (existingPr.ok) {
          existingPullRequest = existingPr.summary
        } else if (!existingPr.notFound) {
          warnings.push(existingPr.error)
        }
      }
      let reason: string | undefined
      if (snapshot.detached || !snapshot.branch) {
        reason = 'Cannot create a pull request from a detached HEAD.'
      } else if (!snapshot.remoteUrl) {
        reason = 'No git remote is configured.'
      } else if (!snapshot.upstream || snapshot.ahead > 0) {
        reason = 'Push the current branch before creating a pull request.'
      } else if (existingPullRequest?.url) {
        reason = 'This branch already has a pull request.'
      }
      const shouldPushFirst = Boolean(
        snapshot.branch && snapshot.remoteUrl && (!snapshot.upstream || snapshot.ahead > 0)
      )
      return {
        ok: true,
        data: {
          snapshot,
          ...(existingPullRequest ? { existingPullRequest } : {}),
          canCreatePullRequest: !reason,
          shouldPushFirst,
          ...(reason ? { reason } : {}),
          warnings
        }
      }
    } catch (error) {
      return failure(error)
    }
  }

  async resolveRepository(inputPath: string): Promise<{ requestedPath: string; repoRoot: string }> {
    const rawPath = expandHomePath(inputPath || '').trim()
    if (!rawPath) throw new Error('Repository path is required.')
    const requestedPath = resolve(rawPath)
    let cwd = requestedPath
    try {
      const stat = await fs.stat(requestedPath)
      if (!stat.isDirectory()) cwd = dirname(requestedPath)
    } catch {
      throw new Error('Path does not exist on disk.')
    }
    const result = await this.run('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      timeoutMs: this.timeoutMs
    })
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || 'Path is not inside a git repository.')
    }
    return {
      requestedPath,
      repoRoot: result.stdout.trim()
    }
  }

  private async readPullRequestSummary(repoRoot: string, selector?: string): Promise<
    | { ok: true; summary?: GitPrSummary }
    | { ok: false; error: string; stderr?: string; notFound?: boolean }
  > {
    const result = await this.runGh(
      [
        'pr',
        'view',
        ...(selector ? [selector] : []),
        '--json',
        'number,url,state,isDraft,headRefName,headRefOid,baseRefName,mergeStateStatus,statusCheckRollup'
      ],
      repoRoot
    )
    if (result.code !== 0) {
      const stderr = result.stderr.trim()
      const stdout = result.stdout.trim()
      const message = stderr || stdout || '`gh pr view` failed.'
      if (isNoPullRequestMessage(message)) {
        return { ok: true }
      }
      return {
        ok: false,
        error: message,
        stderr: stderr || undefined
      }
    }
    return { ok: true, summary: parsePullRequestSummary(result.stdout) }
  }

  private async readHeadSha(repoRoot: string): Promise<string | undefined> {
    const result = await this.run('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      timeoutMs: this.timeoutMs
    })
    return result.code === 0 ? result.stdout.trim() || undefined : undefined
  }

  private async readFailedCiLogs(
    repoRoot: string,
    runs: GitCiRunSummary[],
    maxLogChars: number
  ): Promise<GitCiFailedLog[]> {
    const logs: GitCiFailedLog[] = []
    for (const run of runs) {
      const result = await this.runGh(['run', 'view', String(run.id), '--log-failed'], repoRoot)
      const redacted = redactCiSecrets(result.stdout)
      logs.push({
        runId: run.id,
        name: run.name || run.workflowName,
        exitCode: result.code,
        timedOut: result.code === -1,
        log: truncateText(redacted, maxLogChars),
        hints: summarizeCiFailureHints(redacted),
        ...(result.stderr.trim() ? { stderr: truncateText(redactCiSecrets(result.stderr.trim()), 8_000) } : {})
      })
    }
    return logs
  }

  private async runGh(args: string[], cwd: string): Promise<GitCommandResult> {
    return this.run('gh', args, {
      cwd,
      timeoutMs: this.timeoutMs,
      env: { GH_PROMPT_DISABLED: '1' }
    })
  }

  private async buildSnapshot(inputPath: string): Promise<GitRepositorySnapshot> {
    const repo = await this.resolveRepository(inputPath)
    const [
      branchResult,
      commitResult,
      upstreamResult,
      remoteResult,
      statusResult,
      mergeState,
      lineStats
    ] =
      await Promise.all([
        this.run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
          cwd: repo.repoRoot,
          timeoutMs: this.timeoutMs
        }),
        this.run('git', ['rev-parse', '--short', 'HEAD'], {
          cwd: repo.repoRoot,
          timeoutMs: this.timeoutMs
        }),
        this.run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
          cwd: repo.repoRoot,
          timeoutMs: this.timeoutMs
        }),
        this.run('git', ['config', '--get', 'remote.origin.url'], {
          cwd: repo.repoRoot,
          timeoutMs: this.timeoutMs
        }),
        this.run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
          cwd: repo.repoRoot,
          timeoutMs: this.timeoutMs
        }),
        this.readMergeState(repo.repoRoot),
        this.readLineStats(repo.repoRoot)
      ])

    const branch = branchResult.code === 0 ? branchResult.stdout.trim() : undefined
    const upstream = upstreamResult.code === 0 ? upstreamResult.stdout.trim() : undefined
    const files = parseStatusPorcelainZ(statusResult.stdout)
    const aheadBehind = upstream
      ? await this.readAheadBehind(repo.repoRoot)
      : { ahead: 0, behind: 0 }

    return {
      requestedPath: repo.requestedPath,
      repoRoot: repo.repoRoot,
      branch,
      commit: commitResult.code === 0 ? commitResult.stdout.trim() : undefined,
      detached: !branch,
      upstream,
      remoteName: upstream?.includes('/') ? upstream.split('/')[0] : remoteResult.code === 0 ? 'origin' : undefined,
      remoteUrl: remoteResult.code === 0 ? remoteResult.stdout.trim() : undefined,
      ahead: aheadBehind.ahead,
      behind: aheadBehind.behind,
      files,
      counts: {
        changed: files.length,
        staged: files.filter((file) => file.staged).length,
        unstaged: files.filter((file) => file.unstaged).length,
        untracked: files.filter((file) => file.kind === 'untracked').length
      },
      clean: files.length === 0,
      mergeState,
      conflicts: files.filter((file) => file.kind === 'conflicted').length,
      lineStats
    }
  }

  /**
   * Detect an in-progress merge / rebase / cherry-pick by probing the
   * per-worktree git-dir for its marker files. `git rev-parse --git-dir`
   * resolves the correct dir for linked worktrees too. Returns null for a
   * normal tree (or when git can't be reached).
   */
  private async readMergeState(repoRoot: string): Promise<GitMergeState> {
    const gitDirResult = await this.run('git', ['rev-parse', '--git-dir'], {
      cwd: repoRoot,
      timeoutMs: this.timeoutMs
    })
    if (gitDirResult.code !== 0) return null
    const gitDir = resolve(repoRoot, gitDirResult.stdout.trim())
    const marker = async (name: string): Promise<boolean> => {
      try {
        await fs.access(join(gitDir, name))
        return true
      } catch {
        return false
      }
    }
    const [merge, rebaseMerge, rebaseApply, cherryPick] = await Promise.all([
      marker('MERGE_HEAD'),
      marker('rebase-merge'),
      marker('rebase-apply'),
      marker('CHERRY_PICK_HEAD')
    ])
    if (rebaseMerge || rebaseApply) return 'rebase'
    if (merge) return 'merge'
    if (cherryPick) return 'cherry-pick'
    return null
  }

  /**
   * Total added/deleted lines vs HEAD via `git diff --numstat HEAD` (covers
   * staged + unstaged tracked changes). Untracked-file lines are excluded —
   * they have no HEAD baseline — but counts.changed still includes the files
   * themselves. Returns zeros when there is no HEAD yet (fresh repo) or git is
   * unreachable. Binary files emit "-\t-" rows, which coerce to 0.
   */
  private async readLineStats(repoRoot: string): Promise<{ additions: number; deletions: number }> {
    const result = await this.run('git', ['diff', '--numstat', 'HEAD'], {
      cwd: repoRoot,
      timeoutMs: this.timeoutMs
    })
    if (result.code !== 0) return { additions: 0, deletions: 0 }
    let additions = 0
    let deletions = 0
    for (const line of result.stdout.split('\n')) {
      const row = line.trim()
      if (!row) continue
      const [addRaw, delRaw] = row.split('\t')
      additions += Number(addRaw) || 0
      deletions += Number(delRaw) || 0
    }
    return { additions, deletions }
  }

  private async readAheadBehind(repoRoot: string): Promise<{ ahead: number; behind: number }> {
    const result = await this.run('git', ['rev-list', '--left-right', '--count', 'HEAD...@{u}'], {
      cwd: repoRoot,
      timeoutMs: this.timeoutMs
    })
    if (result.code !== 0) return { ahead: 0, behind: 0 }
    const [aheadRaw, behindRaw] = result.stdout.trim().split(/\s+/)
    return {
      ahead: Number(aheadRaw) || 0,
      behind: Number(behindRaw) || 0
    }
  }

  private async mustRun(command: string, args: string[], cwd: string): Promise<GitCommandResult> {
    const result = await this.run(command, args, { cwd, timeoutMs: this.timeoutMs })
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} ${args.join(' ')} failed.`)
    }
    return result
  }

  private async assertBranchName(repoRoot: string, value: string): Promise<string> {
    const branch = sanitizeBranchName(value)
    await this.mustRun('git', ['check-ref-format', '--branch', branch], repoRoot)
    return branch
  }

  private async branchExists(repoRoot: string, branch: string): Promise<boolean> {
    const result = await this.run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: repoRoot,
      timeoutMs: this.timeoutMs
    })
    return result.code === 0
  }
}

export function parseStatusPorcelainZ(output: string): GitFileStatus[] {
  const entries: GitFileStatus[] = []
  const parts = output.split('\0')
  let i = 0
  while (i < parts.length) {
    const entry = parts[i]
    if (!entry || entry.length < 3) {
      i++
      continue
    }
    const index = entry[0] || ' '
    const workingTree = entry[1] || ' '
    const path = entry.slice(3)
    let originalPath: string | undefined
    if ((index === 'R' || index === 'C') && i + 1 < parts.length) {
      originalPath = parts[i + 1] || undefined
      i += 2
    } else {
      i++
    }
    entries.push({
      path,
      originalPath,
      index,
      workingTree,
      kind: classifyStatus(index, workingTree),
      staged: index !== ' ' && index !== '?' && index !== '!',
      unstaged: workingTree !== ' ' || index === '?' || index === '!'
    })
  }
  return entries
}

export function parseBranchList(output: string, currentBranch?: string): GitBranchInfo[] {
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [name = '', upstream = '', worktreePath = ''] = line.split('\t')
      return {
        name,
        isCurrent: Boolean(currentBranch && name === currentBranch),
        isRemote: false,
        ...(upstream ? { upstream } : {}),
        ...(worktreePath ? { worktreePath } : {})
      }
    })
    .filter((branch) => Boolean(branch.name))
}

export function parseWorktreeList(output: string, currentRepoRoot?: string): GitWorktreeInfo[] {
  const worktrees: GitWorktreeInfo[] = []
  let current: Partial<GitWorktreeInfo> | null = null
  const finish = (): void => {
    if (!current?.path) return
    worktrees.push({
      path: current.path,
      branch: current.branch,
      head: current.head,
      isCurrent: pathsEqual(current.path, currentRepoRoot),
      isBare: current.isBare,
      detached: current.detached
    })
  }
  for (const line of output.split('\n')) {
    const row = line.trim()
    if (!row) {
      finish()
      current = null
      continue
    }
    const [key, ...rest] = row.split(' ')
    const value = rest.join(' ')
    if (key === 'worktree') {
      finish()
      current = { path: value }
    } else if (current && key === 'HEAD') {
      current.head = value
    } else if (current && key === 'branch') {
      current.branch = value.replace(/^refs\/heads\//, '')
    } else if (current && key === 'bare') {
      current.isBare = true
    } else if (current && key === 'detached') {
      current.detached = true
    }
  }
  finish()
  return worktrees
}

async function runCommand(
  command: string,
  args: string[],
  options: GitCommandOptions
): Promise<GitCommandResult> {
  return await new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: scrubCliEnv({
        ...process.env,
        ...(command === 'gh' ? { GH_PROMPT_DISABLED: '1' } : {}),
        ...options.env
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve({ stdout, stderr: `${command} timed out after ${options.timeoutMs || DEFAULT_TIMEOUT_MS}ms.`, code: -1 })
    }, options.timeoutMs || DEFAULT_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      const message =
        error.code === 'ENOENT'
          ? `${command} is not installed or not on PATH.`
          : `Failed to launch ${command}: ${error.message}`
      resolve({ stdout, stderr: message, code: -1 })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({ stdout, stderr, code: code ?? 0 })
    })
  })
}

function classifyStatus(
  index: string,
  workingTree: string
): GitFileStatus['kind'] {
  if (index === '?' || workingTree === '?') return 'untracked'
  if (index === '!' || workingTree === '!') return 'ignored'
  if (index === 'U' || workingTree === 'U' || (index === 'A' && workingTree === 'A')) {
    return 'conflicted'
  }
  if (index === 'R' || workingTree === 'R') return 'renamed'
  if (index === 'A' || workingTree === 'A') return 'created'
  if (index === 'D' || workingTree === 'D') return 'deleted'
  return 'modified'
}

async function pathBaseForRepoPaths(requestedPath: string): Promise<string> {
  try {
    const stat = await fs.stat(requestedPath)
    return stat.isDirectory() ? requestedPath : dirname(requestedPath)
  } catch {
    return dirname(requestedPath)
  }
}

function sanitizeRepoPaths(
  paths: string[] | undefined,
  repoRoot: string,
  basePath: string = repoRoot
): string[] {
  if (!Array.isArray(paths)) return []
  const sanitized: string[] = []
  for (const candidate of paths) {
    const trimmed = String(candidate || '').trim()
    if (!trimmed) continue
    if (isAbsolute(trimmed)) {
      throw new Error('Stage paths must be relative to the repository.')
    }
    const normalized = normalize(trimmed)
    if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${sep}`)) {
      throw new Error('Stage paths must stay inside the repository.')
    }
    const resolvedPath = resolve(basePath, normalized)
    const relativePath = relative(repoRoot, resolvedPath)
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error('Stage paths must stay inside the repository.')
    }
    sanitized.push(relativePath)
  }
  return sanitized
}

function hasAsciiControlChar(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function branchNameHasInvalidChars(branch: string): boolean {
  if (hasAsciiControlChar(branch)) return true
  for (const char of branch) {
    if (/\s/.test(char) || '~^:?*[\\'.includes(char)) return true
  }
  return false
}

function sanitizeBranchName(value: string): string {
  const branch = String(value || '').trim()
  if (!branch) throw new Error('Branch name is required.')
  if (branch.startsWith('-')) throw new Error('Branch name cannot start with a dash.')
  if (
    branch.includes('..') ||
    branch.includes('@{') ||
    branch.includes('\\') ||
    branch.includes('//') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.endsWith('.lock') ||
    branchNameHasInvalidChars(branch)
  ) {
    throw new Error('Branch name contains characters Git will not accept.')
  }
  return branch
}

function sanitizeStartPoint(value?: string): string | undefined {
  const startPoint = String(value || '').trim()
  if (!startPoint) return undefined
  if (startPoint.startsWith('-') || hasAsciiControlChar(startPoint)) {
    throw new Error('Branch start point is invalid.')
  }
  return startPoint
}

function resolveWorktreeTargetPath(
  repoRoot: string,
  input: Pick<GitCreateWorktreeInput, 'name' | 'path' | 'branch'>
): string {
  const rawPath = String(input.path || '').trim()
  const targetPath = rawPath
    ? resolve(rawPath)
    : join(
        dirname(repoRoot),
        '.taskwraith-worktrees',
        safePathSegment(basename(repoRoot)),
        safePathSegment(input.name || input.branch || 'worktree')
      )
  if (pathsEqual(targetPath, repoRoot)) {
    throw new Error('Worktree path must be separate from the primary repository.')
  }
  const relativeToRepo = relative(repoRoot, targetPath)
  if (relativeToRepo && !relativeToRepo.startsWith(`..${sep}`) && relativeToRepo !== '..' && !isAbsolute(relativeToRepo)) {
    throw new Error('Worktree path must not be nested inside the primary repository.')
  }
  return targetPath
}

function safePathSegment(value: string): string {
  const segment = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return segment && segment !== '.' && segment !== '..' ? segment : 'worktree'
}

function pathsEqual(a?: string, b?: string): boolean {
  if (!a || !b) return false
  return resolve(a) === resolve(b)
}

function expandHomePath(value?: string | null): string {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (raw === '~') return homedir()
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2))
  return raw
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function truncateText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n...truncated ${value.length - max} chars`
}

function sanitizeCommitSha(value: unknown): string | undefined {
  const sha = String(value || '').trim()
  if (!sha) return undefined
  if (!/^[A-Fa-f0-9]{7,64}$/.test(sha)) {
    throw new Error('Commit SHA must be 7-64 hexadecimal characters.')
  }
  return sha
}

function sanitizeGhSelector(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const selector = String(value).trim()
  if (!selector) return undefined
  if (selector.startsWith('-') || hasAsciiControlChar(selector) || /\s/.test(selector)) {
    throw new Error('GitHub PR selector must be a PR number, URL, or branch name.')
  }
  return selector.slice(0, 240)
}

function parseGhRunList(output: string): GitCiRunSummary[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(output || '[]')
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed
    .map((item): GitCiRunSummary | null => {
      if (!isRecord(item)) return null
      const id = Number(item.databaseId)
      if (!Number.isFinite(id) || id <= 0) return null
      return {
        id,
        name: stringField(item.displayTitle),
        workflowName: stringField(item.workflowName),
        status: stringField(item.status),
        conclusion: stringField(item.conclusion),
        headSha: stringField(item.headSha),
        event: stringField(item.event),
        url: stringField(item.url),
        createdAt: stringField(item.createdAt),
        updatedAt: stringField(item.updatedAt)
      }
    })
    .filter((item): item is GitCiRunSummary => Boolean(item))
}

function isFailedCiRun(run: GitCiRunSummary): boolean {
  return ['failure', 'timed_out', 'startup_failure', 'action_required', 'cancelled'].includes(
    String(run.conclusion || '').toLowerCase()
  )
}

function isPendingCiRun(run: GitCiRunSummary): boolean {
  const status = String(run.status || '').toLowerCase()
  return Boolean(status && status !== 'completed')
}

function classifyCiStatus(
  runs: GitCiRunSummary[],
  checks: NonNullable<GitPrSummary['checks']>,
  repairAttempt: number,
  maxRepairPushes: number
): GitCiStatusKind {
  if (repairAttempt >= maxRepairPushes) return 'blocked'
  if (runs.some(isFailedCiRun)) return 'failed'
  if (runs.some(isPendingCiRun)) return 'pending'
  const failedChecks = checks.filter((check) =>
    ['failure', 'timed_out', 'startup_failure', 'action_required', 'cancelled'].includes(
      String(check.conclusion || '').toLowerCase()
    )
  )
  if (failedChecks.length > 0) return 'failed'
  const pendingChecks = checks.filter((check) => {
    const status = String(check.status || '').toLowerCase()
    return status && status !== 'completed'
  })
  if (pendingChecks.length > 0) return 'pending'
  if (runs.length > 0 || checks.length > 0) return 'passed'
  return 'unknown'
}

function ciRepairLoop(
  status: GitCiStatusKind,
  repairAttempt: number,
  maxRepairPushes: number
): GitCiStatusSummary['repairLoop'] {
  const shouldStop = repairAttempt >= maxRepairPushes
  return {
    repairAttempt,
    maxRepairPushes,
    shouldStop,
    requireLocalVerification: true,
    nextSuggestedAction: shouldStop
      ? 'ask_user'
      : status === 'passed'
        ? 'done'
        : status === 'pending'
          ? 'wait_for_ci'
          : status === 'failed'
            ? 'repair_and_test_before_push'
            : status === 'blocked'
              ? 'ask_user'
              : 'inspect'
  }
}

function redactCiSecrets(value: string): string {
  return value
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[redacted-github-token]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted-github-token]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[redacted-api-key]')
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/((?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)\s*=\s*)[^\s]+/gi, '$1[redacted]')
}

function summarizeCiFailureHints(log: string): string[] {
  const hints: string[] = []
  const seen = new Set<string>()
  for (const rawLine of log.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.length > 500) continue
    if (!/\b(error|fail|failed|failure|fatal|assert|exception|timed out|npm err|exit code)\b/i.test(line)) {
      continue
    }
    const redacted = redactCiSecrets(line)
    if (seen.has(redacted)) continue
    seen.add(redacted)
    hints.push(redacted)
    if (hints.length >= 20) break
  }
  return hints
}

async function detectCiLocalVerification(repoRoot: string): Promise<GitCiLocalVerification> {
  const packagePath = join(repoRoot, 'package.json')
  try {
    const parsed = JSON.parse(await fs.readFile(packagePath, 'utf8')) as Record<string, unknown>
    const scripts = isRecord(parsed.scripts) ? parsed.scripts : {}
    const commands: string[] = []
    if (typeof scripts.ci === 'string') commands.push('npm run ci')
    if (typeof scripts['lint:errors'] === 'string') commands.push('npm run lint:errors')
    else if (typeof scripts.lint === 'string') commands.push('npm run lint')
    if (typeof scripts.typecheck === 'string') commands.push('npm run typecheck')
    if (typeof scripts.test === 'string') commands.push('npm run test')
    if (commands.length > 0) return { recommendedCommands: commands, source: 'package_json' }
  } catch {
    // Fall through to other project detectors.
  }
  try {
    await fs.access(join(repoRoot, 'Package.swift'))
    return { recommendedCommands: ['swift test'], source: 'swift_package' }
  } catch {
    return { recommendedCommands: ['Run the project CI-equivalent test command locally before pushing.'], source: 'generic' }
  }
}

function parsePullRequestSummary(output: string): GitPrSummary {
  const parsed = JSON.parse(output || '{}') as Record<string, unknown>
  const checks = Array.isArray(parsed.statusCheckRollup)
    ? parsed.statusCheckRollup.map((item) => {
        const record = isRecord(item) ? item : {}
        return {
          name: stringField(record.name),
          status: stringField(record.status),
          conclusion: stringField(record.conclusion),
          url: stringField(record.detailsUrl) || stringField(record.url)
        }
      })
    : undefined
  return {
    number: typeof parsed.number === 'number' ? parsed.number : undefined,
    url: stringField(parsed.url),
    state: stringField(parsed.state),
    isDraft: typeof parsed.isDraft === 'boolean' ? parsed.isDraft : undefined,
    headRefName: stringField(parsed.headRefName),
    headRefOid: stringField(parsed.headRefOid),
    baseRefName: stringField(parsed.baseRefName),
    mergeStateStatus: stringField(parsed.mergeStateStatus),
    checks
  }
}

function isNoPullRequestMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('no pull requests found') ||
    normalized.includes('no open pull requests') ||
    normalized.includes('could not find any pull requests')
  )
}

function failure<T>(error: unknown): GitResult<T> {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
