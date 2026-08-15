import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import { projectRows } from './TranscriptVirtualWindow'
import {
  GUTTER_LENS_BLEED_PX,
  GUTTER_LENS_MIN_HEIGHT_PX,
  GUTTER_MIN_HEIGHT_PX,
  GUTTER_VERTICAL_OFFSET_PX,
  buildTranscriptUserGutterMarkers,
  findActiveGutterMarkerKey,
  gutterBulgeRadiusPx,
  hiddenRoundMarkerRowKey,
  isHiddenRoundMarkerRowKey,
  layoutGutterLens,
  layoutGutterVerticalFrame,
  layoutTranscriptUserGutterMarkers,
  shouldAcceptGutterLiveSpy,
  structuralGutterSpyPropsChanged,
  userGutterPreview,
  userGutterTitle
} from './TranscriptUserMessageGutter'

function message(id: string, role: ChatMessage['role'], content: string): ChatMessage {
  return {
    id,
    role,
    content,
    timestamp: '2026-01-01T00:00:00.000Z'
  }
}

describe('TranscriptUserMessageGutter model', () => {
  it('builds markers only for user rows and keeps duplicate ids row-key addressable', () => {
    const messages = [
      message('same', 'user', 'First prompt'),
      message('assistant-1', 'assistant', 'Assistant answer'),
      message('same', 'user', 'Second prompt')
    ]
    const rows = projectRows(messages)

    const markers = buildTranscriptUserGutterMarkers(messages, rows)

    expect(markers).toHaveLength(2)
    expect(markers[0]).toMatchObject({
      messageId: 'same',
      rowKey: 'same#0',
      ordinal: 1,
      title: 'First prompt'
    })
    expect(markers[1]).toMatchObject({
      messageId: 'same',
      rowKey: 'same#2',
      ordinal: 2,
      title: 'Second prompt'
    })
    expect(markers[1].topPercent).toBeGreaterThan(markers[0].topPercent)
  })

  it('uses measured row heights when supplied', () => {
    const messages = [
      message('first', 'user', 'First prompt'),
      message('long-assistant', 'assistant', 'Assistant answer'),
      message('second', 'user', 'Second prompt')
    ]
    const rows = projectRows(messages)

    const estimatedMarkers = buildTranscriptUserGutterMarkers(messages, rows)
    const measuredMarkers = buildTranscriptUserGutterMarkers(messages, rows, [40, 800, 40])

    expect(measuredMarkers[0].topPercent).toBeLessThan(estimatedMarkers[0].topPercent)
    expect(measuredMarkers[0].topPercent).toBeCloseTo((20 / 880) * 100, 5)
    expect(measuredMarkers[1].topPercent).toBeGreaterThan(estimatedMarkers[1].topPercent)
    expect(measuredMarkers[1].topPercent).toBeCloseTo((860 / 880) * 100, 5)
  })

  it('creates compact titles and previews for blank and long prompts', () => {
    expect(userGutterTitle('')).toBe('User message')
    expect(userGutterPreview('')).toBe('')

    const longPrompt = [
      'Please review the release checklist and focus on the risky edge cases.',
      'One',
      'Two',
      'Three',
      'Four',
      'Five'
    ].join('\n')

    expect(userGutterTitle(longPrompt)).toBe(
      'Please review the release checklist and focus on the risky edge cases.'
    )
    expect(userGutterPreview(longPrompt).split('\n')).toHaveLength(4)
  })

  it('compacts dense marker stacks without changing their order', () => {
    const messages = Array.from({ length: 24 }, (_, index) =>
      message(`user-${index}`, 'user', `Prompt ${index}`)
    )
    const markers = buildTranscriptUserGutterMarkers(messages, projectRows(messages))

    const layout = layoutTranscriptUserGutterMarkers(markers, 900)
    const tops = layout.map((marker) => marker.topPx)
    const span = Math.max(...tops) - Math.min(...tops)

    expect(layout.map((marker) => marker.key)).toEqual(markers.map((marker) => marker.key))
    expect(span).toBeLessThanOrEqual(23 * 8)
    expect(Math.max(...tops)).toBeCloseTo(892, 1)
    for (let index = 1; index < tops.length; index += 1) {
      expect(tops[index]).toBeGreaterThan(tops[index - 1])
    }
  })

  it('bottom-aligns sparse marker stacks beside the composer gutter', () => {
    const messages = [
      message('first', 'user', 'First prompt'),
      message('assistant-1', 'assistant', 'Assistant answer'),
      message('second', 'user', 'Second prompt')
    ]
    const markers = buildTranscriptUserGutterMarkers(messages, projectRows(messages))

    const layout = layoutTranscriptUserGutterMarkers(markers, 900)

    expect(layout[1].topPx).toBeCloseTo(892, 1)
    expect(layout[1].topPx - layout[0].topPx).toBeCloseTo(10, 1)
  })

  it('carries each marker rowIndex in the virtual-row index space', () => {
    const messages = [
      message('u0', 'user', 'First prompt'),
      message('a1', 'assistant', 'Answer'),
      message('u2', 'user', 'Second prompt')
    ]
    const markers = buildTranscriptUserGutterMarkers(messages, projectRows(messages))

    expect(markers.map((marker) => marker.rowIndex)).toEqual([0, 2])
  })

  it('keeps rowIndex POSITIONAL (findScrollAnchor space) when projectRows skips a malformed row', () => {
    // A message with a non-string id is dropped by projectRows, so the emitted
    // rows array is shorter than `messages` and row.index (source position) no
    // longer equals the row's array position. marker.rowIndex must track the
    // ARRAY position (what findScrollAnchor returns), not row.index.
    const messages = [
      message('u0', 'user', 'Turn zero'),
      { ...message('bad', 'assistant', 'malformed'), id: undefined as unknown as string },
      message('u1', 'user', 'Turn one')
    ]
    const rows = projectRows(messages)
    expect(rows).toHaveLength(2)

    const markers = buildTranscriptUserGutterMarkers(messages, rows)
    // Positional: 0 and 1 — NOT 0 and 2 (the source-message positions).
    expect(markers.map((marker) => marker.rowIndex)).toEqual([0, 1])
    expect(markers[1].messageId).toBe('u1')
    // The scroll-spy join resolves the 2nd marker at positional anchor 1.
    expect(findActiveGutterMarkerKey(markers, 1)).toBe(markers[1].key)
  })
})

describe('collapsed ensemble-round markers', () => {
  const headerMessage: ChatMessage = {
    id: 'ensemble-round-header-r1',
    role: 'system',
    content: '',
    timestamp: '2026-01-01T00:00:00.000Z',
    metadata: { kind: 'ensembleRoundHeader', ensembleRoundId: 'r1' }
  }
  // Display list AFTER round collapse: the header row stands in for the
  // round's body (its user prompt included), then the thread continues flat.
  const displayMessages = [
    message('u0', 'user', 'Before the round'),
    headerMessage,
    message('a-after', 'assistant', 'After the round'),
    message('u9', 'user', 'After the round prompt')
  ]
  const hiddenPrompt = message('u-hidden', 'user', 'Prompt inside the collapsed round')
  const collapsed = new Map([[headerMessage.id, [hiddenPrompt]]])

  it('emits markers for user messages hidden inside a collapsed round, anchored at the header row', () => {
    const rows = projectRows(displayMessages)
    const markers = buildTranscriptUserGutterMarkers(displayMessages, rows, undefined, collapsed)

    expect(markers.map((marker) => marker.messageId)).toEqual(['u0', 'u-hidden', 'u9'])
    const hiddenMarker = markers[1]
    // Anchored at the header row's POSITIONAL index (scroll-spy join space).
    expect(hiddenMarker.rowIndex).toBe(1)
    expect(hiddenMarker.ordinal).toBe(2)
    expect(hiddenMarker.title).toBe('Prompt inside the collapsed round')
    expect(hiddenMarker.message).toBe(hiddenPrompt)
    // Ordered between its flat neighbours on the rail.
    expect(hiddenMarker.topPercent).toBeGreaterThan(markers[0].topPercent)
    expect(hiddenMarker.topPercent).toBeLessThan(markers[2].topPercent)
  })

  it('keeps the last hidden prompt active when multiple markers share a collapsed header row', () => {
    const rows = projectRows(displayMessages)
    const secondHiddenPrompt = message('u-hidden-2', 'user', 'Second prompt inside the collapsed round')
    const markers = buildTranscriptUserGutterMarkers(
      displayMessages,
      rows,
      undefined,
      new Map([[headerMessage.id, [hiddenPrompt, secondHiddenPrompt]]])
    )

    expect(markers.map((marker) => marker.messageId)).toEqual([
      'u0',
      'u-hidden',
      'u-hidden-2',
      'u9'
    ])
    expect(markers[1].rowIndex).toBe(1)
    expect(markers[2].rowIndex).toBe(1)
    expect(findActiveGutterMarkerKey(markers, 1)).toBe(markers[2].key)
  })

  it('gives hidden markers a rowKey that can never match a projected row (forces id-based jump)', () => {
    const rows = projectRows(displayMessages)
    const markers = buildTranscriptUserGutterMarkers(displayMessages, rows, undefined, collapsed)
    const hiddenMarker = markers[1]

    expect(rows.some((row) => row.rowKey === hiddenMarker.rowKey)).toBe(false)
    expect(hiddenMarker.rowKey).toContain('~')
    // Keys stay unique across the whole rail.
    expect(new Set(markers.map((marker) => marker.key)).size).toBe(markers.length)
  })

  it('detects minted hidden rowKeys and never a real projected rowKey', () => {
    const minted = hiddenRoundMarkerRowKey('ensemble-round-header-r1#1', 'u-hidden')
    expect(isHiddenRoundMarkerRowKey(minted)).toBe(true)
    // Every rowKey the projector emits must classify as real — the jump path
    // strips ONLY minted keys, so a false positive here would break normal
    // duplicate-id row targeting.
    for (const row of projectRows(displayMessages)) {
      expect(isHiddenRoundMarkerRowKey(row.rowKey)).toBe(false)
    }
    // Ids containing troublesome characters still classify as real.
    expect(isHiddenRoundMarkerRowKey('msg~with~tildes#4')).toBe(false)
    expect(isHiddenRoundMarkerRowKey(undefined)).toBe(false)
    // Round-trip through the builder: the markers it mints classify as
    // hidden, its flat markers as real.
    const markers = buildTranscriptUserGutterMarkers(
      displayMessages,
      projectRows(displayMessages),
      undefined,
      collapsed
    )
    expect(markers.map((marker) => isHiddenRoundMarkerRowKey(marker.rowKey))).toEqual([
      false,
      true,
      false
    ])
  })

  it('emits no extra markers when the map is absent or empty', () => {
    const rows = projectRows(displayMessages)
    expect(buildTranscriptUserGutterMarkers(displayMessages, rows)).toHaveLength(2)
    expect(
      buildTranscriptUserGutterMarkers(displayMessages, rows, undefined, new Map())
    ).toHaveLength(2)
  })
})

describe('findActiveGutterMarkerKey (scroll-spy join)', () => {
  const messages = [
    message('u0', 'user', 'Turn zero'),
    message('a1', 'assistant', 'Answer one'),
    message('u2', 'user', 'Turn two'),
    message('a3', 'assistant', 'Answer three'),
    message('u4', 'user', 'Turn four')
  ]
  const markers = buildTranscriptUserGutterMarkers(messages, projectRows(messages))

  it('maps an anchor row to the nearest user marker at or above it', () => {
    expect(findActiveGutterMarkerKey(markers, 0)).toBe('u0#0')
    // Anchored on the assistant row between turns 0 and 2 → still inside turn 0.
    expect(findActiveGutterMarkerKey(markers, 1)).toBe('u0#0')
    expect(findActiveGutterMarkerKey(markers, 2)).toBe('u2#2')
    expect(findActiveGutterMarkerKey(markers, 3)).toBe('u2#2')
    expect(findActiveGutterMarkerKey(markers, 4)).toBe('u4#4')
  })

  it('clamps below the first and beyond the last marker', () => {
    expect(findActiveGutterMarkerKey(markers, -1)).toBeNull()
    expect(findActiveGutterMarkerKey(markers, 999)).toBe('u4#4')
  })

  it('is defensive against empty markers and non-finite anchors', () => {
    expect(findActiveGutterMarkerKey([], 3)).toBeNull()
    expect(findActiveGutterMarkerKey(markers, Number.NaN)).toBeNull()
  })
})

describe('layoutGutterLens (reading-lens carriage)', () => {
  // A 300px marker stack (centres 100..400) with bleed applied at both ends.
  const top = 100
  const bottom = 400
  const span = bottom - top + GUTTER_LENS_BLEED_PX * 2

  it('sizes the lens by the visible fraction and rides thumb-style with progress', () => {
    const atStart = layoutGutterLens(top, bottom, 0, 0.25)
    const atEnd = layoutGutterLens(top, bottom, 1, 0.25)
    const midway = layoutGutterLens(top, bottom, 0.5, 0.25)

    expect(atStart).not.toBeNull()
    expect(atStart!.heightPx).toBeCloseTo(span * 0.25, 5)
    // Progress 0 → lens top kisses the (bled) stack top.
    expect(atStart!.topPx).toBeCloseTo(top - GUTTER_LENS_BLEED_PX, 5)
    // Progress 1 → lens bottom kisses the (bled) stack bottom.
    expect(atEnd!.topPx + atEnd!.heightPx).toBeCloseTo(bottom + GUTTER_LENS_BLEED_PX, 5)
    // Monotonic travel in between.
    expect(midway!.topPx).toBeGreaterThan(atStart!.topPx)
    expect(midway!.topPx).toBeLessThan(atEnd!.topPx)
  })

  it('clamps the lens to a grabbable minimum height on huge transcripts', () => {
    const lens = layoutGutterLens(top, bottom, 0.5, 0.001)
    expect(lens!.heightPx).toBe(GUTTER_LENS_MIN_HEIGHT_PX)
  })

  it('hides when everything is visible, unmeasured, or the stack is degenerate', () => {
    // Whole transcript fits (nothing to indicate) / unmeasured 0.
    expect(layoutGutterLens(top, bottom, 0.5, 1)).toBeNull()
    expect(layoutGutterLens(top, bottom, 0.5, 0)).toBeNull()
    // Degenerate stack (single-point span) can't host a carriage.
    expect(layoutGutterLens(100, 100, 0.5, 0.25)).toBeNull()
    // Non-finite inputs never throw or emit NaN geometry.
    expect(layoutGutterLens(Number.NaN, bottom, 0.5, 0.25)).toBeNull()
    expect(layoutGutterLens(top, bottom, Number.POSITIVE_INFINITY, 0.25)).toBeNull()
  })

  it('clamps out-of-range progress instead of overshooting the stack', () => {
    const below = layoutGutterLens(top, bottom, -3, 0.25)
    const above = layoutGutterLens(top, bottom, 42, 0.25)
    expect(below!.topPx).toBeCloseTo(top - GUTTER_LENS_BLEED_PX, 5)
    expect(above!.topPx + above!.heightPx).toBeCloseTo(bottom + GUTTER_LENS_BLEED_PX, 5)
  })
})

describe('layoutGutterVerticalFrame (rail band vs the workspace terminal)', () => {
  // A tall pane: 12% top inset clamps to 96, 8% bottom inset to 64.
  const scrollerTop = 100
  const scrollerHeight = 800
  const scrollerBottom = scrollerTop + scrollerHeight

  it('keeps the resting band when nothing occludes the pane floor', () => {
    const frame = layoutGutterVerticalFrame(scrollerTop, scrollerHeight, scrollerBottom)
    expect(frame.top).toBe(scrollerTop + 96 + GUTTER_VERTICAL_OFFSET_PX)
    expect(frame.bottom).toBe(scrollerBottom - 64 + GUTTER_VERTICAL_OFFSET_PX)
    expect(frame.height).toBe(scrollerHeight - 96 - 64)
  })

  it('budges the band up off an open terminal instead of painting over it', () => {
    // 260px terminal + 16px bottom gap + 10px rail clearance.
    const clearBottom = scrollerBottom - 286
    const resting = layoutGutterVerticalFrame(scrollerTop, scrollerHeight, scrollerBottom)
    const lifted = layoutGutterVerticalFrame(scrollerTop, scrollerHeight, clearBottom)

    expect(lifted.bottom).toBe(clearBottom)
    expect(lifted.bottom).toBeLessThan(resting.bottom)
    // Shrinks from the bottom — the top stays on the transcript's reading line.
    expect(lifted.top).toBe(resting.top)
    expect(lifted.height).toBe(clearBottom - resting.top)
    expect(lifted.top + lifted.height).toBe(lifted.bottom)
  })

  it('never stretches the band DOWN to a clear bottom below the pane floor', () => {
    const frame = layoutGutterVerticalFrame(scrollerTop, scrollerHeight, scrollerBottom + 400)
    expect(frame.bottom).toBe(scrollerBottom - 64 + GUTTER_VERTICAL_OFFSET_PX)
  })

  it('honours the minimum band height when the clear band collapses', () => {
    // Pane so short the terminal leaves under 120px of travel: the floor wins
    // (the rail has no usable travel below it either way).
    const frame = layoutGutterVerticalFrame(0, 460, 460 - 286)
    expect(frame.height).toBe(GUTTER_MIN_HEIGHT_PX)
    expect(frame.bottom).toBe(frame.top + GUTTER_MIN_HEIGHT_PX)
  })

  it('falls back to the resting bottom on an unmeasured clear bottom', () => {
    const resting = layoutGutterVerticalFrame(scrollerTop, scrollerHeight, scrollerBottom)
    expect(layoutGutterVerticalFrame(scrollerTop, scrollerHeight, Number.NaN)).toEqual(resting)
  })
})

describe('cut 1b gutter liveSpy merge', () => {
  it('invalidates the liveSpy latch when structural spy props change (streaming growth)', () => {
    // Panel recomputes progress from a taller live total while the user is
    // scrolled up; the RAF sink may not fire, so props must win.
    expect(
      structuralGutterSpyPropsChanged(
        { scrollProgress: 0.4, scrollViewportFraction: 0.2, activeScrollRowKey: 'u#0' },
        { scrollProgress: 0.35, scrollViewportFraction: 0.18, activeScrollRowKey: 'u#0' }
      )
    ).toBe(true)
    expect(
      structuralGutterSpyPropsChanged(
        { scrollProgress: 0.4, scrollViewportFraction: 0.2, activeScrollRowKey: 'u#0' },
        { scrollProgress: 0.4, scrollViewportFraction: 0.2, activeScrollRowKey: 'u#0' }
      )
    ).toBe(false)
    expect(
      structuralGutterSpyPropsChanged(null, {
        scrollProgress: 0.4,
        scrollViewportFraction: 0.2,
        activeScrollRowKey: 'u#0'
      })
    ).toBe(false)
  })

  it('accepts sub-1e-4 progress deltas (pixel-scale on tall threads)', () => {
    // maxScroll ≈ 50_000 → 2px ≈ 4e-5 normalized; the old 1e-4 bail-out
    // treated that as unchanged and froze the lens.
    const prev = { rowIndex: 12, progress: 0.4, viewportFraction: 0.15 }
    const snap = { rowIndex: 12, progress: 0.4 + 4e-5, viewportFraction: 0.15 }
    expect(shouldAcceptGutterLiveSpy(prev, snap)).toBe(true)
    expect(shouldAcceptGutterLiveSpy(prev, prev)).toBe(false)
  })
})

describe('gutterBulgeRadiusPx (dock influence radius)', () => {
  it('shrinks the influence radius as markers compact, clamped legible', () => {
    // Sparse rails reach further; dense rails (5px steps at 36+) tighten so the
    // whole cluster doesn't bulge as one blob. Monotonic non-increasing in count.
    expect(gutterBulgeRadiusPx(3)).toBe(40)
    expect(gutterBulgeRadiusPx(18)).toBe(32)
    expect(gutterBulgeRadiusPx(28)).toBe(24)
    expect(gutterBulgeRadiusPx(48)).toBe(20)
    for (const n of [1, 5, 12, 20, 40, 200]) {
      const r = gutterBulgeRadiusPx(n)
      expect(r).toBeGreaterThanOrEqual(20)
      expect(r).toBeLessThanOrEqual(44)
    }
  })
})
