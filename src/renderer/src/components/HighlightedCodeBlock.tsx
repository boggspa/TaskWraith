import { Fragment, useMemo, type ReactNode } from 'react'
import type { Extension } from '@codemirror/state'
import { HighlightStyle, StreamLanguage, type Language } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { markdown } from '@codemirror/lang-markdown'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { cpp } from '@codemirror/lang-cpp'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { highlightCode, tags } from '@lezer/highlight'
import { StyleModule } from 'style-mod'

type HighlightedCodeBlockProps = {
  content: string
  language?: string
}

/**
 * Same tag → color palette previously applied via CodeMirror's
 * `syntaxHighlighting(chatHighlightStyle)` on an EditorView. Kept as a
 * `HighlightStyle` so static `highlightCode` reuses the identical
 * generated classes / StyleModule rules (no Shiki/hljs/Prism).
 */
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

let highlightStylesMounted = false

function ensureChatHighlightStylesMounted(): void {
  if (highlightStylesMounted) return
  const mod = chatHighlightStyle.module
  if (!mod || typeof document === 'undefined') return
  StyleModule.mount(document, mod)
  highlightStylesMounted = true
}

/** Test/helper: CSS rules emitted for `chatHighlightStyle` (includes #ff9f7a etc.). */
export function chatHighlightStyleRules(): string {
  return chatHighlightStyle.module?.getRules() ?? ''
}

const shellLanguage = StreamLanguage.define(shell)

const normalizeLanguage = (language?: string): string => {
  return (language || '')
    .trim()
    .toLowerCase()
    .replace(/^[.`]+|[.`]+$/g, '')
}

/** Same language-pack map as the former CM path; returns Lezer `Language`s. */
const languageFor = (language?: string): Language | null => {
  const normalized = normalizeLanguage(language)
  if (!normalized) return null

  if (['js', 'jsx', 'javascript', 'mjs', 'cjs'].includes(normalized)) {
    return javascript({ jsx: true }).language
  }
  if (['ts', 'tsx', 'typescript'].includes(normalized)) {
    return javascript({ jsx: normalized === 'tsx', typescript: true }).language
  }
  if (['py', 'python', 'python3'].includes(normalized)) return python().language
  if (['md', 'markdown'].includes(normalized)) return markdown().language
  if (['json', 'jsonc'].includes(normalized)) return json().language
  if (['html', 'htm', 'xml', 'svg'].includes(normalized)) return html().language
  if (['css', 'scss', 'sass', 'less'].includes(normalized)) return css().language
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
  ) {
    return cpp().language
  }
  if (['sh', 'bash', 'zsh', 'shell', 'terminal'].includes(normalized)) return shellLanguage

  return null
}

/**
 * Preserved entry point for the language-pack map (formerly fed to
 * CodeMirror `extensions`). Callers that only need a parser should use
 * `languageFor` via highlighting below.
 */
export const extensionsForLanguage = (language?: string): Extension[] => {
  const lang = languageFor(language)
  return lang ? [lang] : []
}

function languageParser(language?: string) {
  const lang = languageFor(language)
  return lang?.parser ?? null
}

function highlightToNodes(content: string, language?: string): ReactNode {
  const parser = languageParser(language)
  if (!parser) return content

  let tree
  try {
    tree = parser.parse(content)
  } catch {
    return content
  }

  const nodes: ReactNode[] = []
  let key = 0
  highlightCode(
    content,
    tree,
    chatHighlightStyle,
    (text, classes) => {
      if (!text) return
      if (classes) {
        nodes.push(
          <span className={classes} key={`t-${key++}`}>
            {text}
          </span>
        )
      } else {
        nodes.push(<Fragment key={`t-${key++}`}>{text}</Fragment>)
      }
    },
    () => {
      nodes.push('\n')
    }
  )
  return nodes
}

/**
 * Static Lezer highlighter for transcript fenced code.
 *
 * Phase C — replaces the read-only CodeMirror `EditorView` that used to
 * live here. CM measured asynchronously after mount, so blocks painted
 * at ~0 height then grew; that late resize was the main "view scrolls
 * upward" / gap source in code-heavy transcripts. A static `<pre>` has
 * its final height on first layout, so we no longer emit
 * `CODE_BLOCK_RESIZE_EVENT` or attach a per-block ResizeObserver.
 * Wrap-toggle height changes (pre → pre-wrap) are covered by the
 * existing content-level transcript ResizeObserver.
 *
 * Outer `.message-code-shell` chrome (language header, copy, wrap,
 * glow) stays in `StableMarkdownBlock` — this component only owns the
 * highlighted body.
 */
export function HighlightedCodeBlock({ content, language }: HighlightedCodeBlockProps) {
  ensureChatHighlightStylesMounted()

  const nodes = useMemo(() => highlightToNodes(content, language), [content, language])

  return (
    <pre className="message-code-static" translate="no">
      <code className="message-code-content">{nodes}</code>
    </pre>
  )
}
