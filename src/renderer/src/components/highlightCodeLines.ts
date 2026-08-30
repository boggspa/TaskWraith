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

export type HighlightSpan = {
  className?: string
  text: string
}

/**
 * Same theme-aware tag palette as File Editor. Diff Studio reuses these
 * `--cm-*` tokens so light and dark diffs match the editor instead of the
 * transcript's hardcoded chat colors.
 */
const editorHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--cm-keyword)', fontWeight: '600' },
  { tag: [tags.name, tags.deleted, tags.character, tags.macroName], color: 'var(--cm-name)' },
  { tag: [tags.propertyName, tags.variableName, tags.labelName], color: 'var(--cm-property)' },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: 'var(--cm-function)'
  },
  { tag: [tags.className, tags.definition(tags.typeName), tags.typeName], color: 'var(--cm-type)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--cm-number)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--cm-string)' },
  { tag: [tags.regexp, tags.escape], color: 'var(--cm-regexp)' },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: 'var(--cm-comment)',
    fontStyle: 'italic'
  },
  { tag: tags.meta, color: 'var(--cm-meta)' },
  { tag: tags.heading, color: 'var(--cm-heading)', fontWeight: '700' },
  { tag: tags.link, color: 'var(--accent)', textDecoration: 'underline' },
  { tag: tags.invalid, color: 'var(--cm-invalid)' }
])

let highlightStylesMounted = false

export function ensureEditorHighlightStylesMounted(): void {
  if (highlightStylesMounted) return
  const mod = editorHighlightStyle.module
  if (!mod || typeof document === 'undefined') return
  StyleModule.mount(document, mod)
  highlightStylesMounted = true
}

export function editorHighlightStyleRules(): string {
  return editorHighlightStyle.module?.getRules() ?? ''
}

const shellLanguage = StreamLanguage.define(shell)

const LANGUAGE_CANON: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  javascript: 'javascript',
  ts: 'typescript',
  typescript: 'typescript',
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
  fish: 'shell'
}

const EXT_TO_LANGUAGE: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'tsx',
  py: 'python',
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
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  m: 'cpp',
  mm: 'cpp',
  metal: 'cpp',
  swift: 'cpp',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell'
}

export const languageFromPath = (filePath?: string): string => {
  if (!filePath) return ''
  const base = filePath.split(/[\\/]/).pop() || filePath
  const lower = base.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot <= 0 || dot === lower.length - 1) return ''
  return EXT_TO_LANGUAGE[lower.slice(dot + 1)] ?? ''
}

const normalizeLanguage = (language?: string): string => {
  const raw = (language || '')
    .trim()
    .toLowerCase()
    .replace(/^[.`]+|[.`]+$/g, '')
  if (!raw) return ''
  if (raw === 'tsx') return 'tsx'
  return LANGUAGE_CANON[raw] ?? raw
}

const languageFor = (language?: string): Language | null => {
  const normalized = normalizeLanguage(language)
  if (!normalized) return null
  if (normalized === 'javascript') return javascript({ jsx: true }).language
  if (normalized === 'tsx') return javascript({ jsx: true, typescript: true }).language
  if (normalized === 'typescript') return javascript({ jsx: false, typescript: true }).language
  if (normalized === 'python') return python().language
  if (normalized === 'markdown') return markdown().language
  if (normalized === 'json') return json().language
  if (normalized === 'html') return html().language
  if (normalized === 'css') return css().language
  if (normalized === 'cpp') return cpp().language
  if (normalized === 'shell') return shellLanguage
  return null
}

const HIGHLIGHT_CACHE_MAX = 64
const HIGHLIGHT_CACHE_MAX_CHARS = 200_000
const highlightCache = new Map<string, HighlightSpan[][]>()
let highlightParseCountForTest = 0

export function getHighlightParseCountForTest(): number {
  return highlightParseCountForTest
}

export function resetHighlightCodeLinesCacheForTest(): void {
  highlightCache.clear()
  highlightParseCountForTest = 0
}

const plainLineSpans = (content: string): HighlightSpan[][] => {
  if (content.length === 0) return []
  return content.split('\n').map((text) => (text ? [{ text }] : []))
}

const remember = (key: string, lines: HighlightSpan[][], contentLength: number): void => {
  if (contentLength > HIGHLIGHT_CACHE_MAX_CHARS) return
  highlightCache.set(key, lines)
  while (highlightCache.size > HIGHLIGHT_CACHE_MAX) {
    const oldest = highlightCache.keys().next().value
    if (oldest === undefined) break
    highlightCache.delete(oldest)
  }
}

export function highlightCodeToLineSpans(content: string, language?: string): HighlightSpan[][] {
  const parser = languageFor(language)?.parser ?? null
  if (!parser || content.length === 0) return plainLineSpans(content)

  const cacheKey = `${normalizeLanguage(language)}\0${content}`
  const cached = highlightCache.get(cacheKey)
  if (cached) {
    highlightCache.delete(cacheKey)
    highlightCache.set(cacheKey, cached)
    return cached
  }

  let tree
  try {
    highlightParseCountForTest += 1
    tree = parser.parse(content)
  } catch {
    const fallback = plainLineSpans(content)
    remember(cacheKey, fallback, content.length)
    return fallback
  }

  const lines: HighlightSpan[][] = [[]]
  highlightCode(
    content,
    tree,
    editorHighlightStyle,
    (text, classes) => {
      if (!text) return
      const current = lines[lines.length - 1]
      current.push(classes ? { className: classes, text } : { text })
    },
    () => {
      lines.push([])
    }
  )

  remember(cacheKey, lines, content.length)
  return lines
}
