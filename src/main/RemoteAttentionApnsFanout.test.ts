import { describe, expect, it, vi } from 'vitest'
import { RemoteAttentionApnsFanout } from './RemoteAttentionApnsFanout'
import type { BridgeApnsEnv, BridgeRemoteAttentionPushPayload } from './BridgeApnsPusher'

const flushFanout = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

type TokenEntry = { pairID: string; deviceToken: string; env: BridgeApnsEnv }
type AttentionPushCall = [string, BridgeApnsEnv, BridgeRemoteAttentionPushPayload]

function makeTokenStore(
  entries: TokenEntry[] = [{ pairID: 'pair-1', deviceToken: 'token-1', env: 'production' }]
) {
  return {
    list: vi.fn(() => entries),
    remove: vi.fn()
  }
}

describe('RemoteAttentionApnsFanout', () => {
  it('fans out privacy-safe attention payloads to registered tokens', async () => {
    const tokenStore = makeTokenStore([
      { pairID: 'pair-1', deviceToken: 'token-1', env: 'production' as const },
      { pairID: 'pair-2', deviceToken: 'token-2', env: 'sandbox' as const }
    ])
    const pushRemoteAttentionToToken = vi.fn(async () => ({
      delivered: true,
      apnsId: 'apns-1'
    }))
    const pushSilentToToken = vi.fn(async () => ({
      delivered: true,
      apnsId: 'apns-silent-1'
    }))
    const fanout = new RemoteAttentionApnsFanout({
      getTokenStore: () => tokenStore as never,
      getPusher: () => ({ pushRemoteAttentionToToken, pushSilentToToken }),
      isUserAtDesktop: () => false
    })

    fanout.notify({
      reason: 'approval',
      workspaceId: 'workspace-id',
      threadId: 'thread-id',
      approvalId: 'approval-id',
      summary: 'Run rm -rf /Users/dev/project?'
    } as Omit<BridgeRemoteAttentionPushPayload, 'pairID'> & { summary: string })
    await flushFanout()

    expect(pushRemoteAttentionToToken).toHaveBeenCalledTimes(2)
    expect(pushSilentToToken).toHaveBeenCalledTimes(2)
    expect(pushRemoteAttentionToToken).toHaveBeenNthCalledWith(
      1,
      'token-1',
      'production',
      expect.objectContaining({
        pairID: 'pair-1',
        reason: 'approval',
        workspaceId: 'workspace-id',
        threadId: 'thread-id',
        approvalId: 'approval-id'
      })
    )
    const calls = pushRemoteAttentionToToken.mock.calls as unknown as AttentionPushCall[]
    const payload = calls[0][2] as unknown as Record<string, unknown>
    expect(payload.summary).toBeUndefined()
    expect(JSON.stringify(payload)).not.toContain('rm -rf')
    expect(JSON.stringify(payload)).not.toContain('/Users/dev')
  })

  it('drops path-like workspace ids before attention and wake pushes', async () => {
    const tokenStore = makeTokenStore([
      { pairID: 'pair-1', deviceToken: 'token-1', env: 'sandbox' as const }
    ])
    const pushRemoteAttentionToToken = vi.fn(async () => ({
      delivered: true,
      apnsId: 'apns-1'
    }))
    const pushSilentToToken = vi.fn(async () => ({
      delivered: true,
      apnsId: 'apns-silent-1'
    }))
    const fanout = new RemoteAttentionApnsFanout({
      getTokenStore: () => tokenStore as never,
      getPusher: () => ({ pushRemoteAttentionToToken, pushSilentToToken }),
      isUserAtDesktop: () => false
    })

    fanout.notify({
      reason: 'approval',
      workspaceId: '/Users/dev/private-project',
      threadId: 'thread-id',
      approvalId: 'approval-id'
    })
    await flushFanout()

    const attentionCalls = pushRemoteAttentionToToken.mock.calls as unknown as AttentionPushCall[]
    expect(attentionCalls[0][2].workspaceId).toBeNull()
    expect(JSON.stringify(attentionCalls[0][2])).not.toContain('/Users/dev')
    expect(pushSilentToToken).toHaveBeenCalledWith(
      'token-1',
      'sandbox',
      expect.objectContaining({ workspaceId: null })
    )
    const silentCalls = pushSilentToToken.mock.calls as unknown as Array<
      [string, BridgeApnsEnv, Omit<BridgeRemoteAttentionPushPayload, 'pairID'>?]
    >
    expect(JSON.stringify(silentCalls[0][2])).not.toContain('/Users/dev')
  })

  it('suppresses pushes while the user is at the desktop', async () => {
    const tokenStore = makeTokenStore()
    const pushRemoteAttentionToToken = vi.fn()
    const log = vi.fn()
    const fanout = new RemoteAttentionApnsFanout({
      getTokenStore: () => tokenStore as never,
      getPusher: () => ({ pushRemoteAttentionToToken }),
      isUserAtDesktop: () => true,
      log
    })

    fanout.notify({ reason: 'approval', threadId: 'thread-id', approvalId: 'approval-id' })
    await flushFanout()

    expect(pushRemoteAttentionToToken).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('user is at desktop'))
  })

  it('coalesces within the window per pair, thread, and reason', async () => {
    let now = 1_000
    const tokenStore = makeTokenStore()
    const pushRemoteAttentionToToken = vi.fn(async () => ({
      delivered: true,
      apnsId: 'apns-1'
    }))
    const fanout = new RemoteAttentionApnsFanout({
      getTokenStore: () => tokenStore as never,
      getPusher: () => ({ pushRemoteAttentionToToken }),
      isUserAtDesktop: () => false,
      now: () => now,
      coalesceMs: 30_000
    })

    fanout.notify({ reason: 'approval', threadId: 'thread-id', approvalId: 'approval-1' })
    fanout.notify({ reason: 'approval', threadId: 'thread-id', approvalId: 'approval-2' })
    fanout.notify({ reason: 'question', threadId: 'thread-id', questionId: 'question-1' })
    await flushFanout()
    expect(pushRemoteAttentionToToken).toHaveBeenCalledTimes(2)

    now += 30_001
    fanout.notify({ reason: 'approval', threadId: 'thread-id', approvalId: 'approval-3' })
    await flushFanout()
    expect(pushRemoteAttentionToToken).toHaveBeenCalledTimes(3)
  })

  it('prunes APNs tokens Apple reports as dead', async () => {
    const tokenStore = makeTokenStore([
      { pairID: 'pair-dead', deviceToken: 'token-dead', env: 'production' as const }
    ])
    const pushRemoteAttentionToToken = vi.fn(async () => ({
      delivered: false,
      apnsId: '',
      reason: 'BadDeviceToken'
    }))
    const fanout = new RemoteAttentionApnsFanout({
      getTokenStore: () => tokenStore as never,
      getPusher: () => ({ pushRemoteAttentionToToken }),
      isUserAtDesktop: () => false
    })

    fanout.notify({ reason: 'approval', threadId: 'thread-id', approvalId: 'approval-id' })
    await flushFanout()

    expect(tokenStore.remove).toHaveBeenCalledWith('pair-dead')
  })
})
