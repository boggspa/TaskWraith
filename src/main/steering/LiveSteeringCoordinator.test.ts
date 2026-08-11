import { afterEach, describe, expect, it, vi } from 'vitest'

import { RunManager, type LiveSteerDeliveryHooks } from '../RunManager'
import { MidRunSteeringRegistry } from '../run/MidRunSteering'
import { LiveSteeringCoordinator } from './LiveSteeringCoordinator'

afterEach(() => {
  vi.useRealTimers()
})

function fixture(provider: 'kimi' | 'cursor' | 'codex' = 'kimi') {
  vi.useFakeTimers()
  const runManager = new RunManager()
  const registry = new MidRunSteeringRegistry()
  const completeQueuedRun = vi.fn(() => true)
  const fallbackQueuedRun = vi.fn(() => true)
  runManager.create({ runId: 'active-1', provider, appChatId: 'chat-1', status: 'running' })
  const entry = registry.register({
    chatId: 'chat-1',
    messageId: 'midrun-queued-user-queued-1',
    text: 'change direction',
    source: 'liveSteer',
    authorKind: 'host',
    createdAtIso: '2026-08-11T00:00:00.000Z'
  })
  const coordinator = new LiveSteeringCoordinator({
    runManager,
    registry,
    steering: { midTurnSteeringEnabled: true, piLiveSteerEnabled: true },
    completeQueuedRun,
    fallbackQueuedRun,
    timeoutMs: 1_000,
    now: () => Date.parse('2026-08-11T00:00:01.000Z')
  })
  const input = {
    chatId: 'chat-1',
    activeRunId: 'active-1',
    queuedRunId: 'queued-1',
    ownerToken: 'owner-1',
    provider,
    entry
  } as const
  return { coordinator, runManager, registry, completeQueuedRun, fallbackQueuedRun, input }
}

describe('LiveSteeringCoordinator', () => {
  it('completes the durable queued row only after ACP delivery evidence', () => {
    const harness = fixture('kimi')
    let hooks: LiveSteerDeliveryHooks | undefined
    harness.runManager.registerLiveSteerTransport('active-1', {
      sendSteer: (_text, deliveryHooks) => {
        hooks = deliveryHooks
        return true
      },
      cancel: vi.fn()
    })

    expect(harness.coordinator.start(harness.input).status).toBe('injected')
    expect(harness.completeQueuedRun).not.toHaveBeenCalled()
    hooks?.onDelivered()
    expect(harness.completeQueuedRun).toHaveBeenCalledWith(
      'queued-1',
      expect.stringContaining('Delivered live through acp-interrupt')
    )
    vi.advanceTimersByTime(1_000)
    expect(harness.fallbackQueuedRun).not.toHaveBeenCalled()
  })

  it('releases a refused provider to the exact boundary queue', () => {
    const harness = fixture('codex')
    const cancel = vi.fn()
    harness.runManager.registerLiveSteerTransport('active-1', {
      sendSteer: vi.fn(),
      cancel
    })
    expect(harness.coordinator.start(harness.input).status).toBe('boundary')
    expect(harness.fallbackQueuedRun).toHaveBeenCalledWith({
      runId: 'queued-1',
      ownerToken: 'owner-1',
      reason: expect.stringContaining('not available')
    })
    expect(cancel).not.toHaveBeenCalled()
  })

  it('cancels an undrained broker injection and releases it after timeout', () => {
    const harness = fixture('cursor')
    expect(harness.coordinator.start(harness.input).status).toBe('broker-pending')
    vi.advanceTimersByTime(1_000)
    expect(harness.runManager.get('active-1')?.pendingSteerText).toBeFalsy()
    expect(harness.fallbackQueuedRun).toHaveBeenCalledWith({
      runId: 'queued-1',
      ownerToken: 'owner-1',
      reason: expect.stringContaining('not confirmed')
    })
  })

  it('releases a pending attempt when the active run terminalizes', () => {
    const harness = fixture('kimi')
    harness.runManager.registerLiveSteerTransport('active-1', {
      sendSteer: () => true,
      cancel: vi.fn()
    })
    harness.coordinator.start(harness.input)
    harness.coordinator.handleRunSessionChange({
      type: 'updated',
      session: { ...harness.runManager.get('active-1')!, status: 'completed' }
    })
    expect(harness.fallbackQueuedRun).toHaveBeenCalledWith({
      runId: 'queued-1',
      ownerToken: 'owner-1',
      reason: expect.stringContaining('active run ended')
    })
  })

  it('cancel affects the pending steer, not the active run', () => {
    const harness = fixture('kimi')
    const cancel = vi.fn()
    harness.runManager.registerLiveSteerTransport('active-1', {
      sendSteer: () => true,
      cancel
    })
    harness.coordinator.start(harness.input)
    expect(harness.coordinator.cancel('active-1')).toEqual({
      cancelled: true,
      hadPending: true
    })
    expect(cancel).toHaveBeenCalled()
    expect(harness.runManager.get('active-1')?.status).toBe('running')
    expect(harness.fallbackQueuedRun).toHaveBeenCalledTimes(1)
  })
})
