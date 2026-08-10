import { createHash } from 'crypto'

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
