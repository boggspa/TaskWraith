import { describe, expect, it } from 'vitest'
import { createWorkSpanRecorder } from './WorkSpanRecorder'
import { beginProviderConfigWait } from './providerConfigWaitSpan'

function tickingClock(start = 1_000, stepMs = 10): () => number {
  let at = start - stepMs
  return () => (at += stepMs)
}

describe('beginProviderConfigWait', () => {
  it('records one provider_config_wait with the closed-set reason and resource', () => {
    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 8,
      now: tickingClock(5_000, 25)
    })
    const end = beginProviderConfigWait(recorder, {
      chatId: ' chat-light ',
      runId: 'run-1',
      participantId: 'seat-3',
      resource: 'codex_daemon',
      reason: 'registration_change'
    })
    end()
    const snapshot = recorder.snapshot()
    expect(snapshot.rejected).toBe(0)
    expect(snapshot.spans).toHaveLength(1)
    expect(snapshot.spans[0]).toMatchObject({
      process: 'main',
      chatId: 'chat-light',
      runId: 'run-1',
      participantId: 'seat-3',
      kind: 'provider_config_wait',
      resource: 'codex_daemon',
      reason: 'registration_change',
      startedAt: 5_000,
      durationMs: 25
    })
    expect(snapshot.spans[0]?.laneId).toBe('')
  })

  it('is a no-op without a sink, chatId, or a second end call', () => {
    const recorder = createWorkSpanRecorder({
      process: 'main',
      maxRetained: 8,
      now: tickingClock()
    })
    expect(() =>
      beginProviderConfigWait(undefined, {
        chatId: 'chat-a',
        resource: 'cursor_overlay',
        reason: 'cold_start'
      })()
    ).not.toThrow()
    beginProviderConfigWait(recorder, {
      chatId: '  ',
      resource: 'cursor_overlay',
      reason: 'cold_start'
    })()
    beginProviderConfigWait(recorder, {
      resource: 'cursor_overlay',
      reason: 'cold_start'
    })()
    const end = beginProviderConfigWait(recorder, {
      chatId: 'chat-a',
      runId: 'run-1',
      resource: 'cursor_overlay',
      reason: 'cohort_drain'
    })
    end()
    end()
    expect(recorder.snapshot().spans).toHaveLength(1)
    expect(recorder.snapshot().spans[0]).toMatchObject({
      kind: 'provider_config_wait',
      resource: 'cursor_overlay',
      reason: 'cohort_drain',
      durationMs: 10
    })
  })

  it('contains a throwing begin and a throwing end', () => {
    expect(() =>
      beginProviderConfigWait(
        {
          begin: () => {
            throw new Error('begin must not break acquisition')
          }
        },
        { chatId: 'chat-a', resource: 'codex_daemon', reason: 'cohort_drain' }
      )()
    ).not.toThrow()

    expect(() =>
      beginProviderConfigWait(
        {
          begin: () => () => {
            throw new Error('end must not break acquisition')
          }
        },
        { chatId: 'chat-a', resource: 'codex_daemon', reason: 'cold_start' }
      )()
    ).not.toThrow()
  })
})
