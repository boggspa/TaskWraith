import { describe, expect, it } from 'vitest'

import type { EnsembleHostAdmissionSnapshot } from '../services/EnsembleHostAdmissionScheduler'
import { MainSourceProbe } from '../mainSourceProbe.testutil'
import {
  PERF_WORK_SPANS_GLOBAL,
  installMainPerfWorkSpanHandle,
  readPerfWorkSpanWindow
} from './perfWorkSpanHandle'
import { createWorkSpanRecorder, type WorkSpanRecordInput } from './WorkSpanRecorder'

const LIGHT = 'perf-light_beside_large_live-chat-01'
const HEAVY = 'perf-light_beside_large_live-chat-02'
const OTHER = 'chat-someone-else'

function span(chatId: string, startedAt: number, overrides: Partial<WorkSpanRecordInput> = {}) {
  return {
    chatId,
    runId: `run-${chatId}-${startedAt}`,
    participantId: 'perf-seat-02',
    laneId: 'lane-9',
    kind: 'round_start',
    resource: 'none',
    startedAt,
    durationMs: 40,
    ...overrides
  } as WorkSpanRecordInput
}

function recorderWith(spans: WorkSpanRecordInput[], maxRetained = 64) {
  const recorder = createWorkSpanRecorder({ process: 'main', maxRetained })
  for (const entry of spans) recorder.record(entry)
  return recorder
}

function admissionSnapshot(): EnsembleHostAdmissionSnapshot {
  return {
    occupancy: {
      maxActive: 16,
      maxForeground: 12,
      reservedLaneSlots: 4,
      maxQueued: 512,
      active: 3,
      activeForeground: 2,
      activeLanes: 1,
      queued: 5,
      queuedForeground: 4,
      queuedLanes: 1,
      shuttingDown: false
    },
    metrics: { requests: 9, admitted: 4, admittedQueueWaitMs: 120 },
    byChat: [
      { chatId: HEAVY, active: 3, queued: 5 },
      { chatId: OTHER, active: 1, queued: 0 }
    ],
    byProvider: [{ provider: 'ollama', active: 3, queued: 5 }]
  } as unknown as EnsembleHostAdmissionSnapshot
}

const query = (overrides: Record<string, unknown> = {}) => ({
  lanes: { light: LIGHT, heavy: HEAVY },
  sinceMs: 1_000,
  untilMs: 2_000,
  ...overrides
})

describe('readPerfWorkSpanWindow', () => {
  it('reads each lane’s spans in the window as timings, with no identity at all', () => {
    const recorder = recorderWith([
      span(LIGHT, 900),
      span(LIGHT, 1_000),
      span(LIGHT, 1_500, {
        kind: 'persist_barrier',
        reason: 'barrier',
        durationMs: 12,
        bytes: 2048,
        fallback: true
      }),
      span(HEAVY, 1_200, { kind: 'admission_wait', resource: 'ensemble_pool', reason: 'queued' }),
      span(OTHER, 1_300),
      span(LIGHT, 2_000)
    ])
    const read = readPerfWorkSpanWindow(
      { recorder, admission: admissionSnapshot, now: () => 5_000 },
      query()
    )
    expect(read).toMatchObject({
      sampledAt: 5_000,
      sinceMs: 1_000,
      untilMs: 2_000,
      censored: false
    })
    if (!('lanes' in read)) throw new Error('expected a window')
    expect(read.lanes.light.spans).toEqual([
      {
        kind: 'round_start',
        startedAt: 1_000,
        durationMs: 40,
        resource: 'none',
        bytes: 0,
        fallback: false
      },
      {
        kind: 'persist_barrier',
        startedAt: 1_500,
        durationMs: 12,
        resource: 'none',
        bytes: 2048,
        fallback: true,
        reason: 'barrier'
      }
    ])
    expect(read.lanes.heavy.spans).toEqual([
      {
        kind: 'admission_wait',
        startedAt: 1_200,
        durationMs: 40,
        resource: 'ensemble_pool',
        bytes: 0,
        fallback: false,
        reason: 'queued'
      }
    ])
    const serialized = JSON.stringify(read)
    for (const identity of [LIGHT, HEAVY, OTHER, 'run-', 'perf-seat-02', 'lane-9', 'ollama']) {
      expect(serialized).not.toContain(identity)
    }
  })

  it('carries admission occupancy as numbers and each lane’s own admission counts', () => {
    const read = readPerfWorkSpanWindow(
      { recorder: recorderWith([]), admission: admissionSnapshot, now: () => 5_000 },
      query()
    )
    if (!('lanes' in read)) throw new Error('expected a window')
    expect(read.admission).toEqual({
      occupancy: admissionSnapshot().occupancy,
      metrics: { requests: 9, admitted: 4, admittedQueueWaitMs: 120 }
    })
    expect(read.lanes.light.admission).toEqual({ active: 0, queued: 0 })
    expect(read.lanes.heavy.admission).toEqual({ active: 3, queued: 5 })

    const unavailable = readPerfWorkSpanWindow(
      {
        recorder: recorderWith([]),
        admission: () => {
          throw new Error('scheduler gone')
        },
        now: () => 5_000
      },
      query()
    )
    if (!('lanes' in unavailable)) throw new Error('expected a window')
    expect(unavailable.admission).toBeNull()
    expect(unavailable.lanes.light.admission).toBeNull()
  })

  it('censors a window the ring evicted into, and only then', () => {
    const recorder = recorderWith([span(LIGHT, 1_000), span(LIGHT, 1_100), span(LIGHT, 1_200)], 2)
    const at = (sinceMs: number) =>
      readPerfWorkSpanWindow({ recorder, now: () => 5_000 }, query({ sinceMs }))
    expect(at(1_000)).toMatchObject({ censored: true })
    expect(at(1_001)).toMatchObject({ censored: false })
    // Nothing evicted: a window from zero is whole.
    const whole = readPerfWorkSpanWindow(
      { recorder: recorderWith([span(LIGHT, 1_000)]), now: () => 5_000 },
      query({ sinceMs: 0 })
    )
    expect(whole).toMatchObject({ censored: false })
  })

  it('reads every lost-span counter through, each distinct', () => {
    // A clock that always throws degrades every begin(); record() carries its own times.
    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 2,
      sampler: (attrs) => attrs.chatId !== OTHER,
      now: () => {
        throw new Error('clock gone')
      }
    })
    for (const startedAt of [1_000, 1_100, 1_200]) recorder.record(span(LIGHT, startedAt))
    for (const startedAt of [1_300, 1_400]) recorder.record(span(OTHER, startedAt))
    for (let i = 0; i < 3; i += 1) recorder.record(span(LIGHT, 1_500, { kind: 'nap' as never }))
    for (let i = 0; i < 4; i += 1) {
      recorder.begin({ chatId: LIGHT, kind: 'round_start', resource: 'none' })
    }
    const read = readPerfWorkSpanWindow({ recorder, now: () => 5_000 }, query({ sinceMs: 1_050 }))
    expect(read).toMatchObject({
      censored: false,
      ring: { recorded: 3, dropped: 1, sampledOut: 2, rejected: 3, degraded: 4 }
    })
  })

  it('reads admission down to numbers, and survives a snapshot without its parts', () => {
    const noisy = () =>
      ({
        ...admissionSnapshot(),
        occupancy: {
          ...admissionSnapshot().occupancy,
          shuttingDown: true,
          note: OTHER,
          lag: Number.NaN
        },
        metrics: { requests: 9, provider: 'ollama', broken: Number.POSITIVE_INFINITY }
      }) as unknown as EnsembleHostAdmissionSnapshot
    const read = readPerfWorkSpanWindow(
      { recorder: recorderWith([]), admission: noisy, now: () => 5_000 },
      query()
    )
    if (!('lanes' in read)) throw new Error('expected a window')
    expect(read.admission).toEqual({
      occupancy: { ...admissionSnapshot().occupancy, shuttingDown: true },
      metrics: { requests: 9 }
    })
    expect(JSON.stringify(read)).not.toContain(OTHER)

    const partial = readPerfWorkSpanWindow(
      {
        recorder: recorderWith([]),
        admission: () =>
          ({
            occupancy: admissionSnapshot().occupancy
          }) as unknown as EnsembleHostAdmissionSnapshot,
        now: () => 5_000
      },
      query()
    )
    if (!('lanes' in partial)) throw new Error('expected a window')
    expect(partial.admission).toBeNull()
    expect(partial.lanes.heavy.admission).toBeNull()
  })

  it('reads an empty window, and accepts the widest lanes it allows', () => {
    const recorder = recorderWith([span(LIGHT, 1_000)])
    expect(
      readPerfWorkSpanWindow(
        { recorder, now: () => 5_000 },
        query({ sinceMs: 1_000, untilMs: 1_000 })
      )
    ).toMatchObject({ lanes: { light: { spans: [] } } })
    const lanes = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`${'l'.repeat(31)}${i}`, `${i}`.repeat(256)])
    )
    const read = readPerfWorkSpanWindow(
      { recorder, now: () => 5_000 },
      { lanes, sinceMs: 0, untilMs: 1 }
    )
    if (!('lanes' in read)) throw new Error('expected a window')
    expect(Object.keys(read.lanes)).toEqual(Object.keys(lanes))
  })

  it.each([
    ['no lanes object', { lanes: null, sinceMs: 0, untilMs: 1 }, 'lanes_invalid'],
    ['no lanes', { lanes: {}, sinceMs: 0, untilMs: 1 }, 'lanes_invalid'],
    [
      'nine lanes',
      {
        lanes: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`l${i}`, `c${i}`])),
        sinceMs: 0,
        untilMs: 1
      },
      'lanes_invalid'
    ],
    ['a label with capitals', { lanes: { Light: LIGHT }, sinceMs: 0, untilMs: 1 }, 'lanes_invalid'],
    [
      'a label with a hyphen',
      { lanes: { 'light-lane': LIGHT }, sinceMs: 0, untilMs: 1 },
      'lanes_invalid'
    ],
    [
      'a __proto__ label',
      { lanes: { ['__proto__']: LIGHT }, sinceMs: 0, untilMs: 1 },
      'lanes_invalid'
    ],
    [
      'a 33-character label',
      { lanes: { ['l'.repeat(33)]: LIGHT }, sinceMs: 0, untilMs: 1 },
      'lanes_invalid'
    ],
    ['an empty chat id', { lanes: { light: '' }, sinceMs: 0, untilMs: 1 }, 'lanes_invalid'],
    [
      'a chat id that is not a string',
      { lanes: { light: 42 }, sinceMs: 0, untilMs: 1 },
      'lanes_invalid'
    ],
    [
      'an over-long chat id',
      { lanes: { light: 'x'.repeat(257) }, sinceMs: 0, untilMs: 1 },
      'lanes_invalid'
    ],
    [
      'one chat on two lanes',
      { lanes: { a: LIGHT, b: LIGHT }, sinceMs: 0, untilMs: 1 },
      'lanes_invalid'
    ],
    [
      'a non-finite start',
      { lanes: { light: LIGHT }, sinceMs: Number.NaN, untilMs: 1 },
      'window_invalid'
    ],
    ['a negative start', { lanes: { light: LIGHT }, sinceMs: -1, untilMs: 1 }, 'window_invalid'],
    ['no end', { lanes: { light: LIGHT }, sinceMs: 0 }, 'window_invalid'],
    [
      'an end before the start',
      { lanes: { light: LIGHT }, sinceMs: 10, untilMs: 5 },
      'window_invalid'
    ],
    ['no query at all', undefined, 'lanes_invalid'],
    [
      'a query whose getter throws',
      {
        get lanes() {
          throw new Error('hostile')
        }
      },
      'query_invalid'
    ],
    [
      'lanes that cannot be listed',
      {
        lanes: new Proxy(
          {},
          {
            ownKeys() {
              throw new Error('hostile')
            }
          }
        ),
        sinceMs: 0,
        untilMs: 1
      },
      'query_invalid'
    ]
  ])('refuses %s without throwing', (_label, badQuery, refused) => {
    expect(
      readPerfWorkSpanWindow({ recorder: recorderWith([span(LIGHT, 1)]), now: () => 9 }, badQuery)
    ).toEqual({ sampledAt: 9, refused })
  })
})

describe('installMainPerfWorkSpanHandle', () => {
  it('installs only when the harness flag is set, and reads through the recorder', () => {
    const recorder = recorderWith([span(LIGHT, 1_500)])
    const target: Record<string, unknown> = {}
    expect(installMainPerfWorkSpanHandle(recorder, admissionSnapshot, { env: {}, target })).toBe(
      false
    )
    expect(PERF_WORK_SPANS_GLOBAL in target).toBe(false)
    expect(
      installMainPerfWorkSpanHandle(recorder, admissionSnapshot, {
        env: { PERF_PRELOAD_PROBE: '1' },
        target
      })
    ).toBe(true)
    expect(PERF_WORK_SPANS_GLOBAL).toBe('__TASKWRAITH_PERF_WORK_SPANS__')
    const handle = target[PERF_WORK_SPANS_GLOBAL] as (input: unknown) => unknown
    expect(handle(query())).toMatchObject({
      lanes: { light: { spans: [{ startedAt: 1_500 }] }, heavy: { spans: [] } }
    })
  })

  it('is installed from main’s own recorder and admission runtime', () => {
    const probe = new MainSourceProbe('src/main/index.ts', new URL('../index.ts', import.meta.url))
    const calls = probe.callsTo(probe.source, 'installMainPerfWorkSpanHandle')
    expect(calls).toHaveLength(1)
    expect(probe.argText(calls[0], 0)).toBe('mainWorkSpanRecorder')
    expect(probe.argText(calls[0], 1)).toBe('() => ensembleHostAdmissionRuntime.snapshot()')
  })
})
