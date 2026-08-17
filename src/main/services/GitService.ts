import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { homedir, tmpdir } from 'os'
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep
} from 'path'
import { getCliSearchDirs } from '../providers/CliSearchDirs'
import { deriveWorkspaceMutationClaims } from '../WorkspaceMutationClaims'
import { resolveCanonicalWorkspaceLockPath } from '../workLocks/CanonicalWorkspaceLockPath'
import {
  gitCommandEnvironment,
  hardenedGitCommandArgs,
  isSafeExternalGitPushUrl,
  isSafeGitRemoteName,
  LOCAL_GIT_CONFIG_KEY_QUERY_ARGS,
  LOCAL_GIT_FILTER_CONFIG_QUERY_ARGS,
  repositoryLocalPushConfigError,
  repositoryLocalGitFilterError,
  repositoryLocalGitFilterKeys,
  unsafeRepositoryPushConfigKeys
} from './GitCommandSecurity'
import {
  GIT_WORKSPACE_HISTORY_SAMPLE_LIMIT,
  parseGitGrepTrackedLines,
  parseNonNegativeGitCount,
  summarizeGitCommitActivity,
  type GitWorkspaceStats
} from './GitWorkspaceStats'
import { readGitUnpushedCommitStack } from './GitCommitStack'
import type {
  GitUnpushedCommitPageRequest,
  GitUnpushedCommitStack
} from '../../shared/gitUnpushedCommits'
import {
  createGitCommitGroupPullRequest,
  manageGitPullRequest,
  readGitPullRequestWorkspace,
  type GitCommitGroupPullRequestInput,
  type GitCommitGroupPullRequestResult,
  type GitPullRequestLifecycleResult,
  type GitPullRequestManagementInput,
  type GitPullRequestWorkspaceSnapshot
} from './GitPullRequestWorkflow'

const DEFAULT_TIMEOUT_MS = 30_000
const WORKSPACE_STATS_CACHE_TTL_MS = 30_000

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
  totalCommits?: number | null
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
  title?: string
  body?: string
  url?: string
  state?: string
  isDraft?: boolean
  headRefName?: string
  headRefOid?: string
  baseRefName?: string
  mergeStateStatus?: string
  /**
   * Auto-merge is armed on this PR (`gh pr view --json autoMergeRequest`):
   * GitHub has accepted it for merge but it has NOT landed yet — it is waiting
   * on required checks or its turn in the merge queue. Distinct from merged.
   */
  autoMergeEnabled?: boolean
  updatedAt?: string
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

export type GitScopeErrorCode =
  | 'git_scope_workspace_not_registered'
  | 'git_scope_registered_root_unresolved'
  | 'git_scope_registered_root_mismatch'
  | 'git_scope_external_root_unresolved'
  | 'git_scope_external_root_required'
  | 'git_scope_external_repository_not_self_contained'
  | 'git_scope_external_chat_required'
  | 'git_scope_external_read_grant_required'
  | 'git_scope_external_write_grant_required'

export type GitResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; stderr?: string; errorCode?: GitScopeErrorCode }

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
  /** True when desktop authority comes from a per-chat external-path grant. */
  externalRepository?: boolean
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

export interface GitCaptureWorktreePatchInput {
  /** Root of the (linked) worktree whose staged-everything diff to capture. */
  worktreePath: string
}

export interface GitNumstatEntry {
  path: string
  /** null for binary files (git reports `-`). */
  insertions: number | null
  deletions: number | null
  binary: boolean
}

export interface GitWorktreePatchCapture {
  repoRoot: string
  /** Full binary-safe patch of everything vs HEAD (add -A + diff --cached). */
  patch: string
  numstat: GitNumstatEntry[]
  totals: { files: number; insertions: number; deletions: number }
  clean: boolean
}

export interface GitApplyPatchInput {
  repoPath: string
  patch: string
  /**
   * Exact, freshly verified capabilities for a lock-mediated patch. When
   * supplied, GitService re-derives every patch target and refuses unless the
   * immutable patch bytes address exactly this canonical set.
   */
  verifiedTargetPaths?: readonly string[]
  /**
   * false (default): verify with `git apply --check` first and refuse without
   * touching the tree when the patch no longer applies. true: apply with
   * `--3way`, which can leave conflict markers in the working tree for the
   * user to resolve — callers must surface that clearly.
   */
  allowConflicts?: boolean
}

export interface GitPatchApplicationInspection {
  state: 'applicable' | 'already-applied' | 'ambiguous' | 'drifted'
  forwardError?: string
  reverseError?: string
}

export interface GitDeleteBranchInput {
  repoPath: string
  branch: string
  /** -D instead of -d (delete even when unmerged). */
  force?: boolean
}

export class GitService {
  private run: GitCommandRunner
  private timeoutMs: number
  private workspaceStatsCache = new Map<
    string,
    { expiresAt: number; data: GitWorkspaceStats }
  >()
  private workspaceStatsInFlight = new Map<string, Promise<GitWorkspaceStats>>()

  constructor(options: { run?: GitCommandRunner; timeoutMs?: number } = {}) {
    const runner = options.run || runCommand
    this.run = (command, args, commandOptions) =>
      runner(command, hardenedGitCommandArgs(command, args), commandOptions)
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS
  }

  async snapshot(inputPath: string): Promise<GitResult<GitRepositorySnapshot>> {
    try {
      return { ok: true, data: await this.buildSnapshot(inputPath) }
    } catch (error) {
      return failure(error)
    }
  }

  async unpushedCommits(
    inputPath: string,
    page?: GitUnpushedCommitPageRequest
  ): Promise<GitResult<GitUnpushedCommitStack>> {
    try {
      const snapshot = await this.buildSnapshot(inputPath)
      return {
        ok: true,
        data: await readGitUnpushedCommitStack({
          repoRoot: snapshot.repoRoot,
          snapshot,
          run: this.run,
          timeoutMs: this.timeoutMs,
          page
        })
      }
    } catch (error) {
      return failure(error)
    }
  }

  async pullRequestWorkspace(
    inputPath: string
  ): Promise<GitResult<GitPullRequestWorkspaceSnapshot>> {
    try {
      const snapshot = await this.buildSnapshot(inputPath)
      return {
        ok: true,
        data: await readGitPullRequestWorkspace({
          repoRoot: snapshot.repoRoot,
          snapshot,
          run: this.run,
          timeoutMs: this.timeoutMs
        })
      }
    } catch (error) {
      return failure(error)
    }
  }

  async createCommitGroupPullRequest(
    input: GitCommitGroupPullRequestInput
  ): Promise<GitResult<GitCommitGroupPullRequestResult>> {
    try {
      const snapshot = await this.buildSnapshot(input.repoPath)
      const stack = await readGitUnpushedCommitStack({
        repoRoot: snapshot.repoRoot,
        snapshot,
        run: this.run,
        timeoutMs: this.timeoutMs
      })
      if (input.externalRepository) {
        await this.assertSafeExternalPushRemote(
          snapshot.repoRoot,
          snapshot.remoteName || 'origin'
        )
      }
      const {
        repoPath: _repoPath,
        externalRepository: _externalRepository,
        ...request
      } = input
      return {
        ok: true,
        data: await createGitCommitGroupPullRequest(
          {
            repoRoot: snapshot.repoRoot,
            snapshot,
            run: this.run,
            timeoutMs: this.timeoutMs
          },
          stack.commits,
          request
        )
      }
    } catch (error) {
      return failure(error)
    }
  }

  async managePullRequest(
    input: GitPullRequestManagementInput
  ): Promise<GitResult<GitPullRequestLifecycleResult>> {
    try {
      const snapshot = await this.buildSnapshot(input.repoPath)
      const { repoPath: _repoPath, ...request } = input
      return {
        ok: true,
        data: await manageGitPullRequest(
          {
            repoRoot: snapshot.repoRoot,
            snapshot,
            run: this.run,
            timeoutMs: this.timeoutMs
          },
          request
        )
      }
    } catch (error) {
      return failure(error)
    }
  }

  async workspaceStats(inputPath: string): Promise<GitResult<GitWorkspaceStats>> {
    try {
      const repo = await this.resolveRepository(inputPath)
      await this.assertNoRepositoryLocalFilters(repo.repoRoot)
      const now = Date.now()
      const cached = this.workspaceStatsCache.get(repo.repoRoot)
      if (cached && cached.expiresAt > now) return { ok: true, data: cached.data }

      const existing = this.workspaceStatsInFlight.get(repo.repoRoot)
      if (existing) return { ok: true, data: await existing }

      const pending = (async (): Promise<GitWorkspaceStats> => {
        let data = await this.collectWorkspaceStats(repo.repoRoot)
        if (!data.coherent) data = await this.collectWorkspaceStats(repo.repoRoot)
        if (data.coherent) {
          this.workspaceStatsCache.set(repo.repoRoot, {
            expiresAt: Date.now() + WORKSPACE_STATS_CACHE_TTL_MS,
            data
          })
        }
        return data
      })().finally(() => this.workspaceStatsInFlight.delete(repo.repoRoot))
      this.workspaceStatsInFlight.set(repo.repoRoot, pending)
      return { ok: true, data: await pending }
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
      await this.assertNoRepositoryLocalFilters(repo.repoRoot)
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
      const staged = await this.run(
        'git',
        ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--quiet'],
        {
        cwd: repo.repoRoot,
        timeoutMs: this.timeoutMs
        }
      )
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
      const remote =
        snapshot.upstream && !input.setUpstream
          ? snapshot.remoteName || 'origin'
          : input.remote?.trim() || snapshot.remoteName || 'origin'
      if (!isSafeGitRemoteName(remote)) {
        return { ok: false, error: 'Git remote name is not safe to execute.' }
      }
      if (input.externalRepository) {
        await this.assertSafeExternalPushRemote(snapshot.repoRoot, remote)
      }
      const args =
        snapshot.upstream && !input.setUpstream
          ? ['push', '--receive-pack=git-receive-pack']
          : ['push', '--receive-pack=git-receive-pack', '-u', remote, snapshot.branch]
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
      await this.assertNoRepositoryLocalFilters(repo.repoRoot)
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

  /**
   * Stage everything in a (candidate) worktree and capture the full patch vs
   * HEAD. Staging in the worktree is deliberate: linked worktrees own a
   * private index, and `add -A` is the only way untracked files enter the
   * patch. The shared object database means blobs written here are reachable
   * for a later `--3way` apply in the primary worktree.
   */
  async captureWorktreePatch(
    input: GitCaptureWorktreePatchInput
  ): Promise<GitResult<GitWorktreePatchCapture>> {
    try {
      const repo = await this.resolveRepository(input.worktreePath)
      await this.assertNoRepositoryLocalFilters(repo.repoRoot)
      await this.mustRun('git', ['add', '-A'], repo.repoRoot)
      const patch = await this.mustRun(
        'git',
        ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--binary'],
        repo.repoRoot
      )
      const numstatResult = await this.mustRun(
        'git',
        ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--numstat'],
        repo.repoRoot
      )
      const numstat = parseDiffNumstat(numstatResult.stdout)
      const totals = numstat.reduce(
        (acc, entry) => ({
          files: acc.files + 1,
          insertions: acc.insertions + (entry.insertions ?? 0),
          deletions: acc.deletions + (entry.deletions ?? 0)
        }),
        { files: 0, insertions: 0, deletions: 0 }
      )
      return {
        ok: true,
        data: {
          repoRoot: repo.repoRoot,
          patch: patch.stdout,
          numstat,
          totals,
          clean: numstat.length === 0 && !patch.stdout.trim()
        }
      }
    } catch (error) {
      return failure(error)
    }
  }

  /**
   * Apply a captured candidate patch onto a repository's working tree,
   * leaving the result uncommitted — exactly the state a serial agent run
   * would leave behind. Default mode refuses (without touching the tree) when
   * the patch no longer applies cleanly; `allowConflicts` switches to
   * `--3way`, which may leave conflict markers for manual resolution.
   */
  async inspectPatchApplication(
    input: Pick<GitApplyPatchInput, 'repoPath' | 'patch' | 'verifiedTargetPaths'>
  ): Promise<GitResult<GitPatchApplicationInspection>> {
    let tempDir: string | null = null
    try {
      if (!input.patch.trim()) {
        return { ok: false, error: 'The candidate patch is empty; nothing to inspect.' }
      }
      const repo = await this.resolveRepository(input.repoPath)
      await this.assertNoRepositoryLocalFilters(repo.repoRoot)
      if (input.verifiedTargetPaths) {
        await assertVerifiedPatchTargets(repo.repoRoot, input.patch, input.verifiedTargetPaths)
      }
      tempDir = await fs.mkdtemp(join(tmpdir(), 'taskwraith-candidate-inspect-'))
      const patchPath = join(tempDir, 'candidate.patch')
      await fs.writeFile(patchPath, input.patch, { encoding: 'utf8', mode: 0o600 })
      const [forward, reverse] = await Promise.all([
        this.run(
          'git',
          ['apply', '--check', '--binary', '--whitespace=nowarn', patchPath],
          { cwd: repo.repoRoot, timeoutMs: this.timeoutMs }
        ),
        this.run(
          'git',
          ['apply', '--reverse', '--check', '--binary', '--whitespace=nowarn', patchPath],
          { cwd: repo.repoRoot, timeoutMs: this.timeoutMs }
        )
      ])
      const forwardApplies = forward.code === 0
      const reverseApplies = reverse.code === 0
      return {
        ok: true,
        data: {
          state:
            forwardApplies && !reverseApplies
              ? 'applicable'
              : !forwardApplies && reverseApplies
                ? 'already-applied'
                : forwardApplies && reverseApplies
                  ? 'ambiguous'
                  : 'drifted',
          ...(forwardApplies ? {} : { forwardError: forward.stderr.trim() }),
          ...(reverseApplies ? {} : { reverseError: reverse.stderr.trim() })
        }
      }
    } catch (error) {
      return failure(error)
    } finally {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }

  async applyPatchToRepository(
    input: GitApplyPatchInput
  ): Promise<GitResult<GitRepositorySnapshot>> {
    let tempDir: string | null = null
    try {
      if (!input.patch.trim()) {
        return { ok: false, error: 'The candidate patch is empty; nothing to apply.' }
      }
      const repo = await this.resolveRepository(input.repoPath)
      await this.assertNoRepositoryLocalFilters(repo.repoRoot)
      if (input.verifiedTargetPaths) {
        await assertVerifiedPatchTargets(repo.repoRoot, input.patch, input.verifiedTargetPaths)
      }
      tempDir = await fs.mkdtemp(join(tmpdir(), 'taskwraith-candidate-'))
      const patchPath = join(tempDir, 'candidate.patch')
      await fs.writeFile(patchPath, input.patch, { encoding: 'utf8', mode: 0o600 })
      if (input.allowConflicts) {
        const applied = await this.run(
          'git',
          ['apply', '--3way', '--binary', '--whitespace=nowarn', patchPath],
          { cwd: repo.repoRoot, timeoutMs: this.timeoutMs }
        )
        if (applied.code !== 0) {
          const conflicted = /with conflicts|three-way merge/i.test(applied.stderr)
          return {
            ok: false,
            error: conflicted
              ? 'The candidate patch applied with conflicts. Conflict markers were left in the working tree for manual resolution.'
              : applied.stderr.trim() || 'git apply failed.'
          }
        }
      } else {
        const check = await this.run(
          'git',
          ['apply', '--check', '--binary', '--whitespace=nowarn', patchPath],
          { cwd: repo.repoRoot, timeoutMs: this.timeoutMs }
        )
        if (check.code !== 0) {
          return {
            ok: false,
            error: `The candidate patch no longer applies cleanly — the workspace has drifted since the lane forked. ${check.stderr.trim()}`.trim()
          }
        }
        await this.mustRun(
          'git',
          ['apply', '--binary', '--whitespace=nowarn', patchPath],
          repo.repoRoot
        )
      }
      return { ok: true, data: await this.buildSnapshot(repo.repoRoot) }
    } catch (error) {
      return failure(error)
    } finally {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }

  async deleteBranch(input: GitDeleteBranchInput): Promise<GitResult<{ branch: string }>> {
    try {
      const repo = await this.resolveRepository(input.repoPath)
      const branch = await this.assertBranchName(repo.repoRoot, input.branch)
      await this.mustRun(
        'git',
        ['branch', input.force ? '-D' : '-d', branch],
        repo.repoRoot
      )
      return { ok: true, data: { branch } }
    } catch (error) {
      return failure(error)
    }
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

  private async assertSafeExternalPushRemote(repoRoot: string, remote: string): Promise<void> {
    const config = await this.mustRun('git', [...LOCAL_GIT_CONFIG_KEY_QUERY_ARGS], repoRoot)
    const unsafeKeys = unsafeRepositoryPushConfigKeys(repositoryLocalGitFilterKeys(config.stdout))
    if (unsafeKeys.length > 0) throw new Error(repositoryLocalPushConfigError(unsafeKeys))

    const urls = await this.mustRun(
      'git',
      ['remote', 'get-url', '--push', '--all', remote],
      repoRoot
    )
    const resolvedUrls = urls.stdout
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean)
    if (resolvedUrls.length === 0 || resolvedUrls.some((url) => !isSafeExternalGitPushUrl(url))) {
      throw new Error(
        'Externally granted repositories can push only to explicit HTTPS or SSH remotes.'
      )
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
        'number,url,state,isDraft,headRefName,headRefOid,baseRefName,mergeStateStatus,autoMergeRequest,statusCheckRollup'
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

  private async collectWorkspaceStats(repoRoot: string): Promise<GitWorkspaceStats> {
    const before = await this.readWorkspaceStatsGeneration(repoRoot)
    const historySampleCount = GIT_WORKSPACE_HISTORY_SAMPLE_LIMIT + 1
    const [
      totalCommitsResult,
      historyResult,
      branchResult,
      worktreeResult,
      trackedLinesResult,
      latestCommitResult,
      latestTagResult
    ] = await Promise.all([
      this.run('git', ['rev-list', '--count', 'HEAD'], {
        cwd: repoRoot,
        timeoutMs: this.timeoutMs
      }),
      this.run(
        'git',
        ['log', `--max-count=${historySampleCount}`, '--format=%as', 'HEAD'],
        { cwd: repoRoot, timeoutMs: this.timeoutMs }
      ),
      this.run('git', ['for-each-ref', '--format=%(refname)', 'refs/heads'], {
        cwd: repoRoot,
        timeoutMs: this.timeoutMs
      }),
      this.run('git', ['worktree', 'list', '--porcelain'], {
        cwd: repoRoot,
        timeoutMs: this.timeoutMs
      }),
      this.run('git', ['grep', '-I', '-c', '-z', '-e', '', '--', '.'], {
        cwd: repoRoot,
        timeoutMs: this.timeoutMs
      }),
      this.run('git', ['log', '-1', '--format=%H%x00%as%x00%s', 'HEAD'], {
        cwd: repoRoot,
        timeoutMs: this.timeoutMs
      }),
      this.run('git', ['describe', '--tags', '--abbrev=0', 'HEAD'], {
        cwd: repoRoot,
        timeoutMs: this.timeoutMs
      })
    ])
    const after = await this.readWorkspaceStatsGeneration(repoRoot)
    const observedAt = new Date().toISOString()
    const coherent =
      before.valid &&
      after.valid &&
      before.head === after.head &&
      before.status === after.status &&
      before.numstat === after.numstat

    const hasHead = before.head !== null
    const totalCommits = hasHead
      ? totalCommitsResult.code === 0
        ? parseNonNegativeGitCount(totalCommitsResult.stdout)
        : null
      : 0
    const history =
      hasHead && historyResult.code !== 0
        ? {
            activeDays: null,
            historySpanDays: null,
            commitsPerActiveDay: null,
            historyTruncated: false
          }
        : summarizeGitCommitActivity({
            stdout: hasHead ? historyResult.stdout : '',
            totalCommits,
            observedAt
          })
    const latestTag = latestTagResult.code === 0 ? latestTagResult.stdout.trim() : ''
    const commitsSinceLatestTagResult = latestTag
      ? await this.run('git', ['rev-list', '--count', `${latestTag}..HEAD`, '--'], {
          cwd: repoRoot,
          timeoutMs: this.timeoutMs
        })
      : null
    const latestCommitFields =
      latestCommitResult.code === 0 ? latestCommitResult.stdout.trimEnd().split('\0') : []
    const trackedLines =
      trackedLinesResult.code === 0 || trackedLinesResult.code === 1
        ? parseGitGrepTrackedLines(trackedLinesResult.stdout)
        : null

    return {
      repoRoot,
      observedAt,
      coherent,
      ...(!coherent
        ? { coherenceReason: 'HEAD or working-tree state changed while local stats were sampled.' }
        : {}),
      totalCommits,
      localBranchCount:
        branchResult.code === 0 ? nonEmptyLineCount(branchResult.stdout) : null,
      attachedWorktreeCount:
        worktreeResult.code === 0
          ? worktreeResult.stdout
              .split(/\r?\n/)
              .filter((line) => line.startsWith('worktree ')).length
          : null,
      trackedLines,
      activeDays: history.activeDays,
      historySpanDays: history.historySpanDays,
      commitsPerActiveDay: history.commitsPerActiveDay,
      historyTruncated: history.historyTruncated,
      ...(latestCommitFields.length >= 3
        ? {
            latestCommit: {
              hash: latestCommitFields[0],
              authoredOn: latestCommitFields[1],
              subject: latestCommitFields.slice(2).join('\0')
            }
          }
        : {}),
      ...(latestTag ? { latestTag } : {}),
      commitsSinceLatestTag:
        commitsSinceLatestTagResult?.code === 0
          ? parseNonNegativeGitCount(commitsSinceLatestTagResult.stdout)
          : null
    }
  }

  private async readWorkspaceStatsGeneration(repoRoot: string): Promise<{
    head: string | null
    status: string | null
    numstat: string | null
    valid: boolean
  }> {
    const [headResult, statusResult] = await Promise.all([
      this.run('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: repoRoot,
        timeoutMs: this.timeoutMs
      }),
      this.run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
        cwd: repoRoot,
        timeoutMs: this.timeoutMs
      })
    ])
    const head = headResult.code === 0 ? headResult.stdout.trim() : null
    const numstatResult = head
      ? await this.run('git', ['diff', '--no-ext-diff', '--no-textconv', '--numstat', 'HEAD'], {
          cwd: repoRoot,
          timeoutMs: this.timeoutMs
        })
      : null
    return {
      head,
      status: statusResult.code === 0 ? statusResult.stdout : null,
      numstat: numstatResult?.code === 0 ? numstatResult.stdout : null,
      valid: statusResult.code === 0 && (!head || numstatResult?.code === 0)
    }
  }

  private async buildSnapshot(inputPath: string): Promise<GitRepositorySnapshot> {
    const repo = await this.resolveRepository(inputPath)
    await this.assertNoRepositoryLocalFilters(repo.repoRoot)
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
        // Snapshot status is a background read. Without --no-optional-locks,
        // Git may refresh/write the index stat cache; the repo watcher then
        // observes its own read and schedules another snapshot indefinitely.
        this.run(
          'git',
          ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
          {
            cwd: repo.repoRoot,
            timeoutMs: this.timeoutMs
          }
        ),
        this.readMergeState(repo.repoRoot),
        this.readLineStats(repo.repoRoot)
      ])

    const branch = branchResult.code === 0 ? branchResult.stdout.trim() : undefined
    const upstream = upstreamResult.code === 0 ? upstreamResult.stdout.trim() : undefined
    const files = parseStatusPorcelainZ(statusResult.stdout)
    const aheadBehind = upstream
      ? await this.readAheadBehind(repo.repoRoot)
      : { ahead: 0, behind: 0 }
    const totalCommits = upstream ? undefined : await this.readTotalCommits(repo.repoRoot)

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
      totalCommits,
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
    const result = await this.run(
      'git',
      ['diff', '--no-ext-diff', '--no-textconv', '--numstat', 'HEAD'],
      {
        cwd: repoRoot,
        timeoutMs: this.timeoutMs
      }
    )
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

  private async readTotalCommits(repoRoot: string): Promise<number | null> {
    const result = await this.run('git', ['rev-list', '--count', 'HEAD'], {
      cwd: repoRoot,
      timeoutMs: this.timeoutMs
    })
    if (result.code !== 0) return null
    return parseNonNegativeGitCount(result.stdout) ?? 0
  }

  private async assertNoRepositoryLocalFilters(repoRoot: string): Promise<void> {
    const result = await this.run(
      'git',
      [...LOCAL_GIT_FILTER_CONFIG_QUERY_ARGS],
      { cwd: repoRoot, timeoutMs: this.timeoutMs }
    )
    if (result.code === 1 && !result.stdout.trim()) return
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() ||
          result.stdout.trim() ||
          'Repository-local Git filter configuration could not be inspected safely.'
      )
    }
    const filters = repositoryLocalGitFilterKeys(result.stdout)
    if (filters.length > 0) {
      throw new Error(repositoryLocalGitFilterError(filters))
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

async function assertVerifiedPatchTargets(
  repoRoot: string,
  patch: string,
  verifiedTargetPaths: readonly string[]
): Promise<void> {
  const derived = await deriveWorkspaceMutationClaims({
    workspacePath: repoRoot,
    worktreePath: repoRoot,
    action: 'apply_patch',
    args: { patch }
  })
  const derivedTargets = [
    ...new Set(
      derived
        .map((claim) => claim.targetPath)
        .filter((targetPath): targetPath is string => typeof targetPath === 'string')
        .map(
          (targetPath) =>
            resolveCanonicalWorkspaceLockPath({
              rootPath: repoRoot,
              targetPath
            }).canonicalPath
        )
    )
  ].sort()
  const verifiedTargets = [...new Set(verifiedTargetPaths)].sort()
  if (
    derivedTargets.length !== verifiedTargets.length ||
    derivedTargets.some((targetPath, index) => targetPath !== verifiedTargets[index])
  ) {
    throw new Error(
      'The candidate patch targets do not exactly match its freshly verified lock capabilities.'
    )
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

/**
 * Parse `git diff --numstat` output. Binary files report `-` for both
 * counters and become `insertions/deletions: null`. Rename lines keep git's
 * `dir/{old => new}` display path verbatim — numstat consumers are
 * summary-only.
 */
export function parseDiffNumstat(output: string): GitNumstatEntry[] {
  const entries: GitNumstatEntry[] = []
  for (const line of output.split('\n')) {
    const row = line.trimEnd()
    if (!row) continue
    const [rawInsertions, rawDeletions, ...pathParts] = row.split('\t')
    const path = pathParts.join('\t').trim()
    if (!path || rawInsertions === undefined || rawDeletions === undefined) continue
    const binary = rawInsertions === '-' || rawDeletions === '-'
    const insertions = binary ? null : Number.parseInt(rawInsertions, 10)
    const deletions = binary ? null : Number.parseInt(rawDeletions, 10)
    if (!binary && (!Number.isFinite(insertions) || !Number.isFinite(deletions))) continue
    entries.push({
      path,
      insertions: binary ? null : insertions,
      deletions: binary ? null : deletions,
      binary
    })
  }
  return entries
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
    // Resolve `git`/`gh` from the SAME augmented search dirs the provider CLIs
    // use. Bare-spawning them inherited the process PATH, which for a
    // Finder-launched packaged app is the minimal launchd PATH with no
    // /opt/homebrew/bin — so gh reported "not installed or not on PATH" on
    // machines where it was plainly installed and working in the user's shell.
    // Routing through getCliSearchDirs also picks up the user's configured
    // extra CLI directories, so one setting fixes every lane at once.
    const env = gitCommandEnvironment(command, options.env)
    env.PATH = getCliSearchDirs(null, env).join(delimiter)
    const child = spawn(command, args, {
      cwd: options.cwd,
      env,
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

function nonEmptyLineCount(value: string): number {
  return value.split(/\r?\n/).filter((line) => line.trim().length > 0).length
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
    // `autoMergeRequest` is an object when armed and null otherwise — its
    // presence is the whole signal, so it collapses to a boolean here rather
    // than widening the summary with fields nothing reads.
    autoMergeEnabled: isRecord(parsed.autoMergeRequest) ? true : undefined,
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
