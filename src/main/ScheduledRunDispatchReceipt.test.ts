import { describe, expect, it } from 'vitest'
import type { AgentRunPayload } from './run/AgentRunTypes'
import { ScheduledRunDispatchReceiptRegistry } from './ScheduledRunDispatchReceipt'

function payload(overrides: Partial<AgentRunPayload> = {}): AgentRunPayload {
  return {
    provider: 'codex',
    scope: 'workspace',
    workspace: '/Test 1',
    prompt: 'Canonical scheduled prompt.',
    appChatId: 'chat-test-1',
    appRunId: 'run-test-1',
    model: 'gpt-5.6-terra',
    approvalMode: 'plan',
    imagePaths: ['/main-cas/scheduled.png'],
    ...overrides
  }
}

describe('ScheduledRunDispatchReceiptRegistry', () => {
  it('returns the canonical payload exactly once for the same sender/task/run', () => {
    const registry = new ScheduledRunDispatchReceiptRegistry()
    const canonical = payload()
    registry.issue({
      senderId: 1,
      scheduledTaskId: 'scheduled-test-1',
      appRunId: 'run-test-1',
      payload: canonical
    })

    const dispatched = registry.consume({
      senderId: 1,
      scheduledTaskId: 'scheduled-test-1',
      appRunId: 'run-test-1',
      payload: { ...canonical, scheduledTaskId: 'scheduled-test-1' } as AgentRunPayload
    })
    expect(dispatched).toEqual(canonical)
    expect(dispatched).not.toBe(canonical)
    expect(() =>
      registry.consume({
        senderId: 1,
        scheduledTaskId: 'scheduled-test-1',
        appRunId: 'run-test-1',
        payload: canonical
      })
    ).toThrow('Scheduled run dispatch receipt is missing')
  })

  it('rejects another sender or any mutation of the composed payload', () => {
    const registry = new ScheduledRunDispatchReceiptRegistry()
    const canonical = payload()
    registry.issue({
      senderId: 1,
      scheduledTaskId: 'scheduled-test-1',
      appRunId: 'run-test-1',
      payload: canonical
    })

    expect(() =>
      registry.consume({
        senderId: 2,
        scheduledTaskId: 'scheduled-test-1',
        appRunId: 'run-test-1',
        payload: canonical
      })
    ).toThrow('Scheduled run dispatch receipt is missing')
    expect(() =>
      registry.consume({
        senderId: 1,
        scheduledTaskId: 'scheduled-test-1',
        appRunId: 'run-test-1',
        payload: payload({ prompt: 'Forged interactive prompt.' })
      })
    ).toThrow('Scheduled run dispatch receipt is missing')
  })

  it('ignores renderer-only routing fields but never dispatches them', () => {
    const registry = new ScheduledRunDispatchReceiptRegistry()
    const canonical = payload()
    registry.issue({
      senderId: 1,
      scheduledTaskId: 'scheduled-test-1',
      appRunId: 'run-test-1',
      payload: canonical
    })

    const dispatched = registry.consume({
      senderId: 1,
      scheduledTaskId: 'scheduled-test-1',
      appRunId: 'run-test-1',
      payload: {
        ...canonical,
        scheduledTaskId: 'scheduled-test-1',
        runtimeWorktree: {
          requested: true,
          source: 'composer',
          baseWorkspacePath: '/Test 3',
          effectiveWorkspacePath: '/Test 3-worktree',
          status: 'selected'
        }
      } as AgentRunPayload
    })

    expect(dispatched.runtimeWorktree).toBeUndefined()
    expect(dispatched.workspace).toBe('/Test 1')
  })

  it('expires stale receipts', () => {
    let now = 100
    const registry = new ScheduledRunDispatchReceiptRegistry({ now: () => now, ttlMs: 10 })
    const canonical = payload()
    registry.issue({
      senderId: 1,
      scheduledTaskId: 'scheduled-test-1',
      appRunId: 'run-test-1',
      payload: canonical
    })
    now = 111

    expect(() =>
      registry.consume({
        senderId: 1,
        scheduledTaskId: 'scheduled-test-1',
        appRunId: 'run-test-1',
        payload: canonical
      })
    ).toThrow('Scheduled run dispatch receipt is missing')
  })
})
