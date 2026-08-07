/**
 * Composer chrome must follow the focused chat's workspace, not the
 * app-global currentWorkspace leftover from a previous thread.
 *
 * Multiview already preferred chat-resolved; single-pane historically did not,
 * so the footer Workspaces pill and Branch/Commit action paths could stay on
 * AGBench while the thread (and durable run cwd) already pointed at Test 1.
 */

export type ComposerFocusedWorkspaceLike = {
  id: string
  path: string
  displayName: string
}

export function resolveComposerFocusedWorkspace<T extends ComposerFocusedWorkspaceLike>(input: {
  /** Kept for call-site clarity; both modes prefer chat when present. */
  isMultiviewSplit: boolean
  currentChatWorkspace: T | null | undefined
  currentWorkspace: T | null | undefined
}): T | null {
  void input.isMultiviewSplit
  return input.currentChatWorkspace ?? input.currentWorkspace ?? null
}

/**
 * Base path for composer git mutations (branch checkout, commit, Create PR).
 * Prefer the chat-resolved path App already computes; fall back to the
 * workspace record only when no chat path is available.
 */
export function resolveComposerGitActionBasePath(input: {
  currentWorkspacePath?: string | null
  currentWorkspace?: { path?: string | null } | null
}): string | undefined {
  const fromChat = String(input.currentWorkspacePath || '').trim()
  if (fromChat) return fromChat
  const fromRecord = String(input.currentWorkspace?.path || '').trim()
  return fromRecord || undefined
}
