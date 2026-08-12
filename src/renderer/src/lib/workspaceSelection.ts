/**
 * Workspace-selection intent.
 *
 * Two different user surfaces can select a workspace, and they mean
 * genuinely different things:
 *
 * - `'switch'` — the user *intentionally* changes the workspace of the chat
 *   they are currently looking at, via the composer workspace switcher or the
 *   welcome workspace picker. For an Ensemble chat this rebinds the current
 *   chat in place (1.0.5-EW41) so the curated panel + transcript survive the
 *   move rather than getting dropped onto a fresh single-provider welcome.
 *
 * - `'navigate'` — the user clicks a workspace in the sidebar rail (or the
 *   Settings → Workspaces list) to *go to* that workspace. This must open a
 *   fresh New Chat / Welcome draft scoped to the target workspace and must
 *   NEVER relocate the current chat in place. Silently rebinding an
 *   in-progress chat onto another workspace is dangerous — the next run would
 *   operate against the wrong files — and it blurs workspace↔thread identity.
 *
 * The distinction maps cleanly onto the existing prop semantics: the pickers
 * fire `onPickExisting` (a deliberate switch) while the rail and Settings
 * list fire `onSelectWorkspace` (navigation).
 */
export type WorkspaceSelectIntent = 'switch' | 'navigate'

export interface WorkspaceRebindDecisionInput {
  /** Where the selection came from — see {@link WorkspaceSelectIntent}. */
  intent: WorkspaceSelectIntent
  /** Whether the chat currently on screen is an Ensemble chat. */
  isCurrentEnsembleChat: boolean
}

/**
 * Decide whether selecting a workspace should rebind the *current* chat onto
 * that workspace in place (`true`), or leave the current chat untouched and
 * open a fresh draft for the workspace instead (`false`).
 *
 * Only an intentional `'switch'` of an Ensemble chat rebinds in place. Every
 * `'navigate'` selection — and every non-Ensemble selection — opens a fresh
 * draft.
 */
export function shouldRebindCurrentChatOnWorkspaceSelect(
  input: WorkspaceRebindDecisionInput
): boolean {
  if (input.intent !== 'switch') return false
  return input.isCurrentEnsembleChat
}

/**
 * Options for the native "add a workspace" dialog (App's
 * `handleSelectWorkspace`). Only the composer workspace switcher passes
 * `{ intent: 'switch' }`; every other surface omits options.
 */
export interface WorkspaceAddDialogOptions {
  intent?: WorkspaceSelectIntent
}

/**
 * Resolve the {@link WorkspaceSelectIntent} for the add-workspace dialog.
 *
 * Adding a workspace defaults to `'navigate'`: the newly added workspace
 * opens as its own fresh thread, and the chat the user is looking at keeps
 * its workspace. Rebinding the current chat is reserved for the composer
 * workspace switcher, which opts in with an explicit `{ intent: 'switch' }`.
 *
 * The argument is typed `unknown` deliberately. The sidebar `+` and the
 * Settings "Add workspace" button both wire the dialog straight into
 * `onClick`, so React passes a MouseEvent as the first argument; a truthy
 * but unrelated object must resolve to `'navigate'`, never to `'switch'`.
 * Only the exact literal opt-in escalates.
 */
export function resolveWorkspaceAddDialogIntent(options?: unknown): WorkspaceSelectIntent {
  if (
    typeof options === 'object' &&
    options !== null &&
    (options as WorkspaceAddDialogOptions).intent === 'switch'
  ) {
    return 'switch'
  }
  return 'navigate'
}
