import { createHash } from 'crypto'

/**
 * Async, main-owned allocation for one fan-out LANE's isolated worktree.
 *
 * The sibling ThreadWorktreeAllocator keys one worktree per chat, which is
 * exactly wrong for parallel fan-out: every lane in a round shares the chat,
 * so per-chat identity would hand all writers the same checkout. This
 * allocator derives a per-(chat, lane) branch/path identity instead, rechecks
 * it against Git before use, and returns it to the dispatch payload builder.
 * Like its sibling it depends on an injected Git-shaped service and performs
 * no filesystem I/O of its own; unlike its sibling it persists nothing —
 * candidate durability is the FanoutCandidatePersistence layer's job.
 */

export interface FanoutWorktreeAllocation {
  baseWorkspacePath: string
  effectiveWorkspacePath: string
  branch: string
}

export interface FanoutWorktreeGitService {
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

export interface EnsureFanoutWorktreeInput {
  chatId: string
  laneId: string
  /** Human hint folded into the branch/path name (participant id or role). */
  participantHint?: string
  baseWorkspacePath: string
  git: FanoutWorktreeGitService
}

/**
 * Serializes allocation per (workspace, chat, lane) within this main process.
 * Git is still revalidated on every call, so the in-flight map is a race
 * guard and dedupe only — never a source of truth.
 */
export class FanoutWorktreeAllocator {
  private inFlight = new Map<string, Promise<FanoutWorktreeAllocation>>()

  ensure(input: EnsureFanoutWorktreeInput): Promise<FanoutWorktreeAllocation> {
    const key = `${normalizePath(input.baseWorkspacePath)}\u0000${input.chatId}\u0000${input.laneId}`
    const existing = this.inFlight.get(key)
    if (existing) return existing

    const operation = this.ensureUnshared(input).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, operation)
    return operation
  }

  private async ensureUnshared(
    input: EnsureFanoutWorktreeInput
  ): Promise<FanoutWorktreeAllocation> {
    const baseWorkspacePath = normalizePath(input.baseWorkspacePath)
    const chatId = input.chatId.trim()
    const laneId = input.laneId.trim()
    if (!baseWorkspacePath || !chatId || !laneId) {
      throw new Error(
        'An isolated fan-out lane needs a saved chat, a lane id, and a registered workspace.'
      )
    }

    const listed = await input.git.listWorktrees(baseWorkspacePath)
    if (!listed.ok) {
      throw new Error(
        `Could not inspect linked worktrees for this fan-out lane: ${listed.error || 'Git did not return a worktree list'}. Check repository access and try again.`
      )
    }

    const identity = fanoutWorktreeIdentity(chatId, laneId, input.participantHint)
    // Retry-idempotent: a lane re-dispatched after a crash reuses the branch
    // it already created rather than failing on "branch exists".
    const alreadyCreated = listed.data.worktrees.find(
      (worktree) => worktree.branch === identity.branch
    )
    const effectiveWorkspacePath = alreadyCreated
      ? normalizePath(alreadyCreated.path)
      : await this.createWorktree(input, baseWorkspacePath, identity)

    return {
      baseWorkspacePath,
      effectiveWorkspacePath,
      branch: identity.branch
    }
  }

  private async createWorktree(
    input: EnsureFanoutWorktreeInput,
    baseWorkspacePath: string,
    identity: { name: string; branch: string }
  ): Promise<string> {
    const created = await input.git.createWorktree({
      repoPath: baseWorkspacePath,
      name: identity.name,
      branch: identity.branch
    })
    if (!created.ok) {
      throw new Error(
        `Could not create an isolated worktree for this fan-out lane: ${created.error || 'Git did not return a worktree path'}. Open Branch & worktree to inspect the repository, then retry.`
      )
    }
    const path = normalizePath(created.data.requestedPath)
    if (!path) {
      throw new Error(
        'Git created a fan-out worktree without a usable path. Open Branch & worktree and retry.'
      )
    }
    return path
  }
}

/**
 * Deterministic per-(chat, lane) identity. Lane ids are long
 * (`lane-<roundId>-<participantId>-<attempt>`), so the branch carries a short
 * sanitized participant hint for humans plus a 10-hex digest of the exact
 * (chatId, laneId) pair for uniqueness. Deterministic on purpose: a retried
 * allocation for the same lane resolves to the same branch and is reused.
 */
export function fanoutWorktreeIdentity(
  chatId: string,
  laneId: string,
  participantHint?: string
): { name: string; branch: string } {
  const hint =
    (participantHint || '')
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'lane'
  const digest = createHash('sha256').update(`${chatId}\u0000${laneId}`).digest('hex').slice(0, 10)
  const suffix = `${hint}-${digest}`
  return {
    name: `fanout-${suffix}`,
    branch: `taskwraith/fanout-${suffix}`
  }
}

function normalizePath(value: string): string {
  return value.trim().replace(/\/+$/, '')
}
