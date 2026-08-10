import { createHash } from 'crypto'
import type { RuntimeWorktreeIntent } from './run/AgentRunTypes'

/**
 * Soft-fail worktree allocation for a sole ephemeral-fleet writer.
 *
 * Mirrors {@link FanoutWorktreeAllocator}: injected Git service, no filesystem
 * I/O of its own, re-adopts an existing `taskwraith/fleet-…` branch on retry.
 * Unlike fan-out, allocation failures return `null` so the caller can fall
 * back to `capped_inherit` without aborting the wave.
 */

export interface EphemeralFleetWorktreeAllocation {
  baseWorkspacePath: string
  effectiveWorkspacePath: string
  branch: string
}

export interface EphemeralFleetWorktreeGitService {
  listWorktrees(
    repoPath: string
  ): Promise<
    | { ok: true; data: { worktrees: Array<{ path: string; branch?: string }> } }
    | { ok: false; error?: string }
  >
  createWorktree(input: {
    repoPath: string
    name: string
    branch: string
  }): Promise<
    { ok: true; data: { requestedPath: string; branch?: string } } | { ok: false; error?: string }
  >
}

/** Git surface for promote/discard/remove on die-on-return. */
export interface EphemeralFleetWorktreeLifecycleGitService extends EphemeralFleetWorktreeGitService {
  captureWorktreePatch(input: { worktreePath: string }): Promise<
    | {
        ok: true
        data: { patch: string; clean: boolean }
      }
    | { ok: false; error?: string }
  >
  inspectPatchApplication(input: {
    repoPath: string
    patch: string
  }): Promise<
    | { ok: true; data: { state: 'applicable' | 'already-applied' | 'ambiguous' | string } }
    | { ok: false; error?: string }
  >
  applyPatchToRepository(input: {
    repoPath: string
    patch: string
  }): Promise<{ ok: true } | { ok: false; error?: string }>
  removeWorktree(input: {
    repoPath: string
    path: string
    force?: boolean
  }): Promise<{ ok: true } | { ok: false; error?: string }>
  deleteBranch(input: {
    repoPath: string
    branch: string
    force?: boolean
  }): Promise<{ ok: true } | { ok: false; error?: string }>
}

export interface AllocateEphemeralFleetWriterWorktreeInput {
  parentChatId: string
  workerChatId: string
  /** Human hint folded into the branch/path name (role label). */
  label?: string
  baseWorkspacePath: string
  git: EphemeralFleetWorktreeGitService
}

/**
 * Serializes allocation per (workspace, parent, worker) within this main process.
 * Git is still revalidated on every call; the in-flight map is a race guard only.
 */
export class EphemeralFleetWorktreeAllocator {
  private inFlight = new Map<string, Promise<EphemeralFleetWorktreeAllocation | null>>()

  allocate(
    input: AllocateEphemeralFleetWriterWorktreeInput
  ): Promise<EphemeralFleetWorktreeAllocation | null> {
    const key = `${normalizePath(input.baseWorkspacePath)}\u0000${input.parentChatId}\u0000${input.workerChatId}`
    const existing = this.inFlight.get(key)
    if (existing) return existing

    const operation = this.allocateUnshared(input).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, operation)
    return operation
  }

  private async allocateUnshared(
    input: AllocateEphemeralFleetWriterWorktreeInput
  ): Promise<EphemeralFleetWorktreeAllocation | null> {
    const baseWorkspacePath = normalizePath(input.baseWorkspacePath)
    const parentChatId = input.parentChatId.trim()
    const workerChatId = input.workerChatId.trim()
    if (!baseWorkspacePath || !parentChatId || !workerChatId) {
      return null
    }

    let listed: Awaited<ReturnType<EphemeralFleetWorktreeGitService['listWorktrees']>>
    try {
      listed = await input.git.listWorktrees(baseWorkspacePath)
    } catch {
      return null
    }
    if (!listed.ok) {
      return null
    }

    const identity = ephemeralFleetWorktreeIdentity(parentChatId, workerChatId, input.label)
    const alreadyCreated = listed.data.worktrees.find(
      (worktree) => worktree.branch === identity.branch
    )
    if (alreadyCreated) {
      const effectiveWorkspacePath = normalizePath(alreadyCreated.path)
      if (!effectiveWorkspacePath || effectiveWorkspacePath === baseWorkspacePath) {
        return null
      }
      return {
        baseWorkspacePath,
        effectiveWorkspacePath,
        branch: identity.branch
      }
    }

    let created: Awaited<ReturnType<EphemeralFleetWorktreeGitService['createWorktree']>>
    try {
      created = await input.git.createWorktree({
        repoPath: baseWorkspacePath,
        name: identity.name,
        branch: identity.branch
      })
    } catch {
      return null
    }
    if (!created.ok) {
      return null
    }
    const effectiveWorkspacePath = normalizePath(created.data.requestedPath)
    if (!effectiveWorkspacePath || effectiveWorkspacePath === baseWorkspacePath) {
      return null
    }
    return {
      baseWorkspacePath,
      effectiveWorkspacePath,
      branch: identity.branch
    }
  }
}

const sharedAllocator = new EphemeralFleetWorktreeAllocator()

/**
 * Allocate (or re-adopt) an isolated worktree for a sole fleet writer.
 * Soft-fails to `null` on any identity/Git/path problem — callers fall back
 * to `capped_inherit` via {@link resolveEphemeralFleetIsolationForWave}.
 */
export function allocateEphemeralFleetWriterWorktree(
  input: AllocateEphemeralFleetWriterWorktreeInput
): Promise<EphemeralFleetWorktreeAllocation | null> {
  return sharedAllocator.allocate(input)
}

/**
 * Stamp a selected runtimeWorktree intent for an ephemeral-fleet sole writer.
 * Returns undefined unless isolation is worktree and both paths are non-empty
 * and distinct — callers then omit runtimeWorktree from the run payload.
 */
export function buildEphemeralFleetRuntimeWorktreeIntent(input: {
  isolation: string
  baseWorkspacePath?: string
  effectiveWorkspacePath?: string
}): RuntimeWorktreeIntent | undefined {
  if (input.isolation !== 'worktree') return undefined
  const baseWorkspacePath = normalizePath(input.baseWorkspacePath || '')
  const effectiveWorkspacePath = normalizePath(input.effectiveWorkspacePath || '')
  if (!baseWorkspacePath || !effectiveWorkspacePath) return undefined
  if (baseWorkspacePath === effectiveWorkspacePath) return undefined
  return {
    requested: true,
    source: 'ephemeralFleet',
    status: 'selected',
    baseWorkspacePath,
    effectiveWorkspacePath
  }
}

/**
 * Deterministic per-(parentChat, workerChat) identity. Worker chat ids are
 * opaque; the branch carries a short sanitized label hint plus a 10-hex
 * digest of the exact pair for uniqueness and retry re-adoption.
 */
export function ephemeralFleetWorktreeIdentity(
  parentChatId: string,
  workerChatId: string,
  label?: string
): { name: string; branch: string } {
  const hint =
    (label || '')
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'worker'
  const digest = createHash('sha256')
    .update(`${parentChatId}\u0000${workerChatId}`)
    .digest('hex')
    .slice(0, 10)
  const suffix = `${hint}-${digest}`
  return {
    name: `fleet-${suffix}`,
    branch: `taskwraith/fleet-${suffix}`
  }
}

function normalizePath(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

export type EphemeralFleetWorktreeSettleOutcome =
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'requires_action'

/**
 * Re-adopt a linked fleet worktree by deterministic identity. Returns null when
 * the branch/path is not linked (already cleaned or never allocated).
 */
export async function resolveEphemeralFleetWriterWorktree(input: {
  parentChatId: string
  workerChatId: string
  label?: string
  baseWorkspacePath: string
  git: EphemeralFleetWorktreeGitService
}): Promise<EphemeralFleetWorktreeAllocation | null> {
  const baseWorkspacePath = normalizePath(input.baseWorkspacePath)
  if (!baseWorkspacePath || !input.parentChatId.trim() || !input.workerChatId.trim()) {
    return null
  }
  let listed: Awaited<ReturnType<EphemeralFleetWorktreeGitService['listWorktrees']>>
  try {
    listed = await input.git.listWorktrees(baseWorkspacePath)
  } catch {
    return null
  }
  if (!listed.ok) return null
  const identity = ephemeralFleetWorktreeIdentity(
    input.parentChatId,
    input.workerChatId,
    input.label
  )
  const match = listed.data.worktrees.find((worktree) => worktree.branch === identity.branch)
  if (!match) return null
  const effectiveWorkspacePath = normalizePath(match.path)
  if (!effectiveWorkspacePath || effectiveWorkspacePath === baseWorkspacePath) return null
  return {
    baseWorkspacePath,
    effectiveWorkspacePath,
    branch: identity.branch
  }
}

async function cleanupEphemeralFleetWriterWorktree(input: {
  allocation: EphemeralFleetWorktreeAllocation
  git: EphemeralFleetWorktreeLifecycleGitService
}): Promise<{ ok: boolean; error?: string }> {
  const removed = await input.git.removeWorktree({
    repoPath: input.allocation.baseWorkspacePath,
    path: input.allocation.effectiveWorkspacePath,
    force: true
  })
  if (!removed.ok) {
    return { ok: false, error: removed.error || 'git worktree remove failed' }
  }
  const deleted = await input.git.deleteBranch({
    repoPath: input.allocation.baseWorkspacePath,
    branch: input.allocation.branch,
    force: true
  })
  if (!deleted.ok) {
    return { ok: false, error: deleted.error || 'git branch -D failed' }
  }
  return { ok: true }
}

/** Remove a linked fleet worktree + branch. Idempotent when already gone. */
export async function removeEphemeralFleetWriterWorktree(input: {
  parentChatId: string
  workerChatId: string
  label?: string
  baseWorkspacePath: string
  git: EphemeralFleetWorktreeLifecycleGitService
}): Promise<{ ok: boolean; removed: boolean; error?: string }> {
  const allocation = await resolveEphemeralFleetWriterWorktree(input)
  if (!allocation) return { ok: true, removed: false }
  const cleaned = await cleanupEphemeralFleetWriterWorktree({
    allocation,
    git: input.git
  })
  if (!cleaned.ok) return { ok: false, removed: false, error: cleaned.error }
  return { ok: true, removed: true }
}

/**
 * Capture the fleet worktree patch, apply onto the parent checkout (uncommitted),
 * then remove the worktree. Clean worktrees skip apply and only clean up.
 * On apply failure the worktree is retained so edits are not lost.
 */
export async function promoteEphemeralFleetWriterWorktree(input: {
  parentChatId: string
  workerChatId: string
  label?: string
  baseWorkspacePath: string
  git: EphemeralFleetWorktreeLifecycleGitService
}): Promise<{ ok: boolean; applied: boolean; removed: boolean; error?: string }> {
  const allocation = await resolveEphemeralFleetWriterWorktree(input)
  if (!allocation) {
    return { ok: false, applied: false, removed: false, error: 'Fleet worktree is not linked.' }
  }
  const capture = await input.git.captureWorktreePatch({
    worktreePath: allocation.effectiveWorkspacePath
  })
  if (!capture.ok) {
    return {
      ok: false,
      applied: false,
      removed: false,
      error: capture.error || 'Could not capture the fleet worktree patch.'
    }
  }
  if (!capture.data.clean) {
    const inspection = await input.git.inspectPatchApplication({
      repoPath: allocation.baseWorkspacePath,
      patch: capture.data.patch
    })
    if (!inspection.ok) {
      return {
        ok: false,
        applied: false,
        removed: false,
        error: inspection.error || 'Could not inspect the fleet patch against the parent checkout.'
      }
    }
    if (inspection.data.state === 'applicable') {
      const applied = await input.git.applyPatchToRepository({
        repoPath: allocation.baseWorkspacePath,
        patch: capture.data.patch
      })
      if (!applied.ok) {
        return {
          ok: false,
          applied: false,
          removed: false,
          error: applied.error || 'git apply failed against the parent checkout.'
        }
      }
    } else if (inspection.data.state !== 'already-applied') {
      return {
        ok: false,
        applied: false,
        removed: false,
        error:
          inspection.data.state === 'ambiguous'
            ? 'Fleet promote is ambiguous: patch applies both forward and reverse.'
            : 'Fleet patch neither applies cleanly nor matches an already-applied state.'
      }
    }
  }
  const cleaned = await cleanupEphemeralFleetWriterWorktree({
    allocation,
    git: input.git
  })
  if (!cleaned.ok) {
    return {
      ok: false,
      applied: !capture.data.clean,
      removed: false,
      error: cleaned.error
    }
  }
  return { ok: true, applied: !capture.data.clean, removed: true }
}

/**
 * Die-on-return disposition: promote on `done`, otherwise discard/remove.
 * No-ops when no fleet worktree is linked (capped_inherit seats).
 */
export async function settleEphemeralFleetWriterWorktreeOnReturn(input: {
  parentChatId: string
  workerChatId: string
  label?: string
  baseWorkspacePath: string
  outcome: EphemeralFleetWorktreeSettleOutcome
  git: EphemeralFleetWorktreeLifecycleGitService
}): Promise<{ ok: boolean; action: 'promoted' | 'discarded' | 'noop'; error?: string }> {
  const linked = await resolveEphemeralFleetWriterWorktree(input)
  if (!linked) return { ok: true, action: 'noop' }
  if (input.outcome === 'done') {
    const promoted = await promoteEphemeralFleetWriterWorktree(input)
    if (!promoted.ok) {
      return { ok: false, action: 'promoted', error: promoted.error }
    }
    return { ok: true, action: 'promoted' }
  }
  const removed = await removeEphemeralFleetWriterWorktree(input)
  if (!removed.ok) {
    return { ok: false, action: 'discarded', error: removed.error }
  }
  return { ok: true, action: removed.removed ? 'discarded' : 'noop' }
}
