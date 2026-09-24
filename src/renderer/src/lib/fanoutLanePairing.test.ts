import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import {
  admitsMeasuredRowDelta,
  classifyCompactFanoutLaneRows,
  classifyFanoutLaneSlots,
  isFanoutLaneCellSlot,
  FANOUT_LANE_SLOT_ATTRIBUTE,
  FANOUT_LANE_SLOT_DATASET_KEY
} from './fanoutLanePairing'

function lane(id: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: `lane ${id}`,
    timestamp: 0,
    metadata: { kind: 'ensembleParticipant', ensembleLaneId: `lane-${id}` }
  } as unknown as ChatMessage
}

function subThreadReturn(
  id: string,
  extras?: { waveId?: string; role?: 'tool' | 'system' }
): ChatMessage {
  return {
    id,
    role: extras?.role ?? 'tool',
    content: `↩ Result from Codex sub-thread (${id}):\n\nbody`,
    timestamp: 0,
    metadata: {
      kind: 'subThreadReturn',
      subThreadId: `child-${id}`,
      ...(extras?.waveId ? { parallelResultWaveId: extras.waveId } : {})
    }
  } as unknown as ChatMessage
}

function other(id: string): ChatMessage {
  return { id, role: 'assistant', content: id, timestamp: 0 } as unknown as ChatMessage
}

function tool(id: string): ChatMessage {
  return {
    id,
    role: 'tool',
    content: id,
    timestamp: 0,
    metadata: { kind: 'tool' }
  } as unknown as ChatMessage
}

function system(id: string): ChatMessage {
  return { id, role: 'system', content: id, timestamp: 0 } as unknown as ChatMessage
}

function delegation(id: string): ChatMessage {
  return {
    id,
    role: 'tool',
    content: id,
    timestamp: 0,
    metadata: { kind: 'subThreadDelegation', subThreadId: `child-${id}` }
  } as unknown as ChatMessage
}

function fleet(id: string, runId?: string): ChatMessage {
  return {
    id,
    role: 'system',
    content: `Fleet ${id}`,
    timestamp: 0,
    ...(runId ? { runId } : {}),
    metadata: { kind: 'fleetWave', waveId: `wave-${id}` }
  } as unknown as ChatMessage
}

describe('classifyFanoutLaneSlots', () => {
  it('returns nothing while the setting is off, so the stacked layout is untouched', () => {
    expect(classifyFanoutLaneSlots([lane('a'), lane('b')], false).size).toBe(0)
  })

  it('pairs adjacent lanes left-to-right', () => {
    const slots = classifyFanoutLaneSlots([lane('a'), lane('b'), lane('c'), lane('d')], true)
    expect([...slots.entries()]).toEqual([
      ['a#0', 'lead'],
      ['b#0', 'trail'],
      ['c#0', 'lead'],
      ['d#0', 'trail']
    ])
  })

  it('spans the odd lane at the end of a run rather than leaving a hole beside it', () => {
    const slots = classifyFanoutLaneSlots([lane('a'), lane('b'), lane('c')], true)
    expect(slots.get('c#0')).toBe('solo')
  })

  it('spans a lane that has no neighbour at all', () => {
    const slots = classifyFanoutLaneSlots([other('x'), lane('a'), other('y')], true)
    expect(slots.get('a#0')).toBe('solo')
    expect(slots.has('x#0')).toBe(false)
    expect(slots.has('y#0')).toBe(false)
  })

  it('restarts pairing at the left column after a non-lane row breaks the run', () => {
    // Without the run reset, `c` would inherit the parity of the run before the
    // interruption and pair across a row the reader has to scroll past.
    const slots = classifyFanoutLaneSlots(
      [lane('a'), lane('b'), lane('c'), other('gap'), lane('d'), lane('e')],
      true
    )
    expect(slots.get('c#0')).toBe('solo')
    expect(slots.get('d#0')).toBe('lead')
    expect(slots.get('e#0')).toBe('trail')
  })

  it('keeps earlier slots stable when a lane streams in at the end of a run', () => {
    // The virtualiser reuses row objects for an unchanged prefix, so a slot that
    // moved under an append would leave stale geometry behind it.
    const before = classifyFanoutLaneSlots([lane('a'), lane('b'), lane('c')], true)
    const after = classifyFanoutLaneSlots([lane('a'), lane('b'), lane('c'), lane('d')], true)
    expect(after.get('a#0')).toBe(before.get('a#0'))
    expect(after.get('b#0')).toBe(before.get('b#0'))
    expect(before.get('c#0')).toBe('solo')
    expect(after.get('c#0')).toBe('lead')
  })

  it('tolerates an empty transcript', () => {
    expect(classifyFanoutLaneSlots([], true).size).toBe(0)
  })

  it('pairs adjacent subThreadReturn rows left-to-right', () => {
    const slots = classifyFanoutLaneSlots(
      [subThreadReturn('r1'), subThreadReturn('r2'), subThreadReturn('r3'), subThreadReturn('r4')],
      true
    )
    expect([...slots.entries()]).toEqual([
      ['r1#0', 'lead'],
      ['r2#0', 'trail'],
      ['r3#0', 'lead'],
      ['r4#0', 'trail']
    ])
  })

  it('spans the odd trailing return as solo', () => {
    const slots = classifyFanoutLaneSlots(
      [subThreadReturn('r1'), subThreadReturn('r2'), subThreadReturn('r3')],
      true
    )
    expect(slots.get('r1#0')).toBe('lead')
    expect(slots.get('r2#0')).toBe('trail')
    expect(slots.get('r3#0')).toBe('solo')
  })

  it.each([
    ['tool', tool('gap')],
    ['assistant', other('gap')],
    ['system', system('gap')],
    ['delegation', delegation('gap')]
  ] as const)('restarts return pairing after a %s breaker', (_label, breaker) => {
    const slots = classifyFanoutLaneSlots(
      [
        subThreadReturn('r1'),
        subThreadReturn('r2'),
        subThreadReturn('r3'),
        breaker,
        subThreadReturn('r4'),
        subThreadReturn('r5')
      ],
      true
    )
    expect(slots.get('r3#0')).toBe('solo')
    expect(slots.get('r4#0')).toBe('lead')
    expect(slots.get('r5#0')).toBe('trail')
    expect(slots.has(`${breaker.id}#0`)).toBe(false)
  })

  it('does not pair a fan-out lane with an adjacent subThreadReturn', () => {
    const slots = classifyFanoutLaneSlots([lane('a'), subThreadReturn('r1')], true)
    expect(slots.get('a#0')).toBe('solo')
    expect(slots.get('r1#0')).toBe('solo')
  })

  it('does not pair across a gap even when returns share a wave id', () => {
    // Wave identity drives viewport headers elsewhere; pairing never reorders
    // or jumps a scrolled-past row to manufacture adjacency.
    const slots = classifyFanoutLaneSlots(
      [
        subThreadReturn('r1', { waveId: 'wave-1' }),
        other('gap'),
        subThreadReturn('r2', { waveId: 'wave-1' })
      ],
      true
    )
    expect(slots.get('r1#0')).toBe('solo')
    expect(slots.get('r2#0')).toBe('solo')
  })

  it('keeps earlier return slots stable when a fourth return streams in', () => {
    const before = classifyFanoutLaneSlots(
      [subThreadReturn('r1'), subThreadReturn('r2'), subThreadReturn('r3')],
      true
    )
    const after = classifyFanoutLaneSlots(
      [subThreadReturn('r1'), subThreadReturn('r2'), subThreadReturn('r3'), subThreadReturn('r4')],
      true
    )
    expect(after.get('r1#0')).toBe(before.get('r1#0'))
    expect(after.get('r2#0')).toBe(before.get('r2#0'))
    expect(before.get('r3#0')).toBe('solo')
    expect(after.get('r3#0')).toBe('lead')
    expect(after.get('r4#0')).toBe('trail')
  })

  it('pairs two adjacent Fleet calls from the same parent run', () => {
    const slots = classifyFanoutLaneSlots([fleet('f1', 'run-1'), fleet('f2', 'run-1')], true)
    expect(slots.get('f1#0')).toBe('lead')
    expect(slots.get('f2#0')).toBe('trail')
  })

  it('never pairs adjacent Fleet cards from different runs or without run identity', () => {
    const slots = classifyFanoutLaneSlots(
      [fleet('f1', 'run-1'), fleet('f2', 'run-2'), fleet('legacy-1'), fleet('legacy-2')],
      true
    )
    expect(slots.get('f1#0')).toBe('solo')
    expect(slots.get('f2#0')).toBe('solo')
    expect(slots.has('legacy-1#0')).toBe(false)
    expect(slots.has('legacy-2#0')).toBe(false)
  })

  it('pairs same-run Fleet calls from the start and leaves an odd third card full-width', () => {
    const slots = classifyFanoutLaneSlots(
      [fleet('f1', 'run-1'), fleet('f2', 'run-1'), fleet('f3', 'run-1')],
      true
    )
    expect(slots.get('f1#0')).toBe('lead')
    expect(slots.get('f2#0')).toBe('trail')
    expect(slots.get('f3#0')).toBe('solo')
  })
})

describe('classifyFanoutLaneSlots across N tracks', () => {
  const lanes = (count: number): ChatMessage[] =>
    Array.from({ length: count }, (_, index) => lane(`L${index}`))
  const slotList = (count: number, tracks: number): (string | undefined)[] => {
    const slots = classifyFanoutLaneSlots(lanes(count), true, tracks)
    return Array.from({ length: count }, (_, index) => slots.get(`L${index}#0`))
  }

  it('leaves two tracks exactly as the two-across model shipped them', () => {
    // THE BYTE-IDENTITY CONTROL. Medium always resolves to two tracks, so the
    // default and the explicit 2 must be the same map — and the same map the
    // build before this slice produced.
    for (const count of [1, 2, 3, 4, 5, 6, 7]) {
      expect(slotList(count, 2), `${count} lanes`).toEqual(
        Array.from({ length: count }, (_, index) =>
          index === count - 1 && count % 2 === 1 ? 'solo' : index % 2 === 0 ? 'lead' : 'trail'
        )
      )
      const defaulted = classifyFanoutLaneSlots(lanes(count), true)
      expect([...defaulted.entries()]).toEqual([
        ...classifyFanoutLaneSlots(lanes(count), true, 2).entries()
      ])
    }
  })

  it('fills three-across rows, and closes each one with a trail', () => {
    // Six lanes: two full grid rows. Every cell but the last of each row is a
    // `lead`, because a `lead` means "a sibling follows me on this grid row" —
    // which is the one thing the measurement pass needs from this map.
    expect(slotList(6, 3)).toEqual(['lead', 'lead', 'trail', 'lead', 'lead', 'trail'])
  })

  it('spans a lone trailing lane and keeps a partial trailing row in cells', () => {
    // k === 1 spans: a single 1/3-width card beside 2/3 of nothing is the
    // rendering-fault shape `solo` exists to refuse.
    expect(slotList(4, 3)).toEqual(['lead', 'lead', 'trail', 'solo'])
    // k >= 2 keeps its cells: a last grid row that is partly empty is what
    // every grid of cards looks like, and spanning them would throw away the
    // side-by-side reading the setting is for.
    expect(slotList(5, 3)).toEqual(['lead', 'lead', 'trail', 'lead', 'trail'])
    expect(slotList(1, 3)).toEqual(['solo'])
    expect(slotList(2, 3)).toEqual(['lead', 'trail'])
  })

  it('spans every lane at one track, which is what a Narrow column renders', () => {
    expect(slotList(4, 1)).toEqual(['solo', 'solo', 'solo', 'solo'])
    expect(slotList(1, 1)).toEqual(['solo'])
  })

  it('fills five-across rows', () => {
    expect(slotList(7, 5)).toEqual(['lead', 'lead', 'lead', 'lead', 'trail', 'lead', 'trail'])
    expect(slotList(6, 5)).toEqual(['lead', 'lead', 'lead', 'lead', 'trail', 'solo'])
  })

  it('still restarts grouping at a run break, at every track count', () => {
    for (const tracks of [1, 2, 3, 5]) {
      const slots = classifyFanoutLaneSlots(
        [lane('a'), lane('b'), other('gap'), lane('c'), lane('d'), lane('e')],
        true,
        tracks
      )
      // The break row is never stamped, and the run after it starts a fresh
      // group rather than inheriting the first run's phase.
      expect(slots.has('gap#0'), `tracks ${tracks}`).toBe(false)
      expect(slots.get('c#0'), `tracks ${tracks}`).toBe(tracks === 1 ? 'solo' : 'lead')
      expect(slots.get('a#0'), `tracks ${tracks}`).toBe(tracks === 1 ? 'solo' : 'lead')
    }
  })

  it('changes at most the run LAST row when a lane streams in, at every track count', () => {
    // The stability property the virtualiser's prefix reuse rests on, re-proved
    // at three and five tracks: a group that has already closed never moves, so
    // an append can only ever re-slot the row it lands beside.
    for (const tracks of [1, 2, 3, 5]) {
      for (let count = 1; count <= 12; count += 1) {
        const before = slotList(count, tracks)
        const after = slotList(count + 1, tracks)
        const moved: number[] = []
        for (let index = 0; index < count; index += 1) {
          if (before[index] !== after[index]) moved.push(index)
        }
        expect(moved, `tracks ${tracks}, ${count} -> ${count + 1}`).toEqual(
          before[count - 1] === after[count - 1] ? [] : [count - 1]
        )
      }
    }
    // Positive control: the matcher above CAN report a move, so an empty
    // `moved` list is a fact rather than an artefact of the comparison.
    expect(slotList(1, 3)[0]).toBe('solo')
    expect(slotList(2, 3)[0]).toBe('lead')
  })

  it('refuses a degenerate track count rather than stalling the group walk', () => {
    // `perRow` drives a `for` loop's step. Zero or a negative would never
    // terminate; a fractional one would walk off the group boundary.
    for (const tracks of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const slots = classifyFanoutLaneSlots(lanes(3), true, tracks)
      expect(slots.size, `tracks ${tracks}`).toBe(3)
    }
    expect(slotList(3, 0)).toEqual(['solo', 'solo', 'solo'])
    expect(slotList(3, 2.7)).toEqual(['lead', 'trail', 'solo'])
  })
})

describe('admitsMeasuredRowDelta', () => {
  // The pre-paint measurement pass's admission rule, as a pure function. The
  // effect it was extracted from cannot be reached by any renderer test — the
  // suites are `renderToStaticMarkup`, so nothing ever has an `offsetTop` — so
  // this table plus the source guard that the effect CALLS it are the whole
  // proof. Before the extraction it had no test at all.

  it('always admits a positive delta, whatever the row is', () => {
    for (const slot of ['lead', 'trail', 'solo', undefined, null, '']) {
      expect(admitsMeasuredRowDelta(1, slot), String(slot)).toBe(true)
      expect(admitsMeasuredRowDelta(412.5, slot), String(slot)).toBe(true)
    }
  })

  it('admits a zero delta for a LEAD and for nothing else', () => {
    // A lead is followed on its grid row, so the next row's offsetTop is this
    // one's and a zero is the layout telling the truth.
    expect(admitsMeasuredRowDelta(0, 'lead')).toBe(true)
    // NOT a trail. A trail CLOSES its grid row, so its successor starts a fresh
    // one and a real trail can never read zero here — a zero on a trail means
    // the row has NO LAYOUT BOX, and recording it as a measured 0 replaces a
    // usable estimate with a wrong measurement. An earlier shape of this slice
    // admitted it on the reasoning that "both contribute zero to the prefix
    // sum"; that conflates a row that is zero-high with a row that was never
    // laid out. It is also the one thing that made this seam diverge from the
    // build it extends at TWO tracks.
    expect(admitsMeasuredRowDelta(0, 'trail')).toBe(false)
    // A full-span row's successor always starts a fresh grid row, so a zero
    // there means the row has no box — the case that must keep its estimate.
    expect(admitsMeasuredRowDelta(0, 'solo')).toBe(false)
    expect(admitsMeasuredRowDelta(0, undefined)).toBe(false)
    expect(admitsMeasuredRowDelta(0, null)).toBe(false)
    expect(admitsMeasuredRowDelta(0, 'lead ')).toBe(false)
  })

  it('never admits a negative delta', () => {
    for (const slot of ['lead', 'trail', 'solo', undefined]) {
      expect(admitsMeasuredRowDelta(-1, slot), String(slot)).toBe(false)
    }
  })

  it('admits the MIDDLE cell of a three-across row, which is the N>2 repair', () => {
    // At three tracks the first TWO cells of a grid row read a zero delta. The
    // shipped rule admitted only the first (`=== 'lead'`), so the middle cell
    // kept its estimate while the closing cell carried the whole band — heights
    // MIS-ATTRIBUTED, not merely under-counted.
    const row = ['lead', 'lead', 'trail'] as const
    expect(row.map((slot, index) => admitsMeasuredRowDelta(index === 2 ? 400 : 0, slot))).toEqual([
      true,
      true,
      true
    ])
  })

  it('answers without being told the track count', () => {
    // The predicate stays correct when the derived track count and the count
    // CSS actually laid out disagree by one near a boundary, because it reads
    // a fact about this row rather than a column index compared against N.
    expect(admitsMeasuredRowDelta.length).toBe(2)
    expect(isFanoutLaneCellSlot('lead')).toBe(true)
    expect(isFanoutLaneCellSlot('trail')).toBe(true)
    expect(isFanoutLaneCellSlot('solo')).toBe(false)
    expect(isFanoutLaneCellSlot(undefined)).toBe(false)
  })

  it('derives the dataset key from the attribute rather than re-spelling it', () => {
    expect(FANOUT_LANE_SLOT_ATTRIBUTE).toBe('data-fanout-slot')
    expect(FANOUT_LANE_SLOT_DATASET_KEY).toBe('fanoutSlot')
  })
})

/**
 * THE SEAMS THE LANE MODEL CANNOT REACH BY BEHAVIOUR.
 *
 * The renderer suites are `renderToStaticMarkup` with no jsdom: the measurement
 * effect never runs, no element has an `offsetTop`, and the width bucket never
 * leaves 0 — so "the effect uses the shared predicate" and "the track count is
 * derived and passed through untouched" have to be pinned by source string.
 *
 * COMMENT-STRIPPED, and matched as whole value expressions rather than by
 * containment: every arithmetic form of an identifier has the bare identifier
 * as a strict PREFIX, and a `+ 1` on exactly this kind of line has shipped
 * green through the full renderer suite three times in this arc.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** The value expression after `anchor`, to its line end, whitespace collapsed. */
function valueExpressionAfter(source: string, anchor: string): string {
  const at = source.indexOf(anchor)
  expect(at, `anchor not found: ${anchor}`).toBeGreaterThan(-1)
  expect(source.indexOf(anchor, at + 1), `anchor is not unique: ${anchor}`).toBe(-1)
  const rest = source.slice(at + anchor.length)
  const end = rest.indexOf('\n')
  return rest
    .slice(0, end === -1 ? rest.length : end)
    .replace(/\s+/g, ' ')
    .trim()
}

const PANEL_CODE = withoutComments(
  readFileSync(join(__dirname, '../components/TranscriptPanel.tsx'), 'utf8')
)
const VIRTUAL_WINDOW_CODE = withoutComments(
  readFileSync(join(__dirname, 'TranscriptVirtualWindow.ts'), 'utf8')
)

describe('the track count reaches the three places that must agree', () => {
  it('is derived ONCE in the panel, from the epoch, untouched', () => {
    // One derivation. A second would be a second opinion about a layout the DOM
    // has already committed to — the same defect class as a second width
    // sample, which the guard above this one refuses by count.
    expect(PANEL_CODE.split('transcriptLayoutLaneTracks(').length - 1).toBe(1)
    expect(valueExpressionAfter(PANEL_CODE, 'const fanoutLaneTracks =')).toBe(
      'transcriptLayoutLaneTracks(transcriptLayoutEpoch)'
    )
  })

  it('reaches the slot classifier as the third argument', () => {
    expect(PANEL_CODE).toContain(
      'classifyFanoutLaneSlots(displayMessages, pairFanoutLanes, fanoutLaneTracks)'
    )
    // And it is a memo dependency, or a resize would keep serving the slots the
    // old column was grouped for while the grid lays out a different number.
    expect(PANEL_CODE).toContain('[displayMessages, pairFanoutLanes, fanoutLaneTracks]')
  })

  it('reaches the estimator as the divisor, spelled exactly', () => {
    expect(valueExpressionAfter(VIRTUAL_WINDOW_CODE, 'const laneTracks =')).toBe(
      'transcriptLayoutLaneTracks(epoch)'
    )
    // The whole statement, matched EXACTLY over comment-stripped source. A
    // containment check on `Math.round(scaled / laneTracks` passes for
    // `/ laneTracks + 1` and `/ (laneTracks - 1)`; a raw-source exact match is
    // satisfied by a one-line comment decoy inside the same expression. Both
    // have shipped green in this arc.
    const start = VIRTUAL_WINDOW_CODE.indexOf('const laid =')
    expect(start, 'const laid =').toBeGreaterThan(-1)
    expect(VIRTUAL_WINDOW_CODE.indexOf('const laid =', start + 1)).toBe(-1)
    const end = VIRTUAL_WINDOW_CODE.indexOf('return laid', start)
    expect(end, 'return laid').toBeGreaterThan(start)
    expect(VIRTUAL_WINDOW_CODE.slice(start, end).replace(/\s+/g, ' ').trim()).toBe(
      "const laid = pairFanoutLanes && (rowType === 'fanoutResult' || rowType === 'return') " +
        '? Math.round(scaled / laneTracks) : scaled'
    )
  })

  it('leaves the zero-delta admission to the shared predicate, spelled once', () => {
    // The highest-risk seam in the slice: it fails as MIS-ATTRIBUTION rather
    // than as a bounded under-count, and no test can mount it.
    expect(PANEL_CODE.split('admitsMeasuredRowDelta(').length - 1).toBe(1)
    expect(PANEL_CODE).toContain(
      'if (!admitsMeasuredRowDelta(slot, el.dataset[FANOUT_LANE_SLOT_DATASET_KEY])) continue'
    )
    // The shipped inline comparison must not come back beside it — a second
    // spelling is how the placement half and the measurement half disagree.
    expect(PANEL_CODE).not.toContain('isPairLead')
    expect(PANEL_CODE).not.toContain('dataset.fanoutSlot')
  })

  it('emits only truthy slot values, which the render signature depends on', () => {
    // `...(fanoutLaneSlot ? { fanoutLaneSlot } : {})` is the ONLY mechanism that
    // re-renders a cached row element when its slot moves. A falsy slot value —
    // a numeric column index of 0, or an empty string — would be omitted from
    // the signature, and the row would keep its cached element and its stale
    // `data-fanout-slot` with nothing failing to compile or to render.
    expect(PANEL_CODE).toContain('...(fanoutLaneSlot ? { fanoutLaneSlot } : {})')
    const seen = new Set<string>()
    for (const tracks of [1, 2, 3, 5]) {
      for (let count = 1; count <= 7; count += 1) {
        const slots = classifyFanoutLaneSlots(
          Array.from({ length: count }, (_, index) => lane(`L${index}`)),
          true,
          tracks
        )
        for (const value of slots.values()) {
          expect(typeof value, `tracks ${tracks}`).toBe('string')
          expect(Boolean(value), `tracks ${tracks}`).toBe(true)
          seen.add(value)
        }
      }
    }
    expect([...seen].sort()).toEqual(['lead', 'solo', 'trail'])
  })
})

describe('classifyCompactFanoutLaneRows', () => {
  it('leaves a round below the threshold at the full band', () => {
    const compact = classifyCompactFanoutLaneRows([
      lane('a'),
      lane('b'),
      lane('c'),
      lane('d'),
      lane('e')
    ])
    expect(compact.size).toBe(0)
  })

  it('compacts every lane of a six-lane run, including the five that predate the sixth', () => {
    const messages = [other('prompt'), lane('a'), lane('b'), lane('c'), lane('d'), lane('e')]
    expect(classifyCompactFanoutLaneRows(messages).size).toBe(0)

    const withSixth = [...messages, lane('f')]
    const compact = classifyCompactFanoutLaneRows(withSixth)
    expect(compact.size).toBe(6)
    expect(compact.has('a#0')).toBe(true)
    expect(compact.has('f#0')).toBe(true)
  })

  it('counts runs per adjacent block, so a broken run stays at the full band', () => {
    const compact = classifyCompactFanoutLaneRows([
      lane('a'),
      lane('b'),
      lane('c'),
      tool('t1'),
      lane('d'),
      lane('e'),
      lane('f')
    ])
    expect(compact.size).toBe(0)
  })

  it('ignores adjacent pairable rows of other kinds when counting the run', () => {
    const compact = classifyCompactFanoutLaneRows([
      lane('a'),
      lane('b'),
      lane('c'),
      subThreadReturn('r1'),
      subThreadReturn('r2'),
      subThreadReturn('r3')
    ])
    expect(compact.size).toBe(0)
  })

  it('tolerates an empty transcript', () => {
    expect(classifyCompactFanoutLaneRows([]).size).toBe(0)
  })
})
