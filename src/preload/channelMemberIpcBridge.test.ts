import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  CHANNEL_MEMBER_INVITE_PAYLOAD_TYPE,
  CHANNEL_MEMBER_INVITE_PAYLOAD_VERSION,
  CHANNEL_MEMBER_IPC_CHANGED_EVENT,
  CHANNEL_MEMBER_IPC_CHANNELS,
  type ChannelMemberIpcBeginJoinInput
} from '../shared/collaboration/ChannelMemberIpc'
import { CHANNEL_WIRE_PROTOCOL } from '../shared/collaboration/ChannelWireProtocol'
import {
  createChannelMemberIpcBridge,
  type ChannelMemberIpcRendererPort
} from './channelMemberIpcBridge'

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
  const bridge = createChannelMemberIpcBridge({
    invoke,
    on,
    removeListener
  } as ChannelMemberIpcRendererPort)
  return { bridge, invoke, listeners, on, removeListener }
}

describe('Channel member IPC preload bridge', () => {
  it('exposes only the closed member API and preserves exact invoke arity', async () => {
    const target = fixture()
    expect(Object.keys(target.bridge)).toEqual([
      'list',
      'snapshot',
      'beginJoin',
      'confirmJoin',
      'reconnect',
      'append',
      'resume',
      'disconnect',
      'resetLocalHistory',
      'forget',
      'onChanged'
    ])
    expect(Object.isFrozen(target.bridge)).toBe(true)

    const join: ChannelMemberIpcBeginJoinInput = {
      invite: {
        type: CHANNEL_MEMBER_INVITE_PAYLOAD_TYPE,
        v: CHANNEL_MEMBER_INVITE_PAYLOAD_VERSION,
        protocol: CHANNEL_WIRE_PROTOCOL,
        channelId: 'channel-a',
        chatId: 'host-chat-a',
        inviteId: 'invite-a',
        inviteToken: 'one-shot-token',
        roomId: 'room-a',
        expiresAt: 20_000,
        relayUrl: 'wss://relay.example',
        relayUrls: ['wss://relay.example'],
        requiresOutOfBandSas: true as const
      },
      displayName: 'Member B'
    }
    const reconnect = { channelId: 'channel-a' }
    const append = { content: 'hello', clientMessageId: 'member-b-1' }
    const confirmed = { channelId: 'channel-a', confirmed: true as const }

    await target.bridge.list()
    await target.bridge.snapshot()
    await target.bridge.beginJoin(join)
    await target.bridge.confirmJoin()
    await target.bridge.reconnect(reconnect)
    await target.bridge.append(append)
    await target.bridge.resume()
    await target.bridge.disconnect()
    await target.bridge.resetLocalHistory(confirmed)
    await target.bridge.forget(confirmed)

    expect(target.invoke.mock.calls).toEqual([
      [CHANNEL_MEMBER_IPC_CHANNELS.list],
      [CHANNEL_MEMBER_IPC_CHANNELS.snapshot],
      [CHANNEL_MEMBER_IPC_CHANNELS.beginJoin, join],
      [CHANNEL_MEMBER_IPC_CHANNELS.confirmJoin],
      [CHANNEL_MEMBER_IPC_CHANNELS.reconnect, reconnect],
      [CHANNEL_MEMBER_IPC_CHANNELS.append, append],
      [CHANNEL_MEMBER_IPC_CHANNELS.resume],
      [CHANNEL_MEMBER_IPC_CHANNELS.disconnect],
      [CHANNEL_MEMBER_IPC_CHANNELS.resetLocalHistory, confirmed],
      [CHANNEL_MEMBER_IPC_CHANNELS.forget, confirmed]
    ])
  })

  it('selects a bounded snapshot notice and unsubscribes the exact listener once', () => {
    const target = fixture()
    const callback = vi.fn()
    const unsubscribe = target.bridge.onChanged(callback)
    const listener = target.listeners.get(CHANNEL_MEMBER_IPC_CHANGED_EVENT)
    expect(listener).toBeTypeOf('function')
    expect(target.on).toHaveBeenCalledWith(CHANNEL_MEMBER_IPC_CHANGED_EVENT, listener)

    listener?.({}, { channelId: 'channel-a', reason: 'snapshot', authority: 'drop-me' })
    listener?.({}, { reason: 'snapshot', transport: 'drop-me' })
    expect(callback.mock.calls.map(([notice]) => notice)).toEqual([
      { channelId: 'channel-a', reason: 'snapshot' },
      { reason: 'snapshot' }
    ])
    expect(callback.mock.calls.every(([notice]) => Object.isFrozen(notice))).toBe(true)

    listener?.({}, { channelId: '../channel-a', reason: 'snapshot' })
    listener?.({}, { channelId: 'channel-a', reason: 'agent' })
    listener?.({}, null)
    expect(callback).toHaveBeenCalledTimes(2)

    unsubscribe()
    unsubscribe()
    expect(target.removeListener).toHaveBeenCalledTimes(1)
    expect(target.removeListener).toHaveBeenCalledWith(CHANNEL_MEMBER_IPC_CHANGED_EVENT, listener)
    expect(target.listeners.has(CHANNEL_MEMBER_IPC_CHANGED_EVENT)).toBe(false)
  })

  it('is mounted and declared on the isolated window API with global teardown', () => {
    const preload = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
    const declaration = readFileSync(join(process.cwd(), 'src/preload/index.d.ts'), 'utf8')
    expect(preload).toContain(
      "import { createChannelMemberIpcBridge } from './channelMemberIpcBridge'"
    )
    expect(preload).toContain('channelMemberships: createChannelMemberIpcBridge(ipcRenderer)')
    expect(preload).toContain("ipcRenderer.removeAllListeners('channels:member:changed')")
    expect(declaration).toContain(
      "import type { ChannelMemberIpcApi } from '../shared/collaboration/ChannelMemberIpc'"
    )
    expect(declaration).toMatch(/channelMemberships:\s*ChannelMemberIpcApi/)
  })
})
