import type { HostRunEventTarget } from '../host-runtime/HostRunEventTarget'

import type { RunEvent, RunEventSink } from './RunEventBus'

interface ElectronIpcDeliveryTarget extends HostRunEventTarget {
  send(channel: string, payload: unknown): void
  isDestroyed?(): boolean
}

function isElectronIpcDeliveryTarget(
  sender: HostRunEventTarget
): sender is ElectronIpcDeliveryTarget {
  return typeof (sender as { send?: unknown }).send === 'function'
}

/**
 * Electron renderer delivery adapter for the transport-neutral RunEventBus.
 *
 * It deliberately relies only on the structural `send`/`isDestroyed` shape;
 * importing Electron here would make an optional presentation sink appear to
 * be a Host runtime requirement.
 */
export function makeElectronIpcSink(): RunEventSink {
  return {
    id: 'electron-ipc',
    handle(event: RunEvent) {
      if (event.suppressElectronIpc) return
      const sender = event.sender
      if (!sender || !isElectronIpcDeliveryTarget(sender)) return
      try {
        if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) return
      } catch {
        return
      }
      // A frame can be disposed after the isDestroyed check. Renderer delivery
      // is best-effort, so keep this transport race outside the core bus.
      try {
        sender.send(event.channel, event.payload)
      } catch {
        // Durable run event state remains authoritative when the renderer exits.
      }
    }
  }
}
