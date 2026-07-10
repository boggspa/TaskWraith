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
  shouldForwardLiveSnapshot(appChatId: string): boolean
  shouldForward(event: RunEvent): boolean
}

export function createRemoteBridgeRunEventInterestFilter(): RemoteBridgeRunEventInterestFilter {
  const state: RemoteBridgeRunEventInterestState = {
    watchedAppChatId: null,
    hasWatchCapability: false,
    connectedDeviceCount: 0
  }
  const shouldForwardLiveSnapshot = (appChatId: string): boolean => {
    // Older clients never assert a watch, so keep the legacy fan-out until
    // the connected phone proves it understands this capability. A single
    // assertion may only describe one phone; multiple live devices therefore
    // remain fail-open until watch state is tracked per connection.
    if (!state.hasWatchCapability) return true
    if (state.connectedDeviceCount > 1) return true
    return appChatId === state.watchedAppChatId
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
    shouldForwardLiveSnapshot,
    shouldForward(event) {
      if (event.channel !== 'agent-output') return true
      const threadId = extractThreadId(event.payload)
      if (threadId === null) return true
      return shouldForwardLiveSnapshot(threadId)
    }
  }
}
