import { describe, expect, it, vi } from 'vitest'
import { RemoteQuestionRegistry, type RemoteQuestionResolution } from './RemoteQuestionRegistry'

describe('RemoteQuestionRegistry', () => {
  it('registers question metadata and lists projection cards', () => {
    let resolved: RemoteQuestionResolution | null = null
    const registry = new RemoteQuestionRegistry({
      now: () => Date.UTC(2026, 4, 30, 12, 0, 0),
      idFactory: () => 'q-generated',
      setTimer: () => 'timer',
      clearTimer: vi.fn()
    })

    const record = registry.register({
      question: 'Which path should I take?',
      options: ['Safe', 'Fast', ''],
      context: 'Need a decision before editing.',
      provider: 'codex',
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      threadId: 'chat-1',
      runId: 'run-1',
      resolve: (result) => {
        resolved = result
      }
    })

    expect(record).toMatchObject({
      questionId: 'q-generated',
      promptId: 'q-generated',
      question: 'Which path should I take?',
      options: ['Safe', 'Fast'],
      provider: 'codex',
      workspaceId: 'ws-1',
      threadId: 'chat-1',
      runId: 'run-1',
      status: 'pending'
    })
    expect(registry.listProjectionCards()).toEqual([
      expect.objectContaining({
        promptId: 'q-generated',
        question: 'Which path should I take?',
        options: ['Safe', 'Fast'],
        status: 'pending'
      })
    ])
    expect(resolved).toBeNull()
  })

  it('answers a pending question exactly once', () => {
    let resolved: RemoteQuestionResolution | null = null
    const clearTimer = vi.fn()
    const registry = new RemoteQuestionRegistry({
      now: () => Date.UTC(2026, 4, 30, 12, 0, 0),
      setTimer: () => 'timer',
      clearTimer
    })
    registry.register({
      questionId: 'q1',
      question: 'Continue?',
      resolve: (result) => {
        resolved = result
      }
    })

    expect(registry.answer('q1', 'Yes', true)).toMatchObject({ ok: true })
    expect(resolved).toEqual({ answer: 'Yes', is_custom: true })
    expect(clearTimer).toHaveBeenCalledWith('timer')
    expect(registry.listPending()).toHaveLength(0)
    expect(registry.answer('q1', 'Again')).toEqual({ ok: false, reason: 'not-found' })
  })

  it('preserves the source for host-originated questions without changing the UI shape', () => {
    const registry = new RemoteQuestionRegistry({
      setTimer: () => 'timer',
      clearTimer: vi.fn()
    })

    const record = registry.register({
      questionId: 'q-codex-host',
      question: 'Pick one?',
      source: 'codex-host',
      resolve: vi.fn()
    })

    expect(record).toMatchObject({ questionId: 'q-codex-host', source: 'codex-host' })
    expect(registry.listProjectionCards()[0]).not.toHaveProperty('source')
  })

  it('rejects and resolves as a cancellation', () => {
    let resolved: RemoteQuestionResolution | null = null
    const registry = new RemoteQuestionRegistry({
      now: () => Date.UTC(2026, 4, 30, 12, 0, 0),
      setTimer: () => 'timer',
      clearTimer: vi.fn()
    })
    registry.register({
      questionId: 'q1',
      question: 'Continue?',
      resolve: (result) => {
        resolved = result
      }
    })

    const result = registry.reject('q1', 'user-dismissed')
    expect(result.record).toMatchObject({
      questionId: 'q1',
      status: 'rejected',
      cancellationReason: 'user-dismissed'
    })
    expect(resolved).toEqual({
      answer: '',
      is_custom: false,
      cancelled: true,
      cancellation_reason: 'user-dismissed'
    })
  })

  it('sweeps stale questions by expiry', () => {
    let now = 1_000
    let resolved: RemoteQuestionResolution | null = null
    const registry = new RemoteQuestionRegistry({
      now: () => now,
      setTimer: () => 'timer',
      clearTimer: vi.fn()
    })
    registry.register({
      questionId: 'q1',
      question: 'Still there?',
      ttlMs: 50,
      resolve: (result) => {
        resolved = result
      }
    })

    now = 1_049
    expect(registry.sweepStale()).toHaveLength(0)
    now = 1_050
    const expired = registry.sweepStale()
    expect(expired).toHaveLength(1)
    expect(expired[0]).toMatchObject({ questionId: 'q1', status: 'expired' })
    expect(resolved).toEqual({
      answer: '',
      is_custom: false,
      cancelled: true,
      cancellation_reason: 'timeout'
    })
  })

  it('cancels all pending questions for a run', () => {
    const registry = new RemoteQuestionRegistry({
      now: () => Date.UTC(2026, 4, 30, 12, 0, 0),
      setTimer: () => 'timer',
      clearTimer: vi.fn()
    })
    registry.register({ questionId: 'q1', question: 'One?', runId: 'run-1', resolve: vi.fn() })
    registry.register({ questionId: 'q2', question: 'Two?', runId: 'run-2', resolve: vi.fn() })

    expect(registry.cancelForRun('run-1', 'run-cancelled').map((r) => r.questionId)).toEqual(['q1'])
    expect(registry.listPending().map((r) => r.questionId)).toEqual(['q2'])
  })

  it('keeps multiple pending questions queued for the same chat', () => {
    const registry = new RemoteQuestionRegistry({
      now: () => Date.UTC(2026, 4, 30, 12, 0, 0),
      setTimer: () => 'timer',
      clearTimer: vi.fn()
    })
    registry.register({ questionId: 'q1', question: 'One?', threadId: 'chat-1', resolve: vi.fn() })
    registry.register({ questionId: 'q2', question: 'Two?', threadId: 'chat-1', resolve: vi.fn() })

    expect(registry.listPending({ threadId: 'chat-1' }).map((r) => r.questionId)).toEqual([
      'q1',
      'q2'
    ])
  })

  it('rejects scoped answers from the wrong thread without resolving the question', () => {
    const resolve = vi.fn()
    const registry = new RemoteQuestionRegistry({
      now: () => Date.UTC(2026, 4, 30, 12, 0, 0),
      setTimer: () => 'timer',
      clearTimer: vi.fn()
    })
    registry.register({
      questionId: 'q1',
      question: 'Continue?',
      workspaceId: 'ws-1',
      threadId: 'chat-1',
      runId: 'run-1',
      resolve
    })

    expect(
      registry.answerScoped('q1', { workspaceId: 'ws-1', threadId: 'chat-2' }, 'Yes')
    ).toMatchObject({ ok: false, reason: 'scope-mismatch' })
    expect(resolve).not.toHaveBeenCalled()
    expect(registry.has('q1')).toBe(true)

    expect(
      registry.answerScoped(
        'q1',
        { workspaceId: 'ws-1', threadId: 'chat-1', runId: 'run-1' },
        'Yes'
      )
    ).toMatchObject({ ok: true })
    expect(resolve).toHaveBeenCalledWith({ answer: 'Yes', is_custom: false })
  })

  it('caps question, context, options and answers', () => {
    let resolved: RemoteQuestionResolution | null = null
    const registry = new RemoteQuestionRegistry({
      now: () => Date.UTC(2026, 4, 30, 12, 0, 0),
      setTimer: () => 'timer',
      clearTimer: vi.fn()
    })
    const record = registry.register({
      questionId: 'q1',
      question: 'q'.repeat(700),
      context: 'c'.repeat(400),
      options: ['a'.repeat(120), 'B', 'B', 'C', 'D', 'E'],
      resolve: (result) => {
        resolved = result
      }
    })

    expect(record.question).toHaveLength(600)
    expect(record.context).toHaveLength(240)
    expect(record.options).toEqual(['a'.repeat(96), 'B', 'C', 'D'])
    registry.answer('q1', 'x'.repeat(9000))
    expect(resolved).toEqual({ answer: 'x'.repeat(8000), is_custom: false })
  })

  it('stamps the answer origin on the answered event, defaulting to desktop', () => {
    const registry = new RemoteQuestionRegistry({
      setTimer: () => 'timer',
      clearTimer: vi.fn()
    })
    const events: Array<{ type: string; origin?: string; isCustom?: boolean }> = []
    registry.subscribe((event) => {
      events.push({
        type: event.type,
        ...(event.type === 'answered' ? { origin: event.origin, isCustom: event.isCustom } : {})
      })
    })
    registry.register({ questionId: 'q-desktop', question: 'pick', resolve: () => {} })
    registry.answer('q-desktop', 'a', true)
    registry.register({ questionId: 'q-remote', question: 'pick', resolve: () => {} })
    registry.answerScoped('q-remote', {}, 'chip answer', false, 'remote')
    expect(events.filter((event) => event.type === 'answered')).toEqual([
      { type: 'answered', origin: 'desktop', isCustom: true },
      { type: 'answered', origin: 'remote', isCustom: false }
    ])
  })
})
