import { describe, expect, it } from 'vitest'
import type { BridgeRemoteAttentionReason } from './BridgeApnsPusher'
import type { RemoteTaskCard } from './RemoteTaskProjection'
import {
  isRemoteNotificationReason,
  RemoteTaskCompletionNotificationTracker
} from './RemoteNotificationPolicy'

function taskCard(overrides: Partial<RemoteTaskCard> = {}): RemoteTaskCard {
  return {
    id: 'task-1',
    threadId: 'task-1',
    workspaceId: null,
    provider: 'codex',
    title: 'Task',
    status: 'running',
    runId: 'run-1',
    preview: '',
    previewTruncated: false,
    pendingApprovalCount: 0,
    pendingQuestionCount: 0,
    completionNotificationEligible: false,
    ...overrides
  } as RemoteTaskCard
}

describe('RemoteNotificationPolicy', () => {
  it('allows only dedicated questions, dedicated approvals, and successful completion', () => {
    const reasons: BridgeRemoteAttentionReason[] = [
      'approval',
      'question',
      'runComplete',
      'yieldToUser',
      'taskNeedsAttention',
      'ensemble',
      'wakeup',
      'resume',
      'runFailed',
      'runCancelled'
    ]

    expect(reasons.filter(isRemoteNotificationReason)).toEqual([
      'approval',
      'question',
      'runComplete'
    ])
  })

  it('emits once for a settled running-to-success transition', () => {
    const tracker = new RemoteTaskCompletionNotificationTracker()

    expect(tracker.shouldNotify(taskCard())).toBe(false)
    expect(
      tracker.shouldNotify(
        taskCard({ status: 'success', completionNotificationEligible: true })
      )
    ).toBe(true)
    expect(
      tracker.shouldNotify(
        taskCard({ status: 'success', completionNotificationEligible: true })
      )
    ).toBe(false)
  })

  it('waits through a transient participant success until the round becomes eligible', () => {
    const tracker = new RemoteTaskCompletionNotificationTracker()

    expect(tracker.shouldNotify(taskCard())).toBe(false)
    expect(
      tracker.shouldNotify(
        taskCard({ status: 'success', completionNotificationEligible: false })
      )
    ).toBe(false)
    expect(
      tracker.shouldNotify(
        taskCard({ status: 'success', completionNotificationEligible: true })
      )
    ).toBe(true)
  })

  it('does not turn question, approval, failure, or cancellation states into generic alerts', () => {
    const tracker = new RemoteTaskCompletionNotificationTracker()

    expect(tracker.shouldNotify(taskCard())).toBe(false)
    expect(tracker.shouldNotify(taskCard({ status: 'awaitingQuestion' }))).toBe(false)
    expect(tracker.shouldNotify(taskCard({ status: 'awaitingApproval' }))).toBe(false)
    expect(
      tracker.shouldNotify(taskCard({ status: 'failed', completionNotificationEligible: true }))
    ).toBe(false)
    expect(
      tracker.shouldNotify(taskCard({ status: 'cancelled', completionNotificationEligible: true }))
    ).toBe(false)
  })

  it('does not notify for a historical success with no observed live transition', () => {
    const tracker = new RemoteTaskCompletionNotificationTracker()

    expect(
      tracker.shouldNotify(
        taskCard({ status: 'success', completionNotificationEligible: true })
      )
    ).toBe(false)
  })
})
