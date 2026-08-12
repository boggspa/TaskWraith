import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  GitCommandResult,
  GitCommandRunner,
  GitPrSummary,
  GitRepositorySnapshot
} from './GitService'
import type { GitUnpushedCommit } from './GitCommitStack'
import { isSafeGitRemoteName } from './GitCommandSecurity'

const PULL_REQUEST_JSON_FIELDS =
  'number,title,body,url,state,isDraft,headRefName,headRefOid,baseRefName,mergeStateStatus,autoMergeRequest,statusCheckRollup,updatedAt'

export interface GitPullRequestWorkflowContext {
  repoRoot: string
  snapshot: GitRepositorySnapshot
  run: GitCommandRunner
  timeoutMs: number
}

export interface GitPullRequestWorkspaceSnapshot {
  repoRoot: string
  available: boolean
  defaultBaseBranch?: string
  pullRequests: GitPrSummary[]
  reason?: string
  warnings: string[]
}

export interface CreateGitCommitGroupPullRequestInput {
  commits: string[]
  branch: string
  baseBranch: string
  title: string
  body?: string
  draft?: boolean
}

export interface GitCommitGroupPullRequestInput extends CreateGitCommitGroupPullRequestInput {
  repoPath: string
  /** True when authority came from a signed per-chat external-path grant. */
  externalRepository?: boolean
}

export interface GitCommitGroupPullRequestResult {
  branch: string
  baseBranch: string
  commitHashes: string[]
  headSha: string
  pullRequest: GitPrSummary
  warnings: string[]
}

export type GitPullRequestLifecycleAction =
  | { action: 'edit'; title?: string; body?: string; baseBranch?: string }
  | { action: 'mark-ready' }
  | { action: 'convert-to-draft' }
  | { action: 'close' }
  | { action: 'reopen' }
  | {
      action: 'merge'
      strategy: 'merge' | 'squash' | 'rebase'
      auto?: boolean
      deleteBranch?: boolean
      expectedHeadSha?: string
    }

export interface ManageGitPullRequestInput {
  pullRequestNumber: number
  lifecycle: GitPullRequestLifecycleAction
}

export interface GitPullRequestManagementInput extends ManageGitPullRequestInput {
  repoPath: string
}

export interface GitPullRequestLifecycleResult {
  pullRequest: GitPrSummary
  warnings: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function commandFailure(result: GitCommandResult, fallback: string): Error {
  return new Error(result.stderr.trim() || result.stdout.trim() || fallback)
}

function parseChecks(value: unknown): GitPrSummary['checks'] {
  if (!Array.isArray(value)) return undefined
  return value.map((item) => {
    const record = isRecord(item) ? item : {}
    return {
      name: stringField(record.name),
      status: stringField(record.status),
      conclusion: stringField(record.conclusion),
      url: stringField(record.detailsUrl) || stringField(record.url)
    }
  })
}

export function parseGitPullRequestSummary(value: unknown): GitPrSummary {
  const parsed = isRecord(value) ? value : {}
  return {
    number: typeof parsed.number === 'number' ? parsed.number : undefined,
    title: stringField(parsed.title),
    body: typeof parsed.body === 'string' ? parsed.body : undefined,
    url: stringField(parsed.url),
    state: stringField(parsed.state),
    isDraft: typeof parsed.isDraft === 'boolean' ? parsed.isDraft : undefined,
    headRefName: stringField(parsed.headRefName),
    headRefOid: stringField(parsed.headRefOid),
    baseRefName: stringField(parsed.baseRefName),
    mergeStateStatus: stringField(parsed.mergeStateStatus),
    autoMergeEnabled: isRecord(parsed.autoMergeRequest) ? true : undefined,
    updatedAt: stringField(parsed.updatedAt),
    checks: parseChecks(parsed.statusCheckRollup)
  }
}

export function parseGitPullRequestList(output: string): GitPrSummary[] {
  const parsed = JSON.parse(output || '[]') as unknown
  if (!Array.isArray(parsed)) throw new Error('GitHub returned an invalid pull request list.')
  return parsed.map(parseGitPullRequestSummary)
}

async function runGh(
  context: GitPullRequestWorkflowContext,
  args: string[]
): Promise<GitCommandResult> {
  return context.run('gh', args, {
    cwd: context.repoRoot,
    timeoutMs: context.timeoutMs,
    env: { GH_PROMPT_DISABLED: '1' }
  })
}

function fallbackBaseBranch(snapshot: GitRepositorySnapshot): string | undefined {
  if (!snapshot.upstream) return undefined
  const slash = snapshot.upstream.indexOf('/')
  return slash >= 0 ? snapshot.upstream.slice(slash + 1) || undefined : snapshot.upstream
}

export async function readGitPullRequestWorkspace(
  context: GitPullRequestWorkflowContext
): Promise<GitPullRequestWorkspaceSnapshot> {
  const warnings: string[] = []
  if (!context.snapshot.remoteUrl) {
    return {
      repoRoot: context.repoRoot,
      available: false,
      defaultBaseBranch: fallbackBaseBranch(context.snapshot),
      pullRequests: [],
      reason: 'No Git remote is configured for this repository.',
      warnings
    }
  }

  const [repository, pullRequests] = await Promise.all([
    runGh(context, ['repo', 'view', '--json', 'defaultBranchRef']),
    runGh(context, [
      'pr',
      'list',
      '--state',
      'all',
      '--limit',
      '100',
      '--json',
      PULL_REQUEST_JSON_FIELDS
    ])
  ])
  let defaultBaseBranch = fallbackBaseBranch(context.snapshot)
  if (repository.code === 0) {
    try {
      const parsed = JSON.parse(repository.stdout || '{}') as Record<string, unknown>
      if (isRecord(parsed.defaultBranchRef)) {
        defaultBaseBranch = stringField(parsed.defaultBranchRef.name) || defaultBaseBranch
      }
    } catch {
      warnings.push('GitHub returned an invalid default-branch response.')
    }
  } else {
    warnings.push(
      repository.stderr.trim() || repository.stdout.trim() || 'Could not read the default branch.'
    )
  }

  if (pullRequests.code !== 0) {
    return {
      repoRoot: context.repoRoot,
      available: false,
      defaultBaseBranch,
      pullRequests: [],
      reason:
        pullRequests.stderr.trim() ||
        pullRequests.stdout.trim() ||
        'GitHub pull requests are unavailable.',
      warnings
    }
  }

  try {
    return {
      repoRoot: context.repoRoot,
      available: true,
      defaultBaseBranch,
      pullRequests: parseGitPullRequestList(pullRequests.stdout),
      warnings
    }
  } catch (error) {
    return {
      repoRoot: context.repoRoot,
      available: false,
      defaultBaseBranch,
      pullRequests: [],
      reason: error instanceof Error ? error.message : String(error),
      warnings
    }
  }
}

async function assertBranchName(
  context: GitPullRequestWorkflowContext,
  branch: string,
  label: string
): Promise<void> {
  if (!branch) throw new Error(`${label} is required.`)
  const result = await context.run('git', ['check-ref-format', '--branch', branch], {
    cwd: context.repoRoot,
    timeoutMs: context.timeoutMs
  })
  if (result.code !== 0) throw new Error(`${label} is not a valid Git branch name.`)
}

async function removeTemporaryWorktree(
  context: GitPullRequestWorkflowContext,
  worktreePath: string,
  warnings: string[]
): Promise<void> {
  const removed = await context.run('git', ['worktree', 'remove', '--force', worktreePath], {
    cwd: context.repoRoot,
    timeoutMs: context.timeoutMs
  })
  if (removed.code === 0) return
  await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => undefined)
  await context.run('git', ['worktree', 'prune'], {
    cwd: context.repoRoot,
    timeoutMs: context.timeoutMs
  })
  warnings.push('The temporary PR worktree required forced cleanup.')
}

export async function createGitCommitGroupPullRequest(
  context: GitPullRequestWorkflowContext,
  availableCommits: readonly GitUnpushedCommit[],
  input: CreateGitCommitGroupPullRequestInput
): Promise<GitCommitGroupPullRequestResult> {
  const branch = input.branch.trim()
  const baseBranch = input.baseBranch.trim()
  const title = input.title.trim()
  if (!title) throw new Error('Pull request title is required.')
  await assertBranchName(context, branch, 'Pull request branch')
  await assertBranchName(context, baseBranch, 'Base branch')
  if (branch === context.snapshot.branch) {
    throw new Error('Choose a new PR branch; the current checkout must stay in place.')
  }

  const remote = context.snapshot.remoteName || 'origin'
  if (!context.snapshot.remoteUrl) throw new Error('No Git remote is configured.')
  if (!isSafeGitRemoteName(remote)) throw new Error('Git remote name is not safe to execute.')

  const requested = new Set(
    input.commits.map((hash) => {
      const normalized = hash.trim().toLowerCase()
      if (!/^[0-9a-f]{40}$/.test(normalized)) {
        throw new Error('Every selected commit must have a full 40-character Git hash.')
      }
      return normalized
    })
  )
  if (requested.size === 0) throw new Error('Select at least one commit for the pull request.')
  if (requested.size !== input.commits.length) {
    throw new Error('The pull request selection contains duplicate commits.')
  }
  const availableByHash = new Map(
    availableCommits.map((commit) => [commit.hash.toLowerCase(), commit])
  )
  const unknown = Array.from(requested).filter((hash) => !availableByHash.has(hash))
  if (unknown.length > 0) {
    throw new Error('The unpushed commit stack changed. Refresh it before creating this request.')
  }
  const orderedCommits = availableCommits
    .filter((commit) => requested.has(commit.hash.toLowerCase()))
    .slice()
    .reverse()

  const localBranch = await context.run(
    'git',
    ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
    { cwd: context.repoRoot, timeoutMs: context.timeoutMs }
  )
  if (localBranch.code === 0) throw new Error(`Local branch "${branch}" already exists.`)
  const remoteBranch = await context.run(
    'git',
    ['ls-remote', '--exit-code', '--heads', remote, `refs/heads/${branch}`],
    { cwd: context.repoRoot, timeoutMs: context.timeoutMs }
  )
  if (remoteBranch.code === 0) throw new Error(`Remote branch "${branch}" already exists.`)
  if (remoteBranch.code !== 2) {
    throw commandFailure(remoteBranch, 'Could not verify that the PR branch is available.')
  }

  const fetched = await context.run(
    'git',
    ['fetch', '--no-tags', remote, `refs/heads/${baseBranch}`],
    { cwd: context.repoRoot, timeoutMs: context.timeoutMs }
  )
  if (fetched.code !== 0) {
    throw commandFailure(fetched, `Could not fetch ${remote}/${baseBranch}.`)
  }
  const base = await context.run('git', ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], {
    cwd: context.repoRoot,
    timeoutMs: context.timeoutMs
  })
  if (base.code !== 0) throw commandFailure(base, 'Could not resolve the fetched base branch.')

  const warnings: string[] = []
  const temporaryRoot = await fs.mkdtemp(join(tmpdir(), 'taskwraith-pr-group-'))
  const worktreePath = join(temporaryRoot, 'worktree')
  let worktreeAdded = false
  let branchCreated = false
  let pushed = false
  let workflowError: Error | null = null
  let result: GitCommitGroupPullRequestResult | null = null

  try {
    const worktree = await context.run(
      'git',
      ['worktree', 'add', '-b', branch, worktreePath, base.stdout.trim()],
      { cwd: context.repoRoot, timeoutMs: context.timeoutMs }
    )
    if (worktree.code !== 0)
      throw commandFailure(worktree, 'Could not create the isolated PR worktree.')
    worktreeAdded = true
    branchCreated = true

    for (const commit of orderedCommits) {
      const cherryPick = await context.run(
        'git',
        ['cherry-pick', ...(commit.parents.length > 1 ? ['-m', '1'] : []), '--', commit.hash],
        { cwd: worktreePath, timeoutMs: context.timeoutMs }
      )
      if (cherryPick.code !== 0) {
        await context.run('git', ['cherry-pick', '--abort'], {
          cwd: worktreePath,
          timeoutMs: context.timeoutMs
        })
        throw new Error(
          `Commit ${commit.hash.slice(0, 9)} could not be applied to ${baseBranch}: ${
            cherryPick.stderr.trim() || cherryPick.stdout.trim() || 'cherry-pick failed'
          }`
        )
      }
    }

    const head = await context.run('git', ['rev-parse', 'HEAD'], {
      cwd: worktreePath,
      timeoutMs: context.timeoutMs
    })
    if (head.code !== 0) throw commandFailure(head, 'Could not resolve the assembled PR branch.')
    const headSha = head.stdout.trim()
    const push = await context.run(
      'git',
      ['push', '--receive-pack=git-receive-pack', '-u', remote, branch],
      { cwd: worktreePath, timeoutMs: context.timeoutMs }
    )
    if (push.code !== 0) throw commandFailure(push, 'Could not push the assembled PR branch.')
    pushed = true

    const create = await runGh(context, [
      'pr',
      'create',
      '--head',
      branch,
      '--base',
      baseBranch,
      '--title',
      title,
      '--body',
      input.body || '',
      ...(input.draft ? ['--draft'] : [])
    ])
    if (create.code !== 0) throw commandFailure(create, 'Could not create the pull request.')
    const url = create.stdout.trim().match(/https?:\/\/[^\s]+/)?.[0]
    const view = await runGh(context, [
      'pr',
      'view',
      ...(url ? [url] : [branch]),
      '--json',
      PULL_REQUEST_JSON_FIELDS
    ])
    let pullRequest: GitPrSummary
    if (view.code === 0) {
      pullRequest = parseGitPullRequestSummary(JSON.parse(view.stdout || '{}'))
    } else {
      warnings.push('The pull request was created, but its full status could not be refreshed.')
      pullRequest = {
        url,
        state: 'OPEN',
        isDraft: input.draft === true,
        headRefName: branch,
        headRefOid: headSha,
        baseRefName: baseBranch,
        title,
        body: input.body || ''
      }
    }
    result = {
      branch,
      baseBranch,
      commitHashes: orderedCommits.map((commit) => commit.hash),
      headSha,
      pullRequest,
      warnings
    }
  } catch (error) {
    workflowError = error instanceof Error ? error : new Error(String(error))
    if (pushed) {
      const rollback = await context.run(
        'git',
        ['push', '--receive-pack=git-receive-pack', remote, '--delete', branch],
        { cwd: context.repoRoot, timeoutMs: context.timeoutMs }
      )
      if (rollback.code === 0) pushed = false
      else {
        workflowError = new Error(
          `${workflowError.message} The newly pushed branch "${branch}" could not be rolled back and was kept on ${remote}.`
        )
      }
    }
  } finally {
    if (worktreeAdded) await removeTemporaryWorktree(context, worktreePath, warnings)
    await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
  }

  if (workflowError) {
    if (branchCreated && !pushed) {
      await context.run('git', ['branch', '-D', branch], {
        cwd: context.repoRoot,
        timeoutMs: context.timeoutMs
      })
    }
    throw workflowError
  }
  if (!result) throw new Error('Pull request creation finished without a result.')
  return result
}

async function readPullRequest(
  context: GitPullRequestWorkflowContext,
  pullRequestNumber: number
): Promise<GitPrSummary> {
  const view = await runGh(context, [
    'pr',
    'view',
    String(pullRequestNumber),
    '--json',
    PULL_REQUEST_JSON_FIELDS
  ])
  if (view.code !== 0) throw commandFailure(view, 'Could not read the pull request.')
  return parseGitPullRequestSummary(JSON.parse(view.stdout || '{}'))
}

export async function manageGitPullRequest(
  context: GitPullRequestWorkflowContext,
  input: ManageGitPullRequestInput
): Promise<GitPullRequestLifecycleResult> {
  const pullRequestNumber = Math.trunc(input.pullRequestNumber)
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0) {
    throw new Error('A valid pull request number is required.')
  }
  const current = await readPullRequest(context, pullRequestNumber)
  const selector = String(pullRequestNumber)
  let args: string[]
  switch (input.lifecycle.action) {
    case 'edit': {
      const { title, body, baseBranch } = input.lifecycle
      if (title === undefined && body === undefined && baseBranch === undefined) {
        throw new Error('Change the title, body, or base branch before saving.')
      }
      if (title !== undefined && !title.trim()) throw new Error('Pull request title is required.')
      if (baseBranch !== undefined) {
        await assertBranchName(context, baseBranch.trim(), 'Base branch')
      }
      args = [
        'pr',
        'edit',
        selector,
        ...(title !== undefined ? ['--title', title.trim()] : []),
        ...(body !== undefined ? ['--body', body] : []),
        ...(baseBranch !== undefined ? ['--base', baseBranch.trim()] : [])
      ]
      break
    }
    case 'mark-ready':
      args = ['pr', 'ready', selector]
      break
    case 'convert-to-draft':
      args = ['pr', 'ready', selector, '--undo']
      break
    case 'close':
      args = ['pr', 'close', selector]
      break
    case 'reopen':
      args = ['pr', 'reopen', selector]
      break
    case 'merge': {
      if (!['merge', 'squash', 'rebase'].includes(input.lifecycle.strategy)) {
        throw new Error('Choose merge, squash, or rebase as the pull request strategy.')
      }
      const expectedHeadSha = input.lifecycle.expectedHeadSha?.trim() || current.headRefOid
      if (expectedHeadSha && !/^[0-9a-f]{40}$/i.test(expectedHeadSha)) {
        throw new Error('Expected pull request head must be a full Git hash.')
      }
      if (
        input.lifecycle.expectedHeadSha &&
        current.headRefOid &&
        input.lifecycle.expectedHeadSha.toLowerCase() !== current.headRefOid.toLowerCase()
      ) {
        throw new Error('The pull request head changed. Refresh before merging.')
      }
      args = [
        'pr',
        'merge',
        selector,
        `--${input.lifecycle.strategy}`,
        ...(input.lifecycle.auto ? ['--auto'] : []),
        ...(input.lifecycle.deleteBranch ? ['--delete-branch'] : []),
        ...(expectedHeadSha ? ['--match-head-commit', expectedHeadSha] : [])
      ]
      break
    }
  }

  const mutation = await runGh(context, args)
  if (mutation.code !== 0) throw commandFailure(mutation, 'Could not update the pull request.')
  const warnings: string[] = []
  try {
    return { pullRequest: await readPullRequest(context, pullRequestNumber), warnings }
  } catch {
    warnings.push('The action completed, but the pull request status could not be refreshed.')
    return {
      pullRequest: {
        ...current,
        ...(input.lifecycle.action === 'mark-ready' ? { isDraft: false } : {}),
        ...(input.lifecycle.action === 'convert-to-draft' ? { isDraft: true } : {}),
        ...(input.lifecycle.action === 'close' ? { state: 'CLOSED' } : {}),
        ...(input.lifecycle.action === 'reopen' ? { state: 'OPEN' } : {}),
        ...(input.lifecycle.action === 'merge' && input.lifecycle.auto
          ? { autoMergeEnabled: true }
          : input.lifecycle.action === 'merge'
            ? { state: 'MERGED' }
            : {})
      },
      warnings
    }
  }
}
