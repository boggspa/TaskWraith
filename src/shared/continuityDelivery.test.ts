import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord, ChatRun, ToolActivity } from '../main/store/types'
import {
  continuityDeliveryKey,
  formatContinuityCheckpointBlock,
  latestSuccessfulContinuityCompaction,
  planContinuityDeliveryForNextHostTurn
} from './continuityDelivery'
import { CONTINUITY_BLOCK_MAX_CHARS, type SeatContinuityCheckpoint } from './threadContinuity'

const START = '2026-09-05T12:00:00.000Z'
const UPDATED = '2026-09-05T12:05:00.000Z'
const COMPACTED = '2026-09-05T12:10:00.000Z'
const AFTER = '2026-09-05T12:11:00.000Z'

function checkpoint(
  overrides: Partial<SeatContinuityCheckpoint> & Record<string, unknown> = {}
): SeatContinuityCheckpoint {
  return {
    schemaVersion: 1,
    chatId: 'chat',
    seatId: '__solo__',
    revision: 1,
    text: 'Next: inspect replay ordering. Constraint: keep exact evidence references.',
    references: [{ messageId: 'source-message', activityId: 'source-tool' }],
    updatedAt: UPDATED,
    author: {
      provider: 'codex',
      runId: 'author-run',
      providerSessionId: 'session-a'
    },
    ...overrides
  } as SeatContinuityCheckpoint
}

function run(overrides: Partial<ChatRun> = {}): ChatRun {
  return {
    runId: 'run',
    provider: 'codex',
    providerThreadId: 'session-a',
    startedAt: START,
    endedAt: '2026-09-05T12:06:00.000Z',
    status: 'success',
    ...overrides
  }
}

function chat(
  input: {
    checkpoint?: SeatContinuityCheckpoint
    checkpoints?: Record<string, SeatContinuityCheckpoint>
    messages?: ChatMessage[]
    runs?: ChatRun[]
    appChatId?: string
  } = {}
): Pick<ChatRecord, 'appChatId' | 'messages' | 'runs' | 'continuityCheckpoints'> {
  const stored = input.checkpoints || {
    [(input.checkpoint || checkpoint()).seatId]: input.checkpoint || checkpoint()
  }
  return {
    appChatId: input.appChatId || 'chat',
    messages: input.messages || [],
    runs: input.runs || [],
    continuityCheckpoints: stored
  }
}

function compactionMessage(
  input: {
    id?: string
    participantId?: string
    provider?: 'codex' | 'claude'
    timestamp?: string
    kind?: 'completed' | 'failed'
  } = {}
): ChatMessage {
  const provider = input.provider || 'codex'
  return {
    id: input.id || 'compaction',
    role: 'system',
    content: 'Context compacted',
    timestamp: input.timestamp || COMPACTED,
    metadata: {
      kind: 'contextCompaction',
      provider,
      ...(input.participantId ? { ensembleParticipantId: input.participantId } : {}),
      contextCompaction: {
        kind: input.kind || 'completed',
        telemetry: { provider, trigger: 'auto' }
      }
    }
  }
}

function nativePlan(
  record: ReturnType<typeof chat>,
  overrides: Partial<Parameters<typeof planContinuityDeliveryForNextHostTurn>[0]> = {}
) {
  return planContinuityDeliveryForNextHostTurn({
    chat: record,
    provider: 'codex',
    providerSessionId: 'session-a',
    contextMode: 'native-session',
    enabled: true,
    contextIsolated: false,
    tools: {
      checkpoint: 'tw_checkpoint',
      historySearch: 'tw_history_search',
      historyRead: 'tw_history_read'
    },
    ...overrides
  })
}

describe('continuity delivery planning', () => {
  it('uses a successful author run in the same native session and restores after rotation', () => {
    const cp = checkpoint()
    const record = chat({
      checkpoint: cp,
      runs: [run({ runId: 'author-run' })]
    })
    expect(nativePlan(record)).toMatchObject({
      action: 'omit',
      reason: 'known_from_author_run'
    })

    const rotated = nativePlan(record, { providerSessionId: 'session-b' })
    expect(rotated).toMatchObject({ action: 'deliver', reason: 'native_delivery_required' })
    if (rotated.action !== 'deliver') throw new Error('Expected a delivery plan.')
    const delivered = chat({
      checkpoint: cp,
      runs: [
        ...record.runs,
        run({
          runId: 'delivery-run',
          providerThreadId: 'session-b',
          startedAt: AFTER,
          endedAt: '2026-09-05T12:12:00.000Z',
          continuityCheckpointDelivery: rotated.delivery
        })
      ]
    })
    expect(nativePlan(delivered, { providerSessionId: 'session-b' })).toMatchObject({
      action: 'omit',
      reason: 'already_delivered'
    })
  })

  it('treats mid-run compaction as a new boundary and retries a failed delivery', () => {
    const cp = checkpoint()
    const record = chat({
      checkpoint: cp,
      messages: [compactionMessage()],
      runs: [
        run({
          runId: 'author-run',
          startedAt: START,
          endedAt: '2026-09-05T12:12:00.000Z'
        })
      ]
    })
    const first = nativePlan(record)
    expect(first).toMatchObject({ action: 'deliver', reason: 'native_delivery_required' })
    if (first.action !== 'deliver') throw new Error('Expected a delivery plan.')

    const failed = chat({
      checkpoint: cp,
      messages: record.messages,
      runs: [
        ...record.runs,
        run({
          runId: 'failed-delivery',
          startedAt: AFTER,
          endedAt: '2026-09-05T12:12:00.000Z',
          status: 'failed',
          continuityCheckpointDelivery: first.delivery
        })
      ]
    })
    expect(nativePlan(failed)).toMatchObject({
      action: 'deliver',
      delivery: { key: first.delivery.key }
    })

    const succeeded = chat({
      checkpoint: cp,
      messages: record.messages,
      runs: [
        ...failed.runs,
        run({
          runId: 'successful-delivery',
          startedAt: AFTER,
          endedAt: '2026-09-05T12:13:00.000Z',
          continuityCheckpointDelivery: first.delivery
        })
      ]
    })
    expect(nativePlan(succeeded)).toMatchObject({ action: 'omit', reason: 'already_delivered' })
  })

  it('repeats live checkpoints for host-fed turns even after a successful receipt', () => {
    const cp = checkpoint()
    const initial = planContinuityDeliveryForNextHostTurn({
      chat: chat({ checkpoint: cp }),
      provider: 'cursor',
      contextMode: 'host-fed',
      enabled: true,
      contextIsolated: false
    })
    expect(initial).toMatchObject({ action: 'deliver', reason: 'host_fed_repeat' })
    if (initial.action !== 'deliver') throw new Error('Expected a delivery plan.')
    const repeated = planContinuityDeliveryForNextHostTurn({
      chat: chat({
        checkpoint: cp,
        runs: [
          run({
            provider: 'cursor',
            providerThreadId: undefined,
            continuityCheckpointDelivery: initial.delivery
          })
        ]
      }),
      provider: 'cursor',
      contextMode: 'host-fed',
      enabled: true,
      contextIsolated: false
    })
    expect(repeated).toMatchObject({ action: 'deliver', reason: 'host_fed_repeat' })
  })

  it('keeps checkpoints and compaction boundaries isolated by exact seat', () => {
    const worker = checkpoint({ seatId: 'worker', text: 'Worker-only next action.' })
    const reviewer = checkpoint({
      seatId: 'reviewer',
      text: 'Reviewer-only concern.',
      author: { provider: 'codex', runId: 'reviewer-run', providerSessionId: 'session-r' }
    })
    const record = chat({
      checkpoints: { worker, reviewer },
      messages: [compactionMessage({ id: 'reviewer-compact', participantId: 'reviewer' })]
    })
    expect(
      latestSuccessfulContinuityCompaction({
        messages: record.messages,
        seatId: 'worker',
        provider: 'codex'
      })
    ).toBeUndefined()
    const plan = nativePlan(record, { seatId: 'worker' })
    expect(plan).toMatchObject({ action: 'deliver', checkpoint: { seatId: 'worker' } })
    if (plan.action !== 'deliver') throw new Error('Expected a delivery plan.')
    expect(plan.block).toContain('Worker-only next action.')
    expect(plan.block).not.toContain('Reviewer-only concern.')
  })

  it('does not inherit a copied checkpoint in a forked chat', () => {
    expect(nativePlan(chat({ appChatId: 'fork' }))).toEqual({
      action: 'omit',
      reason: 'checkpoint_unavailable'
    })
  })

  it('delivers and receipts a cleared tombstone without inventing checkpoint text', () => {
    const cleared = checkpoint({
      text: '',
      cleared: true,
      references: [],
      author: { provider: 'codex', runId: 'clear-run', providerSessionId: 'session-a' }
    })
    const first = nativePlan(chat({ checkpoint: cleared }))
    expect(first).toMatchObject({ action: 'deliver', reason: 'native_delivery_required' })
    if (first.action !== 'deliver') throw new Error('Expected a delivery plan.')
    expect(first.block).toContain('Status: cleared')
    expect(first.block).not.toContain('Checkpoint text (quoted JSON string)')

    const after = chat({
      checkpoint: cleared,
      runs: [
        run({
          runId: 'clear-delivery',
          startedAt: AFTER,
          endedAt: '2026-09-05T12:12:00.000Z',
          continuityCheckpointDelivery: first.delivery
        })
      ]
    })
    expect(nativePlan(after)).toMatchObject({ action: 'omit', reason: 'already_delivered' })
  })

  it('changes the receipt for checkpoint revision and incarnation changes', () => {
    const first = checkpoint()
    const second = checkpoint({ revision: 2 })
    const reincarnated = checkpoint({
      author: { provider: 'codex', runId: 'replacement-run', providerSessionId: 'session-a' }
    })
    const base = {
      seatId: '__solo__',
      provider: 'codex' as const,
      providerSessionId: 'session-a'
    }
    expect(continuityDeliveryKey({ ...base, checkpoint: first })).not.toBe(
      continuityDeliveryKey({ ...base, checkpoint: second })
    )
    expect(continuityDeliveryKey({ ...base, checkpoint: first })).not.toBe(
      continuityDeliveryKey({ ...base, checkpoint: reincarnated })
    )
  })

  it('honours disable/isolation opt-outs before exposing checkpoint content', () => {
    const record = chat()
    expect(nativePlan(record, { enabled: false })).toEqual({ action: 'omit', reason: 'disabled' })
    expect(nativePlan(record, { contextIsolated: true })).toEqual({
      action: 'omit',
      reason: 'context_isolated'
    })
  })
})

describe('continuity checkpoint prompt block', () => {
  it('bounds the complete block including references and never dereferences tool results', () => {
    const sentinel = 'SECRET_RAW_TOOL_RESULT_MUST_NOT_APPEAR'
    const references = Array.from({ length: 6 }, (_, index) => ({
      messageId: `message-${index}-${'m'.repeat(145)}`,
      activityId: `activity-${index}-${'a'.repeat(142)}`
    }))
    const cp = checkpoint({
      text: `${'\\\n'.repeat(700)}Keep only the authored next action.`,
      references
    })
    const toolActivity = {
      id: references[0].activityId,
      toolName: 'run_shell_command',
      displayName: 'Shell',
      category: 'shell',
      status: 'success',
      rawResultEvent: sentinel
    } as ToolActivity
    const record = chat({
      checkpoint: cp,
      messages: [
        {
          id: references[0].messageId,
          role: 'assistant',
          content: `assistant echo ${sentinel}`,
          timestamp: START,
          toolActivities: [toolActivity]
        }
      ]
    })
    const plan = planContinuityDeliveryForNextHostTurn({
      chat: record,
      provider: 'cursor',
      contextMode: 'host-fed',
      enabled: true,
      contextIsolated: false,
      tools: {
        checkpoint: 'tw_checkpoint',
        historySearch: 'tw_history_search',
        historyRead: 'tw_history_read'
      }
    })
    expect(plan.action).toBe('deliver')
    if (plan.action !== 'deliver') throw new Error('Expected a delivery plan.')
    expect(plan.block.length).toBeLessThanOrEqual(CONTINUITY_BLOCK_MAX_CHARS)
    expect(plan.block).toContain('Evidence references (content intentionally omitted)')
    expect(plan.block).not.toContain(sentinel)
  })

  it('emits tool hints only for explicitly available, valid tools', () => {
    const cp = checkpoint()
    const unavailable = formatContinuityCheckpointBlock(cp)
    expect(unavailable).not.toMatch(/tw_checkpoint|tw_history/)

    const partial = formatContinuityCheckpointBlock(cp, {
      checkpoint: 'not a tool name',
      historySearch: 'tw_history_search'
    })
    expect(partial).not.toMatch(/not a tool name|tw_history_search/)

    const available = formatContinuityCheckpointBlock(cp, {
      checkpoint: 'tw_checkpoint',
      historySearch: 'tw_history_search',
      historyRead: 'tw_history_read'
    })
    expect(available).toContain('tw_checkpoint')
    expect(available).toContain('tw_history_search')
    expect(available).toContain('tw_history_read')
  })

  it('ignores failed, other-provider, and other-seat compaction cards', () => {
    const messages = [
      compactionMessage({ id: 'failed', kind: 'failed' }),
      compactionMessage({ id: 'claude', provider: 'claude' }),
      compactionMessage({ id: 'worker', participantId: 'worker' }),
      compactionMessage({ id: 'solo-success' })
    ]
    expect(
      latestSuccessfulContinuityCompaction({
        messages,
        seatId: '__solo__',
        provider: 'codex'
      })
    ).toEqual({ messageId: 'solo-success', timestamp: COMPACTED })
  })
})
