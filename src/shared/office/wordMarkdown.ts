/**
 * Word model ⇄ Markdown. The Markdown dialect is GitHub-flavored: ATX
 * headings, `-`/`1.` lists (2-space indent per level), pipe tables, and
 * inline **bold** / _italic_ / ~~strike~~ / `code` / [link](url); underline
 * uses a raw `<u>` span since Markdown has no native underline.
 */

import type { WordBlock, WordDocumentModel, WordRun } from './officeModels'

// --- model → markdown --------------------------------------------------------

const escapeMarkdownText = (text: string): string => text.replace(/([\\`*_[\]<>~|])/g, '\\$1')

function runToMarkdown(run: WordRun): string {
  if (run.text === '') return ''
  if (run.code) return `\`${run.text.replace(/`/g, '`​')}\``
  let text = escapeMarkdownText(run.text)
  if (run.bold) text = `**${text}**`
  if (run.italic) text = `_${text}_`
  if (run.strike) text = `~~${text}~~`
  if (run.underline) text = `<u>${text}</u>`
  if (run.link) text = `[${text}](${run.link})`
  return text
}

const runsToMarkdown = (runs: WordRun[]): string =>
  runs.map(runToMarkdown).join('').replace(/\n/g, '  \n')

function tableToMarkdown(rows: WordRun[][][]): string {
  if (rows.length === 0) return ''
  const width = Math.max(...rows.map((row) => row.length), 1)
  const renderRow = (row: WordRun[][]): string => {
    const cells: string[] = []
    for (let index = 0; index < width; index += 1) {
      const cell = row[index] ?? []
      cells.push(runsToMarkdown(cell).replace(/\|/g, '\\|').replace(/\n/g, ' ') || ' ')
    }
    return `| ${cells.join(' | ')} |`
  }
  const lines = [
    renderRow(rows[0]),
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`
  ]
  for (const row of rows.slice(1)) lines.push(renderRow(row))
  return lines.join('\n')
}

export function wordModelToMarkdown(model: WordDocumentModel): string {
  const parts: string[] = []
  let previousWasListItem = false
  for (const block of model.blocks) {
    switch (block.type) {
      case 'image':
        // Standard image syntax with the raster inlined as a data URI —
        // bulky but lossless, and GitHub/VS Code render it.
        parts.push(`![${block.image.name.replace(/[[\]]/g, '')}](${block.image.dataUri})`)
        previousWasListItem = false
        break
      case 'heading':
        parts.push(`${'#'.repeat(block.level)} ${runsToMarkdown(block.runs)}`)
        previousWasListItem = false
        break
      case 'list-item': {
        const indent = '  '.repeat(block.level)
        const marker = block.ordered ? '1.' : '-'
        const line = `${indent}${marker} ${runsToMarkdown(block.runs)}`
        if (previousWasListItem && parts.length > 0) {
          parts[parts.length - 1] += `\n${line}`
        } else {
          parts.push(line)
        }
        previousWasListItem = true
        break
      }
      case 'table':
        parts.push(tableToMarkdown(block.rows))
        previousWasListItem = false
        break
      default:
        parts.push(runsToMarkdown(block.runs))
        previousWasListItem = false
        break
    }
  }
  return parts.join('\n\n') + '\n'
}

// --- markdown → model ---------------------------------------------------------

interface InlineState {
  bold?: boolean
  italic?: boolean
  strike?: boolean
  underline?: boolean
  link?: string
}

function pushRun(runs: WordRun[], text: string, state: InlineState, code = false): void {
  if (text === '') return
  const run: WordRun = { text }
  if (state.bold) run.bold = true
  if (state.italic) run.italic = true
  if (state.strike) run.strike = true
  if (state.underline) run.underline = true
  if (state.link) run.link = state.link
  if (code) run.code = true
  const previous = runs[runs.length - 1]
  if (
    previous &&
    previous.bold === run.bold &&
    previous.italic === run.italic &&
    previous.strike === run.strike &&
    previous.underline === run.underline &&
    previous.code === run.code &&
    previous.link === run.link
  ) {
    previous.text += run.text
    return
  }
  runs.push(run)
}

/** Parses one line of inline markdown into styled runs. */
export function parseInlineMarkdown(source: string): WordRun[] {
  const runs: WordRun[] = []

  const walk = (text: string, state: InlineState): void => {
    let buffer = ''
    let index = 0
    const flush = (): void => {
      if (buffer) {
        pushRun(runs, buffer.replace(/\\([\\`*_[\]<>~|])/g, '$1'), state)
        buffer = ''
      }
    }
    while (index < text.length) {
      const rest = text.slice(index)
      if (text[index] === '\\' && index + 1 < text.length) {
        buffer += text.slice(index, index + 2)
        index += 2
        continue
      }
      const codeMatch = /^`([^`]+)`/.exec(rest)
      if (codeMatch) {
        flush()
        pushRun(runs, codeMatch[1], state, true)
        index += codeMatch[0].length
        continue
      }
      const linkMatch = /^\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/.exec(rest)
      if (linkMatch) {
        flush()
        walk(linkMatch[1], { ...state, link: linkMatch[2] })
        index += linkMatch[0].length
        continue
      }
      const underlineMatch = /^<u>([\s\S]*?)<\/u>/.exec(rest)
      if (underlineMatch) {
        flush()
        walk(underlineMatch[1], { ...state, underline: true })
        index += underlineMatch[0].length
        continue
      }
      const boldMatch = /^(\*\*|__)((?:[^*_]|\*(?!\*)|_(?!_))+)\1/.exec(rest)
      if (boldMatch) {
        flush()
        walk(boldMatch[2], { ...state, bold: true })
        index += boldMatch[0].length
        continue
      }
      const strikeMatch = /^~~([^~]+)~~/.exec(rest)
      if (strikeMatch) {
        flush()
        walk(strikeMatch[1], { ...state, strike: true })
        index += strikeMatch[0].length
        continue
      }
      const italicMatch = /^([*_])([^*_]+)\1/.exec(rest)
      if (italicMatch) {
        flush()
        walk(italicMatch[2], { ...state, italic: true })
        index += italicMatch[0].length
        continue
      }
      buffer += text[index]
      index += 1
    }
    flush()
  }

  walk(source, {})
  return runs
}

const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let current = ''
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]
    if (char === '\\' && trimmed[index + 1] === '|') {
      current += '|'
      index += 1
      continue
    }
    if (char === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  cells.push(current.trim())
  return cells
}

export function markdownToWordModel(markdown: string): WordDocumentModel {
  const lines = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const blocks: WordBlock[] = []
  let paragraphBuffer: string[] = []

  const flushParagraph = (): void => {
    if (paragraphBuffer.length === 0) return
    const text = paragraphBuffer.join('\n')
    blocks.push({ type: 'paragraph', runs: parseInlineMarkdown(text) })
    paragraphBuffer = []
  }

  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    const trimmed = line.trim()

    if (trimmed === '') {
      flushParagraph()
      index += 1
      continue
    }

    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (headingMatch) {
      flushParagraph()
      const level = Math.min(3, headingMatch[1].length) as 1 | 2 | 3
      blocks.push({ type: 'heading', level, runs: parseInlineMarkdown(headingMatch[2]) })
      index += 1
      continue
    }

    const imageMatch = /^!\[([^\]]*)\]\((data:image\/[^)\s]+)\)$/.exec(trimmed)
    if (imageMatch) {
      flushParagraph()
      blocks.push({ type: 'image', image: { dataUri: imageMatch[2], name: imageMatch[1] } })
      index += 1
      continue
    }

    const listMatch = /^(\s*)([-*+]|\d{1,4}[.)])\s+(.*)$/.exec(line)
    if (listMatch) {
      flushParagraph()
      const level = Math.min(8, Math.floor(listMatch[1].replace(/\t/g, '  ').length / 2))
      const ordered = /^\d/.test(listMatch[2])
      blocks.push({ type: 'list-item', ordered, level, runs: parseInlineMarkdown(listMatch[3]) })
      index += 1
      continue
    }

    if (trimmed.includes('|') && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1])) {
      flushParagraph()
      const rows: WordRun[][][] = [splitTableRow(line).map(parseInlineMarkdown)]
      index += 2
      while (index < lines.length && lines[index].includes('|') && lines[index].trim() !== '') {
        rows.push(splitTableRow(lines[index]).map(parseInlineMarkdown))
        index += 1
      }
      blocks.push({ type: 'table', rows })
      continue
    }

    paragraphBuffer.push(trimmed.replace(/\s{2,}$/, ''))
    index += 1
  }
  flushParagraph()

  return { kind: 'word', blocks }
}
