import {
  CHANNEL_IPC_CHANGED_EVENT,
  CHANNEL_IPC_CHANNELS,
  type ChannelIpcApi,
  type ChannelIpcAppendResult,
  type ChannelIpcAuditEvent,
  type ChannelIpcChangeEvent,
  type ChannelIpcChannel,
  type ChannelIpcInviteResult,
  type ChannelIpcMember,
  type ChannelIpcReadResult,
  type ChannelIpcResult
} from '../shared/collaboration/ChannelIpc'

type ChannelIpcListener = (event: unknown, payload: unknown) => void

export interface ChannelIpcRendererPort {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: ChannelIpcListener): unknown
  removeListener(channel: string, listener: ChannelIpcListener): unknown
}

function projectChangeEvent(value: unknown): ChannelIpcChangeEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const channelId = input.channelId
  const reason = input.reason
  if (
    typeof channelId !== 'string' ||
    !channelId ||
    channelId.trim() !== channelId ||
    channelId.length > 512 ||
    channelId.includes('\0')
  ) {
    return null
  }
  if (reason !== 'channel' && reason !== 'membership' && reason !== 'message') return null
  return Object.freeze({ channelId, reason })
}

export function createChannelIpcBridge(ipcRenderer: ChannelIpcRendererPort): ChannelIpcApi {
  if (
    !ipcRenderer ||
    typeof ipcRenderer.invoke !== 'function' ||
    typeof ipcRenderer.on !== 'function' ||
    typeof ipcRenderer.removeListener !== 'function'
  ) {
    throw new Error('createChannelIpcBridge requires an IPC renderer port')
  }

  const invoke = <T>(channel: string, ...args: unknown[]): Promise<ChannelIpcResult<T>> =>
    ipcRenderer.invoke(channel, ...args) as Promise<ChannelIpcResult<T>>

  const api: ChannelIpcApi = {
    list: () => invoke<ChannelIpcChannel[]>(CHANNEL_IPC_CHANNELS.list),
    read: (input) => invoke<ChannelIpcReadResult>(CHANNEL_IPC_CHANNELS.read, input),
    audit: (input) =>
      input === undefined
        ? invoke<ChannelIpcAuditEvent[]>(CHANNEL_IPC_CHANNELS.audit)
        : invoke<ChannelIpcAuditEvent[]>(CHANNEL_IPC_CHANNELS.audit, input),
    create: (input) => invoke<ChannelIpcChannel>(CHANNEL_IPC_CHANNELS.create, input),
    issueInvite: (input) => invoke<ChannelIpcInviteResult>(CHANNEL_IPC_CHANNELS.issueInvite, input),
    append: (input) => invoke<ChannelIpcAppendResult>(CHANNEL_IPC_CHANNELS.append, input),
    revokeMember: (input) => invoke<ChannelIpcMember>(CHANNEL_IPC_CHANNELS.revokeMember, input),
    close: (input) => invoke<ChannelIpcChannel>(CHANNEL_IPC_CHANNELS.close, input),
    onChanged: (callback) => {
      if (typeof callback !== 'function') {
        throw new TypeError('Channel change callback must be a function')
      }
      const listener: ChannelIpcListener = (_event, payload) => {
        const projected = projectChangeEvent(payload)
        if (projected) callback(projected)
      }
      ipcRenderer.on(CHANNEL_IPC_CHANGED_EVENT, listener)
      let subscribed = true
      return () => {
        if (!subscribed) return
        subscribed = false
        ipcRenderer.removeListener(CHANNEL_IPC_CHANGED_EVENT, listener)
      }
    }
  }

  return Object.freeze(api)
}
