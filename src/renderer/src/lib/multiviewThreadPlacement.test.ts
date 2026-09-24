import { describe, expect, it } from 'vitest'
import {
  MULTIVIEW_LAYOUT_IDS,
  paneCountForLayout,
  type MultiviewLayout
} from '../../../shared/multiviewLayouts'
import {
  applySetLayout,
  createInitialMultiviewState,
  type MultiviewCoreState
} from '../hooks/useMultiviewState'
import {
  applyMultiviewThreadPlacement,
  multiviewDropZoneAt,
  multiviewPlacementRects,
  planMultiviewThreadPlacement,
  type MultiviewDropZone
} from './multiviewThreadPlacement'

function populated(layout: MultiviewLayout): MultiviewCoreState {
  const state = applySetLayout(createInitialMultiviewState('alpha'), layout)
  return {
    ...state,
    panes: state.panes.map((pane, index) => ({ ...pane, chatId: `thread-${index}` }))
  }
}

function plan(state: MultiviewCoreState, zone: MultiviewDropZone, index = 0) {
  return planMultiviewThreadPlacement(state, {
    chatId: 'incoming',
    targetPaneId: state.panes[index].id,
    zone,
    visibleChatId: state.layout === 'single' ? state.panes[0].chatId : null
  })
}

describe('multiview thread placement', () => {
  it.each([
    ['left', 'vertical-2', 0],
    ['right', 'vertical-2', 1],
    ['top', 'horizontal-2', 0],
    ['bottom', 'horizontal-2', 1],
    ['center', 'vertical-2', 1]
  ] as const)('previews a %s split from single view', (zone, layout, destination) => {
    const before = createInitialMultiviewState('alpha')
    const original = JSON.stringify(before)
    const preview = plan(before, zone)
    expect(preview.next?.layout).toBe(layout)
    expect(preview.destinationIndex).toBe(destination)
    expect(preview.next?.panes[destination].chatId).toBe('incoming')
    expect(preview.next?.panes[1 - destination]).toBe(before.panes[0])
    expect(JSON.stringify(before)).toBe(original)
    expect(applyMultiviewThreadPlacement(before, preview)).toBe(preview.next)
  })

  it('seeds the actual single-view chat rather than a stale hook selection', () => {
    const before = createInitialMultiviewState('old-thread')
    const preview = planMultiviewThreadPlacement(before, {
      chatId: 'incoming',
      targetPaneId: before.panes[0].id,
      zone: 'right',
      visibleChatId: 'visible'
    })
    expect(preview.next?.panes.map((pane) => pane.chatId)).toEqual(['visible', 'incoming'])
    expect(before.panes[0].chatId).toBe('old-thread')
  })

  it('fills Thread Home without creating an unnecessary empty split', () => {
    const before = createInitialMultiviewState('old-thread')
    const preview = planMultiviewThreadPlacement(before, {
      chatId: 'incoming',
      targetPaneId: before.panes[0].id,
      zone: 'right',
      visibleChatId: null
    })
    expect(preview.kind).toBe('fill')
    expect(preview.next?.layout).toBe('single')
    expect(preview.next?.panes[0].chatId).toBe('incoming')
  })

  it('requires an explicitly previewed centre drop to replace an occupied pane', () => {
    const before = populated('vertical-2')
    const preview = plan(before, 'center', 1)
    expect(preview.kind).toBe('replace')
    expect(preview.label).toBe('Replace this view')
    expect(preview.next?.layout).toBe(before.layout)
    expect(preview.next?.panes[0]).toBe(before.panes[0])
    expect(preview.next?.panes[1].id).toBe(before.panes[1].id)
    expect(before.panes[1].chatId).toBe('thread-1')
  })

  it('treats media and canvas panes as occupied, preserving them during a split', () => {
    const before = populated('vertical-2')
    before.panes[0] = { id: before.panes[0].id, chatId: null, canvasId: 'canvas' }
    before.panes[1] = {
      id: before.panes[1].id,
      chatId: null,
      mediaRef: { id: 'movie', name: 'Movie', kind: 'video' }
    }
    const preview = plan(before, 'bottom')
    expect(preview.kind).toBe('split')
    for (const pane of before.panes) expect(preview.next?.panes).toContain(pane)
    const replace = plan(before, 'center')
    expect(replace.kind).toBe('replace')
    expect(replace.next?.panes[0].canvasId).toBeNull()
  })

  it('uses an adjacent empty cell without growing the grid', () => {
    const before = applySetLayout(createInitialMultiviewState('alpha'), 'vertical-2')
    const preview = plan(before, 'right')
    expect(preview.kind).toBe('fill')
    expect(preview.next?.layout).toBe('vertical-2')
    expect(preview.next?.panes[1].id).toBe(before.panes[1].id)
  })

  it('keeps parked panes and their settings intact when growing from four to six', () => {
    const before = populated('quad')
    const parked = { id: 'parked', chatId: 'hidden-thread' }
    before.parkedPanes = [parked]
    before.paneSettings = { parked: { fx: { sky: true } } }
    const preview = plan(before, 'right')
    expect(preview.next?.layout).toBe('six-way')
    expect(preview.next?.panes.filter((pane) => pane.chatId === null)).toHaveLength(1)
    expect(preview.next?.parkedPanes).toBe(before.parkedPanes)
    expect(preview.next?.paneSettings).toBe(before.paneSettings)
  })

  it('rejects an additional split at eight panes but still allows replacement', () => {
    const before = populated('eight-way')
    const split = plan(before, 'right')
    expect(split.next).toBeNull()
    expect(split.label).toBe('Maximum 8 panes')
    expect(applyMultiviewThreadPlacement(before, split)).toBe(before)
    expect(plan(before, 'center').kind).toBe('replace')
  })

  it('focuses an already visible thread without duplicating it', () => {
    const before = populated('quad')
    const preview = planMultiviewThreadPlacement(before, {
      chatId: 'thread-2',
      targetPaneId: before.panes[0].id,
      zone: 'right',
      visibleChatId: null
    })
    expect(preview.kind).toBe('focus')
    expect(preview.next?.panes).toBe(before.panes)
    expect(preview.next?.focusedPaneIndex).toBe(2)
  })

  it('refuses a stale preview if pane state changed before release', () => {
    const before = populated('vertical-2')
    const preview = plan(before, 'center')
    const changed = { ...before, focusedPaneIndex: 1 }
    expect(applyMultiviewThreadPlacement(changed, preview)).toBe(changed)
  })

  it('uses actual resized track fractions in preview geometry', () => {
    const before = populated('vertical-2')
    before.trackSizes['vertical-2'] = { columns: [3, 1], rows: [1] }
    expect(multiviewPlacementRects(before)).toEqual([
      { left: 0, top: 0, width: 0.75, height: 1 },
      { left: 0.75, top: 0, width: 0.25, height: 1 }
    ])
  })

  it.each(MULTIVIEW_LAYOUT_IDS)(
    'preserves every existing pane across supported %s splits',
    (layout) => {
      const before = populated(layout)
      before.focusedPaneIndex = before.panes.length - 1
      const snapshot = JSON.stringify(before)
      for (let index = 0; index < before.panes.length; index += 1) {
        for (const zone of ['left', 'right', 'top', 'bottom'] as const) {
          const preview = plan(before, zone, index)
          if (!preview.next) continue
          const next = preview.next
          expect(next.panes).toHaveLength(paneCountForLayout(next.layout))
          expect(new Set(next.panes.map((pane) => pane.id)).size).toBe(next.panes.length)
          for (const pane of before.panes) expect(next.panes).toContain(pane)
          expect(next.panes[next.focusedPaneIndex].id).toBe(
            before.panes[before.focusedPaneIndex].id
          )
          expect(next.panes[preview.destinationIndex].chatId).toBe('incoming')
        }
      }
      expect(JSON.stringify(before)).toBe(snapshot)
    }
  )

  it('resolves edge and centre targets consistently', () => {
    expect(multiviewDropZoneAt(0.1, 0.5)).toBe('left')
    expect(multiviewDropZoneAt(0.9, 0.5)).toBe('right')
    expect(multiviewDropZoneAt(0.5, 0.1)).toBe('top')
    expect(multiviewDropZoneAt(0.5, 0.9)).toBe('bottom')
    expect(multiviewDropZoneAt(0.5, 0.5)).toBe('center')
  })
})
