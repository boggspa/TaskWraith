import { describe, expect, it } from 'vitest'
import {
  buildHostCompactionSummaryPrompt,
  CONTEXT_COMPACTION_SUMMARY_MAX_CHARS,
  contextCompactionDedupeKey,
  contextCompactionMessageId,
  contextPressureSeverity,
  codexContextCompactionItemId,
  formatContextCompactionSummary,
  isClaudeContextCompactionSystemEvent,
  isCodexContextCompactionItem,
  isContextOverflowErrorText,
  normalizeClaudeContextCompactionEvent,
  pruneContiguousCompactionPrefix,
  shouldAutoCompactHostContext
} from './contextCompaction'

// Fixtures below are verbatim frames captured from live probes on 2026-07-02
// (claude CLI 2.1.156 / agent-sdk 0.2.141; codex-cli 0.139.0 app-server).

const CLAUDE_COMPACTING = {
  type: 'system',
  subtype: 'status',
  status: 'compacting',
  uuid: 'e4a676d2-8191-48f0-bf31-edeaae85f306',
  session_id: 'bc082119-dccf-426d-bcfc-5935153e63a3'
}

const CLAUDE_STATUS_SUCCESS = {
  type: 'system',
  subtype: 'status',
  status: null,
  compact_result: 'success',
  uuid: 'db271423-ad13-4e07-80db-4b1107e4cc74',
  session_id: 'bc082119-dccf-426d-bcfc-5935153e63a3'
}

const CLAUDE_STATUS_FAILED = {
  type: 'system',
  subtype: 'status',
  status: null,
  compact_result: 'failed',
  compact_error: 'Not enough messages to compact.',
  uuid: '2f9c2f70-0000-4000-8000-000000000001',
  session_id: 'bc082119-dccf-426d-bcfc-5935153e63a3'
}

const CLAUDE_COMPACT_BOUNDARY = {
  type: 'system',
  subtype: 'compact_boundary',
  compact_metadata: {
    trigger: 'manual',
    pre_tokens: 24012,
    post_tokens: 1330,
    duration_ms: 11652,
    preserved_segment: {
      head_uuid: '499dff6d-d6f7-4dfa-83b4-7cf3213b4e94',
      anchor_uuid: 'd1163151-5737-454c-9eb6-4ef865a37dce',
      tail_uuid: '1ab6b29c-2933-4c90-9ec4-c454a1d71b26'
    }
  },
  uuid: 'ca77fa3c-1d96-46d3-b728-eeef779c57b6',
  session_id: 'bc082119-dccf-426d-bcfc-5935153e63a3'
}

const CODEX_COMPACTION_ITEM = {
  type: 'contextCompaction',
  id: '4d644396-5994-43f2-b82a-0569607ae0f5'
}

describe('isClaudeContextCompactionSystemEvent', () => {
  it('matches compacting status, compact_result status, and compact_boundary frames', () => {
    expect(isClaudeContextCompactionSystemEvent(CLAUDE_COMPACTING)).toBe(true)
    expect(isClaudeContextCompactionSystemEvent(CLAUDE_STATUS_SUCCESS)).toBe(true)
    expect(isClaudeContextCompactionSystemEvent(CLAUDE_STATUS_FAILED)).toBe(true)
    expect(isClaudeContextCompactionSystemEvent(CLAUDE_COMPACT_BOUNDARY)).toBe(true)
  })

  it('ignores non-compaction system frames and non-system frames', () => {
    // Plain status heartbeat (SDK emits status:'requesting' during tool turns).
    expect(
      isClaudeContextCompactionSystemEvent({
        type: 'system',
        subtype: 'status',
        status: 'requesting'
      })
    ).toBe(false)
    expect(isClaudeContextCompactionSystemEvent({ type: 'system', subtype: 'init' })).toBe(false)
    expect(
      isClaudeContextCompactionSystemEvent({ type: 'system', subtype: 'task_progress', usage: {} })
    ).toBe(false)
    expect(isClaudeContextCompactionSystemEvent({ type: 'assistant' })).toBe(false)
    expect(isClaudeContextCompactionSystemEvent(null)).toBe(false)
  })
})

describe('normalizeClaudeContextCompactionEvent', () => {
  it('normalizes a compact_boundary into a completed signal with metadata', () => {
    const signal = normalizeClaudeContextCompactionEvent(CLAUDE_COMPACT_BOUNDARY)
    expect(signal).toEqual({
      kind: 'completed',
      telemetry: {
        eventUuid: 'ca77fa3c-1d96-46d3-b728-eeef779c57b6',
        trigger: 'manual',
        preTokens: 24012,
        postTokens: 1330,
        durationMs: 11652
      }
    })
  })

  it('normalizes compacting status to started and failed status to failed', () => {
    expect(normalizeClaudeContextCompactionEvent(CLAUDE_COMPACTING)).toEqual({
      kind: 'started',
      telemetry: { eventUuid: 'e4a676d2-8191-48f0-bf31-edeaae85f306' }
    })
    expect(normalizeClaudeContextCompactionEvent(CLAUDE_STATUS_FAILED)).toEqual({
      kind: 'failed',
      telemetry: {
        eventUuid: '2f9c2f70-0000-4000-8000-000000000001',
        error: 'Not enough messages to compact.'
      }
    })
  })

  it('returns null for the success status frame (compact_boundary is authoritative)', () => {
    expect(normalizeClaudeContextCompactionEvent(CLAUDE_STATUS_SUCCESS)).toBeNull()
  })
})

describe('contextCompactionDedupeKey', () => {
  it('keys failures on error text so re-emitted failure frames dedupe across uuids', () => {
    // The probe observed the SAME failure emitted twice with different uuids.
    const first = normalizeClaudeContextCompactionEvent(CLAUDE_STATUS_FAILED)!
    const second = normalizeClaudeContextCompactionEvent({
      ...CLAUDE_STATUS_FAILED,
      uuid: 'a totally different uuid'
    })!
    expect(contextCompactionDedupeKey(first)).toBe(contextCompactionDedupeKey(second))
  })

  it('keys completed signals on the frame uuid', () => {
    const signal = normalizeClaudeContextCompactionEvent(CLAUDE_COMPACT_BOUNDARY)!
    expect(contextCompactionDedupeKey(signal)).toBe(
      'completed:ca77fa3c-1d96-46d3-b728-eeef779c57b6'
    )
  })
})

describe('codex contextCompaction items', () => {
  it('detects the contextCompaction item and extracts its id', () => {
    expect(isCodexContextCompactionItem(CODEX_COMPACTION_ITEM)).toBe(true)
    expect(codexContextCompactionItemId(CODEX_COMPACTION_ITEM)).toBe(
      '4d644396-5994-43f2-b82a-0569607ae0f5'
    )
    expect(isCodexContextCompactionItem({ type: 'agentMessage', id: 'x' })).toBe(false)
    expect(isCodexContextCompactionItem(null)).toBe(false)
  })
})

describe('stored-summary pruning provenance', () => {
  const messages = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }]

  it('prunes only an exactly resolvable contiguous prefix', () => {
    expect(
      pruneContiguousCompactionPrefix(messages, {
        kind: 'contiguous_prompt_prefix',
        throughMessageId: 'm2',
        coveredMessageIds: ['m1', 'm2']
      })
    ).toEqual([{ id: 'm3' }])
  })

  it('accepts a valid chained prefix only when the prior anchor is inside it', () => {
    expect(
      pruneContiguousCompactionPrefix(messages, {
        kind: 'contiguous_prompt_prefix',
        throughMessageId: 'm3',
        coveredMessageIds: ['m1', 'm2', 'm3'],
        chainedFrom: {
          throughMessageId: 'm2',
          summaryCreatedAt: '2026-07-01T00:00:00Z'
        }
      })
    ).toEqual([])
  })

  it('fails open for bounded windows, provider sessions, and missing provenance', () => {
    expect(
      pruneContiguousCompactionPrefix(messages, {
        kind: 'bounded_prompt_window',
        suppliedMessageIds: ['m2']
      })
    ).toBe(messages)
    expect(
      pruneContiguousCompactionPrefix(messages, {
        kind: 'provider_session',
        providerSessionId: 'session-1',
        observedMessageIds: []
      })
    ).toBe(messages)
    expect(pruneContiguousCompactionPrefix(messages, undefined)).toBe(messages)
  })

  it('fails open for stale, gapped, reordered, duplicate, or invalid chained claims', () => {
    const claims = [
      {
        kind: 'contiguous_prompt_prefix' as const,
        throughMessageId: 'missing',
        coveredMessageIds: ['m1', 'missing']
      },
      {
        kind: 'contiguous_prompt_prefix' as const,
        throughMessageId: 'm3',
        coveredMessageIds: ['m1', 'm3']
      },
      {
        kind: 'contiguous_prompt_prefix' as const,
        throughMessageId: 'm2',
        coveredMessageIds: ['m2', 'm1']
      },
      {
        kind: 'contiguous_prompt_prefix' as const,
        throughMessageId: 'm2',
        coveredMessageIds: ['m1', 'm1']
      },
      {
        kind: 'contiguous_prompt_prefix' as const,
        throughMessageId: 'm3',
        coveredMessageIds: ['m1', 'm2', 'm3'],
        chainedFrom: { throughMessageId: 'missing', summaryCreatedAt: '2026-07-01T00:00:00Z' }
      }
    ]
    for (const claim of claims) {
      expect(pruneContiguousCompactionPrefix(messages, claim)).toBe(messages)
    }
  })

  it('fails open instead of throwing for malformed persisted provenance', () => {
    const malformedClaims: unknown[] = [
      { kind: 'contiguous_prompt_prefix' },
      { kind: 'contiguous_prompt_prefix', throughMessageId: 42, coveredMessageIds: ['m1'] },
      { kind: 'contiguous_prompt_prefix', throughMessageId: 'm1' },
      { kind: 'contiguous_prompt_prefix', throughMessageId: 'm1', coveredMessageIds: 'm1' },
      {
        kind: 'contiguous_prompt_prefix',
        throughMessageId: 'm2',
        coveredMessageIds: ['m1', 'm2'],
        chainedFrom: { throughMessageId: 'm1', summaryCreatedAt: null }
      }
    ]
    for (const claim of malformedClaims) {
      expect(pruneContiguousCompactionPrefix(messages, claim as never)).toBe(messages)
    }
  })

  it('fails open when a claimed id is ambiguous in the current transcript', () => {
    const duplicated = [{ id: 'm1' }, { id: 'm2' }, { id: 'm1' }]
    expect(
      pruneContiguousCompactionPrefix(duplicated, {
        kind: 'contiguous_prompt_prefix',
        throughMessageId: 'm2',
        coveredMessageIds: ['m1', 'm2']
      })
    ).toBe(duplicated)
  })
})

describe('host compaction summarize prompt', () => {
  it('chains prior durable memory before newly selected material', () => {
    const prompt = buildHostCompactionSummaryPrompt({
      previousSummaryText: 'Earlier decision and unresolved risk.',
      materialBlock: 'Oldest uncovered transcript rows.'
    })
    expect(prompt.indexOf('Earlier decision')).toBeLessThan(
      prompt.indexOf('Oldest uncovered transcript rows.')
    )
    expect(prompt.indexOf('Oldest uncovered transcript rows.')).toBeLessThan(
      prompt.indexOf('Create a compact context summary')
    )
  })

  it('caps legacy prior summaries before reinjection', () => {
    const oversized = `${'A'.repeat(CONTEXT_COMPACTION_SUMMARY_MAX_CHARS)}TAIL`
    const prompt = buildHostCompactionSummaryPrompt({ previousSummaryText: oversized })
    expect(prompt).not.toContain('TAIL')
    expect(prompt).toContain('Create a compact context summary')
  })
})

describe('host auto-compaction evidence policy', () => {
  it('never treats generic processed run usage as live occupancy', () => {
    for (const provider of ['kimi', 'grok', 'antigravity'] as const) {
      expect(
        shouldAutoCompactHostContext(provider, { kind: 'generic_run_usage', percent: 999 })
      ).toBe(false)
    }
  })

  it('accepts provider-semantic occupancy for antigravity (full-transcript replay lane)', () => {
    expect(
      shouldAutoCompactHostContext('antigravity', {
        kind: 'provider_semantic_occupancy',
        percent: 90
      })
    ).toBe(true)
    expect(
      shouldAutoCompactHostContext('antigravity', {
        kind: 'provider_semantic_occupancy',
        percent: 89
      })
    ).toBe(false)
    expect(
      shouldAutoCompactHostContext('antigravity', { kind: 'classified_context_overflow' })
    ).toBe(true)
  })

  it('accepts verified occupancy or classified overflow for host providers', () => {
    expect(
      shouldAutoCompactHostContext('grok', {
        kind: 'provider_semantic_occupancy',
        percent: 90
      })
    ).toBe(true)
    expect(shouldAutoCompactHostContext('grok', { kind: 'classified_context_overflow' })).toBe(true)
    expect(
      shouldAutoCompactHostContext('grok', {
        kind: 'provider_semantic_occupancy',
        percent: 89.9
      })
    ).toBe(false)
  })

  it('accepts uncovered prompt rows only for Kimi', () => {
    const evidence = { kind: 'prompt_projection_uncovered' as const, messageIds: ['m1'] }
    expect(shouldAutoCompactHostContext('kimi', evidence)).toBe(true)
    expect(shouldAutoCompactHostContext('grok', evidence)).toBe(false)
    expect(
      shouldAutoCompactHostContext('kimi', {
        kind: 'prompt_projection_uncovered',
        messageIds: []
      })
    ).toBe(false)
  })
})

describe('contextPressureSeverity', () => {
  it('grades ok/warn/critical at the Ollama-parity thresholds', () => {
    expect(contextPressureSeverity(0)).toBe('ok')
    expect(contextPressureSeverity(79.9)).toBe('ok')
    expect(contextPressureSeverity(80)).toBe('warn')
    expect(contextPressureSeverity(94.9)).toBe('warn')
    expect(contextPressureSeverity(95)).toBe('critical')
    expect(contextPressureSeverity(100)).toBe('critical')
    expect(contextPressureSeverity(Number.NaN)).toBe('ok')
  })
})

describe('isContextOverflowErrorText', () => {
  it('matches known provider overflow messages', () => {
    expect(isContextOverflowErrorText('prompt is too long: 213448 tokens > 200000 maximum')).toBe(
      true
    )
    expect(isContextOverflowErrorText("This model's maximum context length is 128000 tokens")).toBe(
      true
    )
    expect(isContextOverflowErrorText('error code: context_length_exceeded')).toBe(true)
    expect(
      isContextOverflowErrorText('input length and `max_tokens` exceed context limit: 199999')
    ).toBe(true)
    expect(isContextOverflowErrorText('request exceeds the model context window')).toBe(true)
  })

  it('does NOT match quota walls or unrelated errors', () => {
    // xAI TPM wall — owned by the quota classifier, not overflow.
    expect(isContextOverflowErrorText('Too many tokens for team')).toBe(false)
    expect(isContextOverflowErrorText('rate_limit_error: usage limit reached')).toBe(false)
    expect(isContextOverflowErrorText('ENOENT: command not found')).toBe(false)
    expect(isContextOverflowErrorText('')).toBe(false)
    expect(isContextOverflowErrorText(undefined)).toBe(false)
  })
})

describe('card helpers', () => {
  it('builds deterministic message ids preferring the event uuid', () => {
    const signal = normalizeClaudeContextCompactionEvent(CLAUDE_COMPACT_BOUNDARY)!
    expect(contextCompactionMessageId(signal.telemetry, 'run-1-completed')).toBe(
      'context-compaction-ca77fa3c-1d96-46d3-b728-eeef779c57b6'
    )
    expect(contextCompactionMessageId({}, 'run-1-failed')).toBe('context-compaction-run-1-failed')
  })

  it('formats summaries in the run-complete row voice', () => {
    const completed = normalizeClaudeContextCompactionEvent(CLAUDE_COMPACT_BOUNDARY)!
    expect(formatContextCompactionSummary(completed, 'Claude')).toBe(
      'Context compacted · 24k → 1k tokens · manual · Claude'
    )
    const failed = normalizeClaudeContextCompactionEvent(CLAUDE_STATUS_FAILED)!
    expect(formatContextCompactionSummary(failed)).toBe(
      'Context compaction failed — Not enough messages to compact.'
    )
    expect(formatContextCompactionSummary({ kind: 'started', telemetry: {} })).toBe(
      'Compacting context…'
    )
  })
})
