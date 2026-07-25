/**
 * Minimal non-validating markup parser for the Office codecs.
 *
 * Two dialects:
 *  - XML mode: OOXML part payloads (document.xml, sheet1.xml, slide1.xml…).
 *  - HTML mode: Chromium `innerHTML` from the Word contentEditable surface.
 *    DOM serialization is always properly nested, so the only HTML quirks we
 *    must handle are void elements and case-insensitive tag names.
 *
 * Deliberately NOT a general parser: no DTD processing and no external or
 * custom entity resolution (only the five XML built-ins, a small named HTML
 * set, and numeric references), which structurally rules out XXE. Unknown
 * constructs are skipped, never fatal — office files from other suites should
 * degrade to partial content, not to errors.
 */

export interface XmlNode {
  /**
   * Tag name as written (namespace prefix preserved), lowercased in HTML
   * mode. Text chunks appear both concatenated in the parent's `text` AND as
   * ordered `#text` children, so order-sensitive consumers (the Word HTML
   * importer) can interleave text with elements while leaf-oriented consumers
   * (OOXML codecs reading `<w:t>`) keep the convenient `.text` view.
   */
  tag: string
  attrs: Record<string, string>
  children: XmlNode[]
  /** Concatenated direct text (entity-decoded). Child element text is NOT included. */
  text: string
}

export const TEXT_NODE_TAG = '#text'

const HTML_VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr'
])

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”'
}

export function decodeEntities(input: string): string {
  if (!input.includes('&')) return input
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()]
    return named ?? match
  })
}

export function escapeXmlText(input: string): string {
  return input.replace(/[&<>]/g, (char) =>
    char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;'
  )
}

export function escapeXmlAttr(input: string): string {
  return input.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&apos;'
    }
  })
}

/** Strips control characters that are illegal in XML 1.0 (keeps tab/newline/CR). */
export function sanitizeXmlText(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}

interface ParseOptions {
  html?: boolean
}

const ATTR_PATTERN = /([^\s=/>"']+)\s*(?:=\s*("([^"]*)"|'([^']*)'|[^\s>]*))?/g

function parseAttributes(source: string, html: boolean): Record<string, string> {
  const attrs: Record<string, string> = {}
  ATTR_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ATTR_PATTERN.exec(source)) !== null) {
    const rawName = match[1]
    if (!rawName) continue
    const name = html ? rawName.toLowerCase() : rawName
    let value = ''
    if (match[3] !== undefined) value = match[3]
    else if (match[4] !== undefined) value = match[4]
    else if (match[2] !== undefined) value = match[2]
    attrs[name] = decodeEntities(value)
  }
  return attrs
}

/**
 * Parses a markup string into a synthetic `#root` node. Lenient: unclosed
 * elements are closed at EOF, stray close tags pop to the nearest matching
 * open tag (or are ignored), and DOCTYPE/PI/comments are skipped.
 */
export function parseMarkup(input: string, options: ParseOptions = {}): XmlNode {
  const html = options.html === true
  const root: XmlNode = { tag: '#root', attrs: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  const top = (): XmlNode => stack[stack.length - 1]
  let index = 0
  const length = input.length

  const appendText = (raw: string, alreadyDecoded = false): void => {
    if (!raw) return
    const decoded = alreadyDecoded ? raw : decodeEntities(raw)
    const parent = top()
    parent.text += decoded
    parent.children.push({ tag: TEXT_NODE_TAG, attrs: {}, children: [], text: decoded })
  }

  while (index < length) {
    const open = input.indexOf('<', index)
    if (open === -1) {
      appendText(input.slice(index))
      break
    }
    if (open > index) appendText(input.slice(index, open))

    if (input.startsWith('<!--', open)) {
      const end = input.indexOf('-->', open + 4)
      index = end === -1 ? length : end + 3
      continue
    }
    if (input.startsWith('<![CDATA[', open)) {
      const end = input.indexOf(']]>', open + 9)
      const body = input.slice(open + 9, end === -1 ? length : end)
      appendText(body, true)
      index = end === -1 ? length : end + 3
      continue
    }
    if (input.startsWith('<!', open) || input.startsWith('<?', open)) {
      const end = input.indexOf('>', open + 2)
      index = end === -1 ? length : end + 1
      continue
    }

    const close = input.indexOf('>', open + 1)
    if (close === -1) {
      appendText(input.slice(open))
      break
    }
    const rawTag = input.slice(open + 1, close).trim()
    index = close + 1
    if (!rawTag) continue

    if (rawTag.startsWith('/')) {
      const name = html ? rawTag.slice(1).trim().toLowerCase() : rawTag.slice(1).trim()
      for (let cursor = stack.length - 1; cursor > 0; cursor -= 1) {
        if (stack[cursor].tag === name) {
          stack.length = cursor
          break
        }
      }
      continue
    }

    const selfClosing = rawTag.endsWith('/')
    const body = selfClosing ? rawTag.slice(0, -1) : rawTag
    const spaceIndex = body.search(/[\s]/)
    const rawName = spaceIndex === -1 ? body : body.slice(0, spaceIndex)
    const name = html ? rawName.toLowerCase() : rawName
    if (!name) continue
    const attrSource = spaceIndex === -1 ? '' : body.slice(spaceIndex + 1)
    const node: XmlNode = {
      tag: name,
      attrs: attrSource ? parseAttributes(attrSource, html) : {},
      children: [],
      text: ''
    }
    top().children.push(node)
    const isVoid = html && HTML_VOID_TAGS.has(name)
    if (!selfClosing && !isVoid) stack.push(node)
  }

  return root
}

/** Local (namespace-stripped) tag name: `w:p` → `p`. */
export function localName(tag: string): string {
  const colon = tag.lastIndexOf(':')
  return colon === -1 ? tag : tag.slice(colon + 1)
}

/** First direct child whose local name matches. */
export function childByLocalName(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((child) => localName(child.tag) === name)
}

/** All direct children whose local name matches. */
export function childrenByLocalName(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => localName(child.tag) === name)
}

/** Depth-first descendants (excluding `node` itself) whose local name matches. */
export function descendantsByLocalName(node: XmlNode, name: string): XmlNode[] {
  const found: XmlNode[] = []
  const walk = (current: XmlNode): void => {
    for (const child of current.children) {
      if (localName(child.tag) === name) found.push(child)
      walk(child)
    }
  }
  walk(node)
  return found
}

/** First depth-first descendant whose local name matches. */
export function firstDescendantByLocalName(node: XmlNode, name: string): XmlNode | undefined {
  for (const child of node.children) {
    if (localName(child.tag) === name) return child
    const nested = firstDescendantByLocalName(child, name)
    if (nested) return nested
  }
  return undefined
}

/** Attribute lookup ignoring namespace prefixes: attr(node, 'val') matches `w:val`. */
export function attrByLocalName(node: XmlNode, name: string): string | undefined {
  if (node.attrs[name] !== undefined) return node.attrs[name]
  for (const [key, value] of Object.entries(node.attrs)) {
    if (localName(key) === name) return value
  }
  return undefined
}

/**
 * Concatenated text of the node and all descendants. Direct text comes first
 * (via `.text`), so exact interleaving with element children is approximate —
 * fine for leaf-oriented OOXML reads, wrong tool for HTML (walk `#text`
 * children instead).
 */
export function deepText(node: XmlNode): string {
  let out = node.text
  for (const child of node.children) {
    if (child.tag === TEXT_NODE_TAG) continue
    out += deepText(child)
  }
  return out
}
