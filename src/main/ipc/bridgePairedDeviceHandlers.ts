import { ipcMain } from 'electron'
import type { PairedDeviceSummary } from '../remote/RemoteBridgeRuntime'
import { requireNonEmptyString } from '../settings/MainSanitizers'

export const BRIDGE_LIST_PAIRED_DEVICES_CHANNEL = 'bridge-list-paired-devices'
export const BRIDGE_UNPAIR_DEVICE_CHANNEL = 'bridge-unpair-device'

/** Structural slice of RemoteBridgeRuntime used by these two handlers. */
export interface BridgePairedDeviceRuntime {
  listPairedDevices: () => PairedDeviceSummary[]
  unpair: (iphoneIdentityPubKey: string) => void
}

export interface BridgePairedDeviceHandlerDeps {
  /**
   * Late-bound getter: the runtime is a nullable `let` in index.ts bootstrap
   * scope (disposed/restarted across the bridge lifecycle), so it must be
   * read at invocation time, never captured at registration.
   */
  getIosRemoteRuntime: () => BridgePairedDeviceRuntime | null
  /**
   * Removes the APNS token for an unpaired device. Optional to preserve the
   * index.ts `bridgeApnsTokenStoreRef?.remove(...)` nullable-ref semantics.
   */
  removeApnsToken?: (pairId: string) => void
}

export function registerBridgePairedDeviceHandlers(deps: BridgePairedDeviceHandlerDeps): void {
  ipcMain.handle(BRIDGE_LIST_PAIRED_DEVICES_CHANNEL, async () => {
    const iosRemoteRuntime = deps.getIosRemoteRuntime()
    if (!iosRemoteRuntime) return []
    return iosRemoteRuntime.listPairedDevices()
  })

  ipcMain.handle(BRIDGE_UNPAIR_DEVICE_CHANNEL, async (_, iphoneIdentityPubKey: string) => {
    const key = requireNonEmptyString(iphoneIdentityPubKey, 'Device identity')
    const iosRemoteRuntime = deps.getIosRemoteRuntime()
    if (!iosRemoteRuntime) {
      return {
        ok: false,
        error: 'Remote iOS pairing is off — enable it in Settings → Devices, then restart.'
      }
    }
    const target = iosRemoteRuntime
      .listPairedDevices()
      .find((device) => device.iphoneIdentityPubKey === key)
    if (!target) {
      return { ok: false, error: 'Paired device not found.' }
    }
    iosRemoteRuntime.unpair(key)
    deps.removeApnsToken?.(target.pairId)
    return { ok: true }
  })
}

export function unregisterBridgePairedDeviceHandlers(): void {
  ipcMain.removeHandler(BRIDGE_LIST_PAIRED_DEVICES_CHANNEL)
  ipcMain.removeHandler(BRIDGE_UNPAIR_DEVICE_CHANNEL)
}
