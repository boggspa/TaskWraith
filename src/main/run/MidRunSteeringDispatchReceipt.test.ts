import { describe, expect, it, vi } from 'vitest'
import type { RunAdapterInvocationReceipt, RunDispatchObserver } from './AgentRunTypes'
import { createMidRunSteeringDispatchReceipt } from './MidRunSteeringDispatchReceipt'

const RECEIPT: RunAdapterInvocationReceipt = {
  provider: 'codex',
  appRunId: 'run-1',
  effectiveWorkspacePath: '/workspace'
}

describe('createMidRunSteeringDispatchReceipt', () => {
  it('records delivery at adapter invocation before the provider operation settles', async () => {
    let settleProvider!: () => void
    const providerOperation = new Promise<void>((resolve) => {
      settleProvider = resolve
    })
    const markDelivered = vi.fn()
    const receipt = createMidRunSteeringDispatchReceipt({ markDelivered })
    const dispatch = async (observer: RunDispatchObserver): Promise<{ dispatched: true }> => {
      observer.onAdapterInvoked?.(RECEIPT)
      await providerOperation
      return { dispatched: true }
    }

    const pendingDispatch = dispatch(receipt.observer)

    expect(markDelivered).toHaveBeenCalledOnce()
    settleProvider()
    await pendingDispatch
    receipt.markAcceptedFallback()
    expect(markDelivered).toHaveBeenCalledOnce()
  })

  it('forwards the exact invocation receipt to the lifecycle observer', () => {
    const upstreamObserver = { onAdapterInvoked: vi.fn() }
    const markDelivered = vi.fn()
    const receipt = createMidRunSteeringDispatchReceipt({
      upstreamObserver,
      markDelivered
    })

    receipt.observer.onAdapterInvoked?.(RECEIPT)

    expect(upstreamObserver.onAdapterInvoked).toHaveBeenCalledWith(RECEIPT)
    expect(markDelivered).toHaveBeenCalledOnce()
  })

  it('keeps delivery observable when the upstream observer throws', () => {
    const markDelivered = vi.fn()
    const receipt = createMidRunSteeringDispatchReceipt({
      upstreamObserver: {
        onAdapterInvoked: () => {
          throw new Error('observer failed')
        }
      },
      markDelivered
    })

    expect(() => receipt.observer.onAdapterInvoked?.(RECEIPT)).toThrow('observer failed')
    expect(markDelivered).toHaveBeenCalledOnce()
  })

  it('supports accepted legacy facades without inventing a preflight receipt', () => {
    const markDelivered = vi.fn()
    const receipt = createMidRunSteeringDispatchReceipt({ markDelivered })

    expect(markDelivered).not.toHaveBeenCalled()
    receipt.markAcceptedFallback()
    receipt.markAcceptedFallback()

    expect(markDelivered).toHaveBeenCalledOnce()
  })
})
