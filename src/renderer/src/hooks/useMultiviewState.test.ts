import { describe, expect, it } from 'vitest'
import type {
  MultiviewPaneMediaRef,
  MultiviewPaneRecord
} from '../../../shared/multiviewLayouts'
import {
  applyAssignToNextPane,
  applyClosePane,
  applyFocusPane,
  applyOpenInNewPane,
  applyOpenMediaInNewPane,
  applyResetTrackSizes,
  applyResizeTrack,
  applySetFocusedPane,
  applySetLayout,
  applySetPaneCanvas,
  applySetPaneChat,
  applySetPaneFxFlag,
  applySetPaneMedia,
  createMultiviewPaneRefs,
  createInitialMultiviewState,
  getLayoutTracks,
  MULTIVIEW_MIN_PANE_PX,
  normalizeMultiviewCoreState,
  removedCanvasIds,
  resolveMultiviewPaneRefs,
  type MultiviewCoreState
} from './useMultiviewState'

/** A minimal media descriptor for the docked-player pane tests. */
const mediaRef = (id = 'm1'): MultiviewPaneMediaRef => ({
  id,
  kind: 'video',
  name: `${id}.mp4`,
  sha256: `sha-${id}`,
  mimeType: 'video/mp4'
})

/** Build pane records with deterministic seeded ids `t0`, `t1`, … from chatIds. */
const panesOf = (chatIds: (string | null)[]): MultiviewPaneRecord[] =>
  chatIds.map((chatId, i) => ({ id: `t${i}`, chatId }))

// nextPaneSeq starts high so freshly-minted ids (`pane-100`, …) never collide
// with the seeded `t*` ids — making "survivor keeps its id / new cell gets a
// fresh id" assertions unambiguous.
const state = (over: Partial<MultiviewCoreState> = {}): MultiviewCoreState => ({
  layout: 'single',
  panes: panesOf([null]),
  focusedPaneIndex: 0,
  trackSizes: {},
  paneSettings: {},
  nextPaneSeq: 100,
  ...over
})

const chatIds = (s: MultiviewCoreState): (string | null)[] => s.panes.map((p) => p.chatId)
const ids = (s: MultiviewCoreState): string[] => s.panes.map((p) => p.id)

describe('createInitialMultiviewState', () => {
  it('starts single, one cell, focused on pane 0', () => {
    expect(createInitialMultiviewState()).toEqual({
      layout: 'single',
      panes: [{ id: 'pane-1', chatId: null }],
      focusedPaneIndex: 0,
      trackSizes: {},
      paneSettings: {},
      nextPaneSeq: 2
    })
  })

  it('seeds pane 0 with the initial chat id', () => {
    const s = createInitialMultiviewState('chat-1')
    expect(chatIds(s)).toEqual(['chat-1'])
    expect(s.panes[0].id).toBe('pane-1')
  })
})

describe('Multiview pane reader ownership', () => {
  it('keeps chat caches and auto-follow isolated by stable pane id across A→B→A and compaction', () => {
    const refsByPaneId = new Map()
    const initial = resolveMultiviewPaneRefs(panesOf(['A', 'B']), refsByPaneId)
    const stateA = {
      scrollTop: 320,
      scrollHeight: 1_000,
      clientHeight: 200,
      scrollRatio: 0.4,
      atBottom: false
    }
    initial[0].autoFollowRef.current = false
    initial[0].chatScrollStateByIdRef.current.set('A', {
      scrollState: stateA,
      autoFollow: false
    })

    const showingB = resolveMultiviewPaneRefs(panesOf(['B', 'B']), refsByPaneId)
    expect(showingB[0]).toBe(initial[0])
    expect(showingB[1]).toBe(initial[1])
    expect(showingB[1].chatScrollStateByIdRef.current.has('A')).toBe(false)
    expect(showingB[1].autoFollowRef.current).toBe(true)

    const returningA = resolveMultiviewPaneRefs(panesOf(['A', 'B']), refsByPaneId)
    expect(returningA[0].chatScrollStateByIdRef.current.get('A')).toEqual({
      scrollState: stateA,
      autoFollow: false
    })
    expect(returningA[0].autoFollowRef.current).toBe(false)

    const compacted = resolveMultiviewPaneRefs([{ id: 't1', chatId: 'B' }], refsByPaneId)
    expect(compacted[0]).toBe(initial[1])
  })

  it('creates independent ownership refs for distinct panes', () => {
    const left = createMultiviewPaneRefs()
    const right = createMultiviewPaneRefs()
    expect(left.autoFollowRef).not.toBe(right.autoFollowRef)
    expect(left.chatScrollStateByIdRef.current).not.toBe(right.chatScrollStateByIdRef.current)
  })
})

describe('applySetLayout', () => {
  it('pads empty cells when growing — existing pane keeps its id, new cells minted', () => {
    const next = applySetLayout(state({ panes: panesOf(['a']) }), 'quad')
    expect(next.layout).toBe('quad')
    expect(chatIds(next)).toEqual(['a', null, null, null])
    expect(next.panes[0].id).toBe('t0') // preserved
    expect(ids(next).slice(1)).toEqual(['pane-100', 'pane-101', 'pane-102']) // freshly minted
    expect(next.nextPaneSeq).toBe(103)
  })

  it('pins and duplicates the visible chat into new panes when seeded', () => {
    const next = applySetLayout(state({ panes: panesOf(['old']) }), 'quad', {
      seedChatId: 'current'
    })
    expect(next.layout).toBe('quad')
    expect(chatIds(next)).toEqual(['current', 'current', 'current', 'current'])
    expect(next.panes[0].id).toBe('t0') // the focused pane's id survives the seed
  })

  it('fills existing empty panes on seeded growth while preserving occupied panes', () => {
    const next = applySetLayout(
      state({ layout: 'vertical-2', panes: panesOf(['a', null]), focusedPaneIndex: 0 }),
      'quad',
      { seedChatId: 'a' }
    )
    expect(chatIds(next)).toEqual(['a', 'a', 'a', 'a'])
  })

  it('truncates and clamps focus when shrinking — survivors keep ids, tail dropped', () => {
    const next = applySetLayout(
      state({ layout: 'quad', panes: panesOf(['a', 'b', 'c', 'd']), focusedPaneIndex: 3 }),
      'vertical-2'
    )
    expect(next.layout).toBe('vertical-2')
    expect(chatIds(next)).toEqual(['a', 'b'])
    expect(ids(next)).toEqual(['t0', 't1'])
    expect(next.focusedPaneIndex).toBe(1)
  })

  it('collapsing to single keeps pane 0 (id and all) and focuses it', () => {
    const next = applySetLayout(
      state({ layout: 'vertical-2', panes: panesOf(['a', 'b']), focusedPaneIndex: 1 }),
      'single'
    )
    expect(next.layout).toBe('single')
    expect(chatIds(next)).toEqual(['a'])
    expect(ids(next)).toEqual(['t0'])
    expect(next.focusedPaneIndex).toBe(0)
  })

  it('returns the same reference when the layout is unchanged', () => {
    const s = state({ layout: 'quad', panes: panesOf(['a', null, null, null]) })
    expect(applySetLayout(s, 'quad')).toBe(s)
  })
})

describe('applySetPaneChat', () => {
  it('sets a cell, preserving the pane id', () => {
    const next = applySetPaneChat(
      state({ layout: 'vertical-2', panes: panesOf([null, null]) }),
      1,
      'b'
    )
    expect(chatIds(next)).toEqual([null, 'b'])
    expect(next.panes[1].id).toBe('t1')
  })

  it('ignores out-of-range indices and no-op writes', () => {
    const s = state({ panes: panesOf(['a']) })
    expect(applySetPaneChat(s, 5, 'x')).toBe(s)
    expect(applySetPaneChat(s, 0, 'a')).toBe(s)
  })

  it('keeps the pane id and its settings when the shown chat changes', () => {
    // Settings belong to the PANE, not the chat: swapping which chat a pane shows
    // must not disturb the pane's id or its per-pane settings.
    let s = state({ layout: 'vertical-2', panes: panesOf(['a', 'b']) })
    s = applySetPaneFxFlag(s, 't1', 'sky', false)
    const next = applySetPaneChat(s, 1, 'c')
    expect(next.panes[1]).toEqual({ id: 't1', chatId: 'c' })
    expect(next.paneSettings.t1?.fx).toEqual({ sky: false })
  })
})

describe('applySetPaneCanvas', () => {
  it('puts a canvas in a pane and clears its chat (mutually exclusive)', () => {
    const next = applySetPaneCanvas(
      state({ layout: 'vertical-2', panes: panesOf(['a', 'b']) }),
      1,
      'cv1'
    )
    expect(next.panes[1]).toEqual({ id: 't1', chatId: null, canvasId: 'cv1' })
    expect(next.panes[0]).toEqual({ id: 't0', chatId: 'a' }) // untouched chat pane keeps old shape
  })

  it('assigning a chat to a canvas pane clears the canvas', () => {
    let s = applySetPaneCanvas(state({ layout: 'vertical-2', panes: panesOf([null, null]) }), 0, 'cv1')
    expect(s.panes[0].canvasId).toBe('cv1')
    s = applySetPaneChat(s, 0, 'chat-x')
    expect(s.panes[0]).toEqual({ id: 't0', chatId: 'chat-x', canvasId: null })
  })

  it('ignores out-of-range indices and no-op writes', () => {
    const s = state({ panes: panesOf(['a']) })
    expect(applySetPaneCanvas(s, 9, 'cv1')).toBe(s)
    expect(applySetPaneCanvas(s, 0, null)).toBe(s) // already canvas-less
  })

  it('setting a canvas also clears any detached media (mutual exclusion)', () => {
    const m = mediaRef()
    let s = applySetPaneMedia(state({ layout: 'vertical-2', panes: panesOf([null, null]) }), 0, m)
    expect(s.panes[0].mediaRef).toBe(m)
    s = applySetPaneCanvas(s, 0, 'cv1')
    expect(s.panes[0]).toEqual({ id: 't0', chatId: null, canvasId: 'cv1', mediaRef: null })
  })
})

describe('removedCanvasIds', () => {
  it('reports canvases removed by chat/media overwrite and layout shrink', () => {
    let before = applySetPaneCanvas(
      state({ layout: 'vertical-2', panes: panesOf([null, null]) }),
      0,
      'cv-chat'
    )
    let after = applySetPaneChat(before, 0, 'chat-x')
    expect(removedCanvasIds(before.panes, after.panes)).toEqual(['cv-chat'])

    before = applySetPaneCanvas(state({ layout: 'vertical-2', panes: panesOf([null, null]) }), 0, 'cv-media')
    after = applySetPaneMedia(before, 0, mediaRef())
    expect(removedCanvasIds(before.panes, after.panes)).toEqual(['cv-media'])

    before = state({
      layout: 'quad',
      panes: [
        { id: 't0', chatId: 'a' },
        { id: 't1', chatId: null, canvasId: 'cv-keep' },
        { id: 't2', chatId: null, canvasId: 'cv-drop' },
        { id: 't3', chatId: null }
      ]
    })
    after = applySetLayout(before, 'vertical-2')
    expect(removedCanvasIds(before.panes, after.panes)).toEqual(['cv-drop'])
  })

  it('ignores canvases that remain live and dedupes duplicate ids defensively', () => {
    const before: MultiviewPaneRecord[] = [
      { id: 'a', chatId: null, canvasId: 'cv1' },
      { id: 'b', chatId: null, canvasId: 'cv1' },
      { id: 'c', chatId: null, canvasId: 'cv2' }
    ]
    const after: MultiviewPaneRecord[] = [{ id: 'z', chatId: null, canvasId: 'cv2' }]
    expect(removedCanvasIds(before, after)).toEqual(['cv1'])
  })
})

describe('applySetPaneMedia', () => {
  const m = mediaRef()

  it('puts a media player in a pane and clears its chat (mutually exclusive)', () => {
    const next = applySetPaneMedia(
      state({ layout: 'vertical-2', panes: panesOf(['a', 'b']) }),
      1,
      m
    )
    expect(next.panes[1]).toEqual({ id: 't1', chatId: null, canvasId: null, mediaRef: m })
    expect(next.panes[0]).toEqual({ id: 't0', chatId: 'a' }) // untouched chat pane keeps old shape
  })

  it('assigning a chat to a media pane clears the media', () => {
    let s = applySetPaneMedia(state({ layout: 'vertical-2', panes: panesOf([null, null]) }), 0, m)
    expect(s.panes[0].mediaRef).toBe(m)
    s = applySetPaneChat(s, 0, 'chat-x')
    expect(s.panes[0]).toEqual({ id: 't0', chatId: 'chat-x', canvasId: null, mediaRef: null })
  })

  it('setting media clears an existing canvas (mutual exclusion both ways)', () => {
    let s = applySetPaneCanvas(state({ layout: 'vertical-2', panes: panesOf([null, null]) }), 0, 'cv1')
    expect(s.panes[0].canvasId).toBe('cv1')
    s = applySetPaneMedia(s, 0, m)
    expect(s.panes[0]).toEqual({ id: 't0', chatId: null, canvasId: null, mediaRef: m })
  })

  it('clearing media restores an empty (chat-null) pane and is a no-op when already media-less', () => {
    let s = applySetPaneMedia(state({ layout: 'vertical-2', panes: panesOf([null, null]) }), 1, m)
    s = applySetPaneMedia(s, 1, null)
    // Mirrors applySetPaneCanvas: clearing leaves the now-null sibling keys the SET
    // branch introduced (canvasId:null). The pane is empty (no chat, no media).
    expect(s.panes[1].chatId).toBeNull()
    expect(s.panes[1].mediaRef).toBeNull()
    expect(s.panes[1].canvasId ?? null).toBeNull()
    const plain = state({ panes: panesOf(['a']) })
    expect(applySetPaneMedia(plain, 0, null)).toBe(plain) // already media-less
  })

  it('ignores out-of-range indices', () => {
    const s = state({ panes: panesOf(['a']) })
    expect(applySetPaneMedia(s, 9, m)).toBe(s)
  })
})

describe('applyOpenMediaInNewPane', () => {
  const m = mediaRef()

  it('grows single -> vertical-2, places the media, and KEEPS focus on the transcript', () => {
    const next = applyOpenMediaInNewPane(
      state({ layout: 'single', panes: panesOf(['a']), focusedPaneIndex: 0 }),
      m
    )
    expect(next.layout).toBe('vertical-2')
    expect(next.focusedPaneIndex).toBe(0) // focus stays on the transcript pane
    expect(next.panes[0]).toEqual({ id: 't0', chatId: 'a' }) // transcript untouched
    expect(next.panes[1].mediaRef).toBe(m)
    expect(next.panes[1].chatId).toBeNull()
    expect(next.panes[1].id).toBe('pane-100') // the new pane gets a fresh id
  })

  it('uses an existing non-focused empty cell without growing', () => {
    const next = applyOpenMediaInNewPane(
      state({ layout: 'vertical-2', panes: panesOf(['a', null]), focusedPaneIndex: 0 }),
      m
    )
    expect(next.layout).toBe('vertical-2')
    expect(next.panes[1].mediaRef).toBe(m)
    expect(next.panes[1].id).toBe('t1') // reused the existing empty pane
  })

  it('never targets the focused pane and never moves focus', () => {
    const next = applyOpenMediaInNewPane(
      state({ layout: 'vertical-2', panes: panesOf([null, null]), focusedPaneIndex: 0 }),
      m
    )
    expect(next.panes[0].mediaRef).toBeFalsy() // focused pane left empty
    expect(next.panes[1].mediaRef).toBe(m)
    expect(next.focusedPaneIndex).toBe(0)
  })

  it('does not clobber an already-detached media pane while a spare exists (grows)', () => {
    // pane 1 already hosts media; the only other non-focused cell is also taken,
    // so there is no empty spare → it grows rather than overwriting pane 1.
    const existing = mediaRef('existing')
    const next = applyOpenMediaInNewPane(
      state({
        layout: 'two-top-one-bottom',
        panes: [
          { id: 't0', chatId: 'a' },
          { id: 't1', chatId: null, mediaRef: existing },
          { id: 't2', chatId: 'c' }
        ],
        focusedPaneIndex: 0
      }),
      m
    )
    expect(next.layout).toBe('quad') // grew (no empty non-focused spare)
    expect(next.panes[1].mediaRef).toBe(existing) // untouched
    expect(next.panes[3].mediaRef).toBe(m) // landed in the fresh cell
  })
})

describe('applySetFocusedPane', () => {
  it('clamps into the layout range', () => {
    const s = state({ layout: 'quad', panes: panesOf(['a', 'b', 'c', 'd']) })
    expect(applySetFocusedPane(s, 9).focusedPaneIndex).toBe(3)
    expect(applySetFocusedPane(s, -1).focusedPaneIndex).toBe(0)
  })

  it('returns the same reference when focus is unchanged', () => {
    const s = state({ layout: 'vertical-2', panes: panesOf(['a', 'b']), focusedPaneIndex: 1 })
    expect(applySetFocusedPane(s, 1)).toBe(s)
  })

  it('does not replace the panes array or mint ids on focus change', () => {
    // Identity-stability matters: App memoizes the derived paneChatIds on
    // `state.panes`, and an effect depends on it — a focus change must not churn.
    const s = state({ layout: 'vertical-2', panes: panesOf(['a', 'b']), focusedPaneIndex: 0 })
    const next = applySetFocusedPane(s, 1)
    expect(next.panes).toBe(s.panes)
    expect(next.nextPaneSeq).toBe(s.nextPaneSeq)
  })
})

describe('applyFocusPane', () => {
  it('pins the outgoing visible chat before focusing another pane (ids unchanged)', () => {
    const next = applyFocusPane(
      state({ layout: 'vertical-2', panes: panesOf(['stale', 'b']), focusedPaneIndex: 0 }),
      1,
      'current'
    )
    expect(chatIds(next)).toEqual(['current', 'b'])
    expect(next.focusedPaneIndex).toBe(1)
    expect(ids(next)).toEqual(['t0', 't1'])
  })

  it('honors the clicked pane when seeded panes still show the same chat', () => {
    const seeded = state({
      layout: 'two-top-one-bottom',
      panes: panesOf(['a', 'a', 'a']),
      focusedPaneIndex: 0
    })
    const next = applyFocusPane(seeded, 2, 'a')

    expect(chatIds(next)).toEqual(['a', 'a', 'a'])
    expect(next.focusedPaneIndex).toBe(2)
    expect(ids(next)).toEqual(['t0', 't1', 't2'])
  })

  it('keeps distinct pane ownership stable through repeated focus churn', () => {
    let next = state({
      layout: 'vertical-2',
      panes: panesOf(['a', 'b']),
      focusedPaneIndex: 0
    })
    for (let index = 0; index < 20; index += 1) {
      const target = index % 2 === 0 ? 1 : 0
      const outgoing = target === 1 ? 'a' : 'b'
      next = applyFocusPane(next, target, outgoing)
      expect(chatIds(next)).toEqual(['a', 'b'])
      expect(new Set(chatIds(next)).size).toBe(2)
      expect(next.focusedPaneIndex).toBe(target)
      expect(ids(next)).toEqual(['t0', 't1'])
    }
  })
})

describe('applyClosePane', () => {
  it('is a no-op in single layout', () => {
    const s = state({ panes: panesOf(['a']) })
    expect(applyClosePane(s, 0)).toBe(s)
  })

  it('drops a cell, compacts, and downgrades one step — survivors keep ids', () => {
    const next = applyClosePane(
      state({ layout: 'quad', panes: panesOf(['a', 'b', 'c', 'd']), focusedPaneIndex: 0 }),
      1
    )
    expect(next.layout).toBe('two-top-one-bottom')
    expect(chatIds(next)).toEqual(['a', 'c', 'd'])
    expect(ids(next)).toEqual(['t0', 't2', 't3']) // t1 gone; the rest keep their ids
    expect(next.focusedPaneIndex).toBe(0)
  })

  it('shifts focus left when closing a cell before the focused one', () => {
    const next = applyClosePane(
      state({ layout: 'quad', panes: panesOf(['a', 'b', 'c', 'd']), focusedPaneIndex: 2 }),
      1
    )
    // c was focused at index 2; after removing b it sits at index 1.
    expect(chatIds(next)).toEqual(['a', 'c', 'd'])
    expect(next.focusedPaneIndex).toBe(1)
  })

  it('keeps focus on the next cell when closing the focused one', () => {
    const next = applyClosePane(
      state({ layout: 'vertical-2', panes: panesOf(['a', 'b']), focusedPaneIndex: 0 }),
      0
    )
    expect(next.layout).toBe('single')
    expect(chatIds(next)).toEqual(['b'])
    expect(ids(next)).toEqual(['t1']) // the surviving pane keeps its original id
    expect(next.focusedPaneIndex).toBe(0)
  })

  it('prunes the closed pane settings; survivor settings stay attached to the right pane', () => {
    // The index-fragility bug class this migration fixes: FX set on pane t2 must
    // still apply to t2 (now at index 1) after closing t1 — NOT to whatever chat
    // shifted up into index 1.
    let s = state({ layout: 'quad', panes: panesOf(['a', 'b', 'c', 'd']), focusedPaneIndex: 0 })
    s = applySetPaneFxFlag(s, 't1', 'sky', false) // the pane we will close
    s = applySetPaneFxFlag(s, 't2', 'ghost', false) // a survivor
    const next = applyClosePane(s, 1)
    expect(next.paneSettings.t1).toBeUndefined() // pruned with the closed pane
    expect(next.paneSettings.t2?.fx).toEqual({ ghost: false }) // survives, still keyed to t2
    expect(next.panes[1]).toEqual({ id: 't2', chatId: 'c' }) // t2 now sits at index 1
  })
})

describe('applyAssignToNextPane', () => {
  it('focuses a chat already visible in another pane without duplicating it', () => {
    const result = applyAssignToNextPane(
      state({ layout: 'vertical-2', panes: panesOf(['test-3', 'test-2']), focusedPaneIndex: 1 }),
      'test-3'
    )
    expect(result.index).toBe(0)
    expect(chatIds(result.state)).toEqual(['test-3', 'test-2'])
    expect(result.state.focusedPaneIndex).toBe(0)
  })

  it('fills the focused pane when it is empty (id preserved)', () => {
    const result = applyAssignToNextPane(
      state({ layout: 'vertical-2', panes: panesOf(['a', null]), focusedPaneIndex: 1 }),
      'b'
    )
    expect(result.index).toBe(1)
    expect(chatIds(result.state)).toEqual(['a', 'b'])
    expect(result.state.focusedPaneIndex).toBe(1)
    expect(result.state.panes[1].id).toBe('t1')
  })

  it('falls to the first empty cell when the focused pane is occupied', () => {
    const result = applyAssignToNextPane(
      state({ layout: 'quad', panes: panesOf(['a', null, null, null]), focusedPaneIndex: 0 }),
      'b'
    )
    expect(result.index).toBe(1)
    expect(chatIds(result.state)).toEqual(['a', 'b', null, null])
  })

  it('overwrites the focused pane when every cell is occupied', () => {
    const result = applyAssignToNextPane(
      state({ layout: 'vertical-2', panes: panesOf(['a', 'b']), focusedPaneIndex: 0 }),
      'z'
    )
    expect(result.index).toBe(0)
    expect(chatIds(result.state)).toEqual(['z', 'b'])
  })

  it('overwrites pane 0 in single layout (callers widen the layout first)', () => {
    const result = applyAssignToNextPane(state({ panes: panesOf(['a']) }), 'z')
    expect(result.index).toBe(0)
    expect(chatIds(result.state)).toEqual(['z'])
  })
})

describe('applyOpenInNewPane', () => {
  it('grows single -> vertical-2 and fills the spare pane, keeping focus', () => {
    const next = applyOpenInNewPane(
      state({ layout: 'single', panes: panesOf(['a']), focusedPaneIndex: 0 }),
      'b',
      'current'
    )
    expect(next.layout).toBe('vertical-2')
    expect(chatIds(next)).toEqual(['current', 'b'])
    expect(next.focusedPaneIndex).toBe(0)
    expect(next.panes[0].id).toBe('t0') // focused pane keeps its id
    expect(next.panes[1].id).toBe('pane-100') // the new pane gets a fresh id
  })

  it('uses an existing non-focused empty cell without growing', () => {
    const next = applyOpenInNewPane(
      state({ layout: 'vertical-2', panes: panesOf(['a', null]), focusedPaneIndex: 0 }),
      'b'
    )
    expect(next.layout).toBe('vertical-2')
    expect(chatIds(next)).toEqual(['a', 'b'])
    expect(next.panes[1].id).toBe('t1') // filled the existing empty pane (id reused)
  })

  it('never fills the focused pane even when it is empty', () => {
    const next = applyOpenInNewPane(
      state({ layout: 'vertical-2', panes: panesOf([null, null]), focusedPaneIndex: 0 }),
      'b'
    )
    expect(chatIds(next)).toEqual([null, 'b'])
    expect(next.focusedPaneIndex).toBe(0)
  })

  it('grows when the only empty cell is the focused one', () => {
    const next = applyOpenInNewPane(
      state({ layout: 'vertical-2', panes: panesOf(['a', null]), focusedPaneIndex: 1 }),
      'b'
    )
    expect(next.layout).toBe('two-top-one-bottom')
    expect(chatIds(next)).toEqual(['a', null, 'b'])
    expect(next.focusedPaneIndex).toBe(1)
  })

  it('overwrites a non-focused cell when already at quad', () => {
    const next = applyOpenInNewPane(
      state({ layout: 'quad', panes: panesOf(['a', 'b', 'c', 'd']), focusedPaneIndex: 0 }),
      'z'
    )
    expect(next.layout).toBe('quad')
    expect(chatIds(next)).toEqual(['a', 'z', 'c', 'd'])
    expect(next.focusedPaneIndex).toBe(0)
  })
})

describe('applySetPaneFxFlag', () => {
  it('sets an explicit flag on a pane by stable id', () => {
    const s = state({ layout: 'vertical-2', panes: panesOf(['a', 'b']) })
    const next = applySetPaneFxFlag(s, 't1', 'sky', false)
    expect(next.paneSettings.t1?.fx).toEqual({ sky: false })
    expect(next.paneSettings.t0).toBeUndefined() // untouched panes follow the global flag
  })

  it('merges a second flag without dropping the first', () => {
    let s = state({ layout: 'vertical-2', panes: panesOf(['a', 'b']) })
    s = applySetPaneFxFlag(s, 't0', 'sky', false)
    s = applySetPaneFxFlag(s, 't0', 'ghost', true)
    expect(s.paneSettings.t0?.fx).toEqual({ sky: false, ghost: true })
  })

  it('returns the same reference when the value is unchanged', () => {
    const s = applySetPaneFxFlag(state({ panes: panesOf(['a']) }), 't0', 'sky', true)
    expect(applySetPaneFxFlag(s, 't0', 'sky', true)).toBe(s)
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
    const tracks = getLayoutTracks(
      { 'vertical-2': { columns: [1, 1, 1], rows: [1] } },
      'vertical-2'
    )
    expect(tracks.columns).toEqual([1, 1])
  })
})

describe('applyResizeTrack', () => {
  it('moves a px delta between the two adjacent column tracks', () => {
    // vertical-2: columns [1,1], total fraction 2, axisTotalPx 1000 -> pairPx 1000.
    // +100px to track0 -> 600px / 400px -> fractions 1.2 / 0.8.
    const next = applyResizeTrack(state({ layout: 'vertical-2', panes: panesOf(['a', 'b']) }), {
      orientation: 'column',
      trackIndex: 0,
      deltaPx: 100,
      axisTotalPx: 1000
    })
    expect(next.trackSizes['vertical-2']?.columns).toEqual([1.2, 0.8])
    // Combined fraction of the adjacent pair is conserved.
    expect(
      next.trackSizes['vertical-2']!.columns[0] + next.trackSizes['vertical-2']!.columns[1]
    ).toBe(2)
  })

  it('clamps so neither adjacent pane drops below the 240px minimum', () => {
    // A huge delta would shrink track1 below 240px; clamp track0 at 1000-240=760.
    const next = applyResizeTrack(state({ layout: 'vertical-2', panes: panesOf(['a', 'b']) }), {
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
    const next = applyResizeTrack(state({ layout: 'vertical-2', panes: panesOf(['a', 'b']) }), {
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
    const next = applyResizeTrack(state({ layout: 'quad', panes: panesOf(['a', 'b', 'c', 'd']) }), {
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
    const s = state({ layout: 'vertical-2', panes: panesOf(['a', 'b']) })
    const next = applyResizeTrack(s, {
      orientation: 'column',
      trackIndex: 0,
      deltaPx: 50,
      axisTotalPx: 400
    })
    expect(next).toBe(s)
  })

  it('is a no-op for a zero / non-finite delta or non-positive axis', () => {
    const s = state({ layout: 'quad', panes: panesOf(['a', 'b', 'c', 'd']) })
    expect(
      applyResizeTrack(s, { orientation: 'column', trackIndex: 0, deltaPx: 0, axisTotalPx: 1000 })
    ).toBe(s)
    expect(
      applyResizeTrack(s, { orientation: 'column', trackIndex: 0, deltaPx: 10, axisTotalPx: 0 })
    ).toBe(s)
  })

  it('ignores an out-of-range track index', () => {
    const s = state({ layout: 'vertical-2', panes: panesOf(['a', 'b']) })
    // vertical-2 has a single internal column boundary (trackIndex 0); 1 is out.
    expect(
      applyResizeTrack(s, { orientation: 'column', trackIndex: 1, deltaPx: 50, axisTotalPx: 1000 })
    ).toBe(s)
  })

  it('resizing one layout does not affect another layout’s fractions', () => {
    const resized = applyResizeTrack(state({ layout: 'vertical-2', panes: panesOf(['a', 'b']) }), {
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
    const resized = applyResizeTrack(state({ layout: 'vertical-2', panes: panesOf(['a', 'b']) }), {
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
    const resized = applyResizeTrack(state({ layout: 'vertical-2', panes: panesOf(['a', 'b']) }), {
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
    const resized = applyResizeTrack(
      state({ layout: 'quad', panes: panesOf(['a', 'b', 'c', 'd']) }),
      {
        orientation: 'row',
        trackIndex: 0,
        deltaPx: 120,
        axisTotalPx: 800
      }
    )
    const reset = applyResetTrackSizes(resized)
    expect(reset.trackSizes.quad).toBeUndefined()
  })

  it('only resets the targeted layout, leaving others intact', () => {
    let s = applyResizeTrack(state({ layout: 'vertical-2', panes: panesOf(['a', 'b']) }), {
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
    const s = state({ layout: 'vertical-2', panes: panesOf(['a', 'b']) })
    expect(applyResetTrackSizes(s, 'vertical-2')).toBe(s)
  })
})

describe('normalizeMultiviewCoreState (backward-compat / hydration bridge)', () => {
  it('falls back to the default single-pane state for a non-object', () => {
    expect(normalizeMultiviewCoreState(null)).toEqual(createInitialMultiviewState())
    expect(normalizeMultiviewCoreState('nope')).toEqual(createInitialMultiviewState())
    expect(normalizeMultiviewCoreState(undefined)).toEqual(createInitialMultiviewState())
  })

  it('upgrades a legacy index-keyed { paneChatIds } blob to stable records', () => {
    const next = normalizeMultiviewCoreState({
      layout: 'quad',
      paneChatIds: ['a', 'b', 'c', 'd'],
      focusedPaneIndex: 2
    })
    expect(next.layout).toBe('quad')
    expect(chatIds(next)).toEqual(['a', 'b', 'c', 'd'])
    expect(next.focusedPaneIndex).toBe(2)
    expect(ids(next)).toEqual(['pane-1', 'pane-2', 'pane-3', 'pane-4'])
    expect(next.nextPaneSeq).toBe(5)
    expect(next.paneSettings).toEqual({})
  })

  it('clamps a legacy blob to the layout pane count (truncate or pad)', () => {
    const truncated = normalizeMultiviewCoreState({
      layout: 'vertical-2',
      paneChatIds: ['a', 'b', 'c', 'd']
    })
    expect(chatIds(truncated)).toEqual(['a', 'b'])
    const padded = normalizeMultiviewCoreState({ layout: 'quad', paneChatIds: ['a'] })
    expect(chatIds(padded)).toEqual(['a', null, null, null])
  })

  it('coerces an invalid layout and focus to safe defaults', () => {
    const next = normalizeMultiviewCoreState({
      layout: 'bogus',
      paneChatIds: ['a'],
      focusedPaneIndex: 9
    })
    expect(next.layout).toBe('single')
    expect(next.focusedPaneIndex).toBe(0)
  })

  it('round-trips the new shape, preserving pane ids and settings', () => {
    const original = applySetPaneFxFlag(
      applySetLayout(createInitialMultiviewState('a'), 'vertical-2', { seedChatId: 'a' }),
      'pane-1',
      'sky',
      false
    )
    const next = normalizeMultiviewCoreState(original)
    expect(ids(next)).toEqual(ids(original))
    expect(chatIds(next)).toEqual(chatIds(original))
    expect(next.paneSettings).toEqual(original.paneSettings)
  })

  it('drops settings for absent panes and advances seq past existing ids', () => {
    const next = normalizeMultiviewCoreState({
      layout: 'vertical-2',
      panes: [
        { id: 'pane-5', chatId: 'a' },
        { id: 'pane-9', chatId: 'b' }
      ],
      paneSettings: { 'pane-5': { fx: { sky: false } }, 'pane-99': { fx: { ghost: true } } }
    })
    expect(ids(next)).toEqual(['pane-5', 'pane-9'])
    expect(next.paneSettings).toEqual({ 'pane-5': { fx: { sky: false } } }) // pane-99 pruned
    expect(next.nextPaneSeq).toBe(10) // highest existing seq (9) + 1
  })

  it('mints an id for a pane record missing one', () => {
    const next = normalizeMultiviewCoreState({
      layout: 'vertical-2',
      panes: [{ chatId: 'a' }, { id: 'pane-2', chatId: 'b' }]
    })
    expect(chatIds(next)).toEqual(['a', 'b'])
    expect(next.panes[0].id).toBe('pane-1') // minted
    expect(next.panes[1].id).toBe('pane-2')
  })

  it('carries a detached mediaRef through normalization', () => {
    const m = mediaRef()
    const next = normalizeMultiviewCoreState({
      layout: 'vertical-2',
      panes: [
        { id: 'pane-1', chatId: null, mediaRef: m },
        { id: 'pane-2', chatId: 'b' }
      ]
    })
    expect(next.panes[0]).toEqual({ id: 'pane-1', chatId: null, mediaRef: m })
    expect(next.panes[1]).toEqual({ id: 'pane-2', chatId: 'b' }) // no mediaRef key
  })
})
