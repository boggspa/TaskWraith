import {
  CHANNEL_AGENT_IPC_CHANNELS,
  type ChannelAgentIpcApi,
  type ChannelAgentIpcOutcome,
  type ChannelAgentIpcOverview,
  type ChannelAgentIpcResult
} from '../shared/collaboration/ChannelAgentIpc'

export interface ChannelAgentIpcRendererPort {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

export function createChannelAgentIpcBridge(
  ipcRenderer: ChannelAgentIpcRendererPort
): ChannelAgentIpcApi {
  if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function') {
    throw new Error('createChannelAgentIpcBridge requires an IPC renderer port')
  }

  const invoke = <T>(channel: string, input: unknown): Promise<ChannelAgentIpcResult<T>> =>
    ipcRenderer.invoke(channel, input) as Promise<ChannelAgentIpcResult<T>>

  const api: ChannelAgentIpcApi = {
    overview: (input) =>
      invoke<ChannelAgentIpcOverview>(CHANNEL_AGENT_IPC_CHANNELS.overview, input),
    enroll: (input) => invoke<ChannelAgentIpcOutcome>(CHANNEL_AGENT_IPC_CHANNELS.enroll, input),
    grant: (input) => invoke<ChannelAgentIpcOutcome>(CHANNEL_AGENT_IPC_CHANNELS.grant, input),
    revoke: (input) => invoke<ChannelAgentIpcOutcome>(CHANNEL_AGENT_IPC_CHANNELS.revoke, input),
    rotate: (input) => invoke<ChannelAgentIpcOutcome>(CHANNEL_AGENT_IPC_CHANNELS.rotate, input)
  }

  return Object.freeze(api)
}
