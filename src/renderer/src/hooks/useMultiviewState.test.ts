import { describe, expect, it } from 'vitest'
import {
  applyAssignToNextPane,
  applyClosePane,
  applyOpenInNewPane,
  applySetFocusedPane,
  applySetLayout,
  applySetPaneChat,
  createInitialMultiviewState,
  type MultiviewCoreState
} from './useMultiviewState'

const state = (over: Partial<MultiviewCoreState>): MultiviewCoreState => ({
  layout: 'single',
  paneChatIds: [null],
  focusedPaneIndex: 0,
  ...over
})

describe('createInitialMultiviewState', () => {
  it('starts single, one cell, focused on pane 0', () => {
    expect(createInitialMultiviewState()).toEqual({
      layout: 'single',
      paneChatIds: [null],
      focusedPaneIndex: 0
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
    expect(next).toEqual({ layout: 'single', paneChatIds: ['a'], focusedPaneIndex: 0 })
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
    expect(next).toEqual({ layout: 'single', paneChatIds: ['b'], focusedPaneIndex: 0 })
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
      'b'
    )
    expect(next.layout).toBe('vertical-2')
    expect(next.paneChatIds).toEqual(['a', 'b'])
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
