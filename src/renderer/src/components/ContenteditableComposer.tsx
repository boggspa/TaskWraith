/**
 * 1.0.5-C5 — Contenteditable composer surface.
 *
 * Replaces the `<textarea>` + `ComposerHighlightOverlay`
 * two-layer pattern with a single `contenteditable="true"`
 * `<div>`. Mention spans become real inline elements rather
 * than a parallel overlay we have to keep visually aligned.
 *
 * **Gated behind `composerContenteditableEnabled`** (main-side
 * env flag exposed to the renderer via capability snapshot).
 * When the gate is off, the existing textarea + overlay
 * remains the rendered composer; this component sits dormant
 * until enabled. App.tsx wiring lands in a follow-on commit;
 * for 1.0.5-C5 the component ships standalone with thorough
 * unit-tested pure helpers and a smoke-tested initial render.
 *
 * **Design centre — plain text is the source of truth**: the
 * orchestrator submits a plain string. We keep the React state
 * as a plain `string` (matching the existing `composerInput`
 * shape) and recompute the DOM HTML on every value change. The
 * component is effectively a controlled surface around its own
 * `innerHTML`. Caret position is preserved across re-renders by
 * saving offset before write + restoring after.
 *
 * **Out of scope for this commit**: full IME composition
 * handling beyond the basics, undo/redo richer than the
 * browser default, App.tsx wiring. Those land as follow-ons
 * once the surface stabilises in dev.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ClipboardEvent,
  type CSSProperties,
  type CompositionEvent,
  type KeyboardEvent
} from 'react'

import {
  buildContenteditableHtml,
  normalisePastedText,
  replaceTriggerWithMention,
  spliceTextAtCaret,
  type MentionSegment
} from '../lib/contenteditable'

export interface ContenteditableComposerProps {
  /** Controlled plain-text value. The component's internal DOM
   * is derived from this string + the `mentions` segments. */
  value: string
  onChange: (value: string) => void
  /** Mention segments to render as styled spans inside the
   * editable surface. Computed by the parent from the value
   * (typically via the existing `mentionHighlight` resolver). */
  mentions?: MentionSegment[]
  /** Fired on Enter without Shift. Shift+Enter inserts a
   * newline. Caller can `preventDefault` via `onKeyDown`. */
  onSubmit?: () => void
  /** Pass-through for slash-menu / mention picker triggers etc. */
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  placeholder?: string
  disabled?: boolean
  /** Composer shell — sets `data-composer-style` on the editable
   * div for per-shell CSS targeting (matches the textarea
   * version). */
  composerStyle?: string
  /** Class name applied to the editable surface. The existing
   * `composer-textarea` class is reused for visual parity
   * with the textarea path. */
  className?: string
  /** Inline style overrides (rare; the existing per-shell CSS
   * does the lifting). */
  style?: CSSProperties
}

export interface ContenteditableComposerRef {
  focus: () => void
  blur: () => void
  /** Imperative insertion at the current caret. Updates the
   * controlled value via `onChange` and restores the caret
   * position to end-of-insertion. */
  insertText: (text: string) => void
  /** Replace the `triggerLength` characters immediately before
   * the caret with `mentionText`. Used by the mention picker
   * when the user selects a candidate. */
  replaceTrigger: (input: { triggerLength: number; mentionText: string }) => void
  /** Clear the editable surface. Sets value to '' and caret
   * to 0. */
  clear: () => void
  /** Read the current caret offset in the plain-text string.
   * Used by the parent to compute mention picker placement. */
  getCaretOffset: () => number
}

/**
 * Walk the contenteditable's child nodes to compute the caret
 * offset relative to the plain-text content. DOM-touching;
 * runs only inside the React wrapper.
 */
function getCaretTextOffset(root: HTMLElement): number {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return 0
  const range = selection.getRangeAt(0)
  if (!root.contains(range.endContainer)) return 0
  // Build a pre-range from the start of root to the caret, then
  // walk its text content. This correctly skips through nested
  // mention spans.
  const preRange = document.createRange()
  preRange.selectNodeContents(root)
  preRange.setEnd(range.endContainer, range.endOffset)
  // toString() collapses <br> and other line breaks into '\n',
  // which matches our plain-text model.
  return preRange.toString().length
}

/**
 * Restore the caret to a specific offset in the contenteditable's
 * plain-text content. Walks text nodes + counts characters until
 * the target offset is reached, then places the caret there.
 *
 * Returns true on success, false if the offset is out of bounds
 * or no selection API is available.
 */
function setCaretTextOffset(root: HTMLElement, offset: number): boolean {
  if (offset < 0) return false
  const selection = window.getSelection()
  if (!selection) return false
  let remaining = offset
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode() as Text | null
  while (node) {
    const len = node.nodeValue?.length ?? 0
    if (remaining <= len) {
      const range = document.createRange()
      range.setStart(node, remaining)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
      return true
    }
    remaining -= len
    node = walker.nextNode() as Text | null
  }
  // Fallback: place caret at end of root.
  const range = document.createRange()
  range.selectNodeContents(root)
  range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)
  return false
}

/**
 * Extract plain text from the contenteditable's children. Walks
 * text nodes + treats `<br>` as `\n`. Matches the model used by
 * `getCaretTextOffset` so caret/text remain in lockstep.
 */
function extractPlainText(root: HTMLElement): string {
  const out: string[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  let node = walker.nextNode() as Node | null
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(node.nodeValue ?? '')
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement
      if (el.tagName === 'BR') out.push('\n')
    }
    node = walker.nextNode() as Node | null
  }
  return out.join('')
}

export const ContenteditableComposer = forwardRef<
  ContenteditableComposerRef,
  ContenteditableComposerProps
>(function ContenteditableComposer(
  {
    value,
    onChange,
    mentions = [],
    onSubmit,
    onKeyDown,
    placeholder,
    disabled,
    composerStyle,
    className,
    style
  },
  ref
): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  // Tracks the value we last wrote to the DOM. Used to skip
  // redundant innerHTML rewrites when the controlled value
  // matches what's already on screen — avoids caret jumps on
  // every keystroke (the most painful contenteditable foot-gun).
  const lastWrittenValueRef = useRef<string>('')
  // Tracks the caret offset before we rewrite innerHTML, so we
  // can restore after.
  const pendingCaretRef = useRef<number | null>(null)
  // Composition state — while IME composition is active we
  // suppress our own re-renders (the browser owns the DOM
  // during composition). On compositionend we re-sync.
  const isComposingRef = useRef(false)

  // Compute the HTML the editable surface should render. Pure
  // function — no DOM access. We memo via a ref check rather
  // than useMemo because the inputs are primitives we already
  // dedupe in `lastWrittenValueRef`.
  const computeHtml = useCallback(
    (text: string): string => buildContenteditableHtml(text, mentions),
    [mentions]
  )

  // Sync prop value → DOM. Runs on mount + whenever `value`
  // changes externally (e.g. parent inserts a mention via the
  // imperative ref). Skips when the DOM already matches —
  // prevents caret jumps on every keystroke.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    if (isComposingRef.current) return
    if (value === lastWrittenValueRef.current) {
      // DOM already in sync — happens when the user typed and
      // we round-tripped through React state. Don't rewrite.
      return
    }
    const html = computeHtml(value)
    root.innerHTML = html
    lastWrittenValueRef.current = value
    // Caret restore: if we have a pending offset (set by
    // imperative insertion), use it; otherwise leave caret as
    // browser placed it.
    if (pendingCaretRef.current !== null) {
      setCaretTextOffset(root, pendingCaretRef.current)
      pendingCaretRef.current = null
    }
  }, [value, computeHtml])

  // Handle user input — extract plain text, push to onChange.
  const handleInput = useCallback(() => {
    if (isComposingRef.current) return // IME owns the DOM
    const root = rootRef.current
    if (!root) return
    const text = extractPlainText(root)
    lastWrittenValueRef.current = text
    onChange(text)
  }, [onChange])

  // Paste — normalise to plain text, splice at caret.
  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      event.preventDefault()
      const root = rootRef.current
      if (!root) return
      const html = event.clipboardData.getData('text/html')
      const plain = event.clipboardData.getData('text/plain')
      const pasteText = html ? normalisePastedText(html) : plain
      if (!pasteText) return
      const caretOffset = getCaretTextOffset(root)
      const next = spliceTextAtCaret({
        value,
        caretOffset,
        inserted: pasteText
      })
      pendingCaretRef.current = next.caretOffset
      onChange(next.value)
    },
    [value, onChange]
  )

  // Enter / Shift+Enter handling.
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (onKeyDown) onKeyDown(event)
      if (event.defaultPrevented) return
      if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
        if (!isComposingRef.current && onSubmit) {
          event.preventDefault()
          onSubmit()
        }
      }
    },
    [onKeyDown, onSubmit]
  )

  // Composition events — IME on / off.
  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true
  }, [])
  const handleCompositionEnd = useCallback(
    (_event: CompositionEvent<HTMLDivElement>) => {
      isComposingRef.current = false
      // Sync our state with whatever the IME committed.
      const root = rootRef.current
      if (!root) return
      const text = extractPlainText(root)
      lastWrittenValueRef.current = text
      onChange(text)
    },
    [onChange]
  )

  // Imperative ref API.
  useImperativeHandle(
    ref,
    () => ({
      focus: () => rootRef.current?.focus(),
      blur: () => rootRef.current?.blur(),
      insertText: (text: string) => {
        const root = rootRef.current
        if (!root) return
        const caretOffset = getCaretTextOffset(root)
        const next = spliceTextAtCaret({ value, caretOffset, inserted: text })
        pendingCaretRef.current = next.caretOffset
        onChange(next.value)
      },
      replaceTrigger: ({ triggerLength, mentionText }) => {
        const root = rootRef.current
        if (!root) return
        const caretOffset = getCaretTextOffset(root)
        const next = replaceTriggerWithMention({
          value,
          caretOffset,
          triggerLength,
          mentionText
        })
        pendingCaretRef.current = next.caretOffset
        onChange(next.value)
      },
      clear: () => {
        pendingCaretRef.current = 0
        onChange('')
      },
      getCaretOffset: () => {
        const root = rootRef.current
        if (!root) return 0
        return getCaretTextOffset(root)
      }
    }),
    [value, onChange]
  )

  // Initial-render HTML — used by the SSR-style render path.
  // After mount the useLayoutEffect takes over via direct DOM
  // writes.
  const initialHtml = computeHtml(value)

  // Track initial-render state so we don't fight React's
  // hydration. After mount, we own innerHTML directly via the
  // layout effect; React's reconciliation should never touch
  // children again.
  useEffect(() => {
    lastWrittenValueRef.current = value
    // Intentionally only run on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      ref={rootRef}
      className={`composer-textarea contenteditable-composer ${className ?? ''}`}
      contentEditable={!disabled}
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-disabled={disabled}
      aria-label={placeholder ?? 'Message'}
      data-composer-style={composerStyle}
      data-placeholder={placeholder ?? ''}
      data-empty={value.length === 0 ? 'true' : 'false'}
      style={style}
      onInput={handleInput}
      onPaste={handlePaste}
      onKeyDown={handleKeyDown}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
      dangerouslySetInnerHTML={{ __html: initialHtml }}
    />
  )
})
