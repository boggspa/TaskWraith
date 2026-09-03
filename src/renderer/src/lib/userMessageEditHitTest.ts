/**
 * Hit-test decision for the rewind-from-message ("Edit & resend from here")
 * click gesture on a user transcript bubble.
 *
 * The original guard was `event.target === event.currentTarget`, which only
 * fires for clicks on the bubble's bare padding: the message text renders
 * inside a child `.user-message-content` wrapper, so clicking the text — the
 * headline gesture — never opened the editor. The guard existed for a real
 * reason, though: a click on a link, a button, or an active drag-selection
 * inside the bubble must not hijack into edit mode. This predicate keeps that
 * intent without excluding the entire text body.
 *
 * Pure and DOM-free (mirroring src/shared/chatRewindPolicy.ts): the component
 * probes the event (`target.closest(...)`, `window.getSelection()`), this
 * module decides. That keeps the decision unit-testable in a repo with no
 * DOM/jsdom test environment.
 */
export interface UserMessageEditClickInput {
  /**
   * Some bubble (this one or another) is already in edit mode. Switching
   * targets mid-edit is deliberately refused: the open editor's Cancel/Save
   * is the explicit way out, and a silent switch would discard typed edits.
   */
  readonly alreadyEditing: boolean
  /**
   * The click landed on or inside an interactive descendant — link, button,
   * input, textarea, select, or `[role="button"]` (the collapse toggle, copy
   * buttons inside rendered markdown, media-strip controls).
   */
  readonly interactiveTarget: boolean
  /**
   * A non-empty text selection is active; drag-to-select text inside the
   * bubble must not collapse into edit mode mid-gesture.
   */
  readonly hasTextSelection: boolean
}

export function shouldOpenUserMessageEditor(input: UserMessageEditClickInput): boolean {
  return !input.alreadyEditing && !input.interactiveTarget && !input.hasTextSelection
}
