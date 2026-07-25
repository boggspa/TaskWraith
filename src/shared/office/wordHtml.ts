/**
 * Word model ⇄ HTML for the contentEditable editing surface.
 *
 * `wordModelToHtml` renders the canonical markup the editor mounts with;
 * `wordHtmlToModel` parses what Chromium hands back after the user edits —
 * including execCommand artifacts (`<b>`, `<div>` line wrappers,
 * `style="font-weight: bold"` spans, `<br>` placeholders) — back into the
 * normalized block model. Both directions are pure string functions so they
 * unit-test without a DOM.
 */

import type { WordBlock, WordDocumentModel, WordImage, WordRun } from './officeModels'
import {
  TEXT_NODE_TAG,
  escapeXmlAttr,
  escapeXmlText,
  localName,
  parseMarkup,
  type XmlNode
} from './xmlLite'

// --- model → html -------------------------------------------------------------

function runToHtml(run: WordRun): string {
  let html = escapeXmlText(run.text).replace(/\n/g, '<br>')
  if (run.code) html = `<code>${html}</code>`
  if (run.bold) html = `<strong>${html}</strong>`
  if (run.italic) html = `<em>${html}</em>`
  if (run.underline) html = `<u>${html}</u>`
  if (run.strike) html = `<s>${html}</s>`
  if (run.link) html = `<a href="${escapeXmlAttr(run.link)}">${html}</a>`
  return html
}

const runsToHtml = (runs: WordRun[]): string => {
  const html = runs.map(runToHtml).join('')
  return html === '' ? '<br>' : html
}

export function wordModelToHtml(model: WordDocumentModel): string {
  const parts: string[] = []
  const listStack: { ordered: boolean }[] = []

  const closeListsTo = (depth: number): void => {
    while (listStack.length > depth) {
      const list = listStack.pop()
      parts.push(list?.ordered ? '</ol>' : '</ul>')
    }
  }

  for (const block of model.blocks) {
    if (block.type !== 'list-item') closeListsTo(0)
    switch (block.type) {
      case 'heading':
        parts.push(`<h${block.level}>${runsToHtml(block.runs)}</h${block.level}>`)
        break
      case 'list-item': {
        const targetDepth = block.level + 1
        closeListsTo(targetDepth)
        if (
          listStack.length === targetDepth &&
          listStack[targetDepth - 1].ordered !== block.ordered
        ) {
          closeListsTo(targetDepth - 1)
        }
        while (listStack.length < targetDepth) {
          listStack.push({ ordered: block.ordered })
          parts.push(block.ordered ? '<ol>' : '<ul>')
        }
        parts.push(`<li>${runsToHtml(block.runs)}</li>`)
        break
      }
      case 'table': {
        const rows = block.rows
          .map((row) => `<tr>${row.map((cell) => `<td>${runsToHtml(cell)}</td>`).join('')}</tr>`)
          .join('')
        parts.push(`<table><tbody>${rows}</tbody></table>`)
        break
      }
      case 'image': {
        const { image } = block
        const size =
          (image.widthPx ? ` width="${image.widthPx}"` : '') +
          (image.heightPx ? ` height="${image.heightPx}"` : '')
        parts.push(
          `<p class="office-word-image-block"><img src="${escapeXmlAttr(image.dataUri)}" alt="${escapeXmlAttr(image.name)}"${size}></p>`
        )
        break
      }
      default:
        parts.push(`<p>${runsToHtml(block.runs)}</p>`)
        break
    }
  }
  closeListsTo(0)
  if (parts.length === 0) return '<p><br></p>'
  return parts.join('')
}

// --- html → model -------------------------------------------------------------

interface InlineStyleState {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  code?: boolean
  link?: string
}

function styleFromAttr(style: string | undefined, state: InlineStyleState): InlineStyleState {
  if (!style) return state
  const next = { ...state }
  const lower = style.toLowerCase()
  if (/font-weight\s*:\s*(bold|[6-9]00)/.test(lower)) next.bold = true
  if (/font-weight\s*:\s*(normal|400)/.test(lower)) next.bold = false
  if (/font-style\s*:\s*italic/.test(lower)) next.italic = true
  if (/text-decoration[^;]*underline/.test(lower)) next.underline = true
  if (/text-decoration[^;]*line-through/.test(lower)) next.strike = true
  return next
}

const normalizeWhitespace = (text: string): string =>
  text.replace(/[\t\r\n]+/g, ' ').replace(/\u00A0/g, ' ')

function appendRun(runs: WordRun[], text: string, state: InlineStyleState): void {
  if (text === '') return
  const run: WordRun = { text }
  if (state.bold) run.bold = true
  if (state.italic) run.italic = true
  if (state.underline) run.underline = true
  if (state.strike) run.strike = true
  if (state.code) run.code = true
  if (state.link) run.link = state.link
  const previous = runs[runs.length - 1]
  if (
    previous &&
    previous.bold === run.bold &&
    previous.italic === run.italic &&
    previous.underline === run.underline &&
    previous.strike === run.strike &&
    previous.code === run.code &&
    previous.link === run.link
  ) {
    previous.text += text
    return
  }
  runs.push(run)
}

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'table',
  'blockquote',
  'pre',
  'section',
  'article',
  'header',
  'footer'
])

const isElement = (node: XmlNode): boolean => node.tag !== TEXT_NODE_TAG
const isBlockElement = (node: XmlNode): boolean =>
  isElement(node) && BLOCK_TAGS.has(localName(node.tag))

/** Emits a node's inline content (ordered text + styled descendants) into runs. */
function emitInline(node: XmlNode, parentState: InlineStyleState, runs: WordRun[]): void {
  for (const child of node.children) {
    if (child.tag === TEXT_NODE_TAG) {
      appendRun(runs, normalizeWhitespace(child.text), parentState)
      continue
    }
    const tag = localName(child.tag)
    if (tag === 'br') {
      appendRun(runs, '\n', parentState)
      continue
    }
    let state = styleFromAttr(child.attrs.style, parentState)
    switch (tag) {
      case 'b':
      case 'strong':
        state = { ...state, bold: true }
        break
      case 'i':
      case 'em':
        state = { ...state, italic: true }
        break
      case 'u':
      case 'ins':
        state = { ...state, underline: true }
        break
      case 's':
      case 'strike':
      case 'del':
        state = { ...state, strike: true }
        break
      case 'code':
      case 'tt':
      case 'kbd':
        state = { ...state, code: true }
        break
      case 'a': {
        const href = child.attrs.href
        if (href && /^https?:\/\//i.test(href)) state = { ...state, link: href }
        break
      }
      default:
        break
    }
    emitInline(child, state, runs)
  }
}

function inlineRunsOf(node: XmlNode): WordRun[] {
  const runs: WordRun[] = []
  emitInline(node, {}, runs)
  // A lone <br> is contentEditable's empty-block placeholder, not content.
  if (runs.length === 1 && runs[0].text === '\n') return []
  const last = runs[runs.length - 1]
  if (last) last.text = last.text.replace(/\n+$/, '')
  return runs.filter((run) => run.text !== '')
}

const runsHaveContent = (runs: WordRun[]): boolean => runs.some((run) => run.text.trim() !== '')

const parseDimension = (value: string | undefined): number | undefined => {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * data:-URI images anywhere under the node, document order. Remote (http)
 * sources are intentionally dropped: the editor never fetches the network,
 * and full raster validation happens again during model normalization.
 */
function collectImages(node: XmlNode): WordImage[] {
  const images: WordImage[] = []
  const walk = (current: XmlNode): void => {
    for (const child of current.children) {
      if (child.tag === TEXT_NODE_TAG) continue
      if (localName(child.tag) === 'img') {
        const src = child.attrs.src ?? ''
        if (/^data:image\//i.test(src)) {
          const image: WordImage = { dataUri: src, name: (child.attrs.alt ?? '').trim() }
          const widthPx = parseDimension(child.attrs.width)
          const heightPx = parseDimension(child.attrs.height)
          if (widthPx) image.widthPx = widthPx
          if (heightPx) image.heightPx = heightPx
          images.push(image)
        }
        continue
      }
      walk(child)
    }
  }
  walk(node)
  return images
}

function collectBlocks(
  parent: XmlNode,
  blocks: WordBlock[],
  listDepth: number,
  ordered: boolean
): void {
  let pendingInline: XmlNode[] = []

  const flushInline = (): void => {
    if (pendingInline.length === 0) return
    const wrapper: XmlNode = { tag: '#inline', attrs: {}, children: pendingInline, text: '' }
    const runs = inlineRunsOf(wrapper)
    if (runsHaveContent(runs)) blocks.push({ type: 'paragraph', runs })
    for (const image of collectImages(wrapper)) blocks.push({ type: 'image', image })
    pendingInline = []
  }

  for (const child of parent.children) {
    if (!isBlockElement(child)) {
      pendingInline.push(child)
      continue
    }
    flushInline()
    const tag = localName(child.tag)

    if (/^h[1-6]$/.test(tag)) {
      const level = Math.min(3, Number.parseInt(tag.slice(1), 10)) as 1 | 2 | 3
      blocks.push({ type: 'heading', level, runs: inlineRunsOf(child) })
      continue
    }
    if (tag === 'ul' || tag === 'ol') {
      collectBlocks(child, blocks, listDepth + 1, tag === 'ol')
      continue
    }
    if (tag === 'li') {
      const nestedLists = child.children.filter(
        (grand) => isElement(grand) && ['ul', 'ol'].includes(localName(grand.tag))
      )
      const inlineOnly: XmlNode = {
        ...child,
        children: child.children.filter(
          (grand) => !(isElement(grand) && ['ul', 'ol'].includes(localName(grand.tag)))
        )
      }
      blocks.push({
        type: 'list-item',
        ordered,
        level: Math.max(0, listDepth - 1),
        runs: inlineRunsOf(inlineOnly)
      })
      for (const nested of nestedLists) {
        collectBlocks(nested, blocks, listDepth + 1, localName(nested.tag) === 'ol')
      }
      continue
    }
    if (tag === 'table') {
      const rows: WordRun[][][] = []
      const walkRows = (current: XmlNode): void => {
        for (const section of current.children) {
          if (!isElement(section)) continue
          const sectionTag = localName(section.tag)
          if (sectionTag === 'tr') {
            const cells = section.children
              .filter((cell) => isElement(cell) && ['td', 'th'].includes(localName(cell.tag)))
              .map((cell) => inlineRunsOf(cell))
            rows.push(cells)
          } else if (['thead', 'tbody', 'tfoot'].includes(sectionTag)) {
            walkRows(section)
          }
        }
      }
      walkRows(child)
      if (rows.length > 0) blocks.push({ type: 'table', rows })
      continue
    }

    // p / div / blockquote / pre / section / article / header / footer
    const hasBlockChildren = child.children.some(isBlockElement)
    if (hasBlockChildren) {
      collectBlocks(child, blocks, listDepth, ordered)
    } else {
      const runs = inlineRunsOf(child)
      const images = collectImages(child)
      // A paragraph that only wraps an image contributes just the image
      // block; mixed content keeps text first, then its images.
      if (images.length === 0 || runsHaveContent(runs)) {
        blocks.push({ type: 'paragraph', runs })
      }
      for (const image of images) blocks.push({ type: 'image', image })
    }
  }
  flushInline()
}

export function wordHtmlToModel(html: string): WordDocumentModel {
  const root = parseMarkup(html, { html: true })
  const blocks: WordBlock[] = []
  collectBlocks(root, blocks, 0, false)
  if (blocks.length === 0) blocks.push({ type: 'paragraph', runs: [] })
  return { kind: 'word', blocks }
}
