import { describe, expect, it } from 'vitest'
import {
  buildCloseoutSummaryUnavailableSnapshot,
  normalizeCloseoutSummaryResult,
  sanitizeCloseoutSummaryRequest
} from './CloseoutSummarizer'

describe('CloseoutSummarizer', () => {
  it('sanitizes a full digest and drops empty or malformed sections', () => {
    const request = sanitizeCloseoutSummaryRequest({
      targetId: '  run-1  ',
      scope: 'ensembleRound',
      status: 'completed',
      durationMs: 39_000,
      provider: 'Codex',
      model: 'GPT-5.6-Sol',
      promptText: `Fix   the\nlogin bug.`,
      finalText: 'Done.',
      fileChanges: [
        { path: 'src/a.ts', additions: 3, deletions: 1 },
        { path: '', additions: 9 },
        { path: 'src/b.ts', additions: -4, deletions: 'x' }
      ],
      commits: [{ hash: 'abc123', subject: 'Fix login' }, { hash: '' }, 'garbage'],
      toolCounts: { write: 3, read: 0, '': 2, shell: 'lots' },
      validations: ['Validation passed for the tests.', '', 42],
      warnings: ['  Sandbox denied one command.  '],
      participants: [
        { label: 'Reviewer', provider: 'Claude', model: 'Fable 5', status: 'answered' },
        { label: '' },
        null
      ]
    })

    expect(request.targetId).toBe('run-1')
    expect(request.scope).toBe('ensembleRound')
    expect(request.promptText).toBe('Fix the login bug.')
    expect(request.fileChanges).toEqual([
      { path: 'src/a.ts', additions: 3, deletions: 1 },
      { path: 'src/b.ts' }
    ])
    expect(request.commits).toEqual([{ hash: 'abc123', subject: 'Fix login' }])
    expect(request.toolCounts).toEqual({ write: 3 })
    expect(request.validations).toEqual(['Validation passed for the tests.'])
    expect(request.warnings).toEqual(['Sandbox denied one command.'])
    expect(request.participants).toEqual([
      { label: 'Reviewer', provider: 'Claude', model: 'Fable 5', status: 'answered' }
    ])
  })

  it('requires a target id and defaults unknown scopes to run', () => {
    expect(() => sanitizeCloseoutSummaryRequest({ targetId: '   ' })).toThrow(
      'Close-out summary target id is required.'
    )
    expect(sanitizeCloseoutSummaryRequest({ targetId: 'run-2', scope: 'nonsense' }).scope).toBe(
      'run'
    )
  })

  it('caps oversized text fields', () => {
    const request = sanitizeCloseoutSummaryRequest({
      targetId: 'run-3',
      promptText: 'p'.repeat(5000),
      finalText: 'f'.repeat(5000)
    })
    expect(request.promptText!.length).toBeLessThanOrEqual(700)
    expect(request.finalText!.length).toBeLessThanOrEqual(1400)
    expect(request.promptText!.endsWith('…')).toBe(true)
  })

  it('shrinks an oversized digest toward the total budget instead of shipping ~16k chars', () => {
    const request = sanitizeCloseoutSummaryRequest({
      targetId: 'round-busy',
      scope: 'ensembleRound',
      promptText: 'p'.repeat(700),
      finalText: 'f'.repeat(1400),
      fileChanges: Array.from({ length: 16 }, (_, index) => ({
        path: `src/${'x'.repeat(180)}-${index}.ts`,
        additions: 10,
        deletions: 2
      })),
      commits: Array.from({ length: 8 }, (_, index) => ({
        hash: `abc123${index}0000`,
        subject: 's'.repeat(140)
      })),
      warnings: Array.from({ length: 8 }, () => 'w'.repeat(280)),
      participants: Array.from({ length: 8 }, (_, index) => ({
        label: `Seat ${index}`,
        provider: 'Codex',
        model: 'GPT-5.6-Sol',
        status: 'answered',
        finalText: 't'.repeat(400)
      }))
    })

    // Reductions apply in dispensability order and stop once the digest fits
    // the budget, so the tail fields (prompt) survive when earlier trims are
    // enough. Assert the applied trims and the overall outcome, not every step.
    expect(request.participants!.length).toBeLessThanOrEqual(4)
    expect(request.participants![0].finalText!.length).toBeLessThanOrEqual(160)
    expect(request.fileChanges!.length).toBeLessThanOrEqual(8)
    expect(request.warnings!.length).toBeLessThanOrEqual(4)
    expect(request.commits!.length).toBeLessThanOrEqual(4)
    expect(request.finalText!.length).toBeLessThanOrEqual(700)
    expect(JSON.stringify(request).length).toBeLessThanOrEqual(8000)
  })

  it('leaves a modest digest untouched by the budget pass', () => {
    const request = sanitizeCloseoutSummaryRequest({
      targetId: 'run-small',
      promptText: 'Fix the login bug.',
      finalText: 'Fixed it.',
      fileChanges: [{ path: 'src/a.ts', additions: 3, deletions: 1 }]
    })
    expect(request.promptText).toBe('Fix the login bug.')
    expect(request.finalText).toBe('Fixed it.')
    expect(request.fileChanges).toHaveLength(1)
  })

  it('normalizes a daemon result into a ready snapshot', () => {
    const request = sanitizeCloseoutSummaryRequest({ targetId: 'run-4' })
    const snapshot = normalizeCloseoutSummaryResult(
      request,
      { summary: '  The run fixed the login bug\nand committed the change.  ' },
      '2026-07-10T10:00:00.000Z'
    )
    expect(snapshot).toEqual({
      targetId: 'run-4',
      generatedAt: '2026-07-10T10:00:00.000Z',
      status: 'ready',
      summary: 'The run fixed the login bug and committed the change.',
      model: 'Apple Foundation Models'
    })
  })

  it('treats an empty daemon summary as unavailable', () => {
    const request = sanitizeCloseoutSummaryRequest({ targetId: 'run-5' })
    const snapshot = normalizeCloseoutSummaryResult(
      request,
      { summary: '   ' },
      '2026-07-10T10:00:00.000Z'
    )
    expect(snapshot.status).toBe('unavailable')
    expect(snapshot.summary).toBe('')
    expect(snapshot.error).toContain('no close-out summary')
  })

  it.each([
    'The run changed 91 files and produced 315 commits.',
    'The run changed ninety files and produced three hundred commits.'
  ])('rejects quantitative provider prose so receipt metrics stay authoritative: %s', (summary) => {
    const request = sanitizeCloseoutSummaryRequest({ targetId: 'run-quantitative' })
    const snapshot = normalizeCloseoutSummaryResult(
      request,
      { summary },
      '2026-07-10T10:00:00.000Z'
    )

    expect(snapshot.status).toBe('unavailable')
    expect(snapshot.summary).toBe('')
    expect(snapshot.error).toContain('app-owned receipt')
  })

  it('builds unavailable snapshots with the failure reason', () => {
    const request = sanitizeCloseoutSummaryRequest({ targetId: 'round-1', scope: 'ensembleRound' })
    const snapshot = buildCloseoutSummaryUnavailableSnapshot(request, 'daemon is not running')
    expect(snapshot.targetId).toBe('round-1')
    expect(snapshot.status).toBe('unavailable')
    expect(snapshot.error).toBe('daemon is not running')
  })
})
