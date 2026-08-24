import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  MULTIVIEW_LAYOUT_IDS,
  getMultiviewLayoutSpec,
  type MultiviewLayout
} from '../../../shared/multiviewLayouts'
import { MultiviewLayoutGlyph, buildMultiviewLayoutGridItems } from './MultiviewLayoutPicker'

describe('MultiviewLayoutGlyph', () => {
  it('draws exactly one rect per pane for every layout', () => {
    for (const id of MULTIVIEW_LAYOUT_IDS) {
      const out = renderToStaticMarkup(<MultiviewLayoutGlyph layout={id} />)
      const rects = (out.match(/<rect/g) || []).length
      expect(rects, `${id} glyph`).toBe(getMultiviewLayoutSpec(id).paneCount)
    }
  })
})

describe('buildMultiviewLayoutGridItems', () => {
  it('lists every layout once with its catalogue label', () => {
    const items = buildMultiviewLayoutGridItems('single', () => {})
    expect(items.map((i) => i.id)).toEqual([...MULTIVIEW_LAYOUT_IDS])
    expect(items.find((i) => i.id === 'quad')?.label).toBe('Quad')
    expect(items.find((i) => i.id === 'single')?.description).toBe('One chat')
    expect(items.find((i) => i.id === 'vertical-2')?.description).toBe('2 panes')
    expect(items.find((i) => i.id === 'vertical-3')).toMatchObject({
      label: 'Vertical split',
      description: '3 panes'
    })
    expect(items.find((i) => i.id === 'six-way')).toMatchObject({
      label: '6-Way',
      description: '6 panes'
    })
  })

  it('flags the current layout active and only that one', () => {
    const items = buildMultiviewLayoutGridItems('vertical-2', () => {})
    expect(items.filter((i) => i.active).map((i) => i.id)).toEqual(['vertical-2'])
  })

  it('disables only the layouts in the disabled set', () => {
    const disabled = new Set<MultiviewLayout>(['quad', 'two-top-one-bottom'])
    const items = buildMultiviewLayoutGridItems('single', () => {}, disabled)
    expect(items.filter((i) => i.disabled).map((i) => i.id).sort()).toEqual([
      'quad',
      'two-top-one-bottom'
    ])
  })

  it('routes onSelect to the chosen layout', () => {
    const onSelect = vi.fn()
    const items = buildMultiviewLayoutGridItems('single', onSelect)
    items.find((i) => i.id === 'one-left-two-right')?.onSelect()
    expect(onSelect).toHaveBeenCalledWith('one-left-two-right')
  })
})
