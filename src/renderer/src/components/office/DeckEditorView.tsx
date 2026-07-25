import { useState } from 'react'
import type {
  DeckBullet,
  DeckDocumentModel,
  DeckSlide
} from '../../../../shared/office/officeModels'
import { OFFICE_MODEL_LIMITS } from '../../../../shared/office/officeModels'

interface DeckEditorViewProps {
  model: DeckDocumentModel
  onChange: (next: DeckDocumentModel) => void
}

/** One bullet per line; 2 leading spaces per nesting level; optional '-' marker tolerated. */
export const bulletsToText = (bullets: DeckBullet[]): string =>
  bullets.map((bullet) => `${'  '.repeat(bullet.level)}${bullet.text}`).join('\n')

export const textToBullets = (text: string): DeckBullet[] => {
  if (text.trim() === '') return []
  return text
    .split('\n')
    .map((line) => {
      const match = /^(\s*)(?:[-*+]\s+)?(.*)$/.exec(line) ?? ['', '', line]
      const level = Math.min(8, Math.floor(match[1].replace(/\t/g, '  ').length / 2))
      return { text: match[2], level }
    })
    .filter((bullet, index, all) => !(bullet.text === '' && index === all.length - 1))
}

export function DeckEditorView({ model, onChange }: DeckEditorViewProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const slideIndex = Math.min(selectedIndex, model.slides.length - 1)
  const slide = model.slides[slideIndex] ?? { title: '', bullets: [], notes: '' }

  const replaceSlide = (index: number, next: DeckSlide): void => {
    onChange({
      kind: 'deck',
      slides: model.slides.map((entry, at) => (at === index ? next : entry))
    })
  }

  const addSlide = (): void => {
    if (model.slides.length >= OFFICE_MODEL_LIMITS.maxDeckSlides) return
    const slides = [...model.slides, { title: '', bullets: [], notes: '' }]
    onChange({ kind: 'deck', slides })
    setSelectedIndex(slides.length - 1)
  }

  const removeSlide = (index: number): void => {
    if (model.slides.length <= 1) return
    const slides = model.slides.filter((_, at) => at !== index)
    onChange({ kind: 'deck', slides })
    setSelectedIndex(Math.max(0, Math.min(index, slides.length - 1)))
  }

  const moveSlide = (index: number, direction: -1 | 1): void => {
    const target = index + direction
    if (target < 0 || target >= model.slides.length) return
    const slides = [...model.slides]
    ;[slides[index], slides[target]] = [slides[target], slides[index]]
    onChange({ kind: 'deck', slides })
    setSelectedIndex(target)
  }

  return (
    <div className="office-deck-editor">
      <aside className="office-deck-rail" aria-label="Slides">
        {model.slides.map((entry, index) => (
          <div
            key={index}
            className={`office-deck-thumb${index === slideIndex ? ' is-active' : ''}`}
          >
            <button
              type="button"
              className="office-deck-thumb-body"
              onClick={() => setSelectedIndex(index)}
            >
              <span className="office-deck-thumb-index">{index + 1}</span>
              <span className="office-deck-thumb-title">{entry.title || 'Untitled slide'}</span>
              <span className="office-deck-thumb-meta">
                {entry.bullets.length} bullet{entry.bullets.length === 1 ? '' : 's'}
              </span>
            </button>
            <span className="office-deck-thumb-actions">
              <button
                type="button"
                title="Move up"
                aria-label={`Move slide ${index + 1} up`}
                disabled={index === 0}
                onClick={() => moveSlide(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                title="Move down"
                aria-label={`Move slide ${index + 1} down`}
                disabled={index === model.slides.length - 1}
                onClick={() => moveSlide(index, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                title="Delete slide"
                aria-label={`Delete slide ${index + 1}`}
                disabled={model.slides.length <= 1}
                onClick={() => removeSlide(index)}
              >
                ✕
              </button>
            </span>
          </div>
        ))}
        <button type="button" className="office-deck-add" onClick={addSlide}>
          + Slide
        </button>
      </aside>
      <div className="office-deck-form">
        <label className="office-field">
          <span>Title</span>
          <input
            value={slide.title}
            placeholder="Slide title"
            onChange={(event) => replaceSlide(slideIndex, { ...slide, title: event.target.value })}
          />
        </label>
        <label className="office-field office-field-grow">
          <span>Bullets — one per line, indent 2 spaces to nest</span>
          <textarea
            className="office-deck-bullets"
            value={bulletsToText(slide.bullets)}
            placeholder={'Point one\n  Sub point'}
            onChange={(event) =>
              replaceSlide(slideIndex, { ...slide, bullets: textToBullets(event.target.value) })
            }
          />
        </label>
        <label className="office-field">
          <span>Speaker notes</span>
          <textarea
            className="office-deck-notes"
            value={slide.notes}
            placeholder="Notes for the presenter"
            onChange={(event) => replaceSlide(slideIndex, { ...slide, notes: event.target.value })}
          />
        </label>
      </div>
    </div>
  )
}
