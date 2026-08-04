import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  createHostRerunContinuationCorrelation,
  createHostRerunContinuationRunId,
  resolveHostRerunContinuationSession
} from './HostRerunContinuation'

const mainSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

function between(start: string, end: string): string {
  const startIndex = mainSource.indexOf(start)
  const endIndex = mainSource.indexOf(end, startIndex)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return mainSource.slice(startIndex, endIndex)
}

describe('host-rerun continuation identity + history join', () => {
  it('mints R1 ≠ R0 and never reuses the approval run for dispatch', () => {
    const parentRunId = 'approval-run-r0'
    const correlation = createHostRerunContinuationCorrelation({
      parentRunId,
      appChatId: 'chat-host-1',
      approvalId: 'req-1',
      hostResult: { exitCode: 0, timedOut: false, resultText: 'ok' }
    })
    expect(correlation.continuationRunId).not.toBe(parentRunId)
    expect(correlation.continuationRunId).toMatch(/^host-rerun-continue-[0-9a-f]{32}$/)

    const continuation = between(
      'async function continueCodexAfterHostRerun(',
      'async function runApprovedHostCommand('
    )
    expect(continuation).toContain('createHostRerunContinuationCorrelation(')
    expect(continuation).toContain('appRunId: continuationRunId')
    expect(continuation).toContain('handoffSourceRunId: approvalRunId')
    // Must not dispatch under the approval run identity.
    expect(continuation).not.toContain('appRunId: approvalRunId')
    expect(continuation).not.toContain("createFallbackRunId('codex')")
  })

  it('resumes the existing Codex session and refuses virgin spawn', () => {
    const parentRunId = 'approval-run-r0'
    const continuationRunId = createHostRerunContinuationRunId({
      parentRunId,
      appChatId: 'chat-host-1',
      approvalId: 'req-1',
      hostResultKey: 'host-result-abc'
    })

    const missing = resolveHostRerunContinuationSession({
      appChatId: 'chat-host-1',
      priorProviderSessionId: null,
      parentRunId,
      continuationRunId
    })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.code).toBe('missing_session')

    const ok = resolveHostRerunContinuationSession({
      appChatId: 'chat-host-1',
      priorProviderSessionId: 'thread_existing',
      parentRunId,
      continuationRunId
    })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.providerSessionId).toBe('thread_existing')

    const continuation = between(
      'async function continueCodexAfterHostRerun(',
      'async function runApprovedHostCommand('
    )
    expect(continuation).toContain('resolveHostRerunContinuationSession(')
    expect(continuation).toContain('linkedProviderSessionId')
    expect(continuation).toContain('approval.threadId')
    expect(continuation).toContain('sessionDecision.ok')
    expect(continuation).toContain('providerSessionId: resumeProviderSessionId')
    // Untrusted host wrap, not a bare dump that could be mistaken for authority.
    expect(continuation).toContain('buildHostRerunContinuationPrompt(')
  })

  it('keeps host projection on R0 and only continues after tool_result projection', () => {
    const approved = between(
      'async function runApprovedHostCommand(',
      'function syncCodexGoalCapabilityMetadata('
    )
    // R0 still owns the host command projection.
    expect(approved).toContain("source: 'codex-host-rerun'")
    expect(approved).toContain('appRunId: approvalRunId')
    const toolResult = approved.indexOf("type: 'tool_result'")
    const continueCall = approved.indexOf('continueCodexAfterHostRerun(')
    const completeProjection = approved.indexOf('completeHostCommandTerminalProjection(')
    expect(toolResult).toBeGreaterThanOrEqual(0)
    expect(continueCall).toBeGreaterThan(toolResult)
    // Projection completion is in finally so R0 result remains even if R1 fails.
    expect(completeProjection).toBeGreaterThan(continueCall)
    expect(approved).toContain('continueCodexAfterHostRerun(approval, result, resultText, requestId)')
  })

  it('keeps Stack attempts fail-closed for host-rerun continuation', () => {
    const approved = between(
      'async function runApprovedHostCommand(',
      'function syncCodexGoalCapabilityMetadata('
    )
    expect(approved).toContain('executionGraphOwnsOrAnchorsRunId(approvalRunId)')
    expect(approved).toContain(
      'Host-process command reruns are unavailable inside a durable Stack attempt'
    )
    const stackGate = approved.indexOf('executionGraphOwnsOrAnchorsRunId(approvalRunId)')
    const continueCall = approved.indexOf('continueCodexAfterHostRerun(')
    expect(stackGate).toBeGreaterThanOrEqual(0)
    expect(stackGate).toBeLessThan(continueCall)
  })

  it('does not dual-own history-join: R1 is a separate dispatch from R0 projection', () => {
    const continuation = between(
      'async function continueCodexAfterHostRerun(',
      'async function runApprovedHostCommand('
    )
    // Independent R1 goes through RunCoordinator with its own appRunId so
    // history deletion of R0 cannot settle R1 (and vice versa).
    expect(continuation).toContain('runCoordinatorRef.dispatch(runPayload')
    expect(continuation).toContain('appRunId: continuationRunId')
    expect(continuation).toContain('handoffSourceRunId: approvalRunId')
    // No turn/start under R0 inside the continuation helper.
    expect(continuation).not.toContain("'turn/start'")
    // Automatic continuation is never Full Access.
    expect(continuation).toContain('const sessionTrust = false')
  })
})
