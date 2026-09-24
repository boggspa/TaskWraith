/**
 * Composer above-bar style state — local flags that replace a `:has()` selector
 * family which was invalidating the whole document.
 *
 * WHY THIS EXISTS (measured, not cosmetic)
 * ---------------------------------------
 * The native 20s renderer trace at
 * `perf-homes/perf-style-/after-d4cec00ba7/soak-artifacts-style-d4cec00ba7`
 * recorded 35 `StyleInvalidatorInvalidationTracking` events with
 * `reason: "Invalidation set invalidates subtree"` and
 * `allDescendantsMightBeInvalid: true`, scheduled on the `HTML` node with
 * `changedPseudo: "has"`. 34 of the 35 largest style recalcs (1310ms of the
 * 1317ms of `UpdateLayoutTree` in the retained trace) followed one of those
 * invalidations, each restyling ~2458 of ~2710 elements — a whole-document
 * restyle triggered by unrelated transcript inserts/deletes.
 *
 * That set was built from 22 composer selectors which all share one shape: a
 * `:has()` condition followed by a combinator and a FEATURELESS subject —
 * `> *`, `> * + *`, `> ::after`, `> :first-child`, `> :last-child`,
 * `> :not(...)`. Blink cannot key an invalidation set on a subject that carries
 * no class/id/tag feature, so it falls back to "invalidate this whole subtree";
 * because the anchor is a `:has()` scope it is scheduled at the document root.
 *
 * Rules like `.composer-above-bar-stack:has(.ensemble-above-row) { ... }` are
 * NOT affected: their subject is a class, so Blink builds a narrow class-keyed
 * set. Those are deliberately left alone.
 *
 * The fix carries the same four conditions as ordinary classes so the affected
 * rules can key on a class instead of `:has()`. State is derived from the real
 * DOM rather than from render-time booleans because several above-rows are
 * rendered by child components that can return `null` from their own state, and
 * the Cursor/Codex shells float workspace rows OUTSIDE the stack.
 */

/** Set on the `.composer-area` that contains an above-bar stack. */
export const COMPOSER_AREA_HAS_ABOVE_STACK_CLASS = 'composer-area--has-above-stack'

/** Set on a stack containing an ensemble / queued / compact-preset row. */
export const COMPOSER_STACK_HAS_ENSEMBLE_ROWS_CLASS = 'composer-above-bar-stack--has-ensemble-rows'

/** Set on a stack with two or more element children. */
export const COMPOSER_STACK_MULTI_ROW_CLASS = 'composer-above-bar-stack--multi-row'

/** Set on a stack with a direct primary-workspace-row child. */
export const COMPOSER_STACK_HAS_PRIMARY_ROW_CLASS = 'composer-above-bar-stack--has-primary-row'

/**
 * Descendant condition of the replaced rules. Kept byte-identical to the
 * `:has()` argument it replaces so the two cannot drift.
 */
export const COMPOSER_ENSEMBLE_ROW_SELECTOR =
  '.ensemble-above-row, .queued-messages-above-row, .ensemble-roster-preset-picker.is-compact'

/** Direct-child condition of the replaced `:has(> ...)` rules. */
export const COMPOSER_PRIMARY_WORKSPACE_ROW_CLASS = 'composer-workspace-above-row--primary'

/** Structural view of a `classList`, so tests need no DOM implementation. */
export interface ClassListLike {
  contains(token: string): boolean
  add(token: string): void
  remove(token: string): void
}

/** Structural view of the stack element. A real `HTMLElement` satisfies it. */
export interface ComposerStackLike {
  readonly classList: ClassListLike
  readonly children: ArrayLike<{ readonly classList: ClassListLike }>
  querySelector(selectors: string): unknown
  closest(selectors: string): { readonly classList: ClassListLike } | null
}

/** The four conditions, read once per pass. */
export interface ComposerAboveBarSnapshot {
  /** `:has(.composer-above-bar-stack)` on the area — true whenever a stack exists. */
  hasAboveStack: boolean
  /** `:has(:is(.ensemble-above-row, .queued-messages-above-row, .ensemble-roster-preset-picker.is-compact))` */
  hasEnsembleRows: boolean
  /** `:has(> :nth-child(2))` — two or more element children. */
  hasMultipleRows: boolean
  /** `:has(> .composer-workspace-above-row--primary)` */
  hasPrimaryWorkspaceRow: boolean
}

/**
 * Read the four conditions from a stack element.
 *
 * Only structural reads (`children`, `querySelector`, `classList.contains`) are
 * used. None of them force style or layout, so this cannot reintroduce the
 * forced-reflow cost the geometry work removed.
 */
export function readComposerAboveBarSnapshot(stack: ComposerStackLike): ComposerAboveBarSnapshot {
  const children = stack.children
  let hasPrimaryWorkspaceRow = false
  for (let index = 0; index < children.length; index++) {
    if (children[index]?.classList.contains(COMPOSER_PRIMARY_WORKSPACE_ROW_CLASS)) {
      hasPrimaryWorkspaceRow = true
      break
    }
  }
  return {
    hasAboveStack: true,
    // `:nth-child(2)` matches the second ELEMENT child, so this is a plain
    // element-child count, not a childNodes count.
    hasMultipleRows: children.length >= 2,
    hasPrimaryWorkspaceRow,
    hasEnsembleRows: stack.querySelector(COMPOSER_ENSEMBLE_ROW_SELECTOR) != null
  }
}

function toggle(classList: ClassListLike, token: string, present: boolean): boolean {
  // Only write when the value actually changes. A no-op `add`/`remove` would not
  // change the attribute, but keeping writes conditional makes the "no redundant
  // class write" property explicit and testable.
  if (present === classList.contains(token)) return false
  if (present) classList.add(token)
  else classList.remove(token)
  return true
}

/**
 * Apply the flags for `stack` and its owning `.composer-area`.
 *
 * Returns the number of class tokens actually written, so a caller (or a test)
 * can assert that a steady state performs no writes.
 */
export function applyComposerAboveBarStyleState(stack: ComposerStackLike): number {
  const snapshot = readComposerAboveBarSnapshot(stack)
  let writes = 0
  if (toggle(stack.classList, COMPOSER_STACK_HAS_ENSEMBLE_ROWS_CLASS, snapshot.hasEnsembleRows))
    writes++
  if (toggle(stack.classList, COMPOSER_STACK_MULTI_ROW_CLASS, snapshot.hasMultipleRows)) writes++
  if (
    toggle(stack.classList, COMPOSER_STACK_HAS_PRIMARY_ROW_CLASS, snapshot.hasPrimaryWorkspaceRow)
  )
    writes++
  const area = stack.closest('.composer-area')
  if (area && toggle(area.classList, COMPOSER_AREA_HAS_ABOVE_STACK_CLASS, snapshot.hasAboveStack))
    writes++
  return writes
}

/**
 * Drop the area flag when the stack unmounts.
 *
 * The stack's own flags leave with its element, but `.composer-area` outlives
 * the stack, so `:has(.composer-above-bar-stack)` going false must be mirrored.
 */
export function clearComposerAboveBarStyleState(stack: ComposerStackLike): number {
  const area = stack.closest('.composer-area')
  if (!area) return 0
  return toggle(area.classList, COMPOSER_AREA_HAS_ABOVE_STACK_CLASS, false) ? 1 : 0
}
