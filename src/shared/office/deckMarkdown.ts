/**
 * Deck model ⇄ Markdown (Marp/Deckset-style): slides separated by `---`,
 * first heading is the slide title, list items are bullets (2-space indent
 * per level), and everything after a `???` line is speaker notes.
 */

import type { DeckDocumentModel, DeckSlide } from './officeModels'

export function deckModelToMarkdown(model: DeckDocumentModel): string {
  const slides = model.slides.map((slide) => {
    const lines: string[] = []
    if (slide.title) lines.push(`# ${slide.title}`)
    for (const bullet of slide.bullets) {
      lines.push(`${'  '.repeat(bullet.level)}- ${bullet.text}`)
    }
    if (slide.notes.trim()) {
      lines.push('')
      lines.push('???')
      lines.push(slide.notes)
    }
    return lines.join('\n')
  })
  return slides.join('\n\n---\n\n') + '\n'
}

export function markdownToDeckModel(markdown: string): DeckDocumentModel {
  const normalized = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const sections = normalized.split(/^\s*---\s*$/m)
  const slides: DeckSlide[] = []
  for (const section of sections) {
    if (!section.trim()) continue
    const slide: DeckSlide = { title: '', bullets: [], notes: '' }
    let inNotes = false
    const noteLines: string[] = []
    for (const line of section.split('\n')) {
      if (inNotes) {
        noteLines.push(line)
        continue
      }
      const trimmed = line.trim()
      if (trimmed === '???') {
        inNotes = true
        continue
      }
      const headingMatch = /^(#{1,6})\s+(.*)$/.exec(trimmed)
      if (headingMatch && slide.title === '') {
        slide.title = headingMatch[2]
        continue
      }
      const bulletMatch = /^(\s*)([-*+]|\d{1,4}[.)])\s+(.*)$/.exec(line)
      if (bulletMatch) {
        const level = Math.min(8, Math.floor(bulletMatch[1].replace(/\t/g, '  ').length / 2))
        slide.bullets.push({ text: bulletMatch[3], level })
        continue
      }
      if (trimmed !== '') {
        // Plain prose line: keep it as a top-level bullet so nothing is lost.
        slide.bullets.push({ text: trimmed, level: 0 })
      }
    }
    slide.notes = noteLines.join('\n').trim()
    slides.push(slide)
  }
  if (slides.length === 0) slides.push({ title: '', bullets: [], notes: '' })
  return { kind: 'deck', slides }
}
