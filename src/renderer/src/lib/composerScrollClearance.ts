/** Extra transcript bottom breathing room per composer above-row strip. */
export const COMPOSER_ABOVE_ROW_CLEARANCE_PX = 20

/** Direct children of `.composer-above-bar-stack` that count as a row strip. */
export const COMPOSER_ABOVE_ROW_STRIP_SELECTOR =
  // (.github-satellite-row left this area — the PR/CI pill now lives inside
  // the pane-bottom timecode bar, whose height already folds into
  // --composer-reserved-height.)
  ':scope > .composer-above-bar, :scope > .ensemble-above-row, :scope > .queued-messages-above-row, :scope > .ensemble-roster-preset-picker'

export function countComposerAboveRowStrips(stack: Element | null): number {
  if (!stack) return 0
  return stack.querySelectorAll(COMPOSER_ABOVE_ROW_STRIP_SELECTOR).length
}

/** First above-row strip is the baseline; each additional strip adds clearance. */
export function composerAboveRowClearancePx(rowCount: number): number {
  return Math.max(0, rowCount - 1) * COMPOSER_ABOVE_ROW_CLEARANCE_PX
}
