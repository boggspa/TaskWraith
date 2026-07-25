import { describe, expect, it } from 'vitest'
import { deckModelToMarkdown, markdownToDeckModel } from './deckMarkdown'
import type { DeckDocumentModel } from './officeModels'

describe('deckMarkdown', () => {
  it('splits slides on --- and reads title, bullets and notes', () => {
    const model = markdownToDeckModel(
      [
        '# Opening',
        '- point one',
        '  - sub point',
        '',
        '???',
        'Remember to smile.',
        '',
        '---',
        '',
        '## Second slide',
        'Plain prose line',
        '- bullet'
      ].join('\n')
    )
    expect(model.slides).toHaveLength(2)
    expect(model.slides[0]).toEqual({
      title: 'Opening',
      bullets: [
        { text: 'point one', level: 0 },
        { text: 'sub point', level: 1 }
      ],
      notes: 'Remember to smile.'
    })
    expect(model.slides[1]).toEqual({
      title: 'Second slide',
      bullets: [
        { text: 'Plain prose line', level: 0 },
        { text: 'bullet', level: 0 }
      ],
      notes: ''
    })
  })

  it('round-trips a deck through markdown', () => {
    const deck: DeckDocumentModel = {
      kind: 'deck',
      slides: [
        {
          title: 'One',
          bullets: [
            { text: 'a', level: 0 },
            { text: 'b', level: 2 }
          ],
          notes: 'note line'
        },
        { title: '', bullets: [{ text: 'untitled slide bullet', level: 0 }], notes: '' }
      ]
    }
    expect(markdownToDeckModel(deckModelToMarkdown(deck))).toEqual(deck)
  })

  it('always yields at least one slide', () => {
    expect(markdownToDeckModel('').slides).toEqual([{ title: '', bullets: [], notes: '' }])
  })
})
