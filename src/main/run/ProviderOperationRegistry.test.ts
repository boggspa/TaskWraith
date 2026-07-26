import { describe, expect, it, vi } from 'vitest'
import { shouldFlushPendingInterrupt } from '../CodexPendingInterrupt'
import {
  createProviderTerminalProjectionOperation,
  createProviderTransportCloseOperation,
  providerTransportAdmissionStillAuthorized,
  providerTransportLaunchStillAuthorized,
  ProviderOperationRegistry,
  ProviderProcessTerminationBackstop,
  waitForProviderOperationSettlement
} from './ProviderOperationRegistry'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('ProviderOperationRegistry', () => {
  it('retains the exact close promise until it settles', async () => {
    const registry = new ProviderOperationRegistry()
    const close = deferred()

    const tracked = registry.track('run-a', close.promise)
    expect(registry.get('run-a')).toBe(tracked)
    close.resolve()
    await tracked
    await Promise.resolve()
    expect(registry.get('run-a')).toBeUndefined()
  })

  it('keeps a history join pending through child close and provider cleanup', async () => {
    const registry = new ProviderOperationRegistry()
    const cleanup = deferred()
    const cleanupStarted = vi.fn(() => cleanup.promise)
    const transport = createProviderTransportCloseOperation(cleanupStarted)
    registry.track('claude-run', transport.operation)

    let historyJoinSettled = false
    const historyJoin = waitForProviderOperationSettlement(registry.get('claude-run')!, 1_000).then(
      (settled) => {
        historyJoinSettled = settled
        return settled
      }
    )

    await Promise.resolve()
    expect(historyJoinSettled).toBe(false)
    expect(cleanupStarted).not.toHaveBeenCalled()

    transport.markTransportClosed()
    await Promise.resolve()
    await Promise.resolve()
    expect(historyJoinSettled).toBe(false)
    expect(cleanupStarted).toHaveBeenCalledTimes(1)

    cleanup.resolve()
    await expect(historyJoin).resolves.toBe(true)
    expect(registry.get('claude-run')).toBeUndefined()
  })

  it('keeps delete-during-Codex-app-server-turn pending through terminal projection', async () => {
    const registry = new ProviderOperationRegistry()
    const terminal = createProviderTerminalProjectionOperation()
    registry.track('codex-app-server-run', terminal.operation)

    let deletionSettled = false
    const deletion = waitForProviderOperationSettlement(
      registry.get('codex-app-server-run')!,
      1_000
    ).then((settled) => {
      deletionSettled = settled
      return settled
    })

    await Promise.resolve()
    expect(deletionSettled).toBe(false)

    // Mirrors the notification handler ordering: durable/UI projection and
    // RunManager terminalization happen before the exact completion signal.
    const projection = vi.fn()
    projection()
    expect(deletionSettled).toBe(false)
    terminal.markTerminalProjectionComplete()

    await expect(deletion).resolves.toBe(true)
    expect(projection).toHaveBeenCalledTimes(1)
    expect(registry.get('codex-app-server-run')).toBeUndefined()
  })

  it('contains a timed-out Codex admission until delayed start is interrupted and terminal', async () => {
    const registry = new ProviderOperationRegistry()
    const terminal = createProviderTerminalProjectionOperation()
    registry.track('codex-timeout-run', terminal.operation)
    const pendingInterrupts = new Set<string>()
    const interrupt = vi.fn()

    // turn/start timed out before turn/started: preserve the stable thread as
    // possibly admitted and do not settle or start another transport.
    pendingInterrupts.add('thread-a')
    let operationSettled = false
    const joined = registry.get('codex-timeout-run')!.then(() => {
      operationSettled = true
    })
    await Promise.resolve()
    expect(operationSettled).toBe(false)

    const delayedState = { threadId: 'thread-a', turnId: 'turn-delayed' }
    if (shouldFlushPendingInterrupt(pendingInterrupts, delayedState)) {
      pendingInterrupts.delete(delayedState.threadId)
      interrupt(delayedState.threadId, delayedState.turnId)
    }
    expect(interrupt).toHaveBeenCalledWith('thread-a', 'turn-delayed')
    expect(operationSettled).toBe(false)

    terminal.markTerminalProjectionComplete()
    await joined
    expect(operationSettled).toBe(true)
  })

  it('keeps delete-during-Codex-exec pending after error until close and cleanup', async () => {
    const registry = new ProviderOperationRegistry()
    const cleanup = deferred()
    const terminalProjection = vi.fn(() => cleanup.promise)
    const transport = createProviderTransportCloseOperation(terminalProjection)
    registry.track('codex-exec-run', transport.operation)

    let deletionSettled = false
    const deletion = waitForProviderOperationSettlement(
      registry.get('codex-exec-run')!,
      1_000
    ).then((settled) => {
      deletionSettled = settled
      return settled
    })

    // A child "error" callback deliberately does not close the operation.
    await Promise.resolve()
    expect(deletionSettled).toBe(false)
    expect(terminalProjection).not.toHaveBeenCalled()

    transport.markTransportClosed()
    await Promise.resolve()
    await Promise.resolve()
    expect(terminalProjection).toHaveBeenCalledTimes(1)
    expect(deletionSettled).toBe(false)

    cleanup.resolve()
    await expect(deletion).resolves.toBe(true)
    expect(registry.get('codex-exec-run')).toBeUndefined()
  })

  it('does not spawn after async setup when history revokes launch authority', async () => {
    const setup = deferred()
    const spawn = vi.fn()
    let historyBlocked = false
    let persistenceAuthorized = true

    const launch = (async () => {
      await setup.promise
      if (
        !providerTransportAdmissionStillAuthorized({
          historyBlocked,
          sessionExists: true,
          persistenceAuthorized
        })
      ) {
        return false
      }
      spawn()
      return true
    })()

    historyBlocked = true
    persistenceAuthorized = false
    setup.resolve()

    await expect(launch).resolves.toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each([
    ['terminal claim', { runAdmitted: false }],
    ['history fence', { historyBlocked: true }],
    ['persistence fence', { persistenceAuthorized: false }],
    ['setup cancellation', { setupSignal: AbortSignal.abort() }]
  ] as const)('denies final launch when the %s revokes authority', (_label, override) => {
    expect(
      providerTransportLaunchStillAuthorized({
        historyBlocked: false,
        persistenceAuthorized: true,
        runAdmitted: true,
        ...override
      })
    ).toBe(false)
  })

  it('admits final launch only while every authority remains live', () => {
    expect(
      providerTransportLaunchStillAuthorized({
        historyBlocked: false,
        persistenceAuthorized: true,
        runAdmitted: true,
        setupSignal: new AbortController().signal
      })
    ).toBe(true)
  })

  it('rejects duplicate and empty run identities', () => {
    const registry = new ProviderOperationRegistry()
    registry.track('run-a', new Promise<void>(() => {}))

    expect(() => registry.track('run-a', Promise.resolve())).toThrow('already tracked')
    expect(() => registry.track('  ', Promise.resolve())).toThrow('exact run id')
  })
})

describe('ProviderProcessTerminationBackstop', () => {
  it('escalates one exact live child and is cleared by close evidence', async () => {
    vi.useFakeTimers()
    try {
      const backstop = new ProviderProcessTerminationBackstop(4_000)
      const first = { exitCode: null as number | null, kill: vi.fn() }
      backstop.arm('run-first', first)

      await vi.advanceTimersByTimeAsync(3_999)
      expect(first.kill).not.toHaveBeenCalled()
      expect(backstop.has('run-first')).toBe(true)

      backstop.clear('run-first')
      await vi.advanceTimersByTimeAsync(1)
      expect(first.kill).not.toHaveBeenCalled()
      expect(backstop.has('run-first')).toBe(false)

      const second = { exitCode: null as number | null, kill: vi.fn() }
      backstop.arm('run-second', second)
      await vi.advanceTimersByTimeAsync(4_000)
      expect(second.kill).toHaveBeenCalledOnce()
      expect(second.kill).toHaveBeenCalledWith('SIGKILL')
      expect(backstop.has('run-second')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not signal a child that already has an exit code', async () => {
    vi.useFakeTimers()
    try {
      const backstop = new ProviderProcessTerminationBackstop(100)
      const process = { exitCode: 0 as number | null, kill: vi.fn() }
      backstop.arm('run-closed', process)
      await vi.advanceTimersByTimeAsync(100)
      expect(process.kill).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('waitForProviderOperationSettlement', () => {
  it('joins resolution and rejection as exact terminal settlement', async () => {
    await expect(waitForProviderOperationSettlement(Promise.resolve(), 100)).resolves.toBe(true)
    await expect(
      waitForProviderOperationSettlement(Promise.reject(new Error('closed with error')), 100)
    ).resolves.toBe(true)
  })

  it('returns false when exact close evidence does not arrive before the bound', async () => {
    vi.useFakeTimers()
    try {
      const waiting = waitForProviderOperationSettlement(new Promise<void>(() => {}), 100)
      await vi.advanceTimersByTimeAsync(100)
      await expect(waiting).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
