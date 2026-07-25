import type { PiKeyMutationResult, PiKeyStoreStatus } from '../main/pi/PiKeyStore'

export const PI_KEY_CHANNELS = {
  status: 'pi:get-key-status',
  set: 'pi:set-upstream-key',
  clear: 'pi:clear-upstream-key',
  clearAll: 'pi:clear-all-keys'
} as const

export interface PiKeyIpcRenderer {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

export function createPiKeyBridge(ipcRenderer: PiKeyIpcRenderer): {
  getPiKeyStatus: () => Promise<PiKeyStoreStatus>
  setPiUpstreamKey: (upstream: string, apiKey: string) => Promise<PiKeyMutationResult>
  clearPiUpstreamKey: (upstream: string) => Promise<PiKeyMutationResult>
  clearAllPiKeys: () => Promise<PiKeyMutationResult>
} {
  return {
    getPiKeyStatus: () => ipcRenderer.invoke(PI_KEY_CHANNELS.status) as Promise<PiKeyStoreStatus>,
    setPiUpstreamKey: (upstream, apiKey) =>
      ipcRenderer.invoke(PI_KEY_CHANNELS.set, upstream, apiKey) as Promise<PiKeyMutationResult>,
    clearPiUpstreamKey: (upstream) =>
      ipcRenderer.invoke(PI_KEY_CHANNELS.clear, upstream) as Promise<PiKeyMutationResult>,
    clearAllPiKeys: () =>
      ipcRenderer.invoke(PI_KEY_CHANNELS.clearAll) as Promise<PiKeyMutationResult>
  }
}
