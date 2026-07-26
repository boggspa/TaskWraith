/**
 * Reserved worktree / branch namespaces.
 *
 * TaskWraith allocates worktrees automatically in two places, and BOTH re-adopt
 * an existing one by matching Git rather than by remembering they made it:
 *
 *   ThreadWorktreeBinding      name `thread-<hint>-<digest>`   branch `taskwraith/thread-…`
 *   FanoutWorktreeAllocation   name `fanout-<hint>-<digest>`   branch `taskwraith/fanout-…`
 *
 * That re-adoption is what makes these names load-bearing rather than cosmetic.
 * A hand-created worktree that lands in one of those namespaces is not merely
 * confusing — the next allocation will find it, decide it already owns it, and
 * hand an agent a checkout a human is working in. So the namespace is a
 * contract, and anything creating a worktree or branch on a user's behalf must
 * stay out of it.
 *
 * The desktop never needed this rule enforced, because the desktop user picks a
 * destination folder and can see what is already there. A remote client can do
 * neither, so the rule becomes code.
 *
 * Kept in shared/ with one exported predicate so a future third allocator adds
 * its prefix HERE and every caller inherits the refusal, rather than each
 * validator growing its own drifting copy of the list.
 */

/** Name prefixes owned by an automatic allocator. */
export const RESERVED_WORKTREE_NAME_PREFIXES = ['thread-', 'fanout-'] as const

/** Branch prefix owned by TaskWraith's own allocators. */
export const RESERVED_BRANCH_PREFIXES = ['taskwraith/'] as const

/** Human-facing refusal — surfaced verbatim to remote clients. */
export const RESERVED_WORKTREE_NAME_MESSAGE =
  'That name is reserved for worktrees TaskWraith manages automatically. Choose another.'

export const RESERVED_BRANCH_MESSAGE =
  'Branch names starting with "taskwraith/" are reserved for worktrees TaskWraith manages automatically. Choose another.'

/**
 * Whether a requested worktree NAME falls in an allocator-owned namespace.
 *
 * Case-insensitive: the derived directory segment is compared by the filesystem,
 * which is case-insensitive on a default macOS volume, so `Fanout-x` and
 * `fanout-x` would collide on disk even though they differ as strings.
 */
export function isReservedWorktreeName(name: string | null | undefined): boolean {
  const value = String(name || '')
    .trim()
    .toLowerCase()
  if (!value) return false
  return RESERVED_WORKTREE_NAME_PREFIXES.some((prefix) => value.startsWith(prefix))
}

/**
 * Whether a requested BRANCH name falls in an allocator-owned namespace.
 * Git refs are case-sensitive, but the check stays case-insensitive anyway:
 * `TaskWraith/thread-x` is not a ref an allocator would create, yet allowing it
 * invites exactly the confusion the namespace exists to prevent.
 */
export function isReservedBranchName(branch: string | null | undefined): boolean {
  const value = String(branch || '')
    .trim()
    .toLowerCase()
  if (!value) return false
  return RESERVED_BRANCH_PREFIXES.some((prefix) => value.startsWith(prefix))
}
