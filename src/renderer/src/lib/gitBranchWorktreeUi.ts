import type { GitRepositorySnapshot } from '../../../main/services/GitService'

export interface GitBranchEntry {
  name: string
  isCurrent: boolean
  isRemote?: boolean
  upstream?: string
}

export interface GitWorktreeEntry {
  path: string
  branch?: string
  head?: string
  isCurrent: boolean
  isBare?: boolean
}

export interface GitBranchListResult {
  ok: boolean
  branches: GitBranchEntry[]
  error?: string
}

export interface GitWorktreeListResult {
  ok: boolean
  worktrees: GitWorktreeEntry[]
  error?: string
}

export interface GitBranchActionResult {
  ok: boolean
  error?: string
  snapshot?: GitRepositorySnapshot
}

export interface GitBranchWorktreeAvailabilityInput {
  workspacePath?: string | null
  apiAvailable: boolean
  dirty: boolean
}

const IPC = {
  listBranches: 'git:list-branches',
  checkoutBranch: 'git:checkout-branch',
  createBranch: 'git:create-branch',
  listWorktrees: 'git:list-worktrees',
  createWorktree: 'git:create-worktree',
  removeWorktree: 'git:remove-worktree',
  selectWorktree: 'git:select-worktree'
} as const

function apiFn(name: string): ((...args: unknown[]) => Promise<unknown>) | null {
  const api = (typeof window !== 'undefined' ? window.api : undefined) as
    | Record<string, (...params: unknown[]) => Promise<unknown>>
    | undefined
  if (!api || typeof api[name] !== 'function') return null
  return api[name]
}

export function gitBranchWorktreeApiAvailable(): boolean {
  return Boolean(apiFn(IPC.listBranches) && apiFn(IPC.checkoutBranch))
}

function gitRepositoryPayload(workspacePath: string, chatId?: string): {
  workspacePath: string
  chatId?: string
} {
  return chatId ? { workspacePath, chatId } : { workspacePath }
}

export async function listGitBranches(
  workspacePath: string,
  chatId?: string
): Promise<GitBranchListResult> {
  const fn = apiFn(IPC.listBranches)
  if (!fn) return { ok: false, branches: [], error: 'Branch list API unavailable.' }
  try {
    const result = (await fn(gitRepositoryPayload(workspacePath, chatId))) as GitBranchListResult
    if (!result || typeof result !== 'object') {
      return { ok: false, branches: [], error: 'Unexpected branch list response.' }
    }
    return {
      ok: Boolean(result.ok),
      branches: Array.isArray(result.branches) ? result.branches : [],
      error: result.error
    }
  } catch (error) {
    return { ok: false, branches: [], error: String(error) }
  }
}

export async function checkoutGitBranch(
  workspacePath: string,
  branch: string,
  chatId?: string
): Promise<GitBranchActionResult> {
  const fn = apiFn(IPC.checkoutBranch)
  if (!fn) return { ok: false, error: 'Checkout API unavailable.' }
  try {
    return (await fn({ ...gitRepositoryPayload(workspacePath, chatId), branch })) as GitBranchActionResult
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

export async function createGitBranch(
  workspacePath: string,
  branch: string,
  from?: string,
  chatId?: string
): Promise<GitBranchActionResult> {
  const fn = apiFn(IPC.createBranch)
  if (!fn) return { ok: false, error: 'Create-branch API unavailable.' }
  try {
    return (await fn({ ...gitRepositoryPayload(workspacePath, chatId), branch, from })) as GitBranchActionResult
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

export async function listGitWorktrees(
  workspacePath: string,
  chatId?: string
): Promise<GitWorktreeListResult> {
  const fn = apiFn(IPC.listWorktrees)
  if (!fn) return { ok: false, worktrees: [], error: 'Worktree list API unavailable.' }
  try {
    const result = (await fn(gitRepositoryPayload(workspacePath, chatId))) as GitWorktreeListResult
    return {
      ok: Boolean(result?.ok),
      worktrees: Array.isArray(result?.worktrees) ? result.worktrees : [],
      error: result?.error
    }
  } catch (error) {
    return { ok: false, worktrees: [], error: String(error) }
  }
}

export async function createGitWorktree(
  workspacePath: string,
  input: { name: string; branch?: string; path?: string },
  chatId?: string
): Promise<GitBranchActionResult> {
  const fn = apiFn(IPC.createWorktree)
  if (!fn) return { ok: false, error: 'Create-worktree API unavailable.' }
  try {
    return (await fn({ ...gitRepositoryPayload(workspacePath, chatId), ...input })) as GitBranchActionResult
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

export async function removeGitWorktree(
  workspacePath: string,
  worktreePath: string,
  force?: boolean,
  chatId?: string
): Promise<GitBranchActionResult> {
  const fn = apiFn(IPC.removeWorktree)
  if (!fn) return { ok: false, error: 'Remove-worktree API unavailable.' }
  try {
    return (await fn({
      ...gitRepositoryPayload(workspacePath, chatId),
      path: worktreePath,
      force: Boolean(force)
    })) as GitBranchActionResult
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

export async function selectGitWorktree(
  workspacePath: string,
  worktreePath: string,
  chatId?: string
): Promise<GitBranchActionResult> {
  const fn = apiFn(IPC.selectWorktree)
  if (!fn) return { ok: false, error: 'Select-worktree API unavailable.' }
  try {
    return (await fn({
      ...gitRepositoryPayload(workspacePath, chatId),
      path: worktreePath
    })) as GitBranchActionResult
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

export function isWorktreeDirty(snapshot: GitRepositorySnapshot | null | undefined): boolean {
  if (!snapshot) return false
  const changed = snapshot.counts?.changed ?? 0
  const unstaged = snapshot.counts?.unstaged ?? 0
  const staged = snapshot.counts?.staged ?? 0
  const conflicts = snapshot.conflicts ?? 0
  return changed > 0 || unstaged > 0 || staged > 0 || conflicts > 0
}

export function branchCheckoutDisabledReason(
  input: GitBranchWorktreeAvailabilityInput
): string {
  if (!input.workspacePath) return 'No workspace'
  if (!input.apiAvailable) return 'Branch controls unavailable until backend IPC lands'
  if (input.dirty) return 'Commit or stash changes before switching branch'
  return ''
}

export function worktreeActionDisabledReason(
  input: Pick<GitBranchWorktreeAvailabilityInput, 'workspacePath' | 'apiAvailable'>
): string {
  if (!input.workspacePath) return 'No workspace'
  if (!input.apiAvailable) return 'Worktree controls unavailable until backend IPC lands'
  return ''
}

export function formatBranchLabel(
  snapshot: GitRepositorySnapshot | null | undefined,
  fallbackBranch?: string
): string {
  if (snapshot?.detached) return 'detached HEAD'
  return snapshot?.branch || fallbackBranch || 'detached'
}
