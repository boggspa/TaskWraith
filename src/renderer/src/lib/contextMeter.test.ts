import { describe, expect, it } from 'vitest'
import {
  contextPercent,
  currentContextTokens,
  buildParticipantContextRows,
  liveOutputTokensForParticipant
} from './contextMeter'
import type { ChatRun, EnsembleParticipant } from '../../../main/store/types'

const run = (overrides: Partial<ChatRun> = {}): ChatRun =>
  ({
    runId: 'r',
    provider: 'claude',
    startedAt: '2026-05-30T12:00:00.000Z',
    status: 'success',
    ...overrides
  }) as ChatRun

const usage = (input: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
  total_tokens: input + output
})

describe('contextPercent', () => {
  it('clamps to 0..100 and returns 0 for an unknown window', () => {
    expect(contextPercent(50_000, 200_000)).toBe(25)
    expect(contextPercent(500_000, 200_000)).toBe(100)
    expect(contextPercent(-5, 200_000)).toBe(0)
    expect(contextPercent(50_000, 0)).toBe(0)
  })
})

describe('currentContextTokens — honest proxy, NOT a cumulative sum', () => {
  it('uses the LATEST run input+output, not the sum across runs', () => {
    const runs = [
      run({ runId: 'a', startedAt: '2026-05-30T12:00:00.000Z', stats: usage(40_000, 2_000) }),
      run({ runId: 'b', startedAt: '2026-05-30T12:05:00.000Z', stats: usage(95_000, 3_000) })
    ]
    // Cumulative would be 140k; honest = latest run only (95k + 3k).
    expect(currentContextTokens(runs)).toBe(98_000)
  })

  it('ignores runs without usage stats when picking the latest', () => {
    const runs = [
      run({ runId: 'a', startedAt: '2026-05-30T12:00:00.000Z', stats: usage(80_000, 1_000) }),
      run({ runId: 'b', startedAt: '2026-05-30T12:09:00.000Z', stats: undefined })
    ]
    expect(currentContextTokens(runs)).toBe(81_000)
  })

  it('adds the in-flight output estimate only while running', () => {
    const runs = [run({ stats: usage(50_000, 1_000) })]
    expect(currentContextTokens(runs, { liveOutputTokens: 500, isRunning: true })).toBe(51_500)
    expect(currentContextTokens(runs, { liveOutputTokens: 500, isRunning: false })).toBe(51_000)
  })

  it('returns 0 for an empty / statless thread', () => {
    expect(currentContextTokens([])).toBe(0)
    expect(currentContextTokens([run({ stats: undefined })])).toBe(0)
  })
})

describe('buildParticipantContextRows — per-participant honest context', () => {
  const participants: EnsembleParticipant[] = [
    { id: 'p1', provider: 'claude', enabled: true, role: 'Architect', order: 0 } as EnsembleParticipant,
    { id: 'p2', provider: 'codex', enabled: true, role: 'Builder', order: 1 } as EnsembleParticipant
  ]

  it('scopes each row to that participant latest run (not the other participant)', () => {
    const runs = [
      run({ runId: 'p1a', ensembleParticipantId: 'p1', startedAt: '2026-05-30T12:00:00.000Z', stats: usage(10_000, 500) }),
      run({ runId: 'p1b', ensembleParticipantId: 'p1', startedAt: '2026-05-30T12:06:00.000Z', stats: usage(120_000, 4_000) }),
      run({ runId: 'p2a', ensembleParticipantId: 'p2', startedAt: '2026-05-30T12:03:00.000Z', stats: usage(30_000, 1_000) })
    ]
    const rows = buildParticipantContextRows(runs, participants)
    expect(rows.map((r) => [r.id, r.usedTokens])).toEqual([
      ['p1', 124_000],
      ['p2', 31_000]
    ])
    expect(rows[0].role).toBe('Architect')
    expect(rows[0].provider).toBe('claude')
    expect(rows[0].windowTokens).toBeGreaterThan(0)
    expect(rows[0].percent).toBeGreaterThan(0)
  })

  it('reads 0% for a participant that has not run yet', () => {
    const rows = buildParticipantContextRows([], participants)
    expect(rows.every((r) => r.usedTokens === 0 && r.percent === 0)).toBe(true)
  })

  it('uses the latest run-reported context limit for a plan-entitled Kimi seat', () => {
    const kimi = {
      id: 'kimi-k3',
      provider: 'kimi',
      model: 'kimi-k3',
      enabled: true,
      role: 'Builder',
      order: 0
    } as EnsembleParticipant
    const rows = buildParticipantContextRows(
      [
        run({
          provider: 'kimi',
          ensembleParticipantId: kimi.id,
          stats: { ...usage(250_000, 12_000), totalTokenLimit: 1_048_576 }
        })
      ],
      [kimi]
    )

    expect(rows[0].usedTokens).toBe(262_000)
    expect(rows[0].windowTokens).toBe(1_048_576)
    expect(rows[0].percent).toBeCloseTo(24.99, 1)
  })

  it('adds the live output estimate ONLY to the actively-running participant', () => {
    const runs = [
      run({ runId: 'p1a', ensembleParticipantId: 'p1', stats: usage(80_000, 2_000) }),
      run({ runId: 'p2a', ensembleParticipantId: 'p2', stats: usage(30_000, 1_000) })
    ]
    const rows = buildParticipantContextRows(runs, participants, {
      participantId: 'p1',
      outputTokens: 600
    })
    expect(rows.find((r) => r.id === 'p1')?.usedTokens).toBe(82_600) // 80k+2k + 600 live
    expect(rows.find((r) => r.id === 'p2')?.usedTokens).toBe(31_000) // untouched
  })

  it('no live add when participantId is unset', () => {
    const runs = [run({ runId: 'p1a', ensembleParticipantId: 'p1', stats: usage(80_000, 2_000) })]
    const rows = buildParticipantContextRows(runs, participants, { outputTokens: 600 })
    expect(rows.find((r) => r.id === 'p1')?.usedTokens).toBe(82_000)
  })

  it('uses live Ollama context windows supplied by the app for participant rows', () => {
    const rows = buildParticipantContextRows(
      [],
      [
        {
          id: 'ollama-custom',
          provider: 'ollama',
          model: 'custom-local:latest',
          enabled: true,
          role: 'Local',
          order: 0
        } as EnsembleParticipant,
        {
          id: 'claude',
          provider: 'claude',
          model: 'claude-sonnet-4-6',
          enabled: true,
          role: 'Reviewer',
          order: 1
        } as EnsembleParticipant
      ],
      {
        resolveWindowTokens: (participant) =>
          participant.provider === 'ollama' ? 65_536 : undefined
      }
    )

    expect(rows.find((r) => r.id === 'ollama-custom')?.windowTokens).toBe(65_536)
    expect(rows.find((r) => r.id === 'claude')?.windowTokens).toBe(200_000)
  })
})

describe('liveOutputTokensForParticipant — scoped to the active participant only', () => {
  const id = (chars: number) => chars // identity so we assert the char count directly

  it('counts ONLY the active participant unsealed-run output, not earlier sealed peers', () => {
    const runs = [
      // p1 already answered + sealed this round (endedAt set, success)
      run({
        runId: 'p1run',
        ensembleParticipantId: 'p1',
        status: 'success',
        endedAt: '2026-05-30T12:05:00.000Z'
      }),
      // p2 is streaming now (no endedAt, running)
      run({ runId: 'p2run', ensembleParticipantId: 'p2', status: 'running' })
    ]
    const messages = [
      { role: 'assistant', runId: 'p1run', content: 'AAAA' }, // p1 sealed — MUST be ignored
      { role: 'assistant', runId: 'p2run', content: 'BB' }, // p2 live — counted
      { role: 'user', runId: 'p2run', content: 'ignored-non-assistant' }
    ]
    // The bug was: a chat-wide sum gave p2 'AAAA'+'BB'=6; scoped gives only 'BB'=2.
    expect(liveOutputTokensForParticipant(runs, messages, 'p2', id)).toBe(2)
    // p1 has no UNSEALED run → 0 (it's done).
    expect(liveOutputTokensForParticipant(runs, messages, 'p1', id)).toBe(0)
  })

  it('returns 0 when participantId is undefined or has no unsealed run', () => {
    const runs = [run({ runId: 'p2run', ensembleParticipantId: 'p2', status: 'running' })]
    expect(liveOutputTokensForParticipant(runs, [], undefined, id)).toBe(0)
    expect(liveOutputTokensForParticipant([], [], 'p2', id)).toBe(0)
  })
})
