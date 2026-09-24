import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'module'
import { afterAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const collector = require('./hostSpans.cjs') as {
  normalizeWorkSpanSection: (
    section: unknown,
    processName?: string
  ) => { ok: true; section: unknown } | { ok: false; reason: string }
  applyCrossThreadToMetrics: (
    metrics: Record<string, unknown>,
    cell: string,
    sections: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Record<string, unknown>
  readHostPerfSnapshotFile: (options: Record<string, unknown>) => Record<string, unknown>
}

const CELL = 'large/2/cold/ollama_same_model_repeated/none'

/** A valid Host section: three accepted spans, the newest two in the tail. */
function section(recentOverrides: Record<string, unknown> = {}, sectionOverrides = {}) {
  return {
    process: 'host',
    byKind: {},
    byResource: {},
    recorded: 3,
    dropped: 0,
    sampledOut: 0,
    rejected: 0,
    degraded: 0,
    recentSpans: {
      encoding: 'ring_tail_rows_v1',
      columns: [
        'seq',
        'chat',
        'kind',
        'resource',
        'startedAt',
        'durationMs',
        'bytes',
        'fallback',
        'reason'
      ],
      limit: 2,
      fromSeq: 2,
      toSeq: 3,
      omittedMaxStartedAt: 1_000,
      chats: ['chat-01', 'chat-02'],
      rows: [
        [2, 0, 'host_queue_wait', 'host_chain', 1_100, 4, 0, false, null],
        [3, 1, 'persist_barrier', 'host_chain', 1_200, 90, 512, true, 'receipt_poll']
      ],
      ...recentOverrides
    },
    ...sectionOverrides
  }
}

function refusal(recentOverrides: Record<string, unknown>, sectionOverrides = {}): string {
  const result = collector.normalizeWorkSpanSection(
    section(recentOverrides, sectionOverrides),
    'host'
  )
  if (result.ok) throw new Error('expected a refusal')
  return result.reason
}

const row = (overrides: Record<number, unknown>) => {
  const base: unknown[] = [
    3,
    1,
    'persist_barrier',
    'host_chain',
    1_200,
    90,
    512,
    true,
    'receipt_poll'
  ]
  for (const [index, value] of Object.entries(overrides)) base[Number(index)] = value
  return [[2, 0, 'host_queue_wait', 'host_chain', 1_100, 4, 0, false, null], base]
}

describe('the recent-span tail in a Host work-span section', () => {
  it('accepts the tail the Host writes, and a section without one', () => {
    expect(collector.normalizeWorkSpanSection(section(), 'host')).toMatchObject({ ok: true })
    const { recentSpans: _absent, ...legacy } = section()
    expect(collector.normalizeWorkSpanSection(legacy, 'host')).toMatchObject({ ok: true })
    expect(
      collector.normalizeWorkSpanSection(
        section({ limit: 0, fromSeq: null, toSeq: null, chats: [], rows: [] }),
        'host'
      )
    ).toMatchObject({ ok: true })
    expect(
      collector.normalizeWorkSpanSection(
        section(
          { fromSeq: null, toSeq: null, omittedMaxStartedAt: null, chats: [], rows: [] },
          { recorded: 0 }
        ),
        'host'
      )
    ).toMatchObject({ ok: true })
  })

  it.each([
    [
      'a missing encoding',
      { encoding: undefined },
      'recentSpans.encoding must be ring_tail_rows_v1'
    ],
    ['another encoding', { encoding: 'ring_tail_rows_v2' }, 'recentSpans.encoding'],
    ['reordered columns', { columns: ['chat', 'seq'] }, 'recentSpans.columns must be'],
    ['a negative limit', { limit: -1 }, 'recentSpans.limit'],
    ['rows over the limit', { limit: 1 }, 'rows must be the newest min(limit, retained) spans'],
    ['rows short of the limit', { limit: 3 }, 'rows must be the newest min(limit, retained) spans'],
    ['a fractional limit', { limit: 1.5 }, 'recentSpans.limit must be a non-negative integer'],
    ['an extra field', { note: 'x' }, 'recentSpans must carry exactly chats,columns,encoding'],
    ['a repeated chat', { chats: ['chat-01', 'chat-01'] }, 'recentSpans.chats must be distinct'],
    ['an empty chat id', { chats: ['', 'chat-02'] }, 'recentSpans.chats must be distinct'],
    [
      'a short row',
      { rows: [[2, 0, 'host_queue_wait'], row({})[1]] },
      'rows[0] must be a row of 9 columns'
    ],
    ['a fractional seq', { rows: row({ 0: 3.5 }) }, 'rows[1] seq must be a positive integer'],
    ['a chat index past the table', { rows: row({ 1: 2 }) }, 'rows[1] chat must index'],
    ['an unknown kind', { rows: row({ 2: 'nap' }) }, 'rows[1] kind is not a known span kind'],
    ['an unknown resource', { rows: row({ 3: 'gpu' }) }, 'rows[1] resource is not a known'],
    ['a negative start', { rows: row({ 4: -1 }) }, 'rows[1] startedAt must be finite'],
    ['a non-finite duration', { rows: row({ 5: null }) }, 'rows[1] durationMs must be finite'],
    ['negative bytes', { rows: row({ 6: -2 }) }, 'rows[1] bytes must be finite'],
    ['a non-boolean fallback', { rows: row({ 7: 1 }) }, 'rows[1] fallback must be a boolean'],
    ['another kind’s reason', { rows: row({ 8: 'queued' }) }, 'rows[1] reason is not a known'],
    ['a reason on a reasonless kind', { rows: row({ 2: 'durable_commit' }) }, 'rows[1] reason'],
    ['a skipped seq', { rows: row({ 0: 4 }) }, 'rows[1].seq must follow the previous row'],
    ['an unused chat', { chats: ['chat-01', 'chat-02', 'chat-03'] }, 'only chats its rows use'],
    ['a fromSeq off its rows', { fromSeq: 1 }, 'fromSeq and toSeq must name'],
    ['a toSeq off its rows', { toSeq: 4 }, 'fromSeq and toSeq must name'],
    ['a negative watermark', { omittedMaxStartedAt: -1 }, 'omittedMaxStartedAt must be null'],
    ['a string watermark', { omittedMaxStartedAt: '1000' }, 'omittedMaxStartedAt must be null'],
    ['no watermark before a later tail', { omittedMaxStartedAt: null }, 'set exactly when']
  ])('refuses %s', (_label, overrides, reason) => {
    expect(refusal(overrides)).toContain(reason)
  })

  it('refuses a tail that is not an object, or does not end at the newest accepted span', () => {
    expect(refusal({}, { recentSpans: 'rows' })).toContain('recentSpans must be an object')
    const { chats: _chats, ...partial } = section().recentSpans
    expect(refusal({}, { recentSpans: partial })).toContain('recentSpans must carry exactly')
    expect(refusal({}, { recorded: 4 })).toContain('must end at the newest accepted span')
  })

  it('refuses a tail over counts the Host writer cannot produce', () => {
    const counts = 'recentSpans needs integer recorded and dropped counts'
    expect(refusal({}, { recorded: 3.5 })).toContain(counts)
    expect(refusal({}, { dropped: 0.5 })).toContain(counts)
    expect(refusal({}, { dropped: 4 })).toContain(counts)
    const empty = { fromSeq: null, toSeq: null, omittedMaxStartedAt: null, chats: [], rows: [] }
    expect(refusal(empty, { recorded: 0.5 })).toContain(counts)
    // The ring retains recorded - dropped spans, and the tail is the newest
    // min(limit, retained) of them: never fewer, never none while any remain.
    const retained = 'rows must be the newest min(limit, retained) spans'
    expect(refusal({}, { dropped: 2 })).toContain(retained)
    expect(refusal({ ...empty, omittedMaxStartedAt: 1_000 })).toContain(retained)
  })

  it('refuses a watermark when nothing precedes the tail', () => {
    expect(
      refusal(
        { fromSeq: null, toSeq: null, omittedMaxStartedAt: 5, chats: [], rows: [] },
        { recorded: 0 }
      )
    ).toContain('set exactly when')
    expect(
      refusal({
        limit: 0,
        fromSeq: null,
        toSeq: null,
        omittedMaxStartedAt: null,
        chats: [],
        rows: []
      })
    ).toContain('set exactly when')
  })

  it('keeps the tail out of the stored crossThread cell and leaves the input intact', () => {
    const host = section()
    const metrics: Record<string, unknown> = {}
    collector.applyCrossThreadToMetrics(metrics, CELL, { host }, { now: () => new Date(0) })
    const cell = (metrics.crossThread as { cells: Record<string, { processes: { host: object } }> })
      .cells[CELL]
    expect(cell.processes.host).not.toHaveProperty('recentSpans')
    expect(cell.processes.host).toMatchObject({ process: 'host', recorded: 3 })
    expect(host.recentSpans.rows).toHaveLength(2)
  })
})

describe('readHostPerfSnapshotFile truncation.recentSpans', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })
  const at = new Date('2026-09-24T12:00:00.000Z')

  function readWith(truncation: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), 'host-recent-spans-'))
    dirs.push(dir)
    const path = join(dir, 'host-snapshot.json')
    const { recentSpans: _dropped, ...workSpans } = section()
    writeFileSync(
      path,
      JSON.stringify({
        identity: { process: 'host', instanceId: 'host-abc', generation: 1, pid: 99 },
        sequence: 1,
        capturedAt: at.toISOString(),
        truncated: true,
        truncation,
        snapshot: { eventLoopLag: {}, sections: { workSpans } }
      })
    )
    return collector.readHostPerfSnapshotFile({ hostPerfSnapshotPath: path, now: () => at })
  }

  it('accepts a boolean marker and refuses any other value', () => {
    expect(readWith({ extraSections: true, recentSpans: true, byChat: false })).toMatchObject({
      truncation: { extraSections: true, recentSpans: true, byChat: false }
    })
    expect(readWith({ extraSections: true, recentSpans: 'yes', byChat: false })).toEqual({
      unsupported: 'host_perf_snapshot_invalid: truncation'
    })
    expect(readWith({ extraSections: true, byChat: false })).toMatchObject({
      truncation: { extraSections: true, byChat: false }
    })
  })
})

describe('readHostPerfSnapshotFile keepRecentSpans', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })
  const at = new Date('2026-09-24T12:00:00.000Z')

  it('validates the tail on every read, and returns it only when asked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-recent-spans-keep-'))
    dirs.push(dir)
    const path = join(dir, 'host-snapshot.json')
    const write = (workSpans: unknown) =>
      writeFileSync(
        path,
        JSON.stringify({
          identity: { process: 'host', instanceId: 'host-1', generation: 1, pid: 4242 },
          sequence: 1,
          capturedAt: at.toISOString(),
          snapshot: { eventLoopLag: {}, sections: { workSpans } }
        })
      )
    const read = (options: Record<string, unknown> = {}) =>
      collector.readHostPerfSnapshotFile({ hostPerfSnapshotPath: path, now: () => at, ...options })
    write(section())
    const plain = read() as { workSpans: Record<string, unknown> }
    expect(plain.workSpans).not.toHaveProperty('recentSpans')
    expect(plain.workSpans).toMatchObject({ process: 'host', recorded: 3 })
    const kept = read({ keepRecentSpans: true }) as { workSpans: Record<string, unknown> }
    expect(kept.workSpans.recentSpans).toEqual(section().recentSpans)
    write(section({ limit: 1 }))
    expect(read()).toMatchObject({
      unsupported: expect.stringContaining('rows must be the newest min(limit, retained) spans')
    })
  })
})
