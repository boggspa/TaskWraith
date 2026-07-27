import { describe, expect, it, vi } from 'vitest'
import { RemoteAttentionApnsFanout } from './RemoteAttentionApnsFanout'
import type { BridgeApnsEnv, BridgeRemoteAttentionPushPayload } from './BridgeApnsPusher'
import { deriveAgreementPublicRaw, openPush } from '../shared/e2ee/pushSeal'

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
    } as never)
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

  it('seals per-device rich content the paired device can open (runComplete)', async () => {
    const macSeed = Buffer.alloc(32, 0x11)
    const deviceSeed = Buffer.alloc(32, 0x22)
    const tokenStore = makeTokenStore([
      {
        pairID: 'pair-1',
        deviceToken: 'token-1',
        env: 'production',
        agreePubRaw: deriveAgreementPublicRaw(deviceSeed).toString('base64')
      }
    ] as never)
    const pushRemoteAttentionToToken = vi.fn(async () => ({ delivered: true, apnsId: 'a' }))
    const fanout = new RemoteAttentionApnsFanout({
      getTokenStore: () => tokenStore as never,
      getPusher: () => ({ pushRemoteAttentionToToken }),
      isUserAtDesktop: () => false,
      getMacIdentitySeed: () => macSeed
    })
    fanout.notify({
      reason: 'runComplete',
      threadId: 't',
      taskId: 't',
      runId: 'r',
      rich: { title: 'Codex', preview: 'Refactored the card', filesChanged: 3, additions: 12, deletions: 4 }
    })
    await flushFanout()
    const payload = (pushRemoteAttentionToToken.mock.calls as unknown as AttentionPushCall[])[0][2]
    expect(payload.twpush).toBeDefined()
    // No plaintext leaks into the payload — ciphertext only.
    expect(JSON.stringify(payload)).not.toContain('Refactored')
    // The paired device opens the blob to the exact rich content.
    const opened = JSON.parse(
      openPush({
        recipientIdentitySeed: deviceSeed,
        senderAgreePubRaw: deriveAgreementPublicRaw(macSeed),
        pairId: 'pair-1',
        envelope: payload.twpush!
      }).toString('utf8')
    )
    expect(opened).toEqual({
      title: 'Codex',
      preview: 'Refactored the card',
      filesChanged: 3,
      additions: 12,
      deletions: 4
    })
  })

  it('seals question text without leaking it into the APNs payload', async () => {
    const macSeed = Buffer.alloc(32, 0x11)
    const deviceSeed = Buffer.alloc(32, 0x22)
    const tokenStore = makeTokenStore([
      {
        pairID: 'pair-1',
        deviceToken: 'token-1',
        env: 'production',
        agreePubRaw: deriveAgreementPublicRaw(deviceSeed).toString('base64')
      }
    ] as never)
    const pushRemoteAttentionToToken = vi.fn(async () => ({ delivered: true, apnsId: 'a' }))
    const fanout = new RemoteAttentionApnsFanout({
      getTokenStore: () => tokenStore as never,
      getPusher: () => ({ pushRemoteAttentionToToken }),
      isUserAtDesktop: () => false,
      getMacIdentitySeed: () => macSeed
    })
    fanout.notify({
      reason: 'question',
      threadId: 't',
      questionId: 'q',
      question: { question: 'Ship this now?\nUse the risky path.' }
    })
    await flushFanout()
    const payload = (pushRemoteAttentionToToken.mock.calls as unknown as AttentionPushCall[])[0][2]
    expect(payload.twpush).toBeDefined()
    expect(JSON.stringify(payload)).not.toContain('Ship this now')
    const opened = JSON.parse(
      openPush({
        recipientIdentitySeed: deviceSeed,
        senderAgreePubRaw: deriveAgreementPublicRaw(macSeed),
        pairId: 'pair-1',
        envelope: payload.twpush!
      }).toString('utf8')
    )
    expect(opened).toEqual({ question: 'Ship this now?' })
  })

  it('omits the blob when the device registered no agreement key (generic alert)', async () => {
    const tokenStore = makeTokenStore([
      { pairID: 'pair-1', deviceToken: 'token-1', env: 'production' as const }
    ])
    const pushRemoteAttentionToToken = vi.fn(async () => ({ delivered: true, apnsId: 'a' }))
    const fanout = new RemoteAttentionApnsFanout({
      getTokenStore: () => tokenStore as never,
      getPusher: () => ({ pushRemoteAttentionToToken }),
      isUserAtDesktop: () => false,
      getMacIdentitySeed: () => Buffer.alloc(32, 0x11)
    })
    fanout.notify({
      reason: 'runComplete',
      threadId: 't',
      rich: { title: 'x', preview: 'y', filesChanged: 0, additions: 0, deletions: 0 }
    })
    await flushFanout()
    const payload = (pushRemoteAttentionToToken.mock.calls as unknown as AttentionPushCall[])[0][2]
    expect(payload.twpush).toBeUndefined()
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

  it('does not coalesce distinct blocking approvals/questions in the same thread', async () => {
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
    fanout.notify({ reason: 'question', threadId: 'thread-id', questionId: 'question-2' })
    await flushFanout()
    expect(pushRemoteAttentionToToken).toHaveBeenCalledTimes(4)

    fanout.notify({ reason: 'approval', threadId: 'thread-id', approvalId: 'approval-2' })
    fanout.notify({ reason: 'question', threadId: 'thread-id', questionId: 'question-2' })
    await flushFanout()
    expect(pushRemoteAttentionToToken).toHaveBeenCalledTimes(4)

    now += 30_001
    fanout.notify({ reason: 'approval', threadId: 'thread-id', approvalId: 'approval-2' })
    await flushFanout()
    expect(pushRemoteAttentionToToken).toHaveBeenCalledTimes(5)
  })

  it.each([
    'yieldToUser',
    'taskNeedsAttention',
    'ensemble',
    'wakeup',
    'resume',
    'runFailed',
    'runCancelled'
  ] as const)('suppresses non-policy reason %s at the production fanout boundary', async (reason) => {
    const tokenStore = makeTokenStore()
    const pushRemoteAttentionToToken = vi.fn()
    const pushSilentToToken = vi.fn()
    const log = vi.fn()
    const fanout = new RemoteAttentionApnsFanout({
      getTokenStore: () => tokenStore as never,
      getPusher: () => ({ pushRemoteAttentionToToken, pushSilentToToken }),
      isUserAtDesktop: () => false,
      log
    })

    fanout.notify({ reason, threadId: 'thread-id', runId: 'run-1' } as never)
    await flushFanout()

    expect(pushRemoteAttentionToToken).not.toHaveBeenCalled()
    expect(pushSilentToToken).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(`suppressed non-actionable notification reason=${reason}`)
    )
  })

  it('coalesces fungible non-blocking events per pair, thread, and reason', async () => {
    const tokenStore = makeTokenStore()
    const pushRemoteAttentionToToken = vi.fn(async () => ({
      delivered: true,
      apnsId: 'apns-1'
    }))
    const fanout = new RemoteAttentionApnsFanout({
      getTokenStore: () => tokenStore as never,
      getPusher: () => ({ pushRemoteAttentionToToken }),
      isUserAtDesktop: () => false,
      now: () => 1_000,
      coalesceMs: 30_000
    })

    fanout.notify({ reason: 'runComplete', threadId: 'thread-id', runId: 'run-1' })
    fanout.notify({ reason: 'runComplete', threadId: 'thread-id', runId: 'run-2' })
    fanout.notify({ reason: 'runComplete', threadId: 'other-thread', runId: 'run-3' })
    await flushFanout()

    expect(pushRemoteAttentionToToken).toHaveBeenCalledTimes(2)
  })

  it('prunes APNs tokens Apple reports as Unregistered', async () => {
    const tokenStore = makeTokenStore([
      { pairID: 'pair-dead', deviceToken: 'token-dead', env: 'production' as const }
    ])
    const pushRemoteAttentionToToken = vi.fn(async () => ({
      delivered: false,
      apnsId: '',
      reason: 'Unregistered'
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

  // Regression: this previously pruned. Both APNs gateways answer BadDeviceToken
  // for a token minted by the other one, so an environment mismatch would delete
  // a LIVE registration and silently kill push until the app re-registered.
  it('keeps the token when Apple answers BadDeviceToken (environment mismatch)', async () => {
    const tokenStore = makeTokenStore([
      { pairID: 'pair-sandbox', deviceToken: 'token-sandbox', env: 'sandbox' as const }
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

    expect(tokenStore.remove).not.toHaveBeenCalled()
  })
})
