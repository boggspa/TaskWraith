import { describe, expect, it } from 'vitest'
import {
  HOST_RERUN_CONTINUATION_SOURCE,
  HOST_RERUN_RESULT_TRUST,
  buildHostRerunContinuationPrompt,
  createHostRerunContinuationCorrelation,
  createHostRerunContinuationRunId,
  createHostRerunHostResultKey,
  resolveHostRerunContinuationSession
} from './HostRerunContinuation'

const parentRunId = 'run-approval-r0'
const appChatId = 'chat-1'
const approvalId = 'approval-req-1'

function resultKey(overrides: Partial<Parameters<typeof createHostRerunHostResultKey>[0]> = {}) {
  return createHostRerunHostResultKey({
    exitCode: 0,
    timedOut: false,
    durationMs: 12,
    resultText: 'Exit code: 0\n\nstdout:\nok',
    ...overrides
  })
}

describe('createHostRerunHostResultKey', () => {
  it('is stable for the same outcome and changes when exit or body changes', () => {
    const a = resultKey()
    const b = resultKey()
    expect(a).toBe(b)
    expect(a).toMatch(/^host-result-[0-9a-f]{32}$/)
    expect(resultKey({ exitCode: 1 })).not.toBe(a)
    expect(resultKey({ resultText: 'different' })).not.toBe(a)
    expect(resultKey({ timedOut: true, exitCode: null })).not.toBe(a)
  })
})

describe('createHostRerunContinuationRunId', () => {
  it('mints a stable R1 identity that is always distinct from R0', () => {
    const hostResultKey = resultKey()
    const r1 = createHostRerunContinuationRunId({
      parentRunId,
      appChatId,
      approvalId,
      hostResultKey
    })
    const same = createHostRerunContinuationRunId({
      parentRunId,
      appChatId,
      approvalId,
      hostResultKey
    })
    expect(r1).toBe(same)
    expect(r1).toMatch(/^host-rerun-continue-[0-9a-f]{32}$/)
    expect(r1).not.toBe(parentRunId)
  })

  it('changes when parent run, chat, approval, or host result changes', () => {
    const hostResultKey = resultKey()
    const base = createHostRerunContinuationRunId({
      parentRunId,
      appChatId,
      approvalId,
      hostResultKey
    })
    expect(
      createHostRerunContinuationRunId({
        parentRunId: 'other-r0',
        appChatId,
        approvalId,
        hostResultKey
      })
    ).not.toBe(base)
    expect(
      createHostRerunContinuationRunId({
        parentRunId,
        appChatId: 'chat-2',
        approvalId,
        hostResultKey
      })
    ).not.toBe(base)
    expect(
      createHostRerunContinuationRunId({
        parentRunId,
        appChatId,
        approvalId: 'other-approval',
        hostResultKey
      })
    ).not.toBe(base)
    expect(
      createHostRerunContinuationRunId({
        parentRunId,
        appChatId,
        approvalId,
        hostResultKey: resultKey({ exitCode: 2 })
      })
    ).not.toBe(base)
  })
})

describe('createHostRerunContinuationCorrelation', () => {
  it('bundles R1 mint with parent correlation fields', () => {
    const correlation = createHostRerunContinuationCorrelation({
      parentRunId,
      appChatId,
      approvalId,
      hostResult: {
        exitCode: 0,
        timedOut: false,
        resultText: 'ok'
      }
    })
    expect(correlation.continuationRunId).not.toBe(correlation.parentRunId)
    expect(correlation.parentRunId).toBe(parentRunId)
    expect(correlation.appChatId).toBe(appChatId)
    expect(correlation.approvalId).toBe(approvalId)
    expect(correlation.source).toBe(HOST_RERUN_CONTINUATION_SOURCE)
    expect(correlation.kind).toBe('host_rerun')
    expect(correlation.hostResultKey).toMatch(/^host-result-/)
  })
})

describe('resolveHostRerunContinuationSession', () => {
  it('requires an existing provider session (never virgin spawn)', () => {
    const continuationRunId = createHostRerunContinuationRunId({
      parentRunId,
      appChatId,
      approvalId,
      hostResultKey: resultKey()
    })
    const missing = resolveHostRerunContinuationSession({
      appChatId,
      priorProviderSessionId: null,
      parentRunId,
      continuationRunId
    })
    expect(missing).toEqual({
      ok: false,
      code: 'missing_session',
      reason: expect.stringContaining('existing Codex provider session')
    })

    const empty = resolveHostRerunContinuationSession({
      appChatId,
      priorProviderSessionId: '   ',
      parentRunId,
      continuationRunId
    })
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.code).toBe('missing_session')
  })

  it('rejects identity collision when R1 equals R0', () => {
    const decision = resolveHostRerunContinuationSession({
      appChatId,
      priorProviderSessionId: 'thread_abc',
      parentRunId,
      continuationRunId: parentRunId
    })
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.code).toBe('identity_collision')
  })

  it('returns the prior session id for resume when R1 is independent', () => {
    const continuationRunId = createHostRerunContinuationRunId({
      parentRunId,
      appChatId,
      approvalId,
      hostResultKey: resultKey()
    })
    const decision = resolveHostRerunContinuationSession({
      appChatId,
      priorProviderSessionId: 'thread_existing_codex',
      parentRunId,
      continuationRunId
    })
    expect(decision).toEqual({
      ok: true,
      providerSessionId: 'thread_existing_codex',
      continuationRunId,
      parentRunId,
      appChatId
    })
  })
})

describe('buildHostRerunContinuationPrompt', () => {
  it('fences host output as untrusted data and includes command + exit', () => {
    const prompt = buildHostRerunContinuationPrompt({
      commandText: 'swift test',
      resultText: 'Exit code: 0\n\nstdout:\nAll tests passed',
      exitCode: 0,
      timedOut: false,
      reason: 'sandbox collision',
      cwd: '/tmp/ws'
    })
    expect(prompt).toContain(HOST_RERUN_RESULT_TRUST)
    expect(prompt).toContain('<host_rerun_result')
    expect(prompt).toContain('swift test')
    expect(prompt).toContain('All tests passed')
    expect(prompt).toContain('Exit: 0')
    expect(prompt).toContain('sandbox collision')
    expect(prompt).toContain('existing provider session')
    expect(prompt).toContain('untrusted')
  })
})
