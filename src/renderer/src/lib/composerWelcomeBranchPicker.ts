/**
 * Welcome-screen branch/worktree picker placement.
 *
 * The composer telemetry row's RIGHT zone belongs to the live thread token /
 * cost / RAM tally. On the welcome (new-thread) screen that tally is
 * deliberately absent — no run has happened, so no estimate exists — and the
 * zone renders empty.
 *
 * That is also the one screen where the branch/worktree picker is missing:
 * the workspace above-row that normally carries it is gated on
 * `!isWelcomeChat`, so a new thread could not be pointed at a branch or an
 * isolated worktree until after its first turn, which is exactly when
 * switching is most disruptive.
 *
 * This decides when the picker borrows the vacant tally slot. It is a pure
 * placement rule so the precedence (tally always wins the zone back) is
 * testable without a DOM.
 */
export interface ComposerWelcomeBranchPickerInput {
  /** The composer is showing the welcome / new-thread state. */
  isWelcomeChat: boolean
  /** This composer surface renders workspace git chrome at all. */
  showWorkspaceGitAboveRows: boolean
  /** A live token/cost tally already owns the right telemetry zone. */
  hasThreadTokenTally: boolean
  /** Workspace-less chat — there is no repository to pick a branch in. */
  isGlobalChat: boolean
  /** Base workspace path git actions resolve against. */
  workspacePath?: string | null
}

/**
 * True when the welcome screen should render the branch/worktree picker in the
 * telemetry row's otherwise-empty right zone.
 */
export function shouldShowComposerWelcomeBranchPicker(
  input: ComposerWelcomeBranchPickerInput
): boolean {
  // Only the welcome state. In an active thread the workspace above-row already
  // carries the picker, and the tally owns this zone.
  if (!input.isWelcomeChat) return false
  // Side chats and isolated shells opt out of workspace git chrome entirely
  // (they are handed a null snapshot too), so never grow a picker there.
  if (!input.showWorkspaceGitAboveRows) return false
  // The tally is the zone's owner; borrowing is only valid while it is vacant.
  if (input.hasThreadTokenTally) return false
  // A global chat has no repository to check out from.
  if (input.isGlobalChat) return false
  return Boolean(String(input.workspacePath || '').trim())
}
