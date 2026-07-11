import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatRecord, EnsembleParticipant } from './store/types'
import { conversationCompactionEligibleRows } from './PromptComposition'
import {
  canDisposeGrokSeatAfterCompaction,
  convergeHostSeatCompaction,
  HOST_SEAT_COMPACTION_DEADLINE_MS,
  HOST_SEAT_COMPACTION_MAX_CHUNKS,
  hostSeatCompactionRequestSucceeded,
  type HostSeatCompactionCheckpointRequest,
  type HostSeatCompactionIdentity,
  type HostSeatContextSummary,
  validateHostSeatCheckpointFreshness
} from './HostSeatCompactionConvergence'

function message(id: string, role: 'user' | 'assistant', content: string): ChatMessage {
  return {
    id,
    role,
    content,
    timestamp: '2026-07-11T00:00:00.000Z'
  }
}

function sixMessageSnapshot(): ChatMessage[] {
  return [
    message('m1', 'user', 'oldest user'),
    message('m2', 'assistant', 'oldest assistant'),
    message('m3', 'user', 'middle user'),
    message('m4', 'assistant', 'middle assistant'),
    message('m5', 'user', 'newest user'),
    message('m6', 'assistant', 'newest assistant')
  ]
}

function seat(overrides: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id: 'seat-1',
    provider: 'grok',
    enabled: true,
    role: 'Worker',
    instructions: '',
    order: 0,
    model: 'grok-4',
    linkedProviderSessionId: 'session-1',
    ...overrides
  }
}

function ensembleChat(
  participant: EnsembleParticipant,
  messages: ChatMessage[] = sixMessageSnapshot()
): ChatRecord {
  return {
    appChatId: 'chat-1',
    provider: 'grok',
    title: 'Compaction test',
    createdAt: 0,
    updatedAt: 0,
    archived: false,
    workspacePath: '/workspace',
    messages,
    ensemble: {
      participants: [participant]
    }
  } as ChatRecord
}

const frozenIdentity: HostSeatCompactionIdentity = {
  participantId: 'seat-1',
  provider: 'grok',
  model: 'grok-4',
  linkedProviderSessionId: 'session-1',
  workspace: '/workspace'
}

const frozenEligibleRows = conversationCompactionEligibleRows(sixMessageSnapshot())

const smallChunkBudget = {
  maxTurns: 1,
  maxCharsPerTurn: 100,
  maxBlockChars: 1_000
}

describe('convergeHostSeatCompaction', () => {
  it('chains successive oldest-uncovered chunks and checkpoints exact prefix progress', async () => {
    const checkpoints: HostSeatCompactionCheckpointRequest[] = []
    const prompts: string[] = []
    const summarize = vi.fn(async (request: { prompt: string }) => {
      prompts.push(request.prompt)
      return { ok: true, text: `summary-${prompts.length}` }
    })

    const result = await convergeHostSeatCompaction({
      provider: 'kimi',
      snapshotMessages: sixMessageSnapshot(),
      startedAtMs: 0,
      now: () => 1,
      nowIso: () => `2026-07-11T00:00:0${checkpoints.length}.000Z`,
      summarize,
      checkpoint: (request) => {
        checkpoints.push(request)
        return { ok: true }
      },
      chunkTurns: 1,
      chunkBudget: smallChunkBudget
    })

    expect(result).toMatchObject({
      checkpointCount: 3,
      coverageComplete: true,
      stopReason: 'complete',
      finalSummary: { text: 'summary-3' }
    })
    expect(checkpoints.map((checkpoint) => checkpoint.claimedMessageIds)).toEqual([
      ['m1', 'm2'],
      ['m1', 'm2', 'm3', 'm4'],
      ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']
    ])
    expect(checkpoints.map((checkpoint) => checkpoint.coverageComplete)).toEqual([
      false,
      false,
      true
    ])
    expect(prompts[0]).toContain('oldest user')
    expect(prompts[0]).not.toContain('middle user')
    expect(prompts[1]).toContain('Previous durable context summary')
    expect(prompts[1]).toContain('summary-1')
    expect(prompts[1]).toContain('middle user')
    expect(prompts[2]).toContain('summary-2')
    expect(prompts[2]).toContain('newest user')
  })

  it('uses the remaining global request time for every child and stops at the deadline', async () => {
    let now = 100
    const timeouts: number[] = []
    const checkpoint = vi.fn(() => {
      now = 1_100
      return { ok: true }
    })

    const result = await convergeHostSeatCompaction({
      provider: 'grok',
      snapshotMessages: sixMessageSnapshot(),
      startedAtMs: 100,
      deadlineMs: 1_000,
      now: () => now,
      nowIso: () => '2026-07-11T00:00:00.000Z',
      summarize: async (request) => {
        timeouts.push(request.timeoutMs)
        return { ok: true, text: 'first checkpoint' }
      },
      checkpoint,
      chunkTurns: 1,
      chunkBudget: smallChunkBudget
    })

    expect(timeouts).toEqual([1_000])
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      checkpointCount: 1,
      coverageComplete: false,
      stopReason: 'deadline',
      finalSummary: { text: 'first checkpoint' }
    })
  })

  it('retains prior checkpoints when a later summarize child times out', async () => {
    let invocation = 0
    const checkpoint = vi.fn(() => ({ ok: true }))
    const result = await convergeHostSeatCompaction({
      provider: 'kimi',
      snapshotMessages: sixMessageSnapshot(),
      startedAtMs: 0,
      now: () => 1,
      nowIso: () => '2026-07-11T00:00:00.000Z',
      summarize: async () => {
        invocation += 1
        return invocation === 1
          ? { ok: true, text: 'durable first chunk' }
          : { ok: false, timedOut: true, error: 'deadline reached' }
      },
      checkpoint,
      chunkTurns: 1,
      chunkBudget: smallChunkBudget
    })

    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      checkpointCount: 1,
      coverageComplete: false,
      stopReason: 'deadline',
      error: 'deadline reached',
      finalSummary: { text: 'durable first chunk' }
    })
    expect(hostSeatCompactionRequestSucceeded(result)).toBe(true)
  })

  it('reports durable partial progress as completed except after a CAS mutation', () => {
    const finalSummary: HostSeatContextSummary = {
      text: 'durable first chunk',
      createdAt: '2026-07-11T00:00:00.000Z',
      provider: 'kimi'
    }
    for (const stopReason of ['deadline', 'summarizer_failed', 'no_progress', 'source_cap'] as const) {
      expect(
        hostSeatCompactionRequestSucceeded({
          checkpointCount: 1,
          coverageComplete: false,
          stopReason,
          finalSummary
        })
      ).toBe(true)
    }
    expect(
      hostSeatCompactionRequestSucceeded({
        checkpointCount: 1,
        coverageComplete: false,
        stopReason: 'mutation',
        finalSummary
      })
    ).toBe(false)
    expect(
      hostSeatCompactionRequestSucceeded({
        checkpointCount: 0,
        coverageComplete: false,
        stopReason: 'summarizer_failed'
      })
    ).toBe(false)
  })

  it('stops at the per-request source cap without discarding progress', async () => {
    const messages = Array.from({ length: 6 }, (_, index) =>
      message(`m${index + 1}`, index % 2 === 0 ? 'user' : 'assistant', `row ${index + 1}`)
    )
    const checkpoint = vi.fn(() => ({ ok: true }))
    const result = await convergeHostSeatCompaction({
      provider: 'kimi',
      snapshotMessages: messages,
      startedAtMs: 0,
      now: () => 1,
      nowIso: () => '2026-07-11T00:00:00.000Z',
      summarize: async ({ chunkIndex }) => ({ ok: true, text: `summary ${chunkIndex}` }),
      checkpoint,
      maxChunks: 2,
      chunkTurns: 1,
      chunkBudget: smallChunkBudget
    })

    expect(checkpoint).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      checkpointCount: 2,
      coverageComplete: false,
      stopReason: 'source_cap',
      finalSummary: { text: 'summary 1' }
    })
  })

  it('never exceeds the hard ten-chunk source cap even when a larger cap is requested', async () => {
    const messages = Array.from({ length: 24 }, (_, index) =>
      message(`m${index + 1}`, index % 2 === 0 ? 'user' : 'assistant', `row ${index + 1}`)
    )
    const checkpoint = vi.fn(() => ({ ok: true }))
    const summarize = vi.fn(async ({ chunkIndex }: { chunkIndex: number }) => ({
      ok: true,
      text: `summary ${chunkIndex}`
    }))

    const result = await convergeHostSeatCompaction({
      provider: 'grok',
      snapshotMessages: messages,
      startedAtMs: 0,
      now: () => 1,
      nowIso: () => '2026-07-11T00:00:00.000Z',
      summarize,
      checkpoint,
      maxChunks: HOST_SEAT_COMPACTION_MAX_CHUNKS + 10,
      chunkTurns: 1,
      chunkBudget: smallChunkBudget
    })

    expect(summarize).toHaveBeenCalledTimes(HOST_SEAT_COMPACTION_MAX_CHUNKS)
    expect(checkpoint).toHaveBeenCalledTimes(HOST_SEAT_COMPACTION_MAX_CHUNKS)
    expect(result.stopReason).toBe('source_cap')
  })

  it('clamps deadline and chunk overrides to the production hard ceilings', async () => {
    const messages = Array.from({ length: 50 }, (_, index) =>
      message(
        `m${index + 1}`,
        index % 2 === 0 ? 'user' : 'assistant',
        `${index + 1}:${'x'.repeat(2_000)}`
      )
    )
    let firstRequest:
      | {
          timeoutMs: number
          suppliedRows: number
          blockLength: number
        }
      | undefined

    await convergeHostSeatCompaction({
      provider: 'grok',
      snapshotMessages: messages,
      startedAtMs: 0,
      now: () => 0,
      nowIso: () => '2026-07-11T00:00:00.000Z',
      deadlineMs: HOST_SEAT_COMPACTION_DEADLINE_MS * 10,
      chunkTurns: 1_000,
      chunkBudget: {
        maxTurns: 1_000,
        maxCharsPerTurn: 100_000,
        maxBlockChars: 1_000_000
      },
      summarize: async ({ timeoutMs, projection }) => {
        firstRequest = {
          timeoutMs,
          suppliedRows: projection.suppliedMessageIds.length,
          blockLength: projection.block.length
        }
        return { ok: true, text: 'bounded summary' }
      },
      checkpoint: () => ({ ok: false, error: 'stop after inspecting the first chunk' })
    })

    expect(firstRequest).toBeDefined()
    expect(firstRequest!.timeoutMs).toBeLessThanOrEqual(HOST_SEAT_COMPACTION_DEADLINE_MS)
    expect(firstRequest!.suppliedRows).toBeLessThanOrEqual(40)
    expect(firstRequest!.blockLength).toBeLessThanOrEqual(12_000)
  })

  it('stops immediately when the global deadline was already consumed', async () => {
    const summarize = vi.fn()
    const checkpoint = vi.fn()
    const result = await convergeHostSeatCompaction({
      provider: 'kimi',
      snapshotMessages: sixMessageSnapshot(),
      startedAtMs: 0,
      now: () => HOST_SEAT_COMPACTION_DEADLINE_MS,
      nowIso: () => '2026-07-11T00:00:00.000Z',
      summarize,
      checkpoint
    })

    expect(summarize).not.toHaveBeenCalled()
    expect(checkpoint).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      checkpointCount: 0,
      coverageComplete: false,
      stopReason: 'deadline'
    })
  })

  it('stops on a failed checkpoint and retains only earlier durable progress', async () => {
    let checkpointInvocation = 0
    const result = await convergeHostSeatCompaction({
      provider: 'grok',
      snapshotMessages: sixMessageSnapshot(),
      startedAtMs: 0,
      now: () => 1,
      nowIso: () => '2026-07-11T00:00:00.000Z',
      summarize: async ({ chunkIndex }) => ({ ok: true, text: `summary ${chunkIndex}` }),
      checkpoint: () => {
        checkpointInvocation += 1
        return checkpointInvocation === 1
          ? { ok: true }
          : { ok: false, error: 'seat tuple changed' }
      },
      chunkTurns: 1,
      chunkBudget: smallChunkBudget
    })

    expect(result).toMatchObject({
      checkpointCount: 1,
      coverageComplete: false,
      stopReason: 'mutation',
      error: 'seat tuple changed',
      finalSummary: { text: 'summary 0' }
    })
  })

  it('does not checkpoint failed or empty summary output', async () => {
    for (const summarizeResult of [
      { ok: false, error: 'provider exited' },
      { ok: true, text: '   ' }
    ]) {
      const checkpoint = vi.fn()
      const result = await convergeHostSeatCompaction({
        provider: 'kimi',
        snapshotMessages: sixMessageSnapshot(),
        startedAtMs: 0,
        now: () => 1,
        nowIso: () => '2026-07-11T00:00:00.000Z',
        summarize: async () => summarizeResult,
        checkpoint,
        chunkTurns: 1,
        chunkBudget: smallChunkBudget
      })

      expect(checkpoint).not.toHaveBeenCalled()
      expect(result.stopReason).toBe('summarizer_failed')
    }
  })

  it('truncates every durable rolling summary to the shared injection cap', async () => {
    let checkpointed: HostSeatContextSummary | undefined
    const result = await convergeHostSeatCompaction({
      provider: 'grok',
      snapshotMessages: [message('m1', 'user', 'only row')],
      startedAtMs: 0,
      now: () => 1,
      nowIso: () => '2026-07-11T00:00:00.000Z',
      summarize: async () => ({ ok: true, text: 'x'.repeat(9_000) }),
      checkpoint: ({ nextSummary }) => {
        checkpointed = nextSummary
        return { ok: true }
      }
    })

    expect(checkpointed?.text).toHaveLength(8_000)
    expect(result).toMatchObject({ checkpointCount: 1, coverageComplete: true })
  })

  it('recognizes an already-complete strict prior summary without spawning another child', async () => {
    const initialSummary: HostSeatContextSummary = {
      text: 'complete prior summary',
      createdAt: '2026-07-10T00:00:00.000Z',
      provider: 'kimi',
      provenance: {
        kind: 'bounded_prompt_window',
        suppliedMessageIds: ['m1', 'm2']
      }
    }
    const summarize = vi.fn()
    const checkpoint = vi.fn()
    const result = await convergeHostSeatCompaction({
      provider: 'kimi',
      snapshotMessages: [
        message('m1', 'user', 'one'),
        message('m2', 'assistant', 'two')
      ],
      initialSummary,
      startedAtMs: 0,
      now: () => 1,
      nowIso: () => '2026-07-11T00:00:00.000Z',
      summarize,
      checkpoint
    })

    expect(summarize).not.toHaveBeenCalled()
    expect(checkpoint).not.toHaveBeenCalled()
    expect(result).toEqual({
      checkpointCount: 0,
      coverageComplete: true,
      stopReason: 'complete',
      finalSummary: initialSummary
    })
  })

  it('fails open to the oldest row when prior provenance is stale', async () => {
    const initialSummary: HostSeatContextSummary = {
      text: 'stale prior summary',
      createdAt: '2026-07-10T00:00:00.000Z',
      provider: 'kimi',
      provenance: {
        kind: 'bounded_prompt_window',
        suppliedMessageIds: ['missing']
      }
    }
    let checkpointedIds: string[] = []
    await convergeHostSeatCompaction({
      provider: 'kimi',
      snapshotMessages: sixMessageSnapshot(),
      initialSummary,
      startedAtMs: 0,
      now: () => 1,
      nowIso: () => '2026-07-11T00:00:00.000Z',
      summarize: async () => ({ ok: true, text: 'replacement summary' }),
      checkpoint: ({ claimedMessageIds }) => {
        checkpointedIds = claimedMessageIds
        return { ok: false, error: 'stop after first projection' }
      },
      chunkTurns: 1,
      chunkBudget: smallChunkBudget
    })

    expect(checkpointedIds).toEqual(['m1', 'm2'])
  })
})

describe('host seat compaction freshness fences', () => {
  const completeSummary: HostSeatContextSummary = {
    text: 'complete durable summary',
    createdAt: '2026-07-11T00:00:00.000Z',
    provider: 'grok',
    provenance: {
      kind: 'bounded_prompt_window',
      suppliedMessageIds: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']
    }
  }

  it('accepts only the frozen participant/provider/model/session/workspace tuple', () => {
    const nextSummary: HostSeatContextSummary = {
      ...completeSummary,
      text: 'next summary'
    }
    expect(
      validateHostSeatCheckpointFreshness({
        chat: ensembleChat(seat()),
        currentWorkspace: '/workspace',
        identity: frozenIdentity,
        snapshotEligibleRows: frozenEligibleRows,
        expectedPreviousSummary: undefined,
        nextSummary,
        claimedMessageIds: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']
      })
    ).toEqual({ ok: true })

    for (const input of [
      { participant: seat({ provider: 'kimi' }), workspace: '/workspace' },
      { participant: seat({ model: 'grok-4.1' }), workspace: '/workspace' },
      { participant: seat({ linkedProviderSessionId: 'session-2' }), workspace: '/workspace' },
      { participant: seat(), workspace: '/other-workspace' }
    ]) {
      expect(
        validateHostSeatCheckpointFreshness({
          chat: ensembleChat(input.participant),
          currentWorkspace: input.workspace,
          identity: frozenIdentity,
          snapshotEligibleRows: frozenEligibleRows,
          expectedPreviousSummary: undefined,
          nextSummary,
          claimedMessageIds: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']
        })
      ).toMatchObject({ ok: false })
    }
  })

  it('rejects a replacement summary stamped for a different provider', () => {
    expect(
      validateHostSeatCheckpointFreshness({
        chat: ensembleChat(seat()),
        currentWorkspace: '/workspace',
        identity: frozenIdentity,
        snapshotEligibleRows: frozenEligibleRows,
        expectedPreviousSummary: undefined,
        nextSummary: {
          ...completeSummary,
          provider: 'kimi'
        },
        claimedMessageIds: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']
      })
    ).toEqual({
      ok: false,
      error: 'The replacement summary provider does not match the seat.'
    })
  })

  it('requires an exact prior-summary match before replacing it', () => {
    const expected: HostSeatContextSummary = {
      ...completeSummary,
      text: 'expected prior'
    }
    const chat = ensembleChat(
      seat({
        contextCompactionSummary: {
          ...expected,
          text: 'concurrently replaced'
        }
      })
    )

    expect(
      validateHostSeatCheckpointFreshness({
        chat,
        currentWorkspace: '/workspace',
        identity: frozenIdentity,
        snapshotEligibleRows: frozenEligibleRows,
        expectedPreviousSummary: expected,
        nextSummary: completeSummary,
        claimedMessageIds: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']
      })
    ).toEqual({ ok: false, error: 'The participant context summary changed.' })
  })

  it('rejects same-id source mutation while allowing newly appended eligible rows to checkpoint', () => {
    const changed = sixMessageSnapshot()
    changed[0] = { ...changed[0], content: 'edited under the same id' }
    expect(
      validateHostSeatCheckpointFreshness({
        chat: ensembleChat(seat(), changed),
        currentWorkspace: '/workspace',
        identity: frozenIdentity,
        snapshotEligibleRows: frozenEligibleRows,
        expectedPreviousSummary: undefined,
        nextSummary: completeSummary,
        claimedMessageIds: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']
      })
    ).toEqual({ ok: false, error: 'The frozen eligible transcript snapshot changed.' })

    expect(
      validateHostSeatCheckpointFreshness({
        chat: ensembleChat(seat(), [
          ...sixMessageSnapshot(),
          message('m7', 'user', 'new row remains for the next request')
        ]),
        currentWorkspace: '/workspace',
        identity: frozenIdentity,
        snapshotEligibleRows: frozenEligibleRows,
        expectedPreviousSummary: undefined,
        nextSummary: completeSummary,
        claimedMessageIds: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']
      })
    ).toEqual({ ok: true })
  })

  it('rejects reordered, missing, and duplicate exact-prefix claims', () => {
    const nextSummary: HostSeatContextSummary = {
      text: 'first checkpoint',
      createdAt: '2026-07-11T00:00:00.000Z',
      provider: 'grok',
      provenance: {
        kind: 'bounded_prompt_window',
        suppliedMessageIds: ['m1', 'm2']
      }
    }
    const variants = [
      [message('m2', 'assistant', 'two'), message('m1', 'user', 'one')],
      [message('m1', 'user', 'one')],
      [
        message('m1', 'user', 'one'),
        message('m2', 'assistant', 'two'),
        message('m1', 'user', 'duplicate')
      ]
    ]

    for (const messages of variants) {
      expect(
        validateHostSeatCheckpointFreshness({
          chat: ensembleChat(seat(), messages),
          currentWorkspace: '/workspace',
          identity: frozenIdentity,
          snapshotEligibleRows: conversationCompactionEligibleRows(messages),
          expectedPreviousSummary: undefined,
          nextSummary,
          claimedMessageIds: ['m1', 'm2']
        })
      ).toEqual({ ok: false, error: 'The claimed transcript prefix is no longer exact.' })
    }
  })

  it('blocks Grok disposal for appended eligible rows but ignores appended system cards', () => {
    const compactedSeat = seat({ contextCompactionSummary: completeSummary })
    const original = sixMessageSnapshot()
    expect(
      canDisposeGrokSeatAfterCompaction({
        chat: ensembleChat(compactedSeat, original),
        currentWorkspace: '/workspace',
        identity: frozenIdentity,
        snapshotEligibleRows: frozenEligibleRows,
        finalSummary: completeSummary
      })
    ).toBe(true)

    expect(
      canDisposeGrokSeatAfterCompaction({
        chat: ensembleChat(compactedSeat, [
          ...original,
          message('m7', 'user', 'arrived during maintenance')
        ]),
        currentWorkspace: '/workspace',
        identity: frozenIdentity,
        snapshotEligibleRows: frozenEligibleRows,
        finalSummary: completeSummary
      })
    ).toBe(false)

    expect(
      canDisposeGrokSeatAfterCompaction({
        chat: ensembleChat(compactedSeat, [
          ...original,
          {
            id: 'system-card',
            role: 'system',
            content: 'Unrelated progress card',
            timestamp: '2026-07-11T00:00:00.000Z'
          }
        ]),
        currentWorkspace: '/workspace',
        identity: frozenIdentity,
        snapshotEligibleRows: frozenEligibleRows,
        finalSummary: completeSummary
      })
    ).toBe(true)

    expect(
      canDisposeGrokSeatAfterCompaction({
        chat: ensembleChat(compactedSeat, original),
        currentWorkspace: '/workspace',
        identity: { ...frozenIdentity, provider: 'kimi' },
        snapshotEligibleRows: frozenEligibleRows,
        finalSummary: { ...completeSummary, provider: 'kimi' }
      })
    ).toBe(false)
    expect(
      canDisposeGrokSeatAfterCompaction({
        chat: ensembleChat(compactedSeat, original),
        currentWorkspace: '/workspace',
        identity: frozenIdentity,
        snapshotEligibleRows: frozenEligibleRows,
        finalSummary: { ...completeSummary, provider: 'kimi' }
      })
    ).toBe(false)
  })
})
