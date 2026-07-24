import { mkdtemp, mkdir, writeFile, rm, utimes, open } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => join(tmpdir(), `taskwraith-external-activity-electron-${process.pid}`)
  }
}))

import {
  applyCursorUsageRecords,
  buildExternalUsageRollup,
  getExternalUsageCached,
  loadExternalProviderUsageRecords,
  resetExternalUsageFrontDoorForTests,
  settleExternalScansForTests,
  setExternalScanDriver,
  setExternalUsageUpdateListener,
  type ExternalScanRequest
} from './ExternalProviderActivity'
import { resetExternalActivityFileCacheForTests } from './ExternalActivityFileCache'
import { buildHeatmapGrid } from '../renderer/src/lib/UsageHeatmap'
import type { UsageRecord } from './store/types'

beforeEach(() => {
  resetExternalActivityFileCacheForTests()
  resetExternalUsageFrontDoorForTests()
})

describe('buildExternalUsageRollup / buildHeatmapGrid parity', () => {
  const now = new Date('2026-05-31T13:00:00.000Z')

  const record = (overrides: Partial<UsageRecord> & { timestamp: number }): UsageRecord => ({
    id: `r-${overrides.timestamp}-${overrides.provider ?? 'codex'}`,
    provider: 'codex',
    workspaceId: 'external',
    chatId: '',
    runId: '',
    model: 'test',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    durationMs: 0,
    ...overrides
  })

  /** Records straddling every boundary the two implementations used to
   * disagree on: the far edge of the 90-day window, a row with a breakdown but
   * no total, and an activity-only marker that must stay at zero. */
  const records: UsageRecord[] = [
    record({ timestamp: now.getTime() - 60 * 60 * 1000, totalTokens: 1_000 }),
    record({ timestamp: now.getTime() - 3 * 24 * 60 * 60 * 1000, totalTokens: 2_000 }),
    record({ timestamp: now.getTime() - 40 * 24 * 60 * 60 * 1000, totalTokens: 4_000 }),
    // Breakdown but no total — the rollup used to count this and the grid did not.
    record({
      timestamp: now.getTime() - 2 * 24 * 60 * 60 * 1000,
      provider: 'claude',
      inputTokens: 10,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 80,
      outputTokens: 10
    }),
    // Activity-only marker: colours a cell, contributes no spend.
    record({ timestamp: now.getTime() - 5 * 60 * 60 * 1000, provider: 'cursor' }),
    // Just inside the oldest calendar column, which a rolling 90x24h cutoff
    // and a calendar-aligned window disagree about.
    record({ timestamp: now.getTime() - 89.5 * 24 * 60 * 60 * 1000, totalTokens: 7_000 })
  ]

  it('reports identical 24h/7d/90d totals to the desktop header', () => {
    const grid = buildHeatmapGrid(records, now, 90)
    const rollup = buildExternalUsageRollup(records, now.getTime())

    expect(rollup.totals.h24).toBe(grid.totals.last24h)
    expect(rollup.totals.d7).toBe(grid.totals.last7d)
    expect(rollup.totals.d90).toBe(grid.totals.window)

    // Pinned, so the two agreeing on a WRONG number cannot pass as parity.
    // 24h: 1_000. 7d: + 2_000 + the 1_000 breakdown-only row. 90d: + 4_000 and
    // the 7_000 row sitting just inside the oldest calendar column.
    expect(rollup.totals.h24).toBe(1_000)
    expect(rollup.totals.d7).toBe(4_000)
    expect(rollup.totals.d90).toBe(15_000)
  })

  it('excludes reset hints and keeps activity-only markers at zero', () => {
    const withHint = [
      ...records,
      record({ timestamp: now.getTime(), usageKind: 'reset_hint', totalTokens: 999_999 })
    ]
    const grid = buildHeatmapGrid(withHint, now, 90)
    const rollup = buildExternalUsageRollup(withHint, now.getTime())

    expect(rollup.totals.d90).toBe(grid.totals.window)
    expect(rollup.providers.find((p) => p.provider === 'cursor')?.d90 ?? 0).toBe(0)
  })
})

describe('loadExternalProviderUsageRecords', () => {
  it('normalizes external provider logs into UsageRecord rows', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-activity-'))
    try {
      await mkdir(join(homeDir, '.codex', 'sessions', '2026', '05', '31'), { recursive: true })
      await mkdir(join(homeDir, '.claude', 'projects', 'sample'), { recursive: true })
      await mkdir(join(homeDir, '.gemini', 'tmp', 'sample', 'chats'), { recursive: true })
      await mkdir(join(homeDir, '.kimi', 'sessions', 'sample', 'turn'), { recursive: true })

      await writeFile(
        join(homeDir, '.codex', 'sessions', '2026', '05', '31', 'rollout.jsonl'),
        [
          JSON.stringify({
            timestamp: '2026-05-31T08:59:00.000Z',
            type: 'turn_context',
            payload: {
              type: 'turn_context',
              model: 'gpt-5.5'
            }
          }),
          JSON.stringify({
            timestamp: '2026-05-31T09:00:00.000Z',
            type: 'event_msg',
            payload: {
              type: 'token_count',
              info: {
                last_token_usage: {
                  input_tokens: 10,
                  cached_input_tokens: 5,
                  output_tokens: 7,
                  reasoning_output_tokens: 3,
                  total_tokens: 17
                }
              }
            }
          })
        ].join('\n')
      )

      await writeFile(
        join(homeDir, '.claude', 'projects', 'sample', 'thread.jsonl'),
        [
          JSON.stringify({
            timestamp: '2026-05-31T10:00:00.000Z',
            requestId: 'req-1',
            message: {
              id: 'msg-1',
              model: 'claude-sonnet',
              usage: {
                input_tokens: 11,
                cache_read_input_tokens: 3,
                output_tokens: 5
              }
            }
          })
        ].join('\n')
      )

      await writeFile(
        join(homeDir, '.gemini', 'tmp', 'sample', 'chats', 'session-2026-05-31.jsonl'),
        [
          JSON.stringify({
            id: 'gemini-1',
            timestamp: '2026-05-31T11:00:00.000Z',
            type: 'gemini',
            model: 'gemini-3.1-pro-preview',
            tokens: { input: 20, output: 4, total: 24 }
          })
        ].join('\n')
      )

      await writeFile(
        join(homeDir, '.kimi', 'sessions', 'sample', 'turn', 'wire.jsonl'),
        [
          JSON.stringify({
            timestamp: Date.parse('2026-05-31T12:00:00.000Z') / 1000,
            message: {
              type: 'StatusUpdate',
              payload: {
                token_usage: {
                  input_other: 13,
                  input_cache_read: 2,
                  input_cache_creation: 1,
                  output: 9
                }
              }
            }
          })
        ].join('\n')
      )

      const records = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T13:00:00.000Z')
      })
      const byProvider = new Map(records.map((record) => [record.provider, record]))

      expect(byProvider.get('codex')).toMatchObject({
        model: 'gpt-5.5',
        inputTokens: 5,
        cacheReadInputTokens: 5,
        outputTokens: 7,
        totalTokens: 17
      })
      expect(byProvider.get('claude')?.totalTokens).toBe(19)
      expect(byProvider.get('claude')?.inputTokens).toBe(11)
      expect(byProvider.get('claude')?.cacheReadInputTokens).toBe(3)
      expect(byProvider.get('gemini')?.totalTokens).toBe(24)
      expect(byProvider.get('kimi')?.totalTokens).toBe(25)
      expect(records.every((record) => record.workspaceId === 'external')).toBe(true)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('does not double-count Codex cache aliases or reasoning subsets', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-codex-subsets-'))
    try {
      const sessionDir = join(homeDir, '.codex', 'sessions', '2026', '05', '31')
      await mkdir(sessionDir, { recursive: true })
      await writeFile(
        join(sessionDir, 'rollout.jsonl'),
        JSON.stringify({
          timestamp: '2026-05-31T09:00:00.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: 10,
                cached_input_tokens: 5,
                cache_read_input_tokens: 5,
                output_tokens: 7,
                reasoning_output_tokens: 3
              }
            }
          }
        })
      )

      const records = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T13:00:00.000Z')
      })

      expect(records.find((record) => record.provider === 'codex')).toMatchObject({
        inputTokens: 5,
        cacheReadInputTokens: 5,
        outputTokens: 7,
        totalTokens: 17
      })
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('reads Grok turn usage from the unified log without double-counting subsets', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-grok-'))
    try {
      await mkdir(join(homeDir, '.grok', 'logs'), { recursive: true })
      await writeFile(
        join(homeDir, '.grok', 'logs', 'unified.jsonl'),
        [
          // Names the model in play; carries no usage of its own.
          JSON.stringify({
            ts: '2026-05-31T09:00:00.000Z',
            msg: 'model catalog: notifying clients',
            ctx: { model_count: 2, current_model_id: 'grok-4.5' }
          }),
          // Auth chatter — the bulk of the log, and never usage.
          JSON.stringify({ ts: '2026-05-31T09:00:01.000Z', msg: 'AuthManager::new', ctx: {} }),
          JSON.stringify({
            ts: '2026-05-31T09:00:02.000Z',
            msg: 'shell.turn.inference_done',
            ctx: {
              prompt_tokens: 1_000,
              cached_prompt_tokens: 800,
              completion_tokens: 120,
              reasoning_tokens: 90
            }
          })
        ].join('\n')
      )

      const records = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T13:00:00.000Z')
      })

      const grok = records.filter((record) => record.provider === 'grok')
      expect(grok).toHaveLength(1)
      expect(grok[0]).toMatchObject({
        // cached_prompt_tokens is inside prompt_tokens, reasoning inside
        // completion: 1_000 + 120, never 1_000 + 800 + 120 + 90.
        totalTokens: 1_120,
        inputTokens: 200,
        cacheReadInputTokens: 800,
        outputTokens: 120,
        model: 'grok-4.5'
      })
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('counts one Claude API call once when it spans several content-block rows', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-claude-blocks-'))
    try {
      const projectDir = join(homeDir, '.claude', 'projects', 'sample')
      await mkdir(projectDir, { recursive: true })
      // One assistant turn with three tool_use blocks: three rows, one API
      // call, and every row repeats the same usage object verbatim except for
      // its sub-second write time.
      const row = (millis: string) =>
        JSON.stringify({
          timestamp: `2026-05-31T09:00:00.${millis}Z`,
          requestId: 'req_abc',
          message: {
            id: 'msg_abc',
            model: 'claude-opus-4-8',
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              cache_read_input_tokens: 900,
              cache_creation_input_tokens: 85
            }
          }
        })
      await writeFile(
        join(projectDir, 'session.jsonl'),
        [row('053'), row('549'), row('988')].join('\n')
      )

      const records = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T13:00:00.000Z')
      })

      const claude = records.filter((record) => record.provider === 'claude')
      expect(claude).toHaveLength(1)
      expect(claude[0]?.totalTokens).toBe(1_000)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('counts a Codex turn once when token_count re-emits an unchanged total', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-codex-repeat-'))
    try {
      const sessionDir = join(homeDir, '.codex', 'sessions', '2026', '05', '31')
      await mkdir(sessionDir, { recursive: true })
      const turn = (minute: string, cumulative: number) =>
        JSON.stringify({
          timestamp: `2026-05-31T09:${minute}:00.000Z`,
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: { total_tokens: cumulative },
              last_token_usage: { input_tokens: 90, output_tokens: 10, total_tokens: 100 }
            }
          }
        })
      await writeFile(
        join(sessionDir, 'rollout.jsonl'),
        // Cumulative advances once, then the same total is re-emitted twice.
        [turn('00', 100), turn('01', 200), turn('02', 200), turn('03', 200)].join('\n')
      )

      const records = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T13:00:00.000Z')
      })

      const codex = records.filter((record) => record.provider === 'codex')
      expect(codex).toHaveLength(2)
      expect(codex.reduce((sum, record) => sum + record.totalTokens, 0)).toBe(200)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('does not bill a forked Codex session for its inherited cumulative baseline', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-codex-fork-'))
    try {
      const sessionDir = join(homeDir, '.codex', 'sessions', '2026', '05', '31')
      await mkdir(sessionDir, { recursive: true })
      await writeFile(
        join(sessionDir, 'rollout.jsonl'),
        // A fork opens carrying 500_000 tokens of the parent's history; only
        // the 100 tokens this turn actually spent belong to this session.
        JSON.stringify({
          timestamp: '2026-05-31T09:00:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: { total_tokens: 500_100 },
              last_token_usage: { input_tokens: 90, output_tokens: 10, total_tokens: 100 }
            }
          }
        })
      )

      const records = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T13:00:00.000Z')
      })

      expect(records.find((record) => record.provider === 'codex')?.totalTokens).toBe(100)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('falls back to the cumulative advance, not the cumulative total', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-codex-fallback-'))
    try {
      const sessionDir = join(homeDir, '.codex', 'sessions', '2026', '05', '31')
      await mkdir(sessionDir, { recursive: true })
      await writeFile(
        join(sessionDir, 'rollout.jsonl'),
        [
          JSON.stringify({
            timestamp: '2026-05-31T09:00:00.000Z',
            payload: {
              type: 'token_count',
              info: {
                total_token_usage: { total_tokens: 1_000 },
                last_token_usage: { input_tokens: 900, output_tokens: 100, total_tokens: 1_000 }
              }
            }
          }),
          // No per-turn breakdown: this turn spent 250, and the running total
          // of 1_250 must never be billed as though it were a single turn.
          JSON.stringify({
            timestamp: '2026-05-31T09:01:00.000Z',
            payload: {
              type: 'token_count',
              info: { total_token_usage: { total_tokens: 1_250 } }
            }
          })
        ].join('\n')
      )

      const records = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T13:00:00.000Z')
      })

      const codex = records.filter((record) => record.provider === 'codex')
      expect(codex.reduce((sum, record) => sum + record.totalTokens, 0)).toBe(1_250)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('counts Codex turns past the first 8MB of a long session file', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-codex-longfile-'))
    try {
      const sessionDir = join(homeDir, '.codex', 'sessions', '2026', '05', '31')
      await mkdir(sessionDir, { recursive: true })
      // The head turn sits behind ~9MB of reasoning output. Tail-reading the
      // last 8MB dropped it entirely, which is how multi-agent run days lost
      // 97-99% of their tokens.
      const filler = JSON.stringify({
        timestamp: '2026-05-31T09:00:30.000Z',
        payload: { type: 'agent_reasoning', text: 'x'.repeat(64 * 1024) }
      })
      await writeFile(
        join(sessionDir, 'rollout.jsonl'),
        [
          JSON.stringify({
            timestamp: '2026-05-31T09:00:00.000Z',
            payload: {
              type: 'token_count',
              info: {
                total_token_usage: { total_tokens: 4_000 },
                last_token_usage: { input_tokens: 3_000, output_tokens: 1_000, total_tokens: 4_000 }
              }
            }
          }),
          ...Array.from({ length: 145 }, () => filler),
          JSON.stringify({
            timestamp: '2026-05-31T09:01:00.000Z',
            payload: {
              type: 'token_count',
              info: {
                total_token_usage: { total_tokens: 4_007 },
                last_token_usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 }
              }
            }
          })
        ].join('\n')
      )

      const records = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T13:00:00.000Z')
      })

      const codex = records.filter((record) => record.provider === 'codex')
      expect(codex).toHaveLength(2)
      expect(codex.reduce((sum, record) => sum + record.totalTokens, 0)).toBe(4_007)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('keeps Codex history beyond the old narrow session cap', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-codex-history-'))
    try {
      const sessionDir = join(homeDir, '.codex', 'sessions', '2026', '05', '31')
      await mkdir(sessionDir, { recursive: true })

      for (let index = 0; index < 270; index += 1) {
        await writeFile(
          join(sessionDir, `rollout-${String(index).padStart(3, '0')}.jsonl`),
          JSON.stringify({
            timestamp: `2026-05-31T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
            payload: {
              type: 'token_count',
              info: {
                last_token_usage: {
                  input_tokens: 1,
                  output_tokens: 1,
                  total_tokens: index === 269 ? 269 : 2
                }
              }
            }
          })
        )
      }

      const records = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T23:00:00.000Z')
      })

      expect(records.filter((record) => record.provider === 'codex')).toHaveLength(270)
      expect(
        records.some((record) => record.provider === 'codex' && record.totalTokens === 269)
      ).toBe(true)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  }, 15_000)

  it('keeps older high-token Claude sessions when many newer session files exist', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-claude-history-'))
    try {
      const projectDir = join(homeDir, '.claude', 'projects', 'sample')
      await mkdir(projectDir, { recursive: true })

      const olderHeavyPath = join(projectDir, 'older-heavy.jsonl')
      await writeFile(
        olderHeavyPath,
        JSON.stringify({
          timestamp: '2026-05-01T10:00:00.000Z',
          requestId: 'req-heavy',
          message: {
            id: 'msg-heavy',
            model: 'claude-opus',
            usage: {
              input_tokens: 9_000,
              cache_read_input_tokens: 500,
              cache_creation_input_tokens: 250,
              output_tokens: 250
            }
          }
        })
      )
      await utimes(
        olderHeavyPath,
        new Date('2026-05-01T10:00:00.000Z'),
        new Date('2026-05-01T10:00:00.000Z')
      )

      for (let index = 0; index < 270; index += 1) {
        const filePath = join(projectDir, `newer-${String(index).padStart(4, '0')}.jsonl`)
        await writeFile(
          filePath,
          JSON.stringify({
            timestamp: `2026-06-01T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
            requestId: `req-${index}`,
            message: {
              id: `msg-${index}`,
              model: 'claude-sonnet',
              usage: { input_tokens: 1, output_tokens: 1 }
            }
          })
        )
        await utimes(
          filePath,
          new Date('2026-06-01T00:00:00.000Z'),
          new Date(Date.parse('2026-06-01T00:00:00.000Z') + index * 1000)
        )
      }

      const records = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-06-30T13:00:00.000Z')
      })
      const claudeRecords = records.filter((record) => record.provider === 'claude')

      expect(claudeRecords).toHaveLength(271)
      expect(claudeRecords.some((record) => record.totalTokens === 10_000)).toBe(true)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  }, 15_000)

  it('keeps early Claude usage from session files larger than the old tail window', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-claude-large-file-'))
    try {
      const projectDir = join(homeDir, '.claude', 'projects', 'sample')
      await mkdir(projectDir, { recursive: true })

      const largePath = join(projectDir, 'large-session.jsonl')
      const handle = await open(largePath, 'w')
      try {
        await handle.write(
          `${JSON.stringify({
            timestamp: '2026-05-01T10:00:00.000Z',
            requestId: 'req-large',
            message: {
              id: 'msg-large',
              model: 'claude-opus',
              usage: { input_tokens: 7_000, output_tokens: 3_000 }
            }
          })}\n`,
          0,
          'utf8'
        )
        for (let megabyte = 1; megabyte <= 129; megabyte += 1) {
          await handle.write('\n', megabyte * 1024 * 1024, 'utf8')
        }
      } finally {
        await handle.close()
      }
      await utimes(
        largePath,
        new Date('2026-05-01T10:00:00.000Z'),
        new Date('2026-05-01T10:00:00.000Z')
      )

      const records = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-06-30T13:00:00.000Z')
      })

      expect(records.filter((record) => record.provider === 'claude')).toHaveLength(1)
      expect(records.find((record) => record.provider === 'claude')?.totalTokens).toBe(10_000)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('reads Codex archived sessions and session-index activity markers', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-codex-archive-'))
    try {
      await mkdir(join(homeDir, '.codex', 'archived_sessions'), { recursive: true })

      await writeFile(
        join(homeDir, '.codex', 'archived_sessions', 'archived.jsonl'),
        JSON.stringify({
          timestamp: '2026-05-30T09:00:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15
              }
            }
          }
        })
      )
      await writeFile(
        join(homeDir, '.codex', 'session_index.jsonl'),
        JSON.stringify({
          id: 'thread-1',
          thread_name: 'hidden from output',
          updated_at: '2026-05-29T13:00:00.000Z'
        })
      )

      const records = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T13:00:00.000Z')
      })
      const codexRecords = records.filter((record) => record.provider === 'codex')

      expect(codexRecords.some((record) => record.totalTokens === 15)).toBe(true)
      expect(codexRecords.some((record) => record.totalTokens === 0)).toBe(true)
      expect(codexRecords.find((record) => record.totalTokens === 15)?.model).toBe('codex')
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('splits Codex external usage by turn_context model within each session file', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-codex-models-'))
    try {
      await mkdir(join(homeDir, '.codex', 'sessions', '2026', '06', '13'), { recursive: true })
      await writeFile(
        join(homeDir, '.codex', 'sessions', '2026', '06', '13', 'rollout.jsonl'),
        [
          JSON.stringify({
            timestamp: '2026-06-13T10:00:00.000Z',
            type: 'turn_context',
            payload: { type: 'turn_context', model: 'gpt-5.5' }
          }),
          JSON.stringify({
            timestamp: '2026-06-13T10:01:00.000Z',
            payload: {
              type: 'token_count',
              info: {
                last_token_usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 }
              }
            }
          }),
          JSON.stringify({
            timestamp: '2026-06-13T11:00:00.000Z',
            type: 'turn_context',
            payload: {
              type: 'turn_context',
              collaboration_mode: { settings: { model: 'gpt-5.4' } }
            }
          }),
          JSON.stringify({
            timestamp: '2026-06-13T11:01:00.000Z',
            type: 'event_msg',
            payload: {
              type: 'token_count',
              info: {
                last_token_usage: { input_tokens: 500, output_tokens: 100, total_tokens: 600 }
              }
            }
          })
        ].join('\n')
      )

      const records = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-06-13T13:00:00.000Z')
      })
      const codexRecords = records.filter((record) => record.provider === 'codex')

      expect(codexRecords.map((record) => [record.model, record.totalTokens]).sort()).toEqual([
        ['gpt-5.4', 600],
        ['gpt-5.5', 1200]
      ])
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('reads Gemini legacy JSON and nested session JSONL activity', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-gemini-sessions-'))
    try {
      const chatsDir = join(homeDir, '.gemini', 'tmp', 'sample', 'chats')
      const nestedDir = join(chatsDir, 'subagent-session')
      await mkdir(nestedDir, { recursive: true })

      await writeFile(
        join(chatsDir, 'session-2026-05-31.json'),
        JSON.stringify({
          sessionId: 'legacy',
          messages: [
            {
              id: 'legacy-1',
              timestamp: '2026-05-31T09:00:00.000Z',
              type: 'gemini',
              model: 'gemini-3.1-pro-preview',
              tokens: { input: 100, output: 20, total: 150 }
            }
          ]
        })
      )
      await writeFile(
        join(nestedDir, 'worker.jsonl'),
        [
          JSON.stringify({
            sessionId: 'worker',
            startTime: '2026-05-31T10:00:00.000Z',
            kind: 'subagent'
          }),
          JSON.stringify({
            id: 'nested-1',
            timestamp: '2026-05-31T10:05:00.000Z',
            type: 'gemini',
            model: 'gemini-3.1-flash-lite-preview',
            tokens: { input: 40, output: 10, total: 50 }
          })
        ].join('\n')
      )

      const records = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T13:00:00.000Z')
      })
      const geminiRecords = records.filter((record) => record.provider === 'gemini')

      expect(geminiRecords.map((record) => record.totalTokens).sort((a, b) => a - b)).toEqual([
        50, 120
      ])
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('loads Cursor IDE agent-transcript usage with estimated tokens', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-cursor-'))
    try {
      const transcriptDir = join(
        homeDir,
        '.cursor',
        'projects',
        'Users-me-Documents-sample',
        'agent-transcripts',
        'composer-abc'
      )
      await mkdir(transcriptDir, { recursive: true })
      await writeFile(
        join(transcriptDir, 'composer-abc.jsonl'),
        [
          JSON.stringify({
            role: 'user',
            message: { content: [{ type: 'text', text: 'a'.repeat(400) }] }
          }),
          JSON.stringify({
            role: 'assistant',
            message: { content: [{ type: 'text', text: 'b'.repeat(200) }] }
          })
        ].join('\n')
      )

      const records = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-06-13T13:00:00.000Z'),
        cursorCachePath: join(homeDir, 'cursor-external-activity-cache.json')
      })
      const cursor = records.find((record) => record.provider === 'cursor')
      expect(cursor?.totalTokens).toBe(150)
      expect(cursor?.model).toBe('composer-2.5-fast')
      expect(cursor?.workspaceId).toBe('external')
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })
})

describe('external activity per-file incremental cache', () => {
  const CODEX_MTIME = new Date('2026-05-31T09:30:00.000Z')
  const CLAUDE_MTIME = new Date('2026-05-31T10:30:00.000Z')

  async function writeFixtures(homeDir: string): Promise<{
    codexPath: string
    claudePath: string
    codexContent: string
    claudeContent: string
  }> {
    const codexDir = join(homeDir, '.codex', 'sessions', '2026', '05', '31')
    const claudeDir = join(homeDir, '.claude', 'projects', 'sample')
    await mkdir(codexDir, { recursive: true })
    await mkdir(claudeDir, { recursive: true })
    const codexPath = join(codexDir, 'rollout.jsonl')
    const claudePath = join(claudeDir, 'thread.jsonl')
    const codexContent = JSON.stringify({
      timestamp: '2026-05-31T09:00:00.000Z',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 10, output_tokens: 7, total_tokens: 17 } }
      }
    })
    const claudeContent = JSON.stringify({
      timestamp: '2026-05-31T10:00:00.000Z',
      requestId: 'req-1',
      message: {
        id: 'msg-1',
        model: 'claude-sonnet',
        usage: { input_tokens: 11, output_tokens: 5 }
      }
    })
    await writeFile(codexPath, codexContent)
    await writeFile(claudePath, claudeContent)
    await utimes(codexPath, CODEX_MTIME, CODEX_MTIME)
    await utimes(claudePath, CLAUDE_MTIME, CLAUDE_MTIME)
    return { codexPath, claudePath, codexContent, claudeContent }
  }

  /** Overwrite with same-length garbage and restore mtime, so a RE-PARSE
   * would yield nothing while mtime+size still match the cache entry. */
  async function corruptKeepingStat(path: string, content: string, mtime: Date): Promise<void> {
    await writeFile(path, 'x'.repeat(content.length))
    await utimes(path, mtime, mtime)
  }

  it('serves unchanged files from the cache across scans and sinceMs drift', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-filecache-'))
    try {
      const cachePath = join(homeDir, 'external-file-cache.jsonl')
      const fx = await writeFixtures(homeDir)

      const first = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T13:00:00.000Z'),
        externalFileCachePath: cachePath
      })
      expect(first.find((record) => record.provider === 'codex')?.totalTokens).toBe(17)
      expect(first.find((record) => record.provider === 'claude')?.totalTokens).toBe(16)

      await corruptKeepingStat(fx.codexPath, fx.codexContent, CODEX_MTIME)
      await corruptKeepingStat(fx.claudePath, fx.claudeContent, CLAUDE_MTIME)

      // One hour later — the rolling 90-day window has drifted forward, the
      // exact scenario that used to defeat sinceMs-keyed caching.
      const second = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T14:00:00.000Z'),
        externalFileCachePath: cachePath
      })
      expect(second.find((record) => record.provider === 'codex')?.totalTokens).toBe(17)
      expect(second.find((record) => record.provider === 'claude')?.totalTokens).toBe(16)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('persists the per-file cache across process restarts', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-filecache-boot-'))
    try {
      const cachePath = join(homeDir, 'external-file-cache.jsonl')
      const fx = await writeFixtures(homeDir)

      await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T13:00:00.000Z'),
        externalFileCachePath: cachePath
      })
      await corruptKeepingStat(fx.codexPath, fx.codexContent, CODEX_MTIME)
      await corruptKeepingStat(fx.claudePath, fx.claudeContent, CLAUDE_MTIME)

      // Simulate a fresh app launch: in-memory state gone, disk cache remains.
      resetExternalActivityFileCacheForTests()

      const afterRestart = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T15:00:00.000Z'),
        externalFileCachePath: cachePath
      })
      expect(afterRestart.find((record) => record.provider === 'codex')?.totalTokens).toBe(17)
      expect(afterRestart.find((record) => record.provider === 'claude')?.totalTokens).toBe(16)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('re-parses files whose mtime or size changed', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-filecache-change-'))
    try {
      const cachePath = join(homeDir, 'external-file-cache.jsonl')
      const fx = await writeFixtures(homeDir)

      const first = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T13:00:00.000Z'),
        externalFileCachePath: cachePath
      })
      expect(first.filter((record) => record.provider === 'codex')).toHaveLength(1)

      const appended = [
        fx.codexContent,
        JSON.stringify({
          timestamp: '2026-05-31T11:00:00.000Z',
          payload: {
            type: 'token_count',
            info: { last_token_usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } }
          }
        })
      ].join('\n')
      await writeFile(fx.codexPath, appended)
      const bumped = new Date('2026-05-31T11:30:00.000Z')
      await utimes(fx.codexPath, bumped, bumped)

      const second = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T13:30:00.000Z'),
        externalFileCachePath: cachePath
      })
      const codexRecords = second.filter((record) => record.provider === 'codex')
      expect(codexRecords).toHaveLength(2)
      expect(codexRecords.some((record) => record.totalTokens === 25)).toBe(true)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('dedupes duplicate Claude events across files through the cache', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-filecache-dedupe-'))
    try {
      const cachePath = join(homeDir, 'external-file-cache.jsonl')
      const claudeDir = join(homeDir, '.claude', 'projects', 'sample')
      await mkdir(claudeDir, { recursive: true })
      const duplicate = JSON.stringify({
        timestamp: '2026-05-31T10:00:00.000Z',
        requestId: 'req-dup',
        message: {
          id: 'msg-dup',
          model: 'claude-sonnet',
          usage: { input_tokens: 11, output_tokens: 5 }
        }
      })
      const mtime = new Date('2026-05-31T10:30:00.000Z')
      for (const name of ['thread-a.jsonl', 'thread-b.jsonl']) {
        await writeFile(join(claudeDir, name), duplicate)
        await utimes(join(claudeDir, name), mtime, mtime)
      }

      const first = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T13:00:00.000Z'),
        externalFileCachePath: cachePath
      })
      expect(first.filter((record) => record.provider === 'claude')).toHaveLength(1)

      // Second scan served from cache must apply the same cross-file dedupe.
      const second = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T14:00:00.000Z'),
        externalFileCachePath: cachePath
      })
      expect(second.filter((record) => record.provider === 'claude')).toHaveLength(1)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })
})

describe('getExternalUsageCached front door', () => {
  const usageRecord = (id: string, provider: string, timestamp: number): UsageRecord =>
    ({
      id,
      provider,
      workspaceId: 'external',
      chatId: `external-${provider}`,
      runId: `external-${provider}`,
      usageKind: 'run',
      model: 'test',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 100,
      durationMs: 0,
      timestamp
    }) as UsageRecord

  it('resolves cold callers at the first partial and upgrades to the full window', async () => {
    const partial = [usageRecord('p1', 'codex', Date.now())]
    const full = [...partial, usageRecord('f1', 'claude', Date.now() - 1000)]
    const updates: UsageRecord[][] = []
    setExternalUsageUpdateListener((records) => updates.push(records))

    const captured: ExternalScanRequest[] = []
    setExternalScanDriver(async (request, onPartial) => {
      captured.push(request)
      onPartial(partial)
      await new Promise((resolve) => setTimeout(resolve, 20))
      return full
    })

    // Cold caller unblocks at the partial — it must NOT wait for the full walk.
    const first = await getExternalUsageCached()
    expect(first).toEqual(partial)
    expect(captured[0]?.partialLookbackDays).toBe(14)

    // Full window lands afterwards; both commits notified the listener.
    await vi.waitFor(() => expect(updates.length).toBe(2))
    expect(updates[0]).toEqual(partial)
    expect(updates[1]).toEqual(full)

    // Warm cache now serves the full set without a new scan.
    const second = await getExternalUsageCached()
    expect(second).toEqual(full)
  })

  it('never requests a partial when forced or when a cached result exists', async () => {
    const full = [usageRecord('f1', 'codex', Date.now())]
    const requests: ExternalScanRequest[] = []
    setExternalScanDriver(async (request) => {
      requests.push(request)
      return full
    })

    await getExternalUsageCached({ maxAgeMs: 0 })
    expect(requests[0]?.partialLookbackDays).toBeNull()
    expect(requests[0]?.options.force).toBe(true)

    // Cache is warm now; a forced refresh again requests no partial (a
    // partial would transiently shrink what is already on screen).
    await getExternalUsageCached({ force: true })
    expect(requests[1]?.partialLookbackDays).toBeNull()
  })

  it('falls back to the in-process scan when the worker driver fails', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-frontdoor-'))
    try {
      setExternalScanDriver(async () => {
        throw new Error('worker exploded')
      })
      // Empty homeDir → in-process scan yields no records, but it must
      // RESOLVE (the worker failure is not surfaced to callers).
      const records = await getExternalUsageCached({
        homeDir,
        externalFileCachePath: join(homeDir, 'file-cache.jsonl'),
        cursorCachePath: join(homeDir, 'cursor-cache.json')
      })
      expect(records).toEqual([])
    } finally {
      // The await above resolved at the partial commit; the fallback's
      // full-window walk is still writing caches into homeDir. Settle it
      // before removal, and retry the rm in case anything else races.
      await settleExternalScansForTests()
      await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  it('merges forwarded cursor records without clobbering other providers', async () => {
    const codex = usageRecord('c1', 'codex', Date.now())
    const cursorOld = usageRecord('cu-old', 'cursor', Date.now() - 5000)
    const cursorNew = usageRecord('cu-new', 'cursor', Date.now())
    setExternalScanDriver(async () => [codex, cursorOld])
    await getExternalUsageCached()

    const updates: UsageRecord[][] = []
    setExternalUsageUpdateListener((records) => updates.push(records))
    applyCursorUsageRecords([cursorNew])

    expect(updates.length).toBe(1)
    const merged = updates[0]
    expect(merged).toContainEqual(codex)
    expect(merged).toContainEqual(cursorNew)
    expect(merged).not.toContainEqual(cursorOld)
  })
})
