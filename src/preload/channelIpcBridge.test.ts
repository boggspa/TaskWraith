import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CHANNEL_IPC_CHANGED_EVENT, CHANNEL_IPC_CHANNELS } from '../shared/collaboration/ChannelIpc'
import { createChannelIpcBridge, type ChannelIpcRendererPort } from './channelIpcBridge'

type Listener = (event: unknown, payload: unknown) => void

function fixture() {
  const invoke = vi.fn(async (channel: string) => ({ ok: true, value: channel }))
  const listeners = new Map<string, Listener>()
  const on = vi.fn((channel: string, listener: Listener) => {
    listeners.set(channel, listener)
  })
  const removeListener = vi.fn((channel: string, listener: Listener) => {
    if (listeners.get(channel) === listener) listeners.delete(channel)
  })
  const bridge = createChannelIpcBridge({
    invoke,
    on,
    removeListener
  } as ChannelIpcRendererPort)
  return { bridge, invoke, listeners, on, removeListener }
}

describe('Channel IPC preload bridge', () => {
  it('exposes only the closed Channel API and preserves exact invoke arity', async () => {
    const target = fixture()
    expect(Object.keys(target.bridge)).toEqual([
      'list',
      'read',
      'audit',
      'create',
      'issueInvite',
      'append',
      'revokeMember',
      'listHumanReviews',
      'approveHumanReview',
      'denyHumanReview',
      'close',
      'onChanged'
    ])

    const read = { channelId: 'channel-a', resumeAfter: 0 }
    const audit = { channelId: 'channel-a', limit: 20 }
    const create = { chatId: 'chat-a', ownerDisplayName: 'Host' }
    const invite = { channelId: 'channel-a', ttlMs: 60_000 }
    const append = { channelId: 'channel-a', clientMessageId: 'client-a', content: 'hello' }
    const revoke = { channelId: 'channel-a', memberId: 'member-a' }
    const reviews = { channelId: 'channel-a' }
    const reviewDecision = { channelId: 'channel-a', reviewId: 'review-a' }
    const close = { channelId: 'channel-a' }

    await target.bridge.list()
    await target.bridge.read(read)
    await target.bridge.audit()
    await target.bridge.audit(audit)
    await target.bridge.create(create)
    await target.bridge.issueInvite(invite)
    await target.bridge.append(append)
    await target.bridge.revokeMember(revoke)
    await target.bridge.listHumanReviews(reviews)
    await target.bridge.approveHumanReview(reviewDecision)
    await target.bridge.denyHumanReview(reviewDecision)
    await target.bridge.close(close)

    expect(target.invoke.mock.calls).toEqual([
      [CHANNEL_IPC_CHANNELS.list],
      [CHANNEL_IPC_CHANNELS.read, read],
      [CHANNEL_IPC_CHANNELS.audit],
      [CHANNEL_IPC_CHANNELS.audit, audit],
      [CHANNEL_IPC_CHANNELS.create, create],
      [CHANNEL_IPC_CHANNELS.issueInvite, invite],
      [CHANNEL_IPC_CHANNELS.append, append],
      [CHANNEL_IPC_CHANNELS.revokeMember, revoke],
      [CHANNEL_IPC_CHANNELS.humanReviews, reviews],
      [CHANNEL_IPC_CHANNELS.approveHumanReview, reviewDecision],
      [CHANNEL_IPC_CHANNELS.denyHumanReview, reviewDecision],
      [CHANNEL_IPC_CHANNELS.close, close]
    ])
  })

  it('selects a bounded change event and unsubscribes the exact listener once', () => {
    const target = fixture()
    const callback = vi.fn()
    const unsubscribe = target.bridge.onChanged(callback)
    const listener = target.listeners.get(CHANNEL_IPC_CHANGED_EVENT)
    expect(listener).toBeTypeOf('function')
    expect(target.on).toHaveBeenCalledWith(CHANNEL_IPC_CHANGED_EVENT, listener)

    listener?.({}, { channelId: 'channel-a', reason: 'message', authority: 'drop-me' })
    expect(callback).toHaveBeenCalledWith({ channelId: 'channel-a', reason: 'message' })
    expect(Object.isFrozen(callback.mock.calls[0][0])).toBe(true)

    listener?.({}, { channelId: ' channel-a', reason: 'message' })
    listener?.({}, { channelId: 'channel-a', reason: 'agent' })
    listener?.({}, null)
    expect(callback).toHaveBeenCalledTimes(1)

    unsubscribe()
    unsubscribe()
    expect(target.removeListener).toHaveBeenCalledTimes(1)
    expect(target.removeListener).toHaveBeenCalledWith(CHANNEL_IPC_CHANGED_EVENT, listener)
    expect(target.listeners.has(CHANNEL_IPC_CHANGED_EVENT)).toBe(false)
  })

  it('is mounted and declared on the isolated window API', () => {
    const preload = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
    const declaration = readFileSync(join(process.cwd(), 'src/preload/index.d.ts'), 'utf8')
    expect(preload).toContain("import { createChannelIpcBridge } from './channelIpcBridge'")
    expect(preload).toContain('channels: createChannelIpcBridge(ipcRenderer)')
    expect(preload).toContain("ipcRenderer.removeAllListeners('channels:changed')")
    expect(declaration).toContain(
      "import type { ChannelIpcApi } from '../shared/collaboration/ChannelIpc'"
    )
    expect(declaration).toMatch(/channels:\s*ChannelIpcApi/)
  })
})
