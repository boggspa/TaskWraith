export function composerHighlightScrollTransform(scrollLeft: number, scrollTop: number): string {
  const x = Number.isFinite(scrollLeft) ? -scrollLeft : 0
  const y = Number.isFinite(scrollTop) ? -scrollTop : 0
  return `translate3d(${x}px, ${y}px, 0)`
}

export function syncComposerHighlightScroll(
  textarea: Pick<HTMLTextAreaElement, 'scrollLeft' | 'scrollTop'>,
  content: Pick<HTMLDivElement, 'style'>
): void {
  content.style.transform = composerHighlightScrollTransform(
    textarea.scrollLeft,
    textarea.scrollTop
  )
}

const COMPOSER_HIGHLIGHT_METRIC_PROPERTIES = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-stretch',
  'font-variant',
  'font-kerning',
  'font-feature-settings',
  'font-variation-settings',
  'font-optical-sizing',
  'font-synthesis',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'tab-size',
  'text-transform',
  'text-indent',
  'text-align',
  'text-align-last',
  'text-rendering',
  'text-size-adjust',
  'white-space',
  'overflow-wrap',
  'word-break',
  'line-break',
  'hyphens',
  'direction',
  'writing-mode',
  'text-orientation',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'box-sizing',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width'
] as const

function cssPixelValue(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Keep the mirror's line-breaking viewport identical to the textarea's.
 *
 * `clientWidth` is the textarea padding box *after* Chromium has removed the
 * vertical scrollbar gutter. A normal absolutely-positioned div still owns
 * that gutter, so using the wrapper width lets the mirror fit a few more
 * characters on a line. Once one layer wraps and the other does not, every
 * later caret and selection rectangle appears displaced. Reconstructing the
 * mirror's CSS width from `clientWidth` makes both layers wrap at the same
 * character whether a scrollbar is present or not.
 */
export function syncComposerHighlightMetrics(
  textarea: Pick<
    HTMLTextAreaElement,
    'clientWidth' | 'clientHeight' | 'scrollHeight' | 'scrollLeft' | 'scrollTop'
  >,
  content: Pick<HTMLDivElement, 'style'>,
  computedStyle: Pick<CSSStyleDeclaration, 'boxSizing' | 'getPropertyValue'>
): void {
  for (const property of COMPOSER_HIGHLIGHT_METRIC_PROPERTIES) {
    content.style.setProperty(property, computedStyle.getPropertyValue(property))
  }

  const borderLeft = cssPixelValue(computedStyle.getPropertyValue('border-left-width'))
  const borderRight = cssPixelValue(computedStyle.getPropertyValue('border-right-width'))
  const borderTop = cssPixelValue(computedStyle.getPropertyValue('border-top-width'))
  const borderBottom = cssPixelValue(computedStyle.getPropertyValue('border-bottom-width'))
  const paddingLeft = cssPixelValue(computedStyle.getPropertyValue('padding-left'))
  const paddingRight = cssPixelValue(computedStyle.getPropertyValue('padding-right'))
  const paddingTop = cssPixelValue(computedStyle.getPropertyValue('padding-top'))
  const paddingBottom = cssPixelValue(computedStyle.getPropertyValue('padding-bottom'))
  const borderBox = computedStyle.boxSizing === 'border-box'

  content.style.width = `${Math.max(
    0,
    borderBox
      ? textarea.clientWidth + borderLeft + borderRight
      : textarea.clientWidth - paddingLeft - paddingRight
  )}px`
  content.style.minHeight = `${Math.max(
    0,
    borderBox
      ? Math.max(textarea.scrollHeight, textarea.clientHeight) + borderTop + borderBottom
      : Math.max(textarea.scrollHeight, textarea.clientHeight) - paddingTop - paddingBottom
  )}px`
  content.style.borderStyle = 'solid'
  content.style.borderColor = 'transparent'
  syncComposerHighlightScroll(textarea, content)
}
