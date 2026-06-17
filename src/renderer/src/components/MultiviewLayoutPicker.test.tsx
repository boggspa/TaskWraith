import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  MULTIVIEW_LAYOUT_IDS,
  getMultiviewLayoutSpec,
  type MultiviewLayout
} from '../../../shared/multiviewLayouts'
import { MultiviewLayoutGlyph, buildMultiviewLayoutSections } from './MultiviewLayoutPicker'

describe('MultiviewLayoutGlyph', () => {
  it('draws exactly one rect per pane for every layout', () => {
    for (const id of MULTIVIEW_LAYOUT_IDS) {
      const out = renderToStaticMarkup(<MultiviewLayoutGlyph layout={id} />)
      const rects = (out.match(/<rect/g) || []).length
      expect(rects, `${id} glyph`).toBe(getMultiviewLayoutSpec(id).paneCount)
    }
  })
})

describe('buildMultiviewLayoutSections', () => {
  it('lists every layout once with its catalogue label', () => {
    const sections = buildMultiviewLayoutSections('single', () => {})
    expect(sections).toHaveLength(1)
    expect(sections[0].items.map((i) => i.id)).toEqual([...MULTIVIEW_LAYOUT_IDS])
    expect(sections[0].items.find((i) => i.id === 'quad')?.label).toBe('Quad')
    expect(sections[0].items.find((i) => i.id === 'single')?.description).toBe('One chat (default)')
    expect(sections[0].items.find((i) => i.id === 'vertical-2')?.description).toBe('2 panes')
  })

  it('flags the current layout active and only that one', () => {
    const items = buildMultiviewLayoutSections('vertical-2', () => {})[0].items
    expect(items.filter((i) => i.active).map((i) => i.id)).toEqual(['vertical-2'])
  })

  it('disables only the layouts in the disabled set', () => {
    const disabled = new Set<MultiviewLayout>(['quad', 'two-top-one-bottom'])
    const items = buildMultiviewLayoutSections('single', () => {}, disabled)[0].items
    expect(items.filter((i) => i.disabled).map((i) => i.id).sort()).toEqual([
      'quad',
      'two-top-one-bottom'
    ])
  })

  it('routes onSelect to the chosen layout', () => {
    const onSelect = vi.fn()
    const items = buildMultiviewLayoutSections('single', onSelect)[0].items
    items.find((i) => i.id === 'one-left-two-right')?.onSelect()
    expect(onSelect).toHaveBeenCalledWith('one-left-two-right')
  })
})
