import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRun, ToolActivity } from './store/types'
import {
  buildAgentStatDelta,
  compactToRollup,
  countRawDeltas,
  diffLineStats,
  extractRunCostUsd,
  extractRunTokens,
  foldAgentStats,
  isPooledAgentId,
  isTerminalRun,
  parseAgentStatRecordLine,
  runDurationMs,
  safeAgentStatsFileName,
  seenRunIds,
  serializeAgentStatRecord,
  statusBucket,
  toolActivityStatsForRun,
  type AgentStatDelta,
  type AgentStatRecord
} from './AgentStatsStore'

function run(overrides: Partial<ChatRun> = {}): ChatRun {
  return {
    runId: 'run-1',
    startedAt: '2026-06-30T12:00:00.000Z',
    endedAt: '2026-06-30T12:01:00.000Z',
    status: 'success',
    ...overrides
  } as ChatRun
}

function activity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'activity-1',
    toolName: 'read_file',
    displayName: 'Read file',
    category: 'read',
    status: 'success',
    ...overrides
  }
}

describe('isPooledAgentId', () => {
  it('accepts prefixed non-empty ids only', () => {
    expect(isPooledAgentId('pooled-agent-x')).toBe(true)
    expect(isPooledAgentId('pooled-agent-')).toBe(false)
    expect(isPooledAgentId('ensemble-participant-1')).toBe(false)
    expect(isPooledAgentId(undefined)).toBe(false)
  })
})

describe('token + cost extraction', () => {
  it('reads snake_case and camelCase, falls back to in+out for total', () => {
    expect(extractRunTokens({ input_tokens: 100, output_tokens: 30, total_tokens: 130 })).toEqual({
      inputTokens: 100,
      outputTokens: 30,
      totalTokens: 130
    })
    expect(extractRunTokens({ inputTokens: 10, outputTokens: 5 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15
    })
  })

  it('adds cache + audio input tokens unless already included', () => {
    expect(
      extractRunTokens({ input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 2 }).inputTokens
    ).toBe(15)
    expect(
      extractRunTokens({
        input_tokens: 10,
        cache_read_input_tokens: 5,
        _taskwraith_input_includes_cache: true
      }).inputTokens
    ).toBe(10)
  })

  it('does not add historical cache-inclusive aliases to input again', () => {
    expect(
      extractRunTokens({
        input_tokens: 100,
        cachedInputTokens: 80,
        output_tokens: 5
      })
    ).toEqual({ inputTokens: 100, outputTokens: 5, totalTokens: 105 })
    expect(
      extractRunTokens({
        input_tokens: 100,
        cache_read_input_tokens: 80,
        _agentbench_input_includes_cache: true,
        output_tokens: 5
      })
    ).toEqual({ inputTokens: 100, outputTokens: 5, totalTokens: 105 })
  })

  it('extracts cost in common spellings, 0 otherwise', () => {
    expect(extractRunCostUsd({ cost_usd: 0.42 })).toBeCloseTo(0.42)
    expect(extractRunCostUsd({ usage: { costUsd: 1.5 } })).toBeCloseTo(1.5)
    expect(extractRunCostUsd({})).toBe(0)
  })
})

describe('runDurationMs', () => {
  it('prefers stats.duration_ms', () => {
    expect(runDurationMs(run({ stats: { duration_ms: 5000 } }))).toBe(5000)
  })
  it('falls back to endedAt - startedAt', () => {
    expect(runDurationMs(run())).toBe(60_000)
  })
  it('is 0 when unknowable', () => {
    expect(runDurationMs({ startedAt: 'nonsense' } as ChatRun)).toBe(0)
  })
})

describe('diffLineStats', () => {
  it('sums additions/deletions and counts files across buckets', () => {
    const stats = diffLineStats(
      run({
        runDiff: {
          runId: 'run-1',
          preSnapshot: { capturedAt: '', isGitRepo: false },
          createdFiles: [{ path: 'a', status: 'created', additions: 10, previewKind: 'none' }],
          modifiedFiles: [
            { path: 'b', status: 'modified', additions: 3, deletions: 4, previewKind: 'none' }
          ],
          deletedFiles: [{ path: 'c', status: 'deleted', deletions: 7, previewKind: 'none' }],
          preExistingFiles: []
        }
      })
    )
    expect(stats).toEqual({ linesAdded: 13, linesRemoved: 11, filesTouched: 3, available: true })
  })

  it('reports unavailable when there is no runDiff', () => {
    expect(diffLineStats(run())).toEqual({
      linesAdded: 0,
      linesRemoved: 0,
      filesTouched: 0,
      available: false
    })
  })
})

describe('toolActivityStatsForRun', () => {
  it('counts only tool activities attached to the target run', () => {
    const messages: Pick<ChatMessage, 'runId' | 'toolActivities'>[] = [
      {
        runId: 'run-1',
        toolActivities: [
          activity({ id: 'read-1', category: 'read' }),
          activity({ id: 'write-1', category: 'write' })
        ]
      },
      {
        runId: 'run-2',
        toolActivities: [activity({ id: 'write-2', category: 'write' })]
      },
      { runId: 'run-1' }
    ]
    expect(toolActivityStatsForRun('run-1', messages)).toEqual({
      toolCalls: 2,
      writeToolCalls: 1
    })
  })
})

describe('status + terminal', () => {
  it('buckets statuses', () => {
    expect(statusBucket(run({ status: 'success_with_warnings' }))).toBe('success')
    expect(statusBucket(run({ status: 'failed' }))).toBe('failed')
    expect(statusBucket(run({ status: 'cancelled' }))).toBe('cancelled')
    expect(statusBucket(run({ cancelled: true, status: 'success' }))).toBe('cancelled')
    expect(statusBucket(run({ status: 'running' }))).toBe('other')
  })
  it('treats running/sleeping as non-terminal', () => {
    expect(isTerminalRun(run({ status: 'running', endedAt: undefined }))).toBe(false)
    expect(isTerminalRun(run({ status: 'sleeping', endedAt: undefined }))).toBe(false)
    expect(isTerminalRun(run({ status: 'success' }))).toBe(true)
    expect(isTerminalRun(run({ cancelled: true, status: 'running' }))).toBe(true)
  })
})

describe('buildAgentStatDelta', () => {
  it('returns null for a non-terminal run', () => {
    expect(buildAgentStatDelta('chat-1', run({ status: 'running', endedAt: undefined }), 1)).toBeNull()
  })
  it('builds a delta for a finalized run', () => {
    const delta = buildAgentStatDelta(
      'chat-1',
      run({
        stats: { input_tokens: 100, output_tokens: 20, cost_usd: 0.1 },
        providerThreadId: 'session-1',
        ensembleRoundId: 'round-1',
        ensembleRole: 'Worker',
        ensembleStageRole: 'worker',
        ensembleLaneIntent: 'write'
      }),
      999,
      { toolCalls: 3, writeToolCalls: 2 }
    )
    expect(delta).toMatchObject({
      runId: 'run-1',
      chatId: 'chat-1',
      providerThreadId: 'session-1',
      ensembleRoundId: 'round-1',
      ensembleRole: 'Worker',
      ensembleStageRole: 'worker',
      ensembleLaneIntent: 'write',
      status: 'success',
      tokensIn: 100,
      tokensOut: 20,
      tokensTotal: 120,
      costUsd: 0.1,
      durationMs: 60_000,
      toolCalls: 3,
      writeToolCalls: 2,
      diffAvailable: false
    })
  })
})

function delta(over: Partial<AgentStatDelta>): AgentStatDelta {
  return {
    runId: 'r',
    chatId: 'c',
    status: 'success',
    tokensIn: 0,
    tokensOut: 0,
    tokensTotal: 0,
    costUsd: 0,
    durationMs: 0,
    linesAdded: 0,
    linesRemoved: 0,
    filesTouched: 0,
    toolCalls: 0,
    writeToolCalls: 0,
    diffAvailable: true,
    at: 0,
    ...over
  }
}

describe('foldAgentStats', () => {
  it('sums, dedupes by runId, counts distinct chats + status buckets', () => {
    const records: AgentStatRecord[] = [
      delta({ runId: 'r1', chatId: 'c1', status: 'success', tokensTotal: 100, at: 10 }),
      delta({
        runId: 'r2',
        chatId: 'c1',
        providerThreadId: 'session-1',
        ensembleRoundId: 'round-1',
        ensembleRole: 'Worker',
        ensembleStageRole: 'worker',
        ensembleLaneIntent: 'write',
        status: 'failed',
        tokensTotal: 50,
        toolCalls: 4,
        writeToolCalls: 2,
        at: 20
      }),
      delta({
        runId: 'r3',
        chatId: 'c2',
        providerThreadId: 'session-2',
        ensembleRoundId: 'round-1',
        ensembleRole: 'Reviewer',
        ensembleStageRole: 'reviewer',
        ensembleLaneIntent: 'read',
        status: 'cancelled',
        toolCalls: 1,
        diffAvailable: false,
        at: 30
      }),
      // Duplicate runId — must be ignored.
      delta({
        runId: 'r1',
        chatId: 'c3',
        providerThreadId: 'session-ignored',
        ensembleRoundId: 'round-ignored',
        tokensTotal: 9999,
        toolCalls: 99,
        at: 99
      })
    ]
    const summary = foldAgentStats('pooled-agent-1', records)
    expect(summary.runs).toBe(3)
    expect(summary.success).toBe(1)
    expect(summary.failed).toBe(1)
    expect(summary.cancelled).toBe(1)
    expect(summary.tokensTotal).toBe(150)
    expect(summary.toolCalls).toBe(5)
    expect(summary.writeToolCalls).toBe(2)
    expect(summary.distinctChats).toBe(2)
    expect(summary.distinctSessions).toBe(2)
    expect(summary.distinctEnsembleRounds).toBe(1)
    expect(summary.ensembleRoles).toEqual([
      { key: 'Reviewer', count: 1 },
      { key: 'Worker', count: 1 }
    ])
    expect(summary.ensembleStageRoles).toEqual([
      { key: 'reviewer', count: 1 },
      { key: 'worker', count: 1 }
    ])
    expect(summary.ensembleLaneIntents).toEqual([
      { key: 'read', count: 1 },
      { key: 'write', count: 1 }
    ])
    expect(summary.runsWithDiffUnavailable).toBe(1)
    expect(summary.lastRunAt).toBe(30)
  })

  it('an empty file yields an all-zero summary', () => {
    expect(foldAgentStats('pooled-agent-1', [])).toMatchObject({
      runs: 0,
      tokensTotal: 0,
      toolCalls: 0,
      writeToolCalls: 0,
      distinctSessions: 0,
      distinctEnsembleRounds: 0,
      ensembleRoles: []
    })
  })

  it('folds legacy records with missing new fields as zero/empty', () => {
    const legacy = {
      runId: 'legacy-run',
      chatId: 'legacy-chat',
      status: 'success',
      tokensIn: 0,
      tokensOut: 0,
      tokensTotal: 10,
      costUsd: 0,
      durationMs: 0,
      linesAdded: 0,
      linesRemoved: 0,
      filesTouched: 0,
      diffAvailable: true,
      at: 1
    } as AgentStatDelta
    expect(foldAgentStats('pooled-agent-1', [legacy])).toMatchObject({
      runs: 1,
      tokensTotal: 10,
      toolCalls: 0,
      writeToolCalls: 0,
      distinctSessions: 0,
      distinctEnsembleRounds: 0,
      ensembleStageRoles: []
    })
  })
})

describe('seenRunIds', () => {
  it('spans the rollup + raw deltas', () => {
    const rollup = compactToRollup('pooled-agent-1', [
      delta({ runId: 'r1' }),
      delta({ runId: 'r2' })
    ])
    const seen = seenRunIds([rollup, delta({ runId: 'r3' })])
    expect([...seen].sort()).toEqual(['r1', 'r2', 'r3'])
  })
})

describe('compaction identity', () => {
  it('folding the compacted rollup equals folding the originals', () => {
    const records: AgentStatRecord[] = [
      delta({ runId: 'r1', chatId: 'c1', status: 'success', tokensTotal: 100, linesAdded: 5, at: 1 }),
      delta({ runId: 'r2', chatId: 'c2', status: 'failed', tokensTotal: 50, diffAvailable: false, at: 2 }),
      delta({ runId: 'r3', chatId: 'c1', status: 'cancelled', costUsd: 0.25, at: 3 })
    ]
    const before = foldAgentStats('pooled-agent-1', records)
    const rollup = compactToRollup('pooled-agent-1', records)
    const after = foldAgentStats('pooled-agent-1', [rollup])
    expect(after).toEqual(before)
    // And a delta appended after compaction still dedupes against the rollup.
    const withDup = foldAgentStats('pooled-agent-1', [rollup, delta({ runId: 'r1', tokensTotal: 777 })])
    expect(withDup).toEqual(before)
  })

  it('countRawDeltas excludes the rollup', () => {
    const rollup = compactToRollup('pooled-agent-1', [delta({ runId: 'r1' })])
    expect(countRawDeltas([rollup, delta({ runId: 'r2' }), delta({ runId: 'r3' })])).toBe(2)
  })
})

describe('serialization + filename safety', () => {
  it('round-trips a delta and a rollup', () => {
    const d = delta({ runId: 'r1' })
    expect(parseAgentStatRecordLine(serializeAgentStatRecord(d))).toEqual(d)
    const rollup = compactToRollup('pooled-agent-1', [d])
    expect(parseAgentStatRecordLine(serializeAgentStatRecord(rollup))).toEqual(rollup)
    expect(parseAgentStatRecordLine('   ')).toBeNull()
    expect(parseAgentStatRecordLine('not json')).toBeNull()
  })

  it('sanitizes the filename against path injection', () => {
    expect(safeAgentStatsFileName('pooled-agent-../../etc/passwd')).toBe(
      'pooled-agent-.._.._etc_passwd.jsonl'
    )
    expect(safeAgentStatsFileName('')).toBe('unknown-agent.jsonl')
  })
})
