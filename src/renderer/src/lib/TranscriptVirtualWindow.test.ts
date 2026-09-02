import { describe, it, expect } from 'vitest'
import type { ChatMessage, ToolActivity } from '../../../main/store/types'
import {
  ESTIMATED_ROW_HEIGHT_PX,
  RUN_BOUNDARY_HEIGHT_PX,
  CONTENT_PX_PER_CHAR,
  CONTENT_SCALE_CAP_PX,
  VIEWPORT_CLAMPED_ESTIMATE_CAP_PX,
  DEFAULT_OVERSCAN_PX,
  WIDTH_BUCKET_PX,
  TRANSCRIPT_VIRTUALIZATION_ENABLED,
  widthBucket,
  classifyRowType,
  contentVersion,
  estimatedHeightFor,
  projectRows,
  projectRowsAfterSharedPrefix,
  headExtensionScrollTop,
  measurementKey,
  isActiveLiveRowKey,
  measurementContentVersion,
  structuralRowSetKey,
  getRowHeight,
  geometryKey,
  ACTIVITY_OUTPUT_ESTIMATE_CHAR_CAP,
  buildHeightOffsets,
  sumHeights,
  sumHeightOffsets,
  totalHeightFromOffsets,
  selectWindow,
  selectWindowBand,
  virtualWindowBandChanged,
  computeTranscriptScrollSpy,
  computeAnchorDelta,
  windowReachesEnd,
  findScrollAnchor,
  decideScrollerBoxRefresh,
  type VirtualRow
} from './TranscriptVirtualWindow'

// --- fixtures -------------------------------------------------------------

function msg(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function activity(overrides: Partial<ToolActivity> & { id: string }): ToolActivity {
  return {
    toolName: 'shell',
    displayName: 'Shell',
    category: 'shell',
    status: 'success',
    ...overrides
  }
}

/** Build a uniform-height array of `n` rows for window math. */
function uniformHeights(n: number, h: number): number[] {
  return Array.from({ length: n }, () => h)
}

describe('TranscriptVirtualWindow', () => {
  describe('widthBucket', () => {
    it('quantises the content width by the default step', () => {
      expect(widthBucket(0)).toBe(0)
      expect(widthBucket(WIDTH_BUCKET_PX - 1)).toBe(0)
      expect(widthBucket(WIDTH_BUCKET_PX)).toBe(1)
      expect(widthBucket(WIDTH_BUCKET_PX * 3 + 5)).toBe(3)
    })

    it('reuses the same bucket for a resize that does not cross a boundary', () => {
      // A few-px resize inside one bucket must NOT invalidate cached
      // measurements — that is the whole point of bucketing.
      expect(widthBucket(640)).toBe(widthBucket(640 + WIDTH_BUCKET_PX - 1))
    })

    it('changes bucket once the width crosses a boundary (real reflow)', () => {
      expect(widthBucket(640)).not.toBe(widthBucket(640 + WIDTH_BUCKET_PX))
    })

    it('honours a custom step', () => {
      expect(widthBucket(250, 100)).toBe(2)
    })

    it('defends against non-finite / non-positive widths', () => {
      expect(widthBucket(Number.NaN)).toBe(0)
      expect(widthBucket(Number.POSITIVE_INFINITY)).toBe(0)
      expect(widthBucket(-100)).toBe(0)
    })
  })

  describe('classifyRowType', () => {
    it('classifies a sub-thread delegation (system + metadata.kind) before the role fallback', () => {
      const m = msg({ id: 'd', role: 'system', metadata: { kind: 'subThreadDelegation' } })
      expect(classifyRowType(m)).toBe('delegation')
    })

    it('classifies a sub-thread return carried on a system message', () => {
      const m = msg({ id: 'r', role: 'system', metadata: { kind: 'subThreadReturn' } })
      expect(classifyRowType(m)).toBe('return')
    })

    it('classifies a tool-role return as a return, NOT a tool row', () => {
      // The renderer detects sub-thread returns first even though they
      // ride on `role: 'tool'`; the row model must agree or the wrong
      // card (ActivityStack) would be projected.
      const m = msg({ id: 'r2', role: 'tool', metadata: { kind: 'subThreadReturn' } })
      expect(classifyRowType(m)).toBe('return')
    })

    it('classifies a peer-message projection before the plain tool fallback', () => {
      const m = msg({
        id: 'peer',
        role: 'tool',
        metadata: { kind: 'threadMessage', providerContextVisibility: 'projection-only' }
      })
      expect(classifyRowType(m)).toBe('threadMessage')
    })

    it('classifies a plain tool message with activities as a tool row', () => {
      expect(
        classifyRowType(
          msg({ id: 't', role: 'tool', toolActivities: [activity({ id: 'activity-1' })] })
        )
      ).toBe('tool')
    })

    it('classifies a content-only tool message as a text fallback row', () => {
      expect(
        classifyRowType(msg({ id: 't-content', role: 'tool', content: '**legacy result**' }))
      ).toBe('system')
    })

    it('classifies an ensemble participant-health card', () => {
      const m = msg({ id: 'p', role: 'system', metadata: { kind: 'ensembleParticipantHealth' } })
      expect(classifyRowType(m)).toBe('participantHealth')
    })

    it('classifies ensemble fan-out lane answers as fixed-height result rows', () => {
      const m = msg({
        id: 'fanout',
        role: 'assistant',
        metadata: {
          kind: 'ensembleParticipant',
          ensembleRoundId: 'round-1',
          ensembleParticipantId: 'reader-1',
          ensembleLaneId: 'lane-round-1-reader-1-1'
        }
      })
      expect(classifyRowType(m)).toBe('fanoutResult')
    })

    it('classifies the role-based bubbles', () => {
      expect(classifyRowType(msg({ id: 'u', role: 'user' }))).toBe('user')
      expect(classifyRowType(msg({ id: 'e', role: 'error' }))).toBe('error')
      expect(classifyRowType(msg({ id: 'a', role: 'assistant' }))).toBe('assistant')
      expect(classifyRowType(msg({ id: 's', role: 'system' }))).toBe('system')
      expect(
        classifyRowType(
          msg({ id: 'side', role: 'system', metadata: { kind: 'ensembleSideMessage' } })
        )
      ).toBe('assistant')
      expect(
        classifyRowType(
          msg({
            id: 'yield',
            role: 'system',
            metadata: { kind: 'ensembleParticipantStatus', ensembleStatus: 'yielded' }
          })
        )
      ).toBe('assistant')
      expect(
        classifyRowType(
          msg({
            id: 'skipped',
            role: 'system',
            metadata: { kind: 'ensembleParticipantStatus', ensembleStatus: 'skipped' }
          })
        )
      ).toBe('system')
    })
  })

  describe('contentVersion', () => {
    it('encodes role initial + content length for text rows', () => {
      expect(contentVersion(msg({ id: 'a', role: 'assistant', content: 'hello' }))).toMatch(/^a:5:/)
      expect(contentVersion(msg({ id: 'u', role: 'user', content: 'hi' }))).toMatch(/^u:2:/)
    })

    it('changes for same-length text edits that alter sampled markdown shape', () => {
      const plain = msg({ id: 'a', role: 'assistant', content: 'hello world' })
      const shaped = msg({ id: 'a', role: 'assistant', content: 'hello\nworld' })
      expect(shaped.content).toHaveLength(plain.content.length)
      expect(contentVersion(shaped)).not.toBe(contentVersion(plain))
    })

    it('changes when streamed text grows, stays equal when text is identical', () => {
      const before = msg({ id: 'a', role: 'assistant', content: 'hello' })
      const grown = msg({ id: 'a', role: 'assistant', content: 'hello world' })
      const same = msg({ id: 'a', role: 'assistant', content: 'hello' })
      expect(contentVersion(grown)).not.toBe(contentVersion(before))
      expect(contentVersion(same)).toBe(contentVersion(before))
    })

    it('encodes count + statuses + output length for tool rows', () => {
      const m = msg({
        id: 't',
        role: 'tool',
        toolActivities: [
          activity({ id: '1', status: 'running', outputPreview: 'abc' }),
          activity({ id: '2', status: 'success', resultSummary: 'de' })
        ]
      })
      // 2 activities, statuses "running|success|", output len 3 + 2 = 5
      expect(contentVersion(m)).toBe('t:2:running|success|:5')
    })

    it('changes when a tool activity status flips (running -> success collapses height)', () => {
      const running = msg({
        id: 't',
        role: 'tool',
        toolActivities: [activity({ id: '1', status: 'running' })]
      })
      const done = msg({
        id: 't',
        role: 'tool',
        toolActivities: [activity({ id: '1', status: 'success' })]
      })
      expect(contentVersion(done)).not.toBe(contentVersion(running))
    })

    it('changes when a tool activity reveals more output', () => {
      const a = msg({
        id: 't',
        role: 'tool',
        toolActivities: [activity({ id: '1', status: 'running', outputPreview: 'a' })]
      })
      const b = msg({
        id: 't',
        role: 'tool',
        toolActivities: [activity({ id: '1', status: 'running', outputPreview: 'aaaa' })]
      })
      expect(contentVersion(b)).not.toBe(contentVersion(a))
    })

    it('uses content length for a tool fallback row with no activities', () => {
      expect(contentVersion(msg({ id: 't', role: 'tool' }))).toMatch(/^t:0:/)
      expect(contentVersion(msg({ id: 't', role: 'tool', content: 'legacy result' }))).toMatch(
        /^t:13:/
      )
      expect(contentVersion(msg({ id: 'a', content: undefined as unknown as string }))).toMatch(
        /^a:0:/
      )
    })

    it('includes folded fan-out tool activity state in assistant row versions', () => {
      const running = msg({
        id: 'fanout',
        role: 'assistant',
        content: 'Scout note.',
        metadata: {
          kind: 'ensembleParticipant',
          ensembleRoundId: 'round-1',
          ensembleParticipantId: 'reader-1',
          ensembleLaneId: 'lane-round-1-reader-1'
        },
        toolActivities: [activity({ id: '1', status: 'running', outputPreview: 'a' })]
      })
      const done = msg({
        ...running,
        toolActivities: [activity({ id: '1', status: 'success', resultSummary: 'done' })]
      })

      expect(contentVersion(done)).not.toBe(contentVersion(running))
      expect(contentVersion(done)).toContain(':t:1:success|:4')
    })
  })

  describe('estimatedHeightFor', () => {
    it('returns the per-type estimate', () => {
      expect(estimatedHeightFor('assistant', false)).toBe(ESTIMATED_ROW_HEIGHT_PX.assistant)
      expect(estimatedHeightFor('user', false)).toBe(ESTIMATED_ROW_HEIGHT_PX.user)
    })

    it('adds the run-boundary band when a RunCard renders above the block', () => {
      expect(estimatedHeightFor('assistant', true)).toBe(
        ESTIMATED_ROW_HEIGHT_PX.assistant + RUN_BOUNDARY_HEIGHT_PX
      )
    })

    it('1.0.7 — defaults contentLength to 0 so the bare per-type estimate is unchanged', () => {
      // Back-compat: the 2-arg form (and contentLength 0) still floors at the
      // per-type estimate, so existing window math is byte-identical.
      expect(estimatedHeightFor('assistant', false, 0)).toBe(ESTIMATED_ROW_HEIGHT_PX.assistant)
      expect(estimatedHeightFor('assistant', false)).toBe(ESTIMATED_ROW_HEIGHT_PX.assistant)
    })

    it('1.0.7 — scales a long text row well above the flat estimate', () => {
      // A dense ensemble participant answer (~2000 chars) should estimate far
      // larger than the 220px flat assistant estimate, so the first window
      // lands close and converges instead of oscillating.
      const long = estimatedHeightFor('assistant', false, 2000)
      expect(long).toBeGreaterThan(ESTIMATED_ROW_HEIGHT_PX.assistant)
      expect(long).toBe(Math.round(2000 * CONTENT_PX_PER_CHAR))
    })

    it('1.0.7 — caps the scaled estimate so a pathological message stays bounded', () => {
      expect(estimatedHeightFor('assistant', false, 100000)).toBe(CONTENT_SCALE_CAP_PX)
    })

    it('sizes dense viewport rows above the flat estimate from a coarse content signal', () => {
      // tool rows are multi-segment (no single outer viewport cap) and keep the
      // generic content scale. Dense sub-thread returns are viewport-clamped —
      // see the ceiling test below.
      expect(estimatedHeightFor('tool', false, 5000)).toBe(CONTENT_SCALE_CAP_PX)
    })

    it('caps single-viewport card estimates at the viewport-clamped ceiling', () => {
      // A READ-heavy Cursor fan-out lane accumulates thousands of chars of tool
      // output, but the ENTIRE card body renders inside one 240px-capped
      // LiveActivityViewport — so its off-screen height must NOT balloon toward
      // CONTENT_SCALE_CAP_PX. That phantom bottom-spacer height is what made
      // auto-follow's snap-to-scrollHeight lurch the transcript to the bottom on
      // every flush while the visible lane card stayed contained at 240px.
      // Sub-thread return cards share the same single-viewport clamp, so a dense
      // return must hit the same ceiling rather than content-scale toward 1400.
      expect(estimatedHeightFor('fanoutResult', false, 100000)).toBe(
        VIEWPORT_CLAMPED_ESTIMATE_CAP_PX
      )
      expect(estimatedHeightFor('fanoutResult', false, 100000)).toBeLessThan(CONTENT_SCALE_CAP_PX)
      expect(estimatedHeightFor('threadMessage', false, 100000)).toBe(
        VIEWPORT_CLAMPED_ESTIMATE_CAP_PX
      )
      expect(estimatedHeightFor('return', false, 100000)).toBe(VIEWPORT_CLAMPED_ESTIMATE_CAP_PX)
      expect(estimatedHeightFor('return', false, 2000)).toBe(VIEWPORT_CLAMPED_ESTIMATE_CAP_PX)
      expect(estimatedHeightFor('return', false, 2000)).toBeLessThan(CONTENT_SCALE_CAP_PX)
      // A small fan-out / return card still floors at its flat per-type base.
      expect(estimatedHeightFor('fanoutResult', false, 0)).toBe(
        ESTIMATED_ROW_HEIGHT_PX.fanoutResult
      )
      expect(estimatedHeightFor('return', false, 0)).toBe(ESTIMATED_ROW_HEIGHT_PX.return)
      // tool rows are multi-segment (no single outer cap) and keep scaling —
      // only cards with one hard-clamped outer viewport are capped.
      expect(estimatedHeightFor('tool', false, 100000)).toBe(CONTENT_SCALE_CAP_PX)
    })

    it('halves a fan-out lane estimate while the paired layout shares a grid row', () => {
      // Two paired lanes occupy ONE row, so two half estimates must sum to the
      // band they really cost. Anything larger inflates the bottom spacer and
      // brings back the auto-follow lurch the cap above exists to prevent.
      const stacked = estimatedHeightFor('fanoutResult', false, 100000)
      const paired = estimatedHeightFor('fanoutResult', false, 100000, true)
      expect(paired).toBe(Math.round(stacked / 2))
      expect(paired * 2).toBe(stacked)
    })

    it('halves a sub-thread return estimate while the paired layout shares a grid row', () => {
      // Once pairing stamps return slots alongside fan-out lanes, a paired
      // return must contribute half a row — same invariant as fanoutResult.
      const stacked = estimatedHeightFor('return', false, 100000)
      const paired = estimatedHeightFor('return', false, 100000, true)
      expect(paired).toBe(Math.round(stacked / 2))
      expect(paired * 2).toBe(stacked)
    })

    it('leaves every other row type alone under the paired layout', () => {
      // Only lane cards that pair (`fanoutResult`, `return`) halve. Full-width
      // transcript rows must keep their stacked estimate — including other
      // viewport-clamped cards like threadMessage that do not share a grid row.
      for (const rowType of [
        'assistant',
        'user',
        'tool',
        'threadMessage',
        'system',
        'guestReply',
        'collaborator',
        'delegation'
      ] as const) {
        expect(estimatedHeightFor(rowType, false, 4000, true)).toBe(
          estimatedHeightFor(rowType, false, 4000)
        )
      }
    })

    it('keeps the run-boundary card at full height on a halved lane row', () => {
      // The RunCard above the row is full-width chrome, not part of the lane —
      // halving it would make the spacer short by the card's height per run.
      const paired = estimatedHeightFor('fanoutResult', true, 100000, true)
      expect(paired - estimatedHeightFor('fanoutResult', false, 100000, true)).toBe(
        estimatedHeightFor('fanoutResult', true, 100000) -
          estimatedHeightFor('fanoutResult', false, 100000)
      )
    })

    it('1.0.7 — adds the run-boundary band on top of a scaled estimate', () => {
      expect(estimatedHeightFor('assistant', true, 2000)).toBe(
        Math.round(2000 * CONTENT_PX_PER_CHAR) + RUN_BOUNDARY_HEIGHT_PX
      )
    })
  })

  describe('projectRows', () => {
    it('produces one row per message with stable ids equal to message.id, in order', () => {
      const messages = [
        msg({ id: 'm1', role: 'user', content: 'hi' }),
        msg({ id: 'm2', role: 'assistant', content: 'yo' }),
        msg({ id: 'm3', role: 'tool', toolActivities: [activity({ id: 'a' })] })
      ]
      const rows = projectRows(messages)
      expect(rows.map((r) => r.id)).toEqual(['m1', 'm2', 'm3'])
      expect(rows.map((r) => r.index)).toEqual([0, 1, 2])
      expect(rows.map((r) => r.rowType)).toEqual(['user', 'assistant', 'tool'])
    })

    it('is deterministic — re-projecting the same messages yields identical ids + versions', () => {
      const messages = [msg({ id: 'm1', content: 'a' }), msg({ id: 'm2', content: 'bb' })]
      const first = projectRows(messages)
      const second = projectRows(messages)
      expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id))
      expect(second.map((r) => r.contentVersion)).toEqual(first.map((r) => r.contentVersion))
    })

    it('changes ONLY the streaming row contentVersion, leaving siblings byte-identical', () => {
      // The core virtualisation invariant: a streamed token must
      // invalidate one row's measurement, never the whole list.
      const before = [
        msg({ id: 'a', role: 'user', content: 'question' }),
        msg({ id: 'b', role: 'assistant', content: 'partial' }),
        msg({ id: 'c', role: 'user', content: 'tail' })
      ]
      const after = [
        msg({ id: 'a', role: 'user', content: 'question' }),
        msg({ id: 'b', role: 'assistant', content: 'partial answer' }),
        msg({ id: 'c', role: 'user', content: 'tail' })
      ]
      const rb = projectRows(before)
      const ra = projectRows(after)
      expect(ra[0].contentVersion).toBe(rb[0].contentVersion)
      expect(ra[2].contentVersion).toBe(rb[2].contentVersion)
      expect(ra[1].contentVersion).not.toBe(rb[1].contentVersion)
    })

    it('marks run-boundary rows and inflates their estimate', () => {
      const messages = [msg({ id: 'm1', role: 'user' }), msg({ id: 'm2', role: 'assistant' })]
      const rows = projectRows(messages, new Set(['m2']))
      expect(rows[0].hasRunBoundary).toBe(false)
      expect(rows[1].hasRunBoundary).toBe(true)
      expect(rows[1].estimatedHeight).toBe(
        ESTIMATED_ROW_HEIGHT_PX.assistant + RUN_BOUNDARY_HEIGHT_PX
      )
    })

    it('treats a null/absent run-boundary set as no boundaries', () => {
      const rows = projectRows([msg({ id: 'm1' })], null)
      expect(rows[0].hasRunBoundary).toBe(false)
    })

    it('skips malformed entries (missing id / non-array input)', () => {
      expect(projectRows(undefined as unknown as ChatMessage[])).toEqual([])
      const rows = projectRows([
        msg({ id: 'ok' }),
        { role: 'assistant', content: '', timestamp: '' } as unknown as ChatMessage
      ])
      expect(rows.map((r) => r.id)).toEqual(['ok'])
    })
  })

  describe('measurementKey', () => {
    it('combines id, content version, width bucket and expansion bit', () => {
      expect(measurementKey('m1', 'a:5', 8, false)).toBe('m1|a:5|8|0')
      expect(measurementKey('m1', 'a:5', 8, true)).toBe('m1|a:5|8|1')
    })

    it('invalidates when the content version changes (streamed token)', () => {
      expect(measurementKey('m1', 'a:5', 8, false)).not.toBe(measurementKey('m1', 'a:6', 8, false))
    })

    it('invalidates when the width bucket changes (reflow)', () => {
      expect(measurementKey('m1', 'a:5', 8, false)).not.toBe(measurementKey('m1', 'a:5', 9, false))
    })

    it('invalidates when the expansion bit changes (ActivityStack expand/collapse)', () => {
      expect(measurementKey('m1', 'a:5', 8, false)).not.toBe(measurementKey('m1', 'a:5', 8, true))
    })
  })

  describe('structuralRowSetKey', () => {
    it('stays equal across content-only rewrites of the same rowKeys', () => {
      const before = projectRows([
        msg({ id: 'u', role: 'user', content: 'hi' }),
        msg({ id: 'a', role: 'assistant', content: 'hel' })
      ])
      const after = projectRows([
        msg({ id: 'u', role: 'user', content: 'hi' }),
        msg({ id: 'a', role: 'assistant', content: 'hello world' })
      ])
      expect(structuralRowSetKey(before)).toBe(structuralRowSetKey(after))
      expect(before[1].contentVersion).not.toBe(after[1].contentVersion)
    })

    it('changes when a row is appended or a rowKey changes', () => {
      const two = projectRows([
        msg({ id: 'u', role: 'user', content: 'hi' }),
        msg({ id: 'a', role: 'assistant', content: 'ok' })
      ])
      const three = projectRows([
        msg({ id: 'u', role: 'user', content: 'hi' }),
        msg({ id: 'a', role: 'assistant', content: 'ok' }),
        msg({ id: 'sys', role: 'system', content: 'note' })
      ])
      expect(structuralRowSetKey(two)).not.toBe(structuralRowSetKey(three))
      expect(structuralRowSetKey([])).toBe('0:')
      expect(structuralRowSetKey(null)).toBe('0:')
    })
  })

  describe('measurementContentVersion', () => {
    it('uses a stable live key for the active assistant row', () => {
      const row = projectRows([msg({ id: 'a', role: 'assistant', content: 'hello' })])[0]
      expect(measurementContentVersion(row, row.rowKey)).toBe('assistant:live')
    })

    it('uses a stable live key for the active tool row', () => {
      const row = projectRows([
        msg({
          id: 'tool',
          role: 'tool',
          toolActivities: [
            activity({
              id: 'kimi-thinking',
              toolName: 'kimi_thinking',
              status: 'success',
              resultSummary: 'reasoning chunk'
            })
          ]
        })
      ])[0]
      expect(measurementContentVersion(row, row.rowKey)).toBe('tool:live')
    })

    it('freezes multiple concurrent live rows via a Set', () => {
      const rows = projectRows([
        msg({
          id: 'tool',
          role: 'tool',
          toolActivities: [
            activity({
              id: 't1',
              toolName: 'shell',
              status: 'running',
              resultSummary: 'partial'
            })
          ]
        }),
        msg({ id: 'a', role: 'assistant', content: 'streaming' })
      ])
      const live = new Set([rows[0].rowKey, rows[1].rowKey])
      expect(measurementContentVersion(rows[0], live)).toBe('tool:live')
      expect(measurementContentVersion(rows[1], live)).toBe('assistant:live')
      expect(isActiveLiveRowKey(rows[0].rowKey, live)).toBe(true)
      expect(isActiveLiveRowKey('missing#9', live)).toBe(false)
    })

    it('uses a stable live key for an active fanoutResult row', () => {
      const row = projectRows([
        msg({
          id: 'fan',
          role: 'assistant',
          content: 'lane output',
          metadata: {
            kind: 'ensembleParticipant',
            ensembleLaneId: 'lane-1',
            ensembleParticipantId: 'p1'
          }
        })
      ])[0]
      expect(row.rowType).toBe('fanoutResult')
      expect(measurementContentVersion(row, row.rowKey)).toBe('fanoutResult:live')
      expect(measurementContentVersion(row, new Set([row.rowKey]))).toBe('fanoutResult:live')
    })

    it('leaves non-active rows on their content version', () => {
      const row = projectRows([msg({ id: 'a', role: 'assistant', content: 'hello' })])[0]
      expect(measurementContentVersion(row, 'other#0')).toBe(row.contentVersion)
      expect(measurementContentVersion(row, new Set(['other#0']))).toBe(row.contentVersion)
    })

    it('does not live-key non-assistant rows', () => {
      const row = projectRows([msg({ id: 'u', role: 'user', content: 'hello' })])[0]
      expect(measurementContentVersion(row, row.rowKey)).toBe(row.contentVersion)
    })
  })

  describe('getRowHeight', () => {
    const row: VirtualRow = {
      id: 'm1',
      rowKey: 'm1#0',
      index: 0,
      rowType: 'assistant',
      contentVersion: 'a:5',
      estimatedHeight: ESTIMATED_ROW_HEIGHT_PX.assistant,
      hasRunBoundary: false
    }

    it('returns the measured height when the cache holds the exact key', () => {
      // getRowHeight keys on row.rowKey, not row.id.
      const cache = new Map<string, number>([[measurementKey('m1#0', 'a:5', 8, false), 321]])
      expect(getRowHeight(row, cache, 8, false)).toBe(321)
    })

    it('falls back to the estimate when the geometry key differs', () => {
      // Measured at a different width bucket → not comparable → estimate.
      const cache = new Map<string, number>([[measurementKey('m1#0', 'a:5', 8, false), 321]])
      expect(getRowHeight(row, cache, 9, false)).toBe(row.estimatedHeight)
    })

    it('falls back to the estimate for an empty cache', () => {
      expect(getRowHeight(row, new Map(), 8, false)).toBe(row.estimatedHeight)
    })

    it('rejects a corrupt (negative / NaN) cached measurement', () => {
      const cache = new Map<string, number>([[measurementKey('m1#0', 'a:5', 8, false), Number.NaN]])
      expect(getRowHeight(row, cache, 8, false)).toBe(row.estimatedHeight)
      const neg = new Map<string, number>([[measurementKey('m1#0', 'a:5', 8, false), -5]])
      expect(getRowHeight(row, neg, 8, false)).toBe(row.estimatedHeight)
    })

    it('accepts a measured height of 0 (a genuinely collapsed row)', () => {
      const cache = new Map<string, number>([[measurementKey('m1#0', 'a:5', 8, false), 0]])
      expect(getRowHeight(row, cache, 8, false)).toBe(0)
    })

    it('1.0.7 — two rows with the SAME message id get DISTINCT rowKeys + cache slots', () => {
      // Duplicate message ids (historical/imported data) must not collide. Two
      // rows sharing id 'dup' at different indices have distinct rowKeys, so
      // their measurements live in separate cache slots and never overwrite.
      const rowA: VirtualRow = { ...row, id: 'dup', rowKey: 'dup#3', index: 3 }
      const rowB: VirtualRow = { ...row, id: 'dup', rowKey: 'dup#7', index: 7 }
      const cache = new Map<string, number>([
        [measurementKey('dup#3', 'a:5', 8, false), 100],
        [measurementKey('dup#7', 'a:5', 8, false), 900]
      ])
      expect(getRowHeight(rowA, cache, 8, false)).toBe(100)
      expect(getRowHeight(rowB, cache, 8, false)).toBe(900)
    })
  })

  describe('projectRows — rowKey collision-proofing', () => {
    it('1.0.7 — assigns a unique rowKey even when message ids DUPLICATE', () => {
      // The real bug: pre-1.0.7 ensemble round-status messages all shared
      // `ensemble-round-status-${roundId}`. projectRows must still yield unique
      // rowKeys so the renderer keys + measurement maps never collide.
      const dupId = 'ensemble-round-status-round-1'
      const messages: ChatMessage[] = [
        { id: dupId, role: 'system', content: 'Handoff 1/12.', timestamp: '2026-01-01T00:00:00Z' },
        { id: dupId, role: 'system', content: 'Handoff 2/12.', timestamp: '2026-01-01T00:00:01Z' },
        { id: dupId, role: 'system', content: 'Yielded back.', timestamp: '2026-01-01T00:00:02Z' }
      ]
      const rows = projectRows(messages)
      expect(rows).toHaveLength(3)
      const rowKeys = rows.map((r) => r.rowKey)
      expect(new Set(rowKeys).size).toBe(3) // all distinct
      expect(rowKeys).toEqual([`${dupId}#0`, `${dupId}#1`, `${dupId}#2`])
      // The bare id stays shared (content-cache identity), only rowKey disambiguates.
      expect(rows.every((r) => r.id === dupId)).toBe(true)
    })
  })

  describe('sumHeights', () => {
    it('sums a half-open slice', () => {
      expect(sumHeights([10, 20, 30, 40], 1, 3)).toBe(50)
    })

    it('clamps out-of-range bounds', () => {
      expect(sumHeights([10, 20, 30], -5, 99)).toBe(60)
    })

    it('skips non-finite and negative entries', () => {
      expect(sumHeights([10, Number.NaN, -5, 20], 0, 4)).toBe(30)
    })

    it('returns 0 for an empty or inverted slice', () => {
      expect(sumHeights([], 0, 0)).toBe(0)
      expect(sumHeights([10, 20], 2, 1)).toBe(0)
    })
  })

  describe('height offsets', () => {
    it('builds reusable prefix offsets and sums ranges in O(1)', () => {
      const offsets = buildHeightOffsets([10, Number.NaN, -5, 20])
      expect(offsets).toEqual([0, 10, 10, 10, 30])
      expect(totalHeightFromOffsets(offsets)).toBe(30)
      expect(sumHeightOffsets(offsets, 1, 4)).toBe(20)
      expect(sumHeightOffsets(offsets, -5, 99)).toBe(30)
    })

    it('selects windows and anchors from supplied offsets with boundary parity', () => {
      const heights = [100, 0, 100, 100]
      const offsets = buildHeightOffsets(heights)
      const window = selectWindow({
        scrollTop: 100,
        viewportHeight: 100,
        heights,
        heightOffsets: offsets,
        overscanPx: 0
      })
      expect(window.startIndex).toBe(2)
      expect(window.endIndex).toBe(3)
      expect(window.topSpacerPx).toBe(100)
      expect(findScrollAnchor(100, heights, offsets)).toEqual({ index: 2, offsetWithin: 0 })
    })
  })

  describe('selectWindow', () => {
    it('returns an empty window for no rows', () => {
      expect(selectWindow({ scrollTop: 0, viewportHeight: 500, heights: [] })).toEqual({
        startIndex: 0,
        endIndex: 0,
        topSpacerPx: 0,
        bottomSpacerPx: 0
      })
    })

    it('mounts the top rows with a zero top spacer at scrollTop 0', () => {
      const heights = uniformHeights(5, 100) // total 500
      const w = selectWindow({ scrollTop: 0, viewportHeight: 200, heights, overscanPx: 0 })
      expect(w.startIndex).toBe(0)
      expect(w.topSpacerPx).toBe(0)
      // viewport covers rows 0-1; row 2 starts exactly at the boundary.
      expect(w.endIndex).toBe(2)
      expect(w.bottomSpacerPx).toBe(300)
    })

    it('preserves total height: topSpacer + mounted + bottomSpacer === Σ(all heights)', () => {
      const heights = [120, 80, 300, 60, 200, 90, 150] // total 1000
      const total = heights.reduce((a, b) => a + b, 0)
      for (const scrollTop of [0, 100, 350, 700, 9999]) {
        const w = selectWindow({ scrollTop, viewportHeight: 250, heights, overscanPx: 120 })
        const mounted = sumHeights(heights, w.startIndex, w.endIndex)
        expect(w.topSpacerPx + mounted + w.bottomSpacerPx).toBe(total)
      }
    })

    it('bottom-follow invariant: at max scroll the last row is mounted and bottomSpacerPx === 0', () => {
      const heights = uniformHeights(5, 100) // total 500
      const viewportHeight = 200
      const maxScroll = 500 - viewportHeight // 300
      const w = selectWindow({ scrollTop: maxScroll, viewportHeight, heights, overscanPx: 0 })
      expect(w.endIndex).toBe(5)
      expect(w.bottomSpacerPx).toBe(0)
      expect(windowReachesEnd(w, heights.length)).toBe(true)
    })

    it('extends the mounted band by the overscan', () => {
      const heights = uniformHeights(10, 100) // total 1000
      const tight = selectWindow({ scrollTop: 400, viewportHeight: 200, heights, overscanPx: 0 })
      const loose = selectWindow({ scrollTop: 400, viewportHeight: 200, heights, overscanPx: 150 })
      expect(loose.startIndex).toBeLessThanOrEqual(tight.startIndex)
      expect(loose.endIndex).toBeGreaterThanOrEqual(tight.endIndex)
    })

    it('force-mounts a requested row for programmatic transcript jumps', () => {
      const heights = uniformHeights(100, 100)
      const normal = selectWindow({ scrollTop: 0, viewportHeight: 240, heights, overscanPx: 0 })
      const forced = selectWindow({
        scrollTop: 0,
        viewportHeight: 240,
        heights,
        overscanPx: 0,
        forceIndex: 50
      })

      expect(normal.startIndex).toBe(0)
      expect(normal.endIndex).toBeLessThanOrEqual(3)
      expect(forced.startIndex).toBeLessThanOrEqual(50)
      expect(forced.endIndex).toBeGreaterThan(50)
      expect(forced.topSpacerPx).toBe(sumHeights(heights, 0, forced.startIndex))
    })

    it('defaults to DEFAULT_OVERSCAN_PX when overscan is omitted', () => {
      const heights = uniformHeights(40, 100) // total 4000
      const w = selectWindow({ scrollTop: 2000, viewportHeight: 400, heights })
      // window roughly spans [2000-overscan, 2400+overscan]
      const topOfStart = sumHeights(heights, 0, w.startIndex)
      expect(topOfStart).toBeLessThanOrEqual(2000 - DEFAULT_OVERSCAN_PX + 100)
    })

    it('collapses everything into the top spacer when scrolled far past the end', () => {
      const heights = uniformHeights(5, 100) // total 500
      const w = selectWindow({ scrollTop: 10000, viewportHeight: 200, heights, overscanPx: 0 })
      expect(w.startIndex).toBe(5)
      expect(w.endIndex).toBe(5)
      expect(w.topSpacerPx).toBe(500)
      expect(w.bottomSpacerPx).toBe(0)
    })

    it('defends against non-finite scroll / viewport inputs', () => {
      const heights = uniformHeights(5, 100)
      const w = selectWindow({
        scrollTop: Number.NaN,
        viewportHeight: Number.POSITIVE_INFINITY,
        heights,
        overscanPx: 0
      })
      // NaN scrollTop -> 0; infinite viewport clamps to a usable window
      expect(w.startIndex).toBe(0)
      expect(w.topSpacerPx).toBe(0)
    })
  })

  describe('virtualWindowBandChanged / selectWindowBand', () => {
    // Cut 1a: gate scrollTick bumps on mounted band identity (start/end/force),
    // not every scroll frame. Spacers are intentionally ignored.
    const bandInput = (scrollTop: number, forceIndex?: number | null) => ({
      scrollTop,
      viewportHeight: 200,
      heights: uniformHeights(40, 100),
      overscanPx: DEFAULT_OVERSCAN_PX,
      forceIndex
    })

    it('returns false for an intra-band scroll that keeps start/end', () => {
      // Overscan is 900px and rows are 100px, so only scroll deltas that stay
      // inside the same offset cell keep the mounted band identical.
      const prev = selectWindowBand(bandInput(1520))
      const next = selectWindowBand(bandInput(1550))
      expect(prev.startIndex).toBe(next.startIndex)
      expect(prev.endIndex).toBe(next.endIndex)
      expect(virtualWindowBandChanged(prev, next)).toBe(false)
    })

    it('returns true when scroll crosses into a different mounted band', () => {
      const prev = selectWindowBand(bandInput(1520))
      const next = selectWindowBand(bandInput(2000))
      expect(prev.startIndex !== next.startIndex || prev.endIndex !== next.endIndex).toBe(true)
      expect(virtualWindowBandChanged(prev, next)).toBe(true)
    })

    it('returns true when forceIndex identity changes even if start/end match', () => {
      expect(
        virtualWindowBandChanged(
          { startIndex: 2, endIndex: 8, forceIndex: null },
          { startIndex: 2, endIndex: 8, forceIndex: 50 }
        )
      ).toBe(true)
      const withForce = selectWindowBand(bandInput(0, 50))
      expect(withForce.forceIndex).toBe(50)
    })

    it('returns true on first publish (null/undefined previous)', () => {
      const band = selectWindowBand(bandInput(400))
      expect(virtualWindowBandChanged(null, band)).toBe(true)
      expect(virtualWindowBandChanged(undefined, band)).toBe(true)
    })

    it('returns false for identical band values', () => {
      const band = { startIndex: 3, endIndex: 12, forceIndex: null as number | null }
      expect(virtualWindowBandChanged(band, { ...band })).toBe(false)
      expect(virtualWindowBandChanged(band, { startIndex: 3, endIndex: 12 })).toBe(false)
    })

    it('returns true when only startIndex or only endIndex changes', () => {
      const base = { startIndex: 3, endIndex: 12, forceIndex: null as number | null }
      expect(virtualWindowBandChanged(base, { ...base, startIndex: 4 })).toBe(true)
      expect(virtualWindowBandChanged(base, { ...base, endIndex: 13 })).toBe(true)
    })
  })

  describe('computeTranscriptScrollSpy', () => {
    // Cut 1b: RAF spy sink shares this formula with render. Progress uses LIVE
    // offsets (total height); rowIndex uses HELD window heights + 0.3*viewport.
    it('derives progress from live total height and rowIndex from held window', () => {
      const heldHeights = uniformHeights(10, 100)
      const heldOffsets = buildHeightOffsets(heldHeights)
      // Live content grew (e.g. measured taller) while the mounted band is held.
      const liveHeights = heldHeights.map((h, i) => (i < 3 ? h + 50 : h))
      const liveOffsets = buildHeightOffsets(liveHeights)
      const viewportHeight = 200
      const scrollTop = 250
      const snap = computeTranscriptScrollSpy({
        enabled: true,
        scrollTop,
        viewportHeight,
        liveHeightOffsets: liveOffsets,
        windowHeights: heldHeights,
        windowHeightOffsets: heldOffsets
      })
      const liveTotal = totalHeightFromOffsets(liveOffsets)
      const maxScroll = liveTotal - viewportHeight
      expect(snap.progress).toBeCloseTo(scrollTop / maxScroll, 6)
      expect(snap.viewportFraction).toBeCloseTo(viewportHeight / liveTotal, 6)
      expect(snap.rowIndex).toBe(
        findScrollAnchor(scrollTop + viewportHeight * 0.3, heldHeights, heldOffsets).index
      )
    })

    it('returns null rowIndex and zero fractions when disabled or empty', () => {
      expect(
        computeTranscriptScrollSpy({
          enabled: false,
          scrollTop: 100,
          viewportHeight: 200,
          liveHeightOffsets: buildHeightOffsets(uniformHeights(5, 100)),
          windowHeights: uniformHeights(5, 100),
          windowHeightOffsets: buildHeightOffsets(uniformHeights(5, 100))
        })
      ).toEqual({ rowIndex: null, progress: 0, viewportFraction: 0 })
      expect(
        computeTranscriptScrollSpy({
          enabled: true,
          scrollTop: 0,
          viewportHeight: 200,
          liveHeightOffsets: [],
          windowHeights: [],
          windowHeightOffsets: []
        })
      ).toEqual({ rowIndex: null, progress: 0, viewportFraction: 0 })
    })

    it('clamps progress to 0..1 and reports full viewport when content fits', () => {
      const heights = uniformHeights(2, 50)
      const offsets = buildHeightOffsets(heights)
      const snap = computeTranscriptScrollSpy({
        enabled: true,
        scrollTop: 999,
        viewportHeight: 400,
        liveHeightOffsets: offsets,
        windowHeights: heights,
        windowHeightOffsets: offsets
      })
      expect(snap.progress).toBe(0)
      expect(snap.viewportFraction).toBe(1)
      expect(snap.rowIndex).toBe(findScrollAnchor(999 + 400 * 0.3, heights, offsets).index)
    })
  })

  describe('computeAnchorDelta', () => {
    it('returns the signed change in the top spacer height', () => {
      // Rows above the viewport measured TALLER than estimated → top
      // spacer grew → scrollTop must increase by the same amount so the
      // visible content does not jump.
      expect(computeAnchorDelta({ previousTopSpacerPx: 400, nextTopSpacerPx: 460 })).toBe(60)
    })

    it('is negative when rows above shrink (e.g. ActivityStack collapsed)', () => {
      expect(computeAnchorDelta({ previousTopSpacerPx: 400, nextTopSpacerPx: 360 })).toBe(-40)
    })

    it('is zero when the top spacer is unchanged', () => {
      expect(computeAnchorDelta({ previousTopSpacerPx: 400, nextTopSpacerPx: 400 })).toBe(0)
    })

    it('treats non-finite inputs as zero', () => {
      expect(computeAnchorDelta({ previousTopSpacerPx: Number.NaN, nextTopSpacerPx: 100 })).toBe(
        100
      )
      expect(computeAnchorDelta({ previousTopSpacerPx: 100, nextTopSpacerPx: Number.NaN })).toBe(
        -100
      )
    })
  })

  describe('windowReachesEnd', () => {
    it('is true when the window includes the last row', () => {
      expect(
        windowReachesEnd({ startIndex: 3, endIndex: 5, topSpacerPx: 0, bottomSpacerPx: 0 }, 5)
      ).toBe(true)
    })

    it('is false when rows remain below the window', () => {
      expect(
        windowReachesEnd({ startIndex: 0, endIndex: 3, topSpacerPx: 0, bottomSpacerPx: 200 }, 5)
      ).toBe(false)
    })
  })

  describe('findScrollAnchor', () => {
    const heights = [100, 100, 100, 100, 100] // tops at 0,100,200,300,400

    it('anchors the top row at scrollTop 0', () => {
      expect(findScrollAnchor(0, heights)).toEqual({ index: 0, offsetWithin: 0 })
    })

    it('returns the row intersecting the viewport top with its sub-row offset', () => {
      // scrollTop 250 sits 50px into row 2 (top at 200).
      expect(findScrollAnchor(250, heights)).toEqual({ index: 2, offsetWithin: 50 })
    })

    it('treats a row boundary as belonging to the lower row', () => {
      // At exactly 200, row 2 (top 200, bottom 300) is the first whose
      // bottom is strictly past 200.
      expect(findScrollAnchor(200, heights)).toEqual({ index: 2, offsetWithin: 0 })
    })

    it('anchors the last row when scrolled at/below the end', () => {
      expect(findScrollAnchor(99999, heights)).toEqual({ index: 4, offsetWithin: 99999 - 400 })
    })

    it('round-trips with sumHeights: Σ(before anchor) + offsetWithin === scrollTop', () => {
      // This is the invariant the renderer relies on to restore scroll:
      // restoring to Σ(heights before anchor.index) + offsetWithin must
      // reproduce the exact scrollTop the anchor was captured at.
      for (const scrollTop of [0, 37, 100, 250, 399, 500]) {
        const a = findScrollAnchor(scrollTop, heights)
        const restored = sumHeights(heights, 0, a.index) + a.offsetWithin
        expect(restored).toBeCloseTo(Math.min(scrollTop, 500), 5)
      }
    })

    it('defends against empty heights and non-finite scrollTop', () => {
      expect(findScrollAnchor(100, [])).toEqual({ index: 0, offsetWithin: 0 })
      expect(findScrollAnchor(Number.NaN, heights)).toEqual({ index: 0, offsetWithin: 0 })
    })

    it('1.0.7 — absolute restore is idempotent (cannot accumulate)', () => {
      // The renderer's Phase-1 anchor correction targets
      // scrollTop = Σ(heights before anchor.index) + offsetWithin. Re-applying
      // that target over UNCHANGED heights must move scrollTop by 0 — the
      // anti-accumulation property the old relative `+= delta` lacked.
      const a = findScrollAnchor(250, heights)
      const target1 = sumHeights(heights, 0, a.index) + a.offsetWithin
      // Re-derive the anchor at the restored position; the target must be stable.
      const a2 = findScrollAnchor(target1, heights)
      const target2 = sumHeights(heights, 0, a2.index) + a2.offsetWithin
      expect(target2).toBeCloseTo(target1, 5)
    })

    it('1.0.7 — absolute restore holds the anchor row fixed when rows ABOVE grow (scroll-up case)', () => {
      // Anchor on a mid-list row, then GROW every row above it (estimate→
      // measured). Restoring to Σ(grown heights before anchor) + offsetWithin
      // keeps the anchor row's visual top (scrollTop − Σbefore) invariant — so
      // the viewport does not bump down. This is the Q2 fix encoded.
      const before = [100, 100, 100, 100, 100, 100] // 6 rows, 600px total
      const scrollTop = 250 // sits 50px into row index 2
      const a = findScrollAnchor(scrollTop, before)
      expect(a.index).toBe(2)
      const visualTopBefore = scrollTop - sumHeights(before, 0, a.index) // 50
      // Rows above the anchor (indices 0,1) each measure 300 instead of 100.
      const after = [300, 300, 100, 100, 100, 100]
      const restored = sumHeights(after, 0, a.index) + a.offsetWithin // 600 + 50
      const visualTopAfter = restored - sumHeights(after, 0, a.index)
      expect(visualTopAfter).toBeCloseTo(visualTopBefore, 5)
      expect(restored).toBe(650) // viewport moves to keep the row fixed, no drift
    })

    it('1.0.7 — absolute restore holds the anchor row fixed when rows ABOVE shrink (scroll-down case)', () => {
      // Symmetric: rows above measure SHORTER than estimate. The restore moves
      // scrollTop UP by exactly the right amount — the Q3 fix.
      const before = [300, 300, 100, 100]
      const scrollTop = 650 // 50px into row index 2
      const a = findScrollAnchor(scrollTop, before)
      expect(a.index).toBe(2)
      const after = [100, 100, 100, 100] // rows above shrink 300→100
      const restored = sumHeights(after, 0, a.index) + a.offsetWithin // 200 + 50
      expect(restored).toBe(250)
      // Anchor row's visual top is preserved (50px) in both frames.
      expect(restored - sumHeights(after, 0, a.index)).toBeCloseTo(
        scrollTop - sumHeights(before, 0, a.index),
        5
      )
    })
  })

  describe('TRANSCRIPT_VIRTUALIZATION_ENABLED', () => {
    it('is ON by default after the TV3 flip', () => {
      // Pinned here so flipping the global default is always an
      // explicit, reviewed change. The non-virtualised fallback stays
      // reachable via the `virtualize={false}` prop until post-soak.
      expect(TRANSCRIPT_VIRTUALIZATION_ENABLED).toBe(true)
    })
  })
})

describe('activity output estimate cap (long-thinking phantom height)', () => {
  const bigThinking = (chars: number): ToolActivity =>
    ({
      id: 'think-1',
      toolName: 'codex_reasoning',
      displayName: 'Reasoning',
      category: 'unknown',
      status: 'success',
      outputPreview: 'x'.repeat(chars)
    }) as ToolActivity

  it('caps a single massive activity output instead of scaling toward the 1400px ceiling', () => {
    const row = projectRows([
      msg({ id: 'm1', role: 'tool', content: '', toolActivities: [bigThinking(100_000)] })
    ])[0]
    // One activity: count term + CAPPED output term, never the raw 100k chars.
    const cappedChars = 180 + ACTIVITY_OUTPUT_ESTIMATE_CHAR_CAP
    expect(row.estimatedHeight).toBe(
      Math.max(ESTIMATED_ROW_HEIGHT_PX.tool, Math.round(cappedChars * CONTENT_PX_PER_CHAR))
    )
    expect(row.estimatedHeight).toBeLessThan(CONTENT_SCALE_CAP_PX / 2)
  })

  it('still scales with activity COUNT (real height driver for tool rows)', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      ...bigThinking(1_000),
      id: `a-${i}`
    }))
    const one = projectRows([
      msg({ id: 'm1', role: 'tool', content: '', toolActivities: many.slice(0, 1) })
    ])[0]
    const ten = projectRows([msg({ id: 'm2', role: 'tool', content: '', toolActivities: many })])[0]
    expect(ten.estimatedHeight).toBeGreaterThan(one.estimatedHeight)
  })
})

describe('getRowHeight geometry fallback (mid-transcript updating rows)', () => {
  const row: VirtualRow = {
    id: 'm1',
    rowKey: 'm1#3',
    index: 3,
    rowType: 'tool',
    contentVersion: 't:1:running|:5000',
    estimatedHeight: 1200,
    hasRunBoundary: false
  }

  it('prefers the exact content-version measurement', () => {
    const measurements = new Map([[measurementKey('m1#3', row.contentVersion, 900, false), 260]])
    const geometry = new Map([[geometryKey('m1#3', 900, false), 240]])
    expect(getRowHeight(row, measurements, 900, false, row.contentVersion, geometry)).toBe(260)
  })

  it('falls back to the last height at this geometry on a content-version miss', () => {
    // The row's thinking grew (new contentVersion) while it was NOT the live
    // tail — reuse its previous real height, never the 1200px estimate.
    const measurements = new Map([[measurementKey('m1#3', 'stale-version', 900, false), 260]])
    const geometry = new Map([[geometryKey('m1#3', 900, false), 260]])
    expect(getRowHeight(row, measurements, 900, false, row.contentVersion, geometry)).toBe(260)
  })

  it('uses the estimate only when the row was never measured at this geometry', () => {
    const geometry = new Map([[geometryKey('m1#3', 820, false), 260]]) // other bucket
    expect(getRowHeight(row, new Map(), 900, false, row.contentVersion, geometry)).toBe(1200)
    expect(getRowHeight(row, new Map(), 900, false, row.contentVersion, undefined)).toBe(1200)
  })
})

describe('decideScrollerBoxRefresh (pane-local scroller resize policy)', () => {
  it('re-selects the window pre-scroll only when the viewport actually changed', () => {
    // Before the first real scroll the window is driven by the
    // forced-bottom-on-load position, which depends on the viewport height.
    expect(
      decideScrollerBoxRefresh({
        hasScrolled: false,
        bucketChanged: false,
        viewportChanged: true,
        bandChanged: false
      })
    ).toEqual({ remeasure: false, rebaselineAnchor: false, reselectWindow: true })
    // The observer's initial fire reports the size it already had — a no-op.
    expect(
      decideScrollerBoxRefresh({
        hasScrolled: false,
        bucketChanged: false,
        viewportChanged: false,
        bandChanged: false
      })
    ).toEqual({ remeasure: false, rebaselineAnchor: false, reselectWindow: false })
  })

  it('after a real scroll, a grown pane re-baselines the anchor and re-selects on band change', () => {
    expect(
      decideScrollerBoxRefresh({
        hasScrolled: true,
        bucketChanged: false,
        viewportChanged: true,
        bandChanged: true
      })
    ).toEqual({ remeasure: false, rebaselineAnchor: true, reselectWindow: true })
  })

  it('a width-bucket change invalidates measurements and re-baselines, even mid-history', () => {
    expect(
      decideScrollerBoxRefresh({
        hasScrolled: true,
        bucketChanged: true,
        viewportChanged: false,
        bandChanged: false
      })
    ).toEqual({ remeasure: true, rebaselineAnchor: true, reselectWindow: false })
  })

  it('an unchanged box after scrolling does nothing', () => {
    expect(
      decideScrollerBoxRefresh({
        hasScrolled: true,
        bucketChanged: false,
        viewportChanged: false,
        bandChanged: false
      })
    ).toEqual({ remeasure: false, rebaselineAnchor: false, reselectWindow: false })
  })
})

describe('useTranscriptVirtualization wiring (scroller box observer)', () => {
  it('observes the scroller box and refreshes without flipping hasScrolled', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/TranscriptPanel.tsx'),
      'utf8'
    )
    const start = source.indexOf('scrollerBoxObserver')
    // A Multiview divider drag, layout switch, or composer chrome collapse
    // resizes the pane's scroller with neither a window resize nor a scroll
    // event; the virtualizer must observe the scroller box itself or its
    // viewport/bucket metrics go stale and the mounted band under-covers the
    // viewport (the resting-pane blank-gap-until-scroll report, 2026-08-27).
    expect(start).toBeGreaterThan(-1)
    const effectEnd = source.indexOf('// Shared ResizeObserver on individual mounted blocks', start)
    expect(effectEnd).toBeGreaterThan(start)
    const wiring = source.slice(start, effectEnd)
    expect(wiring).toContain('decideScrollerBoxRefresh({')
    expect(wiring).toContain('.observe(scroller)')
    // The observer fires once at observe time; that initial fire is NOT a
    // scroll, and forced-bottom-on-load depends on hasScrolledRef staying
    // false until the snap-to-bottom runs.
    expect(wiring).not.toContain('hasScrolledRef.current = true')
  })
})

describe('row keys survive accumulated infinite scroll', () => {
  const ids = (rows: VirtualRow[]): string[] => rows.map((row) => row.rowKey)

  it('keys a row by message id and occurrence, not by list index', () => {
    const rows = projectRows([msg({ id: 'a' }), msg({ id: 'b' }), msg({ id: 'c' })])
    expect(ids(rows)).toEqual(['a#0', 'b#0', 'c#0'])
  })

  it('keeps every existing row key identical when older history is prepended', () => {
    const before = projectRows([msg({ id: 'c' }), msg({ id: 'd' })])
    // Exactly what a prepend produces: the same tail, now at indices 2 and 3.
    const after = projectRows([
      msg({ id: 'a' }),
      msg({ id: 'b' }),
      msg({ id: 'c' }),
      msg({ id: 'd' })
    ])

    // Index-embedded keys would have renamed c#0/d#1 to c#2/d#3 here, orphaning
    // the measurement slot and DOM element of every row already on screen and
    // forcing a re-measure from coarse estimates — the visible jolt seamless
    // scrolling exists to remove.
    expect(ids(after).slice(2)).toEqual(ids(before))
    expect(new Set(ids(after)).size).toBe(4)
  })

  it('keeps existing row keys identical when newer history is appended', () => {
    const before = projectRows([msg({ id: 'a' }), msg({ id: 'b' })])
    const after = projectRows([msg({ id: 'a' }), msg({ id: 'b' }), msg({ id: 'c' })])
    expect(ids(after).slice(0, 2)).toEqual(ids(before))
  })

  it('still gives duplicate message ids distinct keys', () => {
    // Duplicate ids exist in historical/imported transcripts; two rows sharing
    // one measurement slot would mis-size both.
    const rows = projectRows([msg({ id: 'dup' }), msg({ id: 'other' }), msg({ id: 'dup' })])
    expect(ids(rows)).toEqual(['dup#0', 'other#0', 'dup#1'])
    expect(new Set(ids(rows)).size).toBe(3)
  })

  it('never lets a prepended duplicate collide with the row already on screen', () => {
    const rows = projectRows([msg({ id: 'dup' }), msg({ id: 'x' }), msg({ id: 'dup' })])
    expect(new Set(ids(rows)).size).toBe(rows.length)
  })

  describe('projectRowsAfterSharedPrefix (streaming re-projection)', () => {
    it('reuses prefix row objects by reference', () => {
      const messages = [msg({ id: 'a' }), msg({ id: 'b' })]
      const cached = projectRows(messages)
      const next = projectRowsAfterSharedPrefix(cached, [...messages, msg({ id: 'c' })], 2)
      expect(next[0]).toBe(cached[0])
      expect(next[1]).toBe(cached[1])
      expect(ids(next)).toEqual(['a#0', 'b#0', 'c#0'])
    })

    it('carries prefix occurrence counts into the streamed tail', () => {
      // `dup` is first seen INSIDE the reused prefix. The tail walk starts with
      // an empty counter unless the prefix counts are carried in, which would
      // key this second row `dup#0` as well — two rows on one measurement slot
      // and one DOM element, i.e. the 1.0.7 duplicate-id bug re-created for
      // lists that stream.
      const prefix = [msg({ id: 'dup' }), msg({ id: 'x' })]
      const cached = projectRows(prefix)
      const next = projectRowsAfterSharedPrefix(cached, [...prefix, msg({ id: 'dup' })], 2)
      expect(ids(next)).toEqual(['dup#0', 'x#0', 'dup#1'])
      expect(new Set(ids(next)).size).toBe(next.length)
    })

    it('drops cached rows beyond the shared prefix', () => {
      const messages = [msg({ id: 'a' }), msg({ id: 'b' }), msg({ id: 'c' })]
      const cached = projectRows(messages)
      const next = projectRowsAfterSharedPrefix(cached, [msg({ id: 'a' }), msg({ id: 'z' })], 1)
      expect(ids(next)).toEqual(['a#0', 'z#0'])
    })
  })
})

describe('headExtensionScrollTop (prepend scroll anchoring)', () => {
  // 40 older rows landed above the viewport and added 1200px to the scroller.
  const measured = {
    previousWindowStart: 100,
    windowStart: 60,
    previousScrollHeight: 4000,
    scrollHeight: 5200,
    scrollTop: 300
  }

  it('corrects scrollTop by the measured growth when the window head extends', () => {
    // The content the reader was looking at is now 1200px further down, so
    // scrollTop follows it exactly and the prepend is invisible.
    expect(headExtensionScrollTop(measured)).toBe(1500)
  })

  it('leaves an append alone: the head did not move and growth is below the viewport', () => {
    expect(headExtensionScrollTop({ ...measured, windowStart: 100 })).toBeNull()
  })

  it('leaves a wholesale replace / jump alone: the head moved LATER', () => {
    expect(headExtensionScrollTop({ ...measured, windowStart: 140 })).toBeNull()
  })

  it('is a no-op on first paint, before any height was measured', () => {
    expect(headExtensionScrollTop({ ...measured, previousScrollHeight: 0 })).toBeNull()
  })

  it('is a no-op while the head extended but nothing has been laid out yet', () => {
    expect(headExtensionScrollTop({ ...measured, scrollHeight: 4000 })).toBeNull()
  })
})
