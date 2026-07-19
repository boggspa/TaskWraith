import { describe, expect, it, vi } from 'vitest'
import { RunManager } from '../RunManager'
import {
  createProviderTransportCloseOperation,
  ProviderOperationRegistry,
  waitForProviderOperationSettlement
} from './ProviderOperationRegistry'
import { shouldDeferEagerProviderTerminalization } from './ProviderTerminalizationPolicy'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('provider terminalization ownership', () => {
  it('keeps cancel responsive and scoped deletion pending through TERM, KILL, close, and cleanup', async () => {
    vi.useFakeTimers()
    try {
      const runId = 'claude-one-shot'
      const chatId = 'chat-a'
      const manager = new RunManager()
      const operations = new ProviderOperationRegistry()
      const kill = vi.fn()
      const abort = vi.fn()
      const cleanup = deferred()
      const cleanupStarted = vi.fn()
      const transport = createProviderTransportCloseOperation(async () => {
        cleanupStarted()
        await cleanup.promise
        // Mirrors every one-shot provider close/projection handler: the
        // provider callback, not the cancel request, owns terminalization.
        manager.finish(runId, 'failed')
      })

      operations.track(runId, transport.operation)
      manager.create({
        runId,
        appChatId: chatId,
        provider: 'claude',
        status: 'running',
        process: { kill },
        abortController: { abort }
      })

      const cancel = (): boolean => {
        const session = manager.get(runId)
        if (!session || !manager.claimTerminalStatus(runId, 'cancelled')) return false
        session.abortController?.abort()
        session.process?.kill()
        if (
          !shouldDeferEagerProviderTerminalization({
            graphOwnedAttempt: false,
            exactTransportOperationTracked: Boolean(operations.get(runId))
          })
        ) {
          manager.finish(runId, 'cancelled')
        }
        return true
      }

      // Ordinary cancellation returns immediately and records its terminal
      // meaning, while retaining the exact session as lifecycle authority.
      expect(cancel()).toBe(true)
      expect(manager.getClaimedTerminalStatus(runId)).toBe('cancelled')
      expect(manager.get(runId)?.status).toBe('running')
      expect(manager.getActiveByProvider('claude').map((session) => session.runId)).toEqual([runId])
      expect(kill).toHaveBeenCalledWith()

      let deletionSettled = false
      const deleteChat = (async () => {
        const target = manager
          .getActiveByProvider('claude')
          .find((session) => session.appChatId === chatId)
        if (!target) throw new Error('Scoped deletion missed the cancelling provider run.')
        target.abortController?.abort()
        target.process?.kill()
        const exactOperation = operations.get(target.runId)
        if (!exactOperation) throw new Error('Exact transport close authority is missing.')

        let settled = await waitForProviderOperationSettlement(exactOperation, 25)
        if (!settled) {
          target.process?.kill('SIGKILL')
          settled = await waitForProviderOperationSettlement(exactOperation, 25)
        }
        if (!settled) throw new Error('Exact transport did not close.')
        if (manager.getActiveByProvider('claude').some((session) => session.runId === runId)) {
          throw new Error('Provider close did not terminalize the exact run.')
        }
        return true
      })().finally(() => {
        deletionSettled = true
      })

      await Promise.resolve()
      expect(deletionSettled).toBe(false)
      await vi.advanceTimersByTimeAsync(25)
      expect(kill).toHaveBeenCalledWith('SIGKILL')
      expect(deletionSettled).toBe(false)

      transport.markTransportClosed()
      await Promise.resolve()
      await Promise.resolve()
      expect(cleanupStarted).toHaveBeenCalledTimes(1)
      expect(deletionSettled).toBe(false)

      cleanup.resolve()
      await expect(deleteChat).resolves.toBe(true)
      expect(manager.get(runId)?.status).toBe('cancelled')
      expect(deletionSettled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves graph confirmation semantics and eagerly finishes only untracked ordinary runs', () => {
    expect(
      shouldDeferEagerProviderTerminalization({
        graphOwnedAttempt: true,
        exactTransportOperationTracked: false
      })
    ).toBe(true)
    expect(
      shouldDeferEagerProviderTerminalization({
        graphOwnedAttempt: false,
        exactTransportOperationTracked: true
      })
    ).toBe(true)
    expect(
      shouldDeferEagerProviderTerminalization({
        graphOwnedAttempt: false,
        exactTransportOperationTracked: false
      })
    ).toBe(false)
  })
})
