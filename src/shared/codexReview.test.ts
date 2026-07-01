import { describe, expect, it } from 'vitest'
import {
  codexReviewCompletionTelemetry,
  codexReviewStartTelemetry,
  codexReviewTargetLabel,
  isCodexReviewToolName,
  mergeCodexReviewTelemetry,
  normalizeCodexReviewStatus,
  type CodexReviewTelemetry
} from './codexReview'

describe('isCodexReviewToolName', () => {
  it('matches the synthesized review anchor name', () => {
    expect(isCodexReviewToolName('codex_review')).toBe(true)
    expect(isCodexReviewToolName('CODEX_REVIEW')).toBe(true)
  })
  it('rejects other tools', () => {
    expect(isCodexReviewToolName('workflow')).toBe(false)
    expect(isCodexReviewToolName('review')).toBe(false)
    expect(isCodexReviewToolName('')).toBe(false)
    expect(isCodexReviewToolName(null)).toBe(false)
  })
})

describe('codexReviewTargetLabel', () => {
  it('labels the known Codex target shapes', () => {
    expect(codexReviewTargetLabel({ type: 'uncommittedChanges' })).toBe('uncommitted changes')
    expect(codexReviewTargetLabel({ type: 'stagedChanges' })).toBe('staged changes')
    expect(codexReviewTargetLabel({ type: 'commit', sha: 'abcdef1234' })).toBe('commit abcdef12')
    expect(codexReviewTargetLabel('everything')).toBe('everything')
  })
  it('falls back to spaced words for unknown types, undefined otherwise', () => {
    expect(codexReviewTargetLabel({ type: 'workingTree' })).toBe('working tree')
    expect(codexReviewTargetLabel(undefined)).toBeUndefined()
    expect(codexReviewTargetLabel({})).toBeUndefined()
  })
})

describe('normalizeCodexReviewStatus', () => {
  it('maps common status strings', () => {
    expect(normalizeCodexReviewStatus('completed')).toBe('completed')
    expect(normalizeCodexReviewStatus('success')).toBe('completed')
    expect(normalizeCodexReviewStatus('failed')).toBe('failed')
    expect(normalizeCodexReviewStatus('cancelled')).toBe('stopped')
    expect(normalizeCodexReviewStatus('running')).toBe('running')
    expect(normalizeCodexReviewStatus('')).toBe('unknown')
    expect(normalizeCodexReviewStatus('weird')).toBe('unknown')
  })
})

describe('codexReviewStartTelemetry', () => {
  it('builds running telemetry from the review/start request', () => {
    const t = codexReviewStartTelemetry({ target: { type: 'uncommittedChanges' }, model: 'gpt-x' })
    expect(t).toEqual({
      provider: 'codex',
      status: 'running',
      target: 'uncommitted changes',
      model: 'gpt-x'
    })
  })
  it('omits absent fields', () => {
    expect(codexReviewStartTelemetry({})).toEqual({ provider: 'codex', status: 'running' })
  })
})

describe('codexReviewCompletionTelemetry', () => {
  it('maps a completed review', () => {
    const t = codexReviewCompletionTelemetry({
      status: 'completed',
      durationMs: 42000,
      totalTokens: 9000
    })
    expect(t.status).toBe('completed')
    expect(t.durationMs).toBe(42000)
    expect(t.totalTokens).toBe(9000)
  })
  it('defaults a status-less settle to completed, and an error to failed', () => {
    expect(codexReviewCompletionTelemetry({}).status).toBe('completed')
    expect(codexReviewCompletionTelemetry({ error: 'boom' }).status).toBe('failed')
    expect(codexReviewCompletionTelemetry({ error: 'boom' }).error).toBe('boom')
  })
})

describe('mergeCodexReviewTelemetry', () => {
  it('keeps prior fields when the patch is sparse', () => {
    const prev: CodexReviewTelemetry = { provider: 'codex', target: 'uncommitted changes', status: 'running' }
    const merged = mergeCodexReviewTelemetry(prev, { status: 'completed', durationMs: 100 })
    expect(merged.target).toBe('uncommitted changes')
    expect(merged.status).toBe('completed')
    expect(merged.durationMs).toBe(100)
  })
  it('never downgrades a terminal status back to running', () => {
    const prev: CodexReviewTelemetry = { status: 'completed' }
    expect(mergeCodexReviewTelemetry(prev, { status: 'running' }).status).toBe('completed')
  })
})
