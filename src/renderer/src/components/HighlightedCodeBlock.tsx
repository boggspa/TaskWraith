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

/**
 * Trim/lowercase, then collapse aliases that share an identical language pack
 * so the highlight cache key (`${normalizeLanguage}\\0${content}`) hits across
 * `js` / `javascript` (and peers). `tsx` stays distinct from `ts` because the
 * pack enables JSX only for tsx.
 */
const LANGUAGE_CANON: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  javascript: 'javascript',
  ts: 'typescript',
  typescript: 'typescript',
  // tsx intentionally omitted — different pack options than ts
  py: 'python',
  python: 'python',
  python3: 'python',
  md: 'markdown',
  markdown: 'markdown',
  json: 'json',
  jsonc: 'json',
  html: 'html',
  htm: 'html',
  xml: 'html',
  svg: 'html',
  css: 'css',
  scss: 'css',
  sass: 'css',
  less: 'css',
  c: 'cpp',
  h: 'cpp',
  cc: 'cpp',
  cpp: 'cpp',
  'c++': 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  objc: 'cpp',
  'objective-c': 'cpp',
  m: 'cpp',
  mm: 'cpp',
  metal: 'cpp',
  swift: 'cpp',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shell: 'shell',
  terminal: 'shell'
}

const normalizeLanguage = (language?: string): string => {
  const raw = (language || '')
    .trim()
    .toLowerCase()
    .replace(/^[.`]+|[.`]+$/g, '')
  if (!raw) return ''
  return LANGUAGE_CANON[raw] ?? raw
}

/** Same language-pack map as the former CM path; returns Lezer `Language`s. */
const languageFor = (language?: string): Language | null => {
  const normalized = normalizeLanguage(language)
  if (!normalized) return null

  if (normalized === 'javascript') {
    return javascript({ jsx: true }).language
  }
  if (normalized === 'tsx') {
    return javascript({ jsx: true, typescript: true }).language
  }
  if (normalized === 'typescript') {
    return javascript({ jsx: false, typescript: true }).language
  }
  if (normalized === 'python') return python().language
  if (normalized === 'markdown') return markdown().language
  if (normalized === 'json') return json().language
  if (normalized === 'html') return html().language
  if (normalized === 'css') return css().language
  if (normalized === 'cpp') return cpp().language
  if (normalized === 'shell') return shellLanguage

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

/** Module LRU for sync Lezer highlight results across virtualizer remounts. */
const HIGHLIGHT_CACHE_MAX = 64
const HIGHLIGHT_CACHE_MAX_CHARS = 200_000
const highlightToNodesCache = new Map<string, ReactNode>()
let highlightParseCountForTest = 0

export function getHighlightParseCountForTest(): number {
  return highlightParseCountForTest
}

export function highlightToNodesCacheSizeForTest(): number {
  return highlightToNodesCache.size
}

export function resetHighlightToNodesCacheForTest(): void {
  highlightToNodesCache.clear()
  highlightParseCountForTest = 0
}

function rememberHighlightNodes(key: string, nodes: ReactNode, contentLength: number): void {
  if (contentLength > HIGHLIGHT_CACHE_MAX_CHARS) return
  highlightToNodesCache.set(key, nodes)
  while (highlightToNodesCache.size > HIGHLIGHT_CACHE_MAX) {
    const oldest = highlightToNodesCache.keys().next().value
    if (oldest === undefined) break
    highlightToNodesCache.delete(oldest)
  }
}

function highlightToNodes(content: string, language?: string): ReactNode {
  const parser = languageParser(language)
  if (!parser) return content

  const cacheKey = `${normalizeLanguage(language)}\0${content}`
  const cached = highlightToNodesCache.get(cacheKey)
  if (cached !== undefined) {
    // Refresh insertion order (LRU).
    highlightToNodesCache.delete(cacheKey)
    highlightToNodesCache.set(cacheKey, cached)
    return cached
  }

  let tree
  try {
    highlightParseCountForTest += 1
    tree = parser.parse(content)
  } catch {
    rememberHighlightNodes(cacheKey, content, content.length)
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
  rememberHighlightNodes(cacheKey, nodes, content.length)
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
