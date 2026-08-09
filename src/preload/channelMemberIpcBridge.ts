import {
  CHANNEL_MEMBER_IPC_CHANGED_EVENT,
  CHANNEL_MEMBER_IPC_CHANNELS,
  type ChannelMemberIpcApi,
  type ChannelMemberIpcChangeEvent,
  type ChannelMemberIpcMembershipSummary,
  type ChannelMemberIpcMessage,
  type ChannelMemberIpcResult,
  type ChannelMemberIpcSnapshot
} from '../shared/collaboration/ChannelMemberIpc'

type ChannelMemberIpcListener = (event: unknown, payload: unknown) => void

export interface ChannelMemberIpcRendererPort {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: ChannelMemberIpcListener): unknown
  removeListener(channel: string, listener: ChannelMemberIpcListener): unknown
}

function projectChangeEvent(value: unknown): ChannelMemberIpcChangeEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (input.reason !== 'snapshot') return null
  if (input.channelId === undefined) return Object.freeze({ reason: 'snapshot' })
  if (typeof input.channelId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(input.channelId)) {
    return null
  }
  return Object.freeze({ channelId: input.channelId, reason: 'snapshot' })
}

export function createChannelMemberIpcBridge(
  ipcRenderer: ChannelMemberIpcRendererPort
): ChannelMemberIpcApi {
  if (
    !ipcRenderer ||
    typeof ipcRenderer.invoke !== 'function' ||
    typeof ipcRenderer.on !== 'function' ||
    typeof ipcRenderer.removeListener !== 'function'
  ) {
    throw new Error('createChannelMemberIpcBridge requires an IPC renderer port')
  }

  const invoke = <T>(channel: string, ...args: unknown[]): Promise<ChannelMemberIpcResult<T>> =>
    ipcRenderer.invoke(channel, ...args) as Promise<ChannelMemberIpcResult<T>>

  const api: ChannelMemberIpcApi = {
    list: () => invoke<ChannelMemberIpcMembershipSummary[]>(CHANNEL_MEMBER_IPC_CHANNELS.list),
    snapshot: () => invoke<ChannelMemberIpcSnapshot>(CHANNEL_MEMBER_IPC_CHANNELS.snapshot),
    beginJoin: (input) =>
      invoke<{ confirmCode: string }>(CHANNEL_MEMBER_IPC_CHANNELS.beginJoin, input),
    confirmJoin: () => invoke<ChannelMemberIpcSnapshot>(CHANNEL_MEMBER_IPC_CHANNELS.confirmJoin),
    reconnect: (input) =>
      invoke<ChannelMemberIpcSnapshot>(CHANNEL_MEMBER_IPC_CHANNELS.reconnect, input),
    append: (input) =>
      invoke<{ record: ChannelMemberIpcMessage; deduplicated: boolean }>(
        CHANNEL_MEMBER_IPC_CHANNELS.append,
        input
      ),
    resume: () => invoke<ChannelMemberIpcSnapshot>(CHANNEL_MEMBER_IPC_CHANNELS.resume),
    disconnect: () => invoke<ChannelMemberIpcSnapshot>(CHANNEL_MEMBER_IPC_CHANNELS.disconnect),
    resetLocalHistory: (input) =>
      invoke<ChannelMemberIpcSnapshot>(CHANNEL_MEMBER_IPC_CHANNELS.resetLocalHistory, input),
    forget: (input) => invoke<ChannelMemberIpcSnapshot>(CHANNEL_MEMBER_IPC_CHANNELS.forget, input),
    onChanged: (callback) => {
      if (typeof callback !== 'function') {
        throw new TypeError('Channel member change callback must be a function')
      }
      const listener: ChannelMemberIpcListener = (_event, payload) => {
        const projected = projectChangeEvent(payload)
        if (projected) callback(projected)
      }
      ipcRenderer.on(CHANNEL_MEMBER_IPC_CHANGED_EVENT, listener)
      let subscribed = true
      return () => {
        if (!subscribed) return
        subscribed = false
        ipcRenderer.removeListener(CHANNEL_MEMBER_IPC_CHANGED_EVENT, listener)
      }
    }
  }

  return Object.freeze(api)
}
