/**
 * Async, main-owned binding for one chat's isolated worktree.
 *
 * The renderer may still select a worktree explicitly, but a runtime profile
 * that requires isolation must not force the user through that picker on every
 * turn. This allocator gives each chat a stable branch/path identity, rechecks
 * it against Git before every use, and only then returns it to the dispatch
 * preflight. It deliberately depends on an injected Git-shaped service: the
 * allocation path stays testable and never reaches for filesystem APIs itself.
 */

export interface ThreadWorktreeBinding {
  schemaVersion: 1
  baseWorkspacePath: string
  effectiveWorkspacePath: string
  branch: string
}

export interface ThreadWorktreeInfo {
  path: string
  branch?: string
}

export interface ThreadWorktreeGitService {
  listWorktrees(
    repoPath: string
  ): Promise<
    | { ok: true; data: { worktrees: ThreadWorktreeInfo[] } }
    | { ok: false; error?: string }
  >
  createWorktree(input: {
    repoPath: string
    name: string
    branch: string
  }): Promise<
    | { ok: true; data: { requestedPath: string; branch?: string } }
    | { ok: false; error?: string }
  >
}

export type ThreadWorktreeProgress = 'checking' | 'creating' | 'binding'

export interface EnsureThreadWorktreeInput {
  chatId: string
  baseWorkspacePath: string
  binding?: ThreadWorktreeBinding
  git: ThreadWorktreeGitService
  /**
   * Durable persistence is intentionally injected. The current AppStore uses
   * synchronous whole-chat writes, so dispatch wiring must provide an async
   * bounded patch rather than adding more synchronous I/O here.
   */
  persist: (binding: ThreadWorktreeBinding) => Promise<void>
  onProgress?: (progress: ThreadWorktreeProgress) => void
}

/**
 * Serializes allocation for a single chat within this main process. Git is
 * still revalidated after process restarts, so this is an optimization and a
 * race guard — never the durable source of truth.
 */
export class ThreadWorktreeAllocator {
  private inFlight = new Map<string, Promise<ThreadWorktreeBinding>>()

  ensure(input: EnsureThreadWorktreeInput): Promise<ThreadWorktreeBinding> {
    const key = `${normalizePath(input.baseWorkspacePath)}\u0000${input.chatId}`
    const existing = this.inFlight.get(key)
    if (existing) return existing

    const operation = this.ensureUnshared(input).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, operation)
    return operation
  }

  private async ensureUnshared(input: EnsureThreadWorktreeInput): Promise<ThreadWorktreeBinding> {
    const baseWorkspacePath = normalizePath(input.baseWorkspacePath)
    const chatId = input.chatId.trim()
    if (!baseWorkspacePath || !chatId) {
      throw new Error('An isolated worktree needs both a saved chat and a registered workspace.')
    }

    input.onProgress?.('checking')
    const listed = await input.git.listWorktrees(baseWorkspacePath)
    if (!listed.ok) {
      throw new Error(
        `Could not inspect linked worktrees for this chat: ${listed.error || 'Git did not return a worktree list'}. Check repository access and try again.`
      )
    }

    const persisted = input.binding
    if (persisted && normalizePath(persisted.baseWorkspacePath) === baseWorkspacePath) {
      const persistedPath = normalizePath(persisted.effectiveWorkspacePath)
      const linked = listed.data.worktrees.some((worktree) => normalizePath(worktree.path) === persistedPath)
      if (linked) return { ...persisted, baseWorkspacePath, effectiveWorkspacePath: persistedPath }
    }

    const identity = threadWorktreeIdentity(chatId)
    const alreadyCreated = listed.data.worktrees.find((worktree) => worktree.branch === identity.branch)
    const effectiveWorkspacePath = alreadyCreated
      ? normalizePath(alreadyCreated.path)
      : await this.createWorktree(input, baseWorkspacePath, identity)

    const binding: ThreadWorktreeBinding = {
      schemaVersion: 1,
      baseWorkspacePath,
      effectiveWorkspacePath,
      branch: identity.branch
    }
    input.onProgress?.('binding')
    try {
      await input.persist(binding)
    } catch (error) {
      throw new Error(
        `The isolated worktree was prepared but could not be bound to this chat: ${error instanceof Error ? error.message : String(error)}. Retry the run; TaskWraith will re-check the branch before reuse.`
      )
    }
    return binding
  }

  private async createWorktree(
    input: EnsureThreadWorktreeInput,
    baseWorkspacePath: string,
    identity: { name: string; branch: string }
  ): Promise<string> {
    input.onProgress?.('creating')
    const created = await input.git.createWorktree({
      repoPath: baseWorkspacePath,
      name: identity.name,
      branch: identity.branch
    })
    if (!created.ok) {
      throw new Error(
        `Could not create an isolated worktree for this chat: ${created.error || 'Git did not return a worktree path'}. Open Branch & worktree to inspect the repository, then retry.`
      )
    }
    const path = normalizePath(created.data.requestedPath)
    if (!path) {
      throw new Error('Git created an isolated worktree without a usable path. Open Branch & worktree and retry.')
    }
    return path
  }
}

function threadWorktreeIdentity(chatId: string): { name: string; branch: string } {
  const segment = chatId
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  const suffix = segment || 'chat'
  return {
    name: `thread-${suffix}`,
    branch: `taskwraith/thread-${suffix}`
  }
}

function normalizePath(value: string): string {
  return value.trim().replace(/\/+$/, '')
}
