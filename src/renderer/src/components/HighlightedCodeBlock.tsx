import { useEffect, useMemo, useRef } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { markdown } from '@codemirror/lang-markdown'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { cpp } from '@codemirror/lang-cpp'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { tags } from '@lezer/highlight'
import {
  CODE_BLOCK_RESIZE_EVENT,
  buildCodeBlockResizeEventInit,
  type CodeBlockResizeDetail
} from '../lib/TranscriptScroll'

type HighlightedCodeBlockProps = {
  content: string
  language?: string
}

const chatCodeTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: 'var(--app-bg-sunken)',
      color: 'var(--text-secondary)',
      fontSize: 'var(--font-size-sm)',
      borderRadius: 'var(--radius-sm)'
    },
    '.cm-content': {
      padding: 'var(--space-sm)',
      caretColor: 'var(--accent)',
      fontFamily: 'var(--font-mono)',
      lineHeight: '1.5'
    },
    '.cm-line': {
      padding: '0'
    },
    '.cm-gutters': {
      display: 'none'
    },
    '.cm-scroller': {
      fontFamily: 'var(--font-mono)',
      overflow: 'auto'
    },
    '&.cm-focused': {
      outline: 'none'
    },
    '.cm-selectionBackground': {
      backgroundColor: 'rgba(90, 140, 255, 0.28) !important'
    }
  },
  { dark: true }
)

const chatHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: '#ff9f7a' },
  { tag: [tags.name, tags.variableName], color: '#e7e9ee' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#8ab4ff' },
  { tag: [tags.className, tags.typeName], color: '#ffd166' },
  { tag: [tags.propertyName, tags.attributeName], color: '#9bdcff' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: '#c39bff' },
  { tag: [tags.string, tags.special(tags.string)], color: '#8ee6a8' },
  { tag: [tags.regexp, tags.escape], color: '#78dcca' },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: '#7f8796',
    fontStyle: 'italic'
  },
  { tag: [tags.meta, tags.processingInstruction], color: '#9aa4b5' },
  { tag: [tags.heading, tags.strong], color: '#f0f3f8', fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: '#8ab4ff', textDecoration: 'underline' },
  { tag: tags.invalid, color: '#ff6b6b' }
])

const shellLanguage = StreamLanguage.define(shell)

const normalizeLanguage = (language?: string): string => {
  return (language || '')
    .trim()
    .toLowerCase()
    .replace(/^[.`]+|[.`]+$/g, '')
}

const extensionsForLanguage = (language?: string): Extension[] => {
  const normalized = normalizeLanguage(language)
  if (!normalized) return []

  if (['js', 'jsx', 'javascript', 'mjs', 'cjs'].includes(normalized))
    return [javascript({ jsx: true })]
  if (['ts', 'tsx', 'typescript'].includes(normalized))
    return [javascript({ jsx: normalized === 'tsx', typescript: true })]
  if (['py', 'python', 'python3'].includes(normalized)) return [python()]
  if (['md', 'markdown'].includes(normalized)) return [markdown()]
  if (['json', 'jsonc'].includes(normalized)) return [json()]
  if (['html', 'htm', 'xml', 'svg'].includes(normalized)) return [html()]
  if (['css', 'scss', 'sass', 'less'].includes(normalized)) return [css()]
  if (
    [
      'c',
      'h',
      'cc',
      'cpp',
      'c++',
      'cxx',
      'hpp',
      'hh',
      'objc',
      'objective-c',
      'm',
      'mm',
      'metal',
      'swift'
    ].includes(normalized)
  )
    return [cpp()]
  if (['sh', 'bash', 'zsh', 'shell', 'terminal'].includes(normalized)) return [shellLanguage]

  return []
}

export function HighlightedCodeBlock({ content, language }: HighlightedCodeBlockProps) {
  // Wrapper ref so a SCOPED ResizeObserver can watch only this code
  // block. CodeMirror measures content asynchronously after mount: the
  // block paints with a small/zero height first, then resizes once the
  // editor view computes its real layout. In long Kimi transcripts
  // (lots of fenced code in tool output) that late growth is the
  // primary source of the "view scrolls upward" / "huge rendering gap"
  // symptom — the transcript scroller had already snapped to the
  // pre-measure bottom and the post-measure height jump leaves the
  // user stranded above the new bottom.
  //
  // We dispatch a bubbling custom event (`CODE_BLOCK_RESIZE_EVENT`)
  // so the transcript scroll effect in App.tsx can re-pin via its
  // standard rAF path. The handler there is gated on
  // `shouldRepinAfterCodeBlockResize`, which honours both the
  // `autoFollow` state and the per-frame user-scroll-away flag, so a
  // deliberate scroll-up is never fought.
  //
  // IMPORTANT — why this does NOT reintroduce the historical
  // ResizeObserver feedback loop:
  //   * The previous loop observed the _entire transcript content_,
  //     so every scrollTop write that triggered a reflow re-entered
  //     the observer callback.
  //   * Here the observer is scoped to a single code block. Writing
  //     `scrollTop` on the transcript scroll container does not
  //     change this code block's own bounding rect, so dispatching
  //     the event and the resulting re-pin do not feed back.
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Memoize the extension set on `language` only. @uiw/react-codemirror
  // treats a new `extensions` array reference as a reconfigure
  // (StateEffect.reconfigure.of(...)), so passing a fresh array literal on
  // every render fires a full reconfigure on every streamed delta. With the
  // stable tail key (MarkdownMessage), that reconfigure would become the
  // dominant per-delta cost for a streaming code fence. The content updates
  // cheaply through the `value` prop (a doc transaction on the reused view);
  // the extensions only change when the language changes.
  const extensions = useMemo<Extension[]>(
    () => [
      chatCodeTheme,
      syntaxHighlighting(chatHighlightStyle),
      EditorView.lineWrapping,
      ...extensionsForLanguage(language)
    ],
    [language]
  )

  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver((entries) => {
      // The observer can fire with multiple entries on a single
      // batched callback. The receiver only cares "did this block
      // resize" — taking the most recent entry is sufficient and
      // matches what `buildCodeBlockResizeEventInit` documents.
      const entry = entries[entries.length - 1]
      const init = buildCodeBlockResizeEventInit(entry)
      const event = new CustomEvent<CodeBlockResizeDetail>(CODE_BLOCK_RESIZE_EVENT, init)
      node.dispatchEvent(event)
    })

    observer.observe(node)
    return () => {
      observer.disconnect()
    }
  }, [])

  return (
    <div ref={containerRef}>
      <CodeMirror
        value={content}
        basicSetup={false}
        editable={false}
        readOnly
        extensions={extensions}
      />
    </div>
  )
}
