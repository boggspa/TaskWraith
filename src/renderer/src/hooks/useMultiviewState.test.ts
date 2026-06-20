import { describe, expect, it } from 'vitest'
import {
  applyAssignToNextPane,
  applyClosePane,
  applyFocusPane,
  applyOpenInNewPane,
  applyResetTrackSizes,
  applyResizeTrack,
  applySetFocusedPane,
  applySetLayout,
  applySetPaneChat,
  createInitialMultiviewState,
  getLayoutTracks,
  MULTIVIEW_MIN_PANE_PX,
  type MultiviewCoreState
} from './useMultiviewState'

const state = (over: Partial<MultiviewCoreState>): MultiviewCoreState => ({
  layout: 'single',
  paneChatIds: [null],
  focusedPaneIndex: 0,
  trackSizes: {},
  ...over
})

describe('createInitialMultiviewState', () => {
  it('starts single, one cell, focused on pane 0', () => {
    expect(createInitialMultiviewState()).toEqual({
      layout: 'single',
      paneChatIds: [null],
      focusedPaneIndex: 0,
      trackSizes: {}
    })
  })

  it('seeds pane 0 with the initial chat id', () => {
    expect(createInitialMultiviewState('chat-1').paneChatIds).toEqual(['chat-1'])
  })
})

describe('applySetLayout', () => {
  it('pads empty cells when growing', () => {
    const next = applySetLayout(state({ paneChatIds: ['a'] }), 'quad')
    expect(next.layout).toBe('quad')
    expect(next.paneChatIds).toEqual(['a', null, null, null])
  })

  it('pins and duplicates the visible chat into new panes when seeded', () => {
    const next = applySetLayout(state({ paneChatIds: ['old'] }), 'quad', {
      seedChatId: 'current'
    })
    expect(next.layout).toBe('quad')
    expect(next.paneChatIds).toEqual(['current', 'current', 'current', 'current'])
  })

  it('fills existing empty panes on seeded growth while preserving occupied panes', () => {
    const next = applySetLayout(
      state({ layout: 'vertical-2', paneChatIds: ['a', null], focusedPaneIndex: 0 }),
      'quad',
      { seedChatId: 'a' }
    )
    expect(next.paneChatIds).toEqual(['a', 'a', 'a', 'a'])
  })

  it('truncates and clamps focus when shrinking', () => {
    const next = applySetLayout(
      state({ layout: 'quad', paneChatIds: ['a', 'b', 'c', 'd'], focusedPaneIndex: 3 }),
      'vertical-2'
    )
    expect(next.layout).toBe('vertical-2')
    expect(next.paneChatIds).toEqual(['a', 'b'])
    expect(next.focusedPaneIndex).toBe(1)
  })

  it('collapsing to single keeps pane 0 and focuses it', () => {
    const next = applySetLayout(
      state({ layout: 'vertical-2', paneChatIds: ['a', 'b'], focusedPaneIndex: 1 }),
      'single'
    )
    expect(next).toEqual({
      layout: 'single',
      paneChatIds: ['a'],
      focusedPaneIndex: 0,
      trackSizes: {}
    })
  })

  it('returns the same reference when the layout is unchanged', () => {
    const s = state({ layout: 'quad', paneChatIds: ['a', null, null, null] })
    expect(applySetLayout(s, 'quad')).toBe(s)
  })
})

describe('applySetPaneChat', () => {
  it('sets a cell', () => {
    expect(
      applySetPaneChat(state({ layout: 'vertical-2', paneChatIds: [null, null] }), 1, 'b')
        .paneChatIds
    ).toEqual([null, 'b'])
  })

  it('ignores out-of-range indices and no-op writes', () => {
    const s = state({ paneChatIds: ['a'] })
    expect(applySetPaneChat(s, 5, 'x')).toBe(s)
    expect(applySetPaneChat(s, 0, 'a')).toBe(s)
  })
})

describe('applySetFocusedPane', () => {
  it('clamps into the layout range', () => {
    const s = state({ layout: 'quad', paneChatIds: ['a', 'b', 'c', 'd'] })
    expect(applySetFocusedPane(s, 9).focusedPaneIndex).toBe(3)
    expect(applySetFocusedPane(s, -1).focusedPaneIndex).toBe(0)
  })

  it('returns the same reference when focus is unchanged', () => {
    const s = state({ layout: 'vertical-2', paneChatIds: ['a', 'b'], focusedPaneIndex: 1 })
    expect(applySetFocusedPane(s, 1)).toBe(s)
  })
})

describe('applyFocusPane', () => {
  it('pins the outgoing visible chat before focusing another pane', () => {
    const next = applyFocusPane(
      state({ layout: 'vertical-2', paneChatIds: ['stale', 'b'], focusedPaneIndex: 0 }),
      1,
      'current'
    )
    expect(next.paneChatIds).toEqual(['current', 'b'])
    expect(next.focusedPaneIndex).toBe(1)
  })
})

describe('applyClosePane', () => {
  it('is a no-op in single layout', () => {
    const s = state({ paneChatIds: ['a'] })
    expect(applyClosePane(s, 0)).toBe(s)
  })

  it('drops a cell, compacts, and downgrades one step', () => {
    const next = applyClosePane(
      state({ layout: 'quad', paneChatIds: ['a', 'b', 'c', 'd'], focusedPaneIndex: 0 }),
      1
    )
    expect(next.layout).toBe('two-top-one-bottom')
    expect(next.paneChatIds).toEqual(['a', 'c', 'd'])
    expect(next.focusedPaneIndex).toBe(0)
  })

  it('shifts focus left when closing a cell before the focused one', () => {
    const next = applyClosePane(
      state({ layout: 'quad', paneChatIds: ['a', 'b', 'c', 'd'], focusedPaneIndex: 2 }),
      1
    )
    // c was focused at index 2; after removing b it sits at index 1.
    expect(next.paneChatIds).toEqual(['a', 'c', 'd'])
    expect(next.focusedPaneIndex).toBe(1)
  })

  it('keeps focus on the next cell when closing the focused one', () => {
    const next = applyClosePane(
      state({ layout: 'vertical-2', paneChatIds: ['a', 'b'], focusedPaneIndex: 0 }),
      0
    )
    expect(next).toEqual({
      layout: 'single',
      paneChatIds: ['b'],
      focusedPaneIndex: 0,
      trackSizes: {}
    })
  })
})

describe('applyAssignToNextPane', () => {
  it('fills the focused pane when it is empty', () => {
    const result = applyAssignToNextPane(
      state({ layout: 'vertical-2', paneChatIds: ['a', null], focusedPaneIndex: 1 }),
      'b'
    )
    expect(result.index).toBe(1)
    expect(result.state.paneChatIds).toEqual(['a', 'b'])
    expect(result.state.focusedPaneIndex).toBe(1)
  })

  it('falls to the first empty cell when the focused pane is occupied', () => {
    const result = applyAssignToNextPane(
      state({ layout: 'quad', paneChatIds: ['a', null, null, null], focusedPaneIndex: 0 }),
      'b'
    )
    expect(result.index).toBe(1)
    expect(result.state.paneChatIds).toEqual(['a', 'b', null, null])
  })

  it('overwrites the focused pane when every cell is occupied', () => {
    const result = applyAssignToNextPane(
      state({ layout: 'vertical-2', paneChatIds: ['a', 'b'], focusedPaneIndex: 0 }),
      'z'
    )
    expect(result.index).toBe(0)
    expect(result.state.paneChatIds).toEqual(['z', 'b'])
  })

  it('overwrites pane 0 in single layout (callers widen the layout first)', () => {
    const result = applyAssignToNextPane(state({ paneChatIds: ['a'] }), 'z')
    expect(result.index).toBe(0)
    expect(result.state.paneChatIds).toEqual(['z'])
  })
})

describe('applyOpenInNewPane', () => {
  it('grows single -> vertical-2 and fills the spare pane, keeping focus', () => {
    const next = applyOpenInNewPane(
      state({ layout: 'single', paneChatIds: ['a'], focusedPaneIndex: 0 }),
      'b',
      'current'
    )
    expect(next.layout).toBe('vertical-2')
    expect(next.paneChatIds).toEqual(['current', 'b'])
    expect(next.focusedPaneIndex).toBe(0)
  })

  it('uses an existing non-focused empty cell without growing', () => {
    const next = applyOpenInNewPane(
      state({ layout: 'vertical-2', paneChatIds: ['a', null], focusedPaneIndex: 0 }),
      'b'
    )
    expect(next.layout).toBe('vertical-2')
    expect(next.paneChatIds).toEqual(['a', 'b'])
  })

  it('never fills the focused pane even when it is empty', () => {
    const next = applyOpenInNewPane(
      state({ layout: 'vertical-2', paneChatIds: [null, null], focusedPaneIndex: 0 }),
      'b'
    )
    expect(next.paneChatIds).toEqual([null, 'b'])
    expect(next.focusedPaneIndex).toBe(0)
  })

  it('grows when the only empty cell is the focused one', () => {
    const next = applyOpenInNewPane(
      state({ layout: 'vertical-2', paneChatIds: ['a', null], focusedPaneIndex: 1 }),
      'b'
    )
    expect(next.layout).toBe('two-top-one-bottom')
    expect(next.paneChatIds).toEqual(['a', null, 'b'])
    expect(next.focusedPaneIndex).toBe(1)
  })

  it('overwrites a non-focused cell when already at quad', () => {
    const next = applyOpenInNewPane(
      state({ layout: 'quad', paneChatIds: ['a', 'b', 'c', 'd'], focusedPaneIndex: 0 }),
      'z'
    )
    expect(next.layout).toBe('quad')
    expect(next.paneChatIds).toEqual(['a', 'z', 'c', 'd'])
    expect(next.focusedPaneIndex).toBe(0)
  })
})

describe('getLayoutTracks', () => {
  it('falls back to the spec defaults (equal tracks) when nothing is stored', () => {
    expect(getLayoutTracks({}, 'vertical-2')).toEqual({ columns: [1, 1], rows: [1] })
    expect(getLayoutTracks({}, 'horizontal-2')).toEqual({ columns: [1], rows: [1, 1] })
    expect(getLayoutTracks({}, 'quad')).toEqual({ columns: [1, 1], rows: [1, 1] })
  })

  it('returns the stored fractions when present', () => {
    const tracks = getLayoutTracks({ 'vertical-2': { columns: [2, 1], rows: [1] } }, 'vertical-2')
    expect(tracks.columns).toEqual([2, 1])
  })

  it('ignores a stale stored entry whose length no longer matches the layout', () => {
    // A 3-track columns entry on a 2-column layout is stale -> use defaults.
    const tracks = getLayoutTracks({ 'vertical-2': { columns: [1, 1, 1], rows: [1] } }, 'vertical-2')
    expect(tracks.columns).toEqual([1, 1])
  })
})

describe('applyResizeTrack', () => {
  it('moves a px delta between the two adjacent column tracks', () => {
    // vertical-2: columns [1,1], total fraction 2, axisTotalPx 1000 -> pairPx 1000.
    // +100px to track0 -> 600px / 400px -> fractions 1.2 / 0.8.
    const next = applyResizeTrack(state({ layout: 'vertical-2', paneChatIds: ['a', 'b'] }), {
      orientation: 'column',
      trackIndex: 0,
      deltaPx: 100,
      axisTotalPx: 1000
    })
    expect(next.trackSizes['vertical-2']?.columns).toEqual([1.2, 0.8])
    // Combined fraction of the adjacent pair is conserved.
    expect(next.trackSizes['vertical-2']!.columns[0] + next.trackSizes['vertical-2']!.columns[1]).toBe(2)
  })

  it('clamps so neither adjacent pane drops below the 240px minimum', () => {
    // A huge delta would shrink track1 below 240px; clamp track0 at 1000-240=760.
    const next = applyResizeTrack(state({ layout: 'vertical-2', paneChatIds: ['a', 'b'] }), {
      orientation: 'column',
      trackIndex: 0,
      deltaPx: 100000,
      axisTotalPx: 1000
    })
    const cols = next.trackSizes['vertical-2']!.columns
    // track0 -> 760px (1.52fr), track1 -> 240px (0.48fr) at the min.
    expect(cols[0]).toBeCloseTo(1.52, 6)
    expect(cols[1]).toBeCloseTo(0.48, 6)
    // The clamped track1 maps back to exactly MULTIVIEW_MIN_PANE_PX.
    const pairPx = 1000
    expect((cols[1] / (cols[0] + cols[1])) * pairPx).toBeCloseTo(MULTIVIEW_MIN_PANE_PX, 6)
  })

  it('clamps a negative delta symmetrically (track0 cannot go below the min)', () => {
    const next = applyResizeTrack(state({ layout: 'vertical-2', paneChatIds: ['a', 'b'] }), {
      orientation: 'column',
      trackIndex: 0,
      deltaPx: -100000,
      axisTotalPx: 1000
    })
    const cols = next.trackSizes['vertical-2']!.columns
    expect(cols[0]).toBeCloseTo(0.48, 6)
    expect(cols[1]).toBeCloseTo(1.52, 6)
  })

  it('resizes rows independently of columns on a 2x2 layout', () => {
    // rows [1,1], pairPx 1000; +200 -> 700/300 -> 1.4/0.6 (both above the 240 min).
    const next = applyResizeTrack(state({ layout: 'quad', paneChatIds: ['a', 'b', 'c', 'd'] }), {
      orientation: 'row',
      trackIndex: 0,
      deltaPx: 200,
      axisTotalPx: 1000
    })
    expect(next.trackSizes.quad?.rows).toEqual([1.4, 0.6])
    expect(next.trackSizes.quad?.columns).toEqual([1, 1])
  })

  it('leaves the pair fixed when it cannot hold two minimums', () => {
    // pairPx 400 < 2*240; no room to resize without violating a minimum.
    const s = state({ layout: 'vertical-2', paneChatIds: ['a', 'b'] })
    const next = applyResizeTrack(s, {
      orientation: 'column',
      trackIndex: 0,
      deltaPx: 50,
      axisTotalPx: 400
    })
    expect(next).toBe(s)
  })

  it('is a no-op for a zero / non-finite delta or non-positive axis', () => {
    const s = state({ layout: 'quad', paneChatIds: ['a', 'b', 'c', 'd'] })
    expect(applyResizeTrack(s, { orientation: 'column', trackIndex: 0, deltaPx: 0, axisTotalPx: 1000 })).toBe(s)
    expect(applyResizeTrack(s, { orientation: 'column', trackIndex: 0, deltaPx: 10, axisTotalPx: 0 })).toBe(s)
  })

  it('ignores an out-of-range track index', () => {
    const s = state({ layout: 'vertical-2', paneChatIds: ['a', 'b'] })
    // vertical-2 has a single internal column boundary (trackIndex 0); 1 is out.
    expect(applyResizeTrack(s, { orientation: 'column', trackIndex: 1, deltaPx: 50, axisTotalPx: 1000 })).toBe(s)
  })

  it('resizing one layout does not affect another layout’s fractions', () => {
    const resized = applyResizeTrack(state({ layout: 'vertical-2', paneChatIds: ['a', 'b'] }), {
      orientation: 'column',
      trackIndex: 0,
      deltaPx: 100,
      axisTotalPx: 1000
    })
    // quad was never touched -> still the spec defaults.
    expect(resized.trackSizes.quad).toBeUndefined()
    expect(getLayoutTracks(resized.trackSizes, 'quad')).toEqual({ columns: [1, 1], rows: [1, 1] })
    // ...and vertical-2 keeps its drag.
    expect(getLayoutTracks(resized.trackSizes, 'vertical-2').columns).toEqual([1.2, 0.8])
  })

  it('survives switching layout away and back within a session', () => {
    const resized = applyResizeTrack(state({ layout: 'vertical-2', paneChatIds: ['a', 'b'] }), {
      orientation: 'column',
      trackIndex: 0,
      deltaPx: 100,
      axisTotalPx: 1000
    })
    const switched = applySetLayout(resized, 'quad')
    const back = applySetLayout(switched, 'vertical-2')
    expect(getLayoutTracks(back.trackSizes, 'vertical-2').columns).toEqual([1.2, 0.8])
  })
})

describe('applyResetTrackSizes', () => {
  it('drops a dragged layout back to the spec defaults', () => {
    const resized = applyResizeTrack(state({ layout: 'vertical-2', paneChatIds: ['a', 'b'] }), {
      orientation: 'column',
      trackIndex: 0,
      deltaPx: 120,
      axisTotalPx: 1000
    })
    expect(resized.trackSizes['vertical-2']).toBeDefined()
    const reset = applyResetTrackSizes(resized, 'vertical-2')
    expect(reset.trackSizes['vertical-2']).toBeUndefined()
    expect(getLayoutTracks(reset.trackSizes, 'vertical-2')).toEqual({ columns: [1, 1], rows: [1] })
  })

  it('resets the current layout when no layout id is passed', () => {
    const resized = applyResizeTrack(state({ layout: 'quad', paneChatIds: ['a', 'b', 'c', 'd'] }), {
      orientation: 'row',
      trackIndex: 0,
      deltaPx: 120,
      axisTotalPx: 800
    })
    const reset = applyResetTrackSizes(resized)
    expect(reset.trackSizes.quad).toBeUndefined()
  })

  it('only resets the targeted layout, leaving others intact', () => {
    let s = applyResizeTrack(state({ layout: 'vertical-2', paneChatIds: ['a', 'b'] }), {
      orientation: 'column',
      trackIndex: 0,
      deltaPx: 100,
      axisTotalPx: 1000
    })
    s = applySetLayout(s, 'quad')
    s = applyResizeTrack(s, { orientation: 'row', trackIndex: 0, deltaPx: 100, axisTotalPx: 800 })
    const reset = applyResetTrackSizes(s, 'quad')
    expect(reset.trackSizes.quad).toBeUndefined()
    expect(getLayoutTracks(reset.trackSizes, 'vertical-2').columns).toEqual([1.2, 0.8])
  })

  it('returns the same reference when there is nothing stored for the layout', () => {
    const s = state({ layout: 'vertical-2', paneChatIds: ['a', 'b'] })
    expect(applyResetTrackSizes(s, 'vertical-2')).toBe(s)
  })
})
