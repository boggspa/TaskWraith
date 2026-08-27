import { afterEach, describe, expect, it, vi } from 'vitest'

import { RunManager, type LiveSteerDeliveryHooks } from '../RunManager'
import { MidRunSteeringRegistry } from '../run/MidRunSteering'
import { LiveSteeringCoordinator } from './LiveSteeringCoordinator'

afterEach(() => {
  vi.useRealTimers()
})

function fixture(provider: 'kimi' | 'cursor' | 'codex' = 'kimi', midTurnSteeringEnabled = true) {
  vi.useFakeTimers()
  const runManager = new RunManager()
  const registry = new MidRunSteeringRegistry()
  const markAdmissionPending = vi.fn(() => true)
  const releaseDefinitelyRejectedQueuedRun = vi.fn(() => true)
  const completeQueuedRun = vi.fn(() => true)
  const failQueuedRun = vi.fn(() => true)
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
    steering: { midTurnSteeringEnabled, piLiveSteerEnabled: true },
    markAdmissionPending,
    releaseDefinitelyRejectedQueuedRun,
    completeQueuedRun,
    failQueuedRun,
    fallbackQueuedRun,
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
  return {
    coordinator,
    runManager,
    registry,
    markAdmissionPending,
    releaseDefinitelyRejectedQueuedRun,
    completeQueuedRun,
    failQueuedRun,
    fallbackQueuedRun,
    input
  }
}

describe('LiveSteeringCoordinator', () => {
  it('commits the admission fence before touching a provider transport', () => {
    const harness = fixture('kimi')
    const order: string[] = []
    harness.markAdmissionPending.mockImplementation(() => {
      order.push('fence')
      return true
    })
    const sendSteer = vi.fn(() => {
      order.push('provider')
      return true
    })
    harness.runManager.registerLiveSteerTransport('active-1', {
      sendSteer,
      cancel: vi.fn()
    })

    expect(harness.coordinator.start(harness.input).status).toBe('injected')
    expect(order).toEqual(['fence', 'provider'])
    expect(harness.markAdmissionPending).toHaveBeenCalledWith({
      runId: 'queued-1',
      ownerToken: 'owner-1',
      activeRunId: 'active-1',
      strategy: 'acp-interrupt'
    })
  })

  it('does not route when the durable admission fence refuses or throws', () => {
    for (const fenceFailure of [false, new Error('store unavailable')]) {
      const harness = fixture('kimi')
      const sendSteer = vi.fn(() => true)
      harness.runManager.registerLiveSteerTransport('active-1', {
        sendSteer,
        cancel: vi.fn()
      })
      harness.markAdmissionPending.mockImplementation(() => {
        if (fenceFailure instanceof Error) throw fenceFailure
        return fenceFailure
      })

      expect(harness.coordinator.start(harness.input)).toMatchObject({ status: 'boundary' })
      expect(sendSteer).not.toHaveBeenCalled()
      expect(harness.fallbackQueuedRun).toHaveBeenCalledTimes(1)
    }
  })

  it('does not mint an admission fence for a structured boundary with no provider write', () => {
    const harness = fixture('codex')

    expect(
      harness.coordinator.start({
        ...harness.input,
        forceBoundaryAfterToolResult: true,
        boundaryReason: 'Images require a fresh boundary.'
      }).status
    ).toBe('boundary')
    expect(harness.markAdmissionPending).not.toHaveBeenCalled()
    expect(harness.runManager.getInterruptState('active-1').killAfterToolResult).toBe(true)
  })

  it('does not mint an admission fence when live steering is disabled', () => {
    const harness = fixture('kimi', false)
    const sendSteer = vi.fn(() => true)
    harness.runManager.registerLiveSteerTransport('active-1', {
      sendSteer,
      cancel: vi.fn()
    })

    expect(harness.coordinator.start(harness.input).status).toBe('boundary')
    expect(harness.markAdmissionPending).not.toHaveBeenCalled()
    expect(sendSteer).not.toHaveBeenCalled()
  })

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

  it('lets rapid steers share one active provider transport without demoting later entries', () => {
    const harness = fixture('kimi')
    const hooks: LiveSteerDeliveryHooks[] = []
    harness.runManager.registerLiveSteerTransport('active-1', {
      sendSteer: (_text, deliveryHooks) => {
        if (deliveryHooks) hooks.push(deliveryHooks)
        return true
      },
      cancel: vi.fn()
    })
    const secondEntry = harness.registry.register({
      chatId: 'chat-1',
      messageId: 'midrun-queued-user-queued-2',
      text: 'and preserve the tests',
      source: 'liveSteer',
      authorKind: 'host',
      createdAtIso: '2026-08-11T00:00:00.500Z'
    })

    expect(harness.coordinator.start(harness.input).status).toBe('injected')
    expect(
      harness.coordinator.start({
        ...harness.input,
        queuedRunId: 'queued-2',
        ownerToken: 'owner-2',
        entry: secondEntry
      }).status
    ).toBe('injected')
    expect(harness.fallbackQueuedRun).not.toHaveBeenCalled()
    expect(hooks).toHaveLength(2)

    hooks[0]?.onDelivered()
    hooks[1]?.onDelivered()
    expect(harness.completeQueuedRun).toHaveBeenCalledTimes(2)
    expect(harness.coordinator.hasPending('active-1')).toBe(false)
  })

  it('returns the synchronous provider rejection outcome instead of an injected fiction', () => {
    const harness = fixture('kimi')
    harness.runManager.registerLiveSteerTransport('active-1', {
      sendSteer: (_text, hooks) => {
        hooks?.onRejected?.('provider refused before admission')
        return true
      },
      cancel: vi.fn()
    })

    expect(harness.coordinator.start(harness.input)).toMatchObject({
      status: 'boundary',
      reason: 'provider refused before admission'
    })
    expect(harness.releaseDefinitelyRejectedQueuedRun).toHaveBeenCalledWith({
      runId: 'queued-1',
      ownerToken: 'owner-1',
      reason: 'provider refused before admission'
    })
    expect(harness.fallbackQueuedRun).not.toHaveBeenCalled()
    expect(harness.coordinator.hasPendingQueuedRun('queued-1')).toBe(false)
    expect(harness.runManager.getInterruptState('active-1')).toMatchObject({
      killAfterToolResult: true,
      pendingBoundarySteerRunIds: ['queued-1']
    })
  })

  it('preserves synchronous delivery evidence emitted reentrantly by the transport', () => {
    const harness = fixture('kimi')
    harness.runManager.registerLiveSteerTransport('active-1', {
      sendSteer: (_text, hooks) => {
        hooks?.onDelivered()
        return true
      },
      cancel: vi.fn()
    })

    expect(harness.coordinator.start(harness.input)).toMatchObject({ status: 'injected' })
    expect(harness.completeQueuedRun).toHaveBeenCalledTimes(1)
    expect(harness.fallbackQueuedRun).not.toHaveBeenCalled()
  })

  it('keeps later text behind an earlier structured boundary instead of overtaking it live', () => {
    const harness = fixture('kimi')
    harness.coordinator.start({
      ...harness.input,
      forceBoundaryAfterToolResult: true,
      boundaryReason: 'Images need a fresh turn.'
    })
    const sendSteer = vi.fn(() => true)
    harness.runManager.registerLiveSteerTransport('active-1', {
      sendSteer,
      cancel: vi.fn()
    })
    const laterEntry = harness.registry.register({
      chatId: 'chat-1',
      messageId: 'midrun-queued-user-queued-2',
      text: 'then tighten the spacing',
      source: 'liveSteer',
      authorKind: 'host',
      createdAtIso: '2026-08-11T00:00:00.500Z'
    })

    expect(
      harness.coordinator.start({
        ...harness.input,
        queuedRunId: 'queued-2',
        ownerToken: 'owner-2',
        entry: laterEntry
      }).status
    ).toBe('boundary')
    expect(sendSteer).not.toHaveBeenCalled()
    expect(harness.runManager.getInterruptState('active-1').pendingBoundarySteerRunIds).toEqual([
      'queued-1',
      'queued-2'
    ])
  })

  it('releases a refused provider to the exact boundary queue', () => {
    const harness = fixture('codex')
    const cancel = vi.fn()
    harness.runManager.registerLiveSteerTransport('active-1', {
      sendSteer: vi.fn(),
      cancel
    })
    expect(harness.coordinator.start(harness.input).status).toBe('boundary')
    expect(harness.releaseDefinitelyRejectedQueuedRun).toHaveBeenCalledWith({
      runId: 'queued-1',
      ownerToken: 'owner-1',
      reason: expect.stringContaining('refused the live turn steer')
    })
    expect(cancel).not.toHaveBeenCalled()
  })

  it('does not time out a broker steer while a long-running tool is still active', () => {
    const harness = fixture('cursor')
    expect(harness.coordinator.start(harness.input).status).toBe('broker-pending')
    vi.advanceTimersByTime(60_000)
    expect(harness.runManager.get('active-1')?.pendingSteerText).toBeTruthy()
    expect(harness.fallbackQueuedRun).not.toHaveBeenCalled()

    harness.coordinator.handleRunSessionChange({
      type: 'updated',
      session: { ...harness.runManager.get('active-1')!, status: 'completed' }
    })
    expect(harness.failQueuedRun).toHaveBeenCalledWith(
      'queued-1',
      expect.stringContaining('active run ended without concrete')
    )
    expect(harness.fallbackQueuedRun).not.toHaveBeenCalled()
  })

  it('fails an admitted attempt instead of replaying when the active run terminalizes', () => {
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
    expect(harness.failQueuedRun).toHaveBeenCalledWith(
      'queued-1',
      expect.stringContaining('active run ended without concrete')
    )
    expect(harness.fallbackQueuedRun).not.toHaveBeenCalled()
  })

  it('waits for the exact bounded Codex RPC after the turn terminal event', async () => {
    const harness = fixture('codex')
    let hooks: LiveSteerDeliveryHooks | undefined
    harness.runManager.registerLiveSteerTransport('active-1', {
      sendSteer: (_text, deliveryHooks) => {
        hooks = deliveryHooks
        return true
      },
      cancel: vi.fn()
    })
    harness.coordinator.start(harness.input)

    harness.coordinator.handleRunSessionChange({
      type: 'updated',
      session: { ...harness.runManager.get('active-1')!, status: 'completed' }
    })
    await vi.runAllTimersAsync()
    expect(harness.failQueuedRun).not.toHaveBeenCalled()
    expect(harness.fallbackQueuedRun).not.toHaveBeenCalled()
    expect(harness.coordinator.hasPendingQueuedRun('queued-1')).toBe(true)

    hooks?.onAmbiguous?.('turn/steer timed out')
    expect(harness.failQueuedRun).toHaveBeenCalledWith(
      'queued-1',
      expect.stringContaining('turn/steer timed out')
    )
  })

  it('gives the real two-hop Codex request settlement one event-loop turn before ambiguity', async () => {
    const harness = fixture('codex')
    let hooks: LiveSteerDeliveryHooks | undefined
    harness.runManager.registerLiveSteerTransport('active-1', {
      sendSteer: (_text, deliveryHooks) => {
        hooks = deliveryHooks
        return true
      },
      cancel: vi.fn()
    })
    harness.coordinator.start(harness.input)

    void Promise.resolve()
      .then(() => Promise.resolve())
      .then(() => hooks?.onDelivered())
    harness.coordinator.handleRunSessionChange({
      type: 'updated',
      session: { ...harness.runManager.get('active-1')!, status: 'completed' }
    })
    expect(harness.failQueuedRun).not.toHaveBeenCalled()
    await vi.runAllTimersAsync()

    expect(harness.completeQueuedRun).toHaveBeenCalledTimes(1)
    expect(harness.failQueuedRun).not.toHaveBeenCalled()
    expect(harness.fallbackQueuedRun).not.toHaveBeenCalled()
  })

  it('retains a fenced Codex steer until the exact turn transport binds, then retries once', () => {
    const harness = fixture('codex')

    expect(harness.coordinator.start(harness.input)).toMatchObject({
      status: 'broker-pending',
      strategy: 'codex-turn-steer',
      reason: expect.stringContaining('exact bound Codex turn transport')
    })
    expect(harness.coordinator.hasPendingQueuedRun('queued-1')).toBe(true)
    expect(harness.fallbackQueuedRun).not.toHaveBeenCalled()
    expect(harness.markAdmissionPending).not.toHaveBeenCalled()

    let hooks: LiveSteerDeliveryHooks | undefined
    const sendSteer = vi.fn((_text, deliveryHooks) => {
      hooks = deliveryHooks
      return true
    })
    harness.runManager.registerLiveSteerTransport('active-1', {
      sendSteer,
      cancel: vi.fn()
    })

    expect(harness.coordinator.retryPendingForActiveRun('active-1')).toEqual([
      expect.objectContaining({ status: 'injected', strategy: 'codex-turn-steer' })
    ])
    expect(sendSteer).toHaveBeenCalledTimes(1)
    expect(harness.markAdmissionPending).toHaveBeenCalledTimes(1)
    expect(harness.coordinator.retryPendingForActiveRun('active-1')).toEqual([])

    hooks?.onDelivered()
    expect(harness.completeQueuedRun).toHaveBeenCalledTimes(1)
    expect(harness.coordinator.hasPendingQueuedRun('queued-1')).toBe(false)
  })

  it('retains a Codex steer that arrives before its RunManager session exists', () => {
    const harness = fixture('codex')
    harness.runManager.remove('active-1')

    expect(harness.coordinator.start(harness.input)).toMatchObject({
      status: 'broker-pending',
      strategy: 'codex-turn-steer'
    })
    expect(harness.markAdmissionPending).not.toHaveBeenCalled()
    expect(harness.fallbackQueuedRun).not.toHaveBeenCalled()

    const session = harness.runManager.create({
      runId: 'active-1',
      provider: 'codex',
      appChatId: 'chat-1',
      status: 'running'
    })
    harness.coordinator.handleRunSessionChange({ type: 'created', session })
    const sendSteer = vi.fn(() => true)
    harness.runManager.registerLiveSteerTransport('active-1', {
      sendSteer,
      cancel: vi.fn()
    })
    harness.coordinator.retryPendingForActiveRun('active-1')

    expect(sendSteer).toHaveBeenCalledTimes(1)
    expect(harness.markAdmissionPending).toHaveBeenCalledTimes(1)
  })

  it('safely queues a pre-session Codex steer if startup never binds', () => {
    const harness = fixture('codex')
    harness.runManager.remove('active-1')
    harness.coordinator.start(harness.input)

    vi.advanceTimersByTime(10_000)

    expect(harness.fallbackQueuedRun).toHaveBeenCalledWith({
      runId: 'queued-1',
      ownerToken: 'owner-1',
      reason: expect.stringContaining('did not bind during startup')
    })
    expect(harness.markAdmissionPending).not.toHaveBeenCalled()
  })

  it('safely falls back if Codex terminalizes before its exact transport binds', () => {
    const harness = fixture('codex')
    expect(harness.coordinator.start(harness.input).status).toBe('broker-pending')

    harness.coordinator.handleRunSessionChange({
      type: 'updated',
      session: { ...harness.runManager.get('active-1')!, status: 'completed' }
    })

    expect(harness.fallbackQueuedRun).toHaveBeenCalledTimes(1)
    expect(harness.failQueuedRun).not.toHaveBeenCalled()
    expect(harness.markAdmissionPending).not.toHaveBeenCalled()
    expect(harness.coordinator.hasPendingQueuedRun('queued-1')).toBe(false)
  })

  it('fences Codex immediately before retrying a newly-bound transport', () => {
    const harness = fixture('codex')
    expect(harness.coordinator.start(harness.input).status).toBe('broker-pending')
    harness.markAdmissionPending.mockReturnValue(false)
    const sendSteer = vi.fn(() => true)
    harness.runManager.registerLiveSteerTransport('active-1', {
      sendSteer,
      cancel: vi.fn()
    })

    expect(harness.coordinator.retryPendingForActiveRun('active-1')).toEqual([
      expect.objectContaining({
        status: 'boundary',
        reason: expect.stringContaining('crash-recovery fence')
      })
    ])
    expect(harness.markAdmissionPending).toHaveBeenCalledTimes(1)
    expect(sendSteer).not.toHaveBeenCalled()
  })

  it('releases immediately when a native transport explicitly rejects admission', () => {
    const harness = fixture('kimi')
    let hooks: LiveSteerDeliveryHooks | undefined
    harness.runManager.registerLiveSteerTransport('active-1', {
      sendSteer: (_text, deliveryHooks) => {
        hooks = deliveryHooks
        return true
      },
      cancel: vi.fn()
    })

    harness.coordinator.start(harness.input)
    hooks?.onRejected?.('active turn is not steerable')

    expect(harness.releaseDefinitelyRejectedQueuedRun).toHaveBeenCalledWith({
      runId: 'queued-1',
      ownerToken: 'owner-1',
      reason: 'active turn is not steerable'
    })
    expect(harness.fallbackQueuedRun).not.toHaveBeenCalled()
    expect(harness.failQueuedRun).not.toHaveBeenCalled()
  })

  it('fails attention-visible instead of replaying an ambiguous native admission', () => {
    const harness = fixture('kimi')
    let hooks: LiveSteerDeliveryHooks | undefined
    harness.runManager.registerLiveSteerTransport('active-1', {
      sendSteer: (_text, deliveryHooks) => {
        hooks = deliveryHooks
        return true
      },
      cancel: vi.fn()
    })

    harness.coordinator.start(harness.input)
    hooks?.onAmbiguous?.('turn/steer timed out')

    expect(harness.failQueuedRun).toHaveBeenCalledWith(
      'queued-1',
      expect.stringContaining('turn/steer timed out')
    )
    expect(harness.fallbackQueuedRun).not.toHaveBeenCalled()
    expect(harness.registry.pendingForChat('chat-1')).toEqual([])
  })

  it('disarms a structured boundary when durable queue release fails', () => {
    const harness = fixture('codex')
    harness.fallbackQueuedRun.mockReturnValue(false)

    harness.coordinator.start({
      ...harness.input,
      forceBoundaryAfterToolResult: true,
      boundaryReason: 'Images require a fresh boundary.'
    })

    expect(harness.runManager.getInterruptState('active-1').killAfterToolResult).toBeUndefined()
    expect(harness.failQueuedRun).toHaveBeenCalledWith(
      'queued-1',
      expect.stringContaining('fallback could not be committed')
    )
  })

  it('records an attention-visible failure if delivered completion cannot commit', () => {
    const harness = fixture('kimi')
    harness.completeQueuedRun.mockReturnValue(false)
    let hooks: LiveSteerDeliveryHooks | undefined
    harness.runManager.registerLiveSteerTransport('active-1', {
      sendSteer: (_text, deliveryHooks) => {
        hooks = deliveryHooks
        return true
      },
      cancel: vi.fn()
    })

    harness.coordinator.start(harness.input)
    hooks?.onDelivered()

    expect(harness.failQueuedRun).toHaveBeenCalledWith(
      'queued-1',
      expect.stringContaining('completion receipt could not be committed')
    )
  })

  it('retains ownership until delivered completion or failure commits durably', () => {
    const harness = fixture('kimi')
    harness.completeQueuedRun.mockReturnValue(false)
    harness.failQueuedRun.mockReturnValue(false)
    let hooks: LiveSteerDeliveryHooks | undefined
    harness.runManager.registerLiveSteerTransport('active-1', {
      sendSteer: (_text, deliveryHooks) => {
        hooks = deliveryHooks
        return true
      },
      cancel: vi.fn()
    })

    harness.coordinator.start(harness.input)
    hooks?.onDelivered()

    expect(harness.coordinator.hasPendingQueuedRun('queued-1')).toBe(true)
    expect(harness.registry.pendingForChat('chat-1')).toHaveLength(1)
    expect(harness.coordinator.pendingResult('queued-1')).toMatchObject({ status: 'failed' })

    harness.failQueuedRun.mockReturnValue(true)
    expect(harness.coordinator.reconcilePendingQueuedRun('queued-1')).toMatchObject({
      status: 'failed'
    })
    expect(harness.coordinator.hasPendingQueuedRun('queued-1')).toBe(false)
    expect(harness.registry.pendingForChat('chat-1')).toEqual([])
  })

  it('retains ownership when neither definite-rejection release nor failure can commit', () => {
    const harness = fixture('kimi')
    harness.releaseDefinitelyRejectedQueuedRun.mockReturnValue(false)
    harness.failQueuedRun.mockReturnValue(false)
    harness.runManager.registerLiveSteerTransport('active-1', {
      sendSteer: () => false,
      cancel: vi.fn()
    })

    expect(harness.coordinator.start(harness.input)).toMatchObject({ status: 'failed' })
    expect(harness.coordinator.hasPendingQueuedRun('queued-1')).toBe(true)

    harness.releaseDefinitelyRejectedQueuedRun.mockReturnValue(true)
    expect(harness.coordinator.reconcilePendingQueuedRun('queued-1')).toMatchObject({
      status: 'boundary'
    })
    expect(harness.coordinator.hasPendingQueuedRun('queued-1')).toBe(false)
  })

  it('contains durable-store exceptions in delivery hooks and lifecycle listeners', () => {
    const harness = fixture('kimi')
    harness.completeQueuedRun.mockImplementation(() => {
      throw new Error('complete store unavailable')
    })
    harness.failQueuedRun.mockImplementation(() => {
      throw new Error('failure store unavailable')
    })
    harness.fallbackQueuedRun.mockImplementation(() => {
      throw new Error('fallback store unavailable')
    })
    let hooks: LiveSteerDeliveryHooks | undefined
    harness.runManager.registerLiveSteerTransport('active-1', {
      sendSteer: (_text, deliveryHooks) => {
        hooks = deliveryHooks
        return true
      },
      cancel: vi.fn()
    })
    harness.coordinator.start(harness.input)

    expect(() => hooks?.onDelivered()).not.toThrow()
    expect(() =>
      harness.coordinator.handleRunSessionChange({
        type: 'updated',
        session: { ...harness.runManager.get('active-1')!, status: 'completed' }
      })
    ).not.toThrow()
    expect(harness.coordinator.hasPendingQueuedRun('queued-1')).toBe(true)
  })

  it('fails ambiguous rather than replaying when a fenced transport throws', () => {
    const harness = fixture('kimi')
    harness.runManager.registerLiveSteerTransport('active-1', {
      sendSteer: () => {
        throw new Error('transport exploded')
      },
      cancel: vi.fn()
    })

    expect(harness.coordinator.start(harness.input)).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('transport exploded')
    })
    expect(harness.failQueuedRun).toHaveBeenCalledTimes(1)
    expect(harness.fallbackQueuedRun).not.toHaveBeenCalled()
    expect(harness.coordinator.hasPendingQueuedRun('queued-1')).toBe(false)
  })

  it('makes a duplicate start idempotent while its first delivery is pending', () => {
    const harness = fixture('kimi')
    const sendSteer = vi.fn(() => true)
    harness.runManager.registerLiveSteerTransport('active-1', {
      sendSteer,
      cancel: vi.fn()
    })

    const first = harness.coordinator.start(harness.input)
    const duplicate = harness.coordinator.start(harness.input)

    expect(duplicate).toBe(first)
    expect(sendSteer).toHaveBeenCalledTimes(1)
  })

  it('cancel fails an admission-unknown steer without affecting the active run', () => {
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
    expect(harness.failQueuedRun).toHaveBeenCalledWith(
      'queued-1',
      expect.stringContaining('cancelled without proving')
    )
    expect(harness.fallbackQueuedRun).not.toHaveBeenCalled()
  })

  it('keeps ownership through transport cancel so possibly-admitted ACP is never replayed', () => {
    const harness = fixture('kimi')
    let hooks: LiveSteerDeliveryHooks | undefined
    const cancel = vi.fn(() => {
      hooks?.onAmbiguous?.('ACP follow-up may already have been admitted')
    })
    harness.runManager.registerLiveSteerTransport('active-1', {
      sendSteer: (_text, deliveryHooks) => {
        hooks = deliveryHooks
        return true
      },
      cancel
    })
    harness.coordinator.start(harness.input)

    expect(harness.coordinator.cancel('active-1')).toEqual({
      cancelled: true,
      hadPending: true
    })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(harness.failQueuedRun).toHaveBeenCalledWith(
      'queued-1',
      expect.stringContaining('ACP follow-up may already have been admitted')
    )
    expect(harness.fallbackQueuedRun).not.toHaveBeenCalled()
  })

  it('fails ambiguous instead of replaying when an admitted transport throws on cancel', () => {
    const harness = fixture('kimi')
    harness.runManager.registerLiveSteerTransport('active-1', {
      sendSteer: () => true,
      cancel: () => {
        throw new Error('cancel write failed')
      }
    })
    harness.coordinator.start(harness.input)

    expect(harness.coordinator.cancel('active-1')).toEqual({
      cancelled: true,
      hadPending: true
    })
    expect(harness.failQueuedRun).toHaveBeenCalledWith(
      'queued-1',
      expect.stringContaining('transport was unavailable or threw while cancelling')
    )
    expect(harness.fallbackQueuedRun).not.toHaveBeenCalled()
  })

  it('cancel disarms an already-queued structured boundary without stopping the run', () => {
    const harness = fixture('codex')
    harness.coordinator.start({
      ...harness.input,
      forceBoundaryAfterToolResult: true,
      boundaryReason: 'Images need a fresh turn.'
    })

    expect(harness.coordinator.cancel('active-1')).toEqual({
      cancelled: true,
      hadPending: true
    })
    expect(harness.runManager.getInterruptState('active-1').killAfterToolResult).toBeUndefined()
    expect(harness.runManager.get('active-1')?.status).toBe('running')
  })

  it('cancel disarms an earlier structured boundary when a later text steer is pending', () => {
    const harness = fixture('kimi')
    harness.coordinator.start({
      ...harness.input,
      forceBoundaryAfterToolResult: true,
      boundaryReason: 'Images need a fresh turn.'
    })
    harness.runManager.registerLiveSteerTransport('active-1', {
      sendSteer: () => true,
      cancel: vi.fn()
    })
    const textEntry = harness.registry.register({
      chatId: 'chat-1',
      messageId: 'midrun-queued-user-queued-2',
      text: 'also adjust spacing',
      source: 'liveSteer',
      authorKind: 'host',
      createdAtIso: '2026-08-11T00:00:00.500Z'
    })
    harness.coordinator.start({
      ...harness.input,
      queuedRunId: 'queued-2',
      ownerToken: 'owner-2',
      entry: textEntry
    })

    expect(harness.coordinator.cancel('active-1')).toEqual({
      cancelled: true,
      hadPending: true
    })
    expect(harness.runManager.getInterruptState('active-1').killAfterToolResult).toBeUndefined()
  })
})
