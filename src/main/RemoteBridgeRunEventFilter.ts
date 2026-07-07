import { extractThreadId } from './BridgeRunEventSink'
import type { RunEvent } from './RunEventBus'

export interface RemoteBridgeRunEventInterestState {
  watchedAppChatId: string | null
  hasWatchCapability: boolean
  connectedDeviceCount: number
}

export interface RemoteBridgeRunEventInterestFilter {
  readonly state: RemoteBridgeRunEventInterestState
  setConnectedDeviceCount(count: number): void
  setWatchedThread(appChatId: string | null): void
  resetOnDeviceEstablished(): void
  shouldForward(event: RunEvent): boolean
}

export function createRemoteBridgeRunEventInterestFilter(): RemoteBridgeRunEventInterestFilter {
  const state: RemoteBridgeRunEventInterestState = {
    watchedAppChatId: null,
    hasWatchCapability: false,
    connectedDeviceCount: 0
  }

  return {
    state,
    setConnectedDeviceCount(count) {
      state.connectedDeviceCount = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0))
    },
    setWatchedThread(appChatId) {
      state.watchedAppChatId = appChatId
      state.hasWatchCapability = true
    },
    resetOnDeviceEstablished() {
      state.watchedAppChatId = null
      state.hasWatchCapability = false
    },
    shouldForward(event) {
      if (event.channel !== 'agent-output') return true
      if (!state.hasWatchCapability) return true
      if (state.connectedDeviceCount > 1) return true
      const threadId = extractThreadId(event.payload)
      if (threadId === null) return true
      return threadId === state.watchedAppChatId
    }
  }
}
