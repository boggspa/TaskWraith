/**
 * Host Arc Wave 4.3a-wire + 4.3b — Desktop Host projection IPC bridge.
 *
 * WHAT THIS IS. The main-process broker that lets the sandboxed Desktop
 * renderer talk to Host. It owns one `HostProjectionClient` and exposes a
 * read channel plus the Wave 4.3b command/receipt channels.
 *
 * WHY IT MUST EXIST IN MAIN. Every BrowserWindow runs `sandbox: true` with
 * `contextIsolation: true`, so preload has no Node access and the renderer can
 * never open the Host unix socket itself. `HostProjectionClient` imports
 * `node:net` and `node:fs`, so it is main-only. That leaves exactly one legal
 * shape: main holds the client, preload is a thin conduit, the renderer
 * consumes plain objects.
 *
 * WHY IT GOES THROUGH THE PROTOCOL, NOT THE STORES. This module connects over
 * the authenticated local Host socket like any other client, rather than
 * reaching into Host's composition or stores. The goal is explicit that
 * clients must not read Host stores directly or build competing authority —
 * and Desktop is a client. Brokering the real protocol keeps that true; a
 * shortcut into the authority object would have been faster and wrong.
 *
 * WAVE 4.3b COMMAND SURFACE. `command.submit` and `receipt.lookup` ride the
 * same client (no parallel mutation socket). Capabilities request includes
 * `commands` + `receipts`. `approval.decide` is a Host command name submitted
 * through `command.submit`, matching TUI 4.2b — not a separate IPC verb.
 *
 * FAILURE IS REPORTED, NEVER FABRICATED. A failed fetch returns
 * `{ ok: false, error }`. It never returns an empty snapshot: an empty
 * projection asserts "there are no chats", which is a false claim rather than
 * a neutral default, and it is exactly the fabricated-telemetry failure the
 * goal forbids. Errors are returned as values rather than thrown because an
 * Error crossing the IPC boundary loses its type and arrives as a generic
 * "Error invoking remote method" string.
 */

import { ipcMain } from 'electron'

import type { HostCommand, HostCursorPosition } from '../../shared/hostProtocol'
import {
  createHostProjectionBroker,
  type HostProjectionBroker,
  type HostProjectionClientPort,
  type HostProjectionCommandResult,
  type HostProjectionDeltasResult,
  type HostProjectionReceiptLookupResult,
  type HostProjectionSnapshotResult
} from '../host/HostProjectionBroker'

export type {
  HostProjectionClientPort,
  HostProjectionCommandResult,
  HostProjectionDeltasResult,
  HostProjectionReceiptLookupResult,
  HostProjectionSnapshotResult
} from '../host/HostProjectionBroker'

/** Read channel — HostSnapshot. */
export const HOST_PROJECTION_SNAPSHOT_CHANNEL = 'host-projection:snapshot'

/** Ordered delta catch-up from a renderer-held generation/cursor. */
export const HOST_PROJECTION_DELTAS_SINCE_CHANNEL = 'host-projection:deltas-since'

/** Wave 4.3b — submit a HostCommand; returns the initial receipt. */
export const HOST_PROJECTION_COMMAND_SUBMIT_CHANNEL = 'host-projection:command-submit'

/** Wave 4.3b — lookup a durable receipt by commandId. */
export const HOST_PROJECTION_RECEIPT_LOOKUP_CHANNEL = 'host-projection:receipt-lookup'

export interface HostProjectionHandlersDeps {
  /** Absolute userData path — the client reads Host discovery from it. */
  readonly userDataPath: string
  /** App version, presented as the client version in the hello frame. */
  readonly appVersion: string
  /** Client factory seam; defaults to a real HostProjectionClient. */
  readonly createClient?: () => HostProjectionClientPort
  /** Shared Desktop broker. Production passes one instance to every consumer. */
  readonly broker?: HostProjectionBroker
  /** ipcMain seam for tests. */
  readonly ipc?: Pick<typeof ipcMain, 'handle' | 'removeHandler'>
}

function isHostCommandShape(value: unknown): value is HostCommand {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<HostCommand>
  return (
    candidate.type === 'host.command' &&
    typeof candidate.commandId === 'string' &&
    candidate.commandId.length > 0 &&
    typeof candidate.idempotencyKey === 'string' &&
    candidate.idempotencyKey.length > 0 &&
    typeof candidate.name === 'string' &&
    candidate.name.length > 0
  )
}

/**
 * Register the Desktop Host projection bridge.
 *
 * Registration is idempotent: each channel is removed before it is added, so a
 * dev-mode re-initialisation cannot throw "Attempted to register a second
 * handler". Electron throws on duplicate `handle`, and that throw would abort
 * whatever startup step is registering us.
 */
export function registerHostProjectionHandlers(deps: HostProjectionHandlersDeps): void {
  if (!deps || typeof deps !== 'object') {
    throw new Error('registerHostProjectionHandlers requires deps')
  }
  if (typeof deps.userDataPath !== 'string' || deps.userDataPath.length === 0) {
    throw new Error('registerHostProjectionHandlers requires a userDataPath')
  }

  const ipc = deps.ipc ?? ipcMain

  const broker =
    deps.broker ??
    createHostProjectionBroker({
      userDataPath: deps.userDataPath,
      appVersion: deps.appVersion,
      ...(deps.createClient ? { createClient: deps.createClient } : {})
    })

  ipc.removeHandler?.(HOST_PROJECTION_SNAPSHOT_CHANNEL)
  ipc.handle(HOST_PROJECTION_SNAPSHOT_CHANNEL, async (): Promise<HostProjectionSnapshotResult> => {
    return broker.snapshot()
  })

  ipc.removeHandler?.(HOST_PROJECTION_DELTAS_SINCE_CHANNEL)
  ipc.handle(
    HOST_PROJECTION_DELTAS_SINCE_CHANNEL,
    async (_event, position: unknown): Promise<HostProjectionDeltasResult> => {
      const candidate = position as Partial<HostCursorPosition> | null
      if (
        !candidate ||
        !Number.isSafeInteger(candidate.generation) ||
        Number(candidate.generation) < 0 ||
        !Number.isSafeInteger(candidate.cursor) ||
        Number(candidate.cursor) < 0
      ) {
        return { ok: false, error: 'host projection delta lookup requires generation and cursor' }
      }
      return broker.deltasSince({
        generation: Number(candidate.generation),
        cursor: Number(candidate.cursor)
      })
    }
  )

  ipc.removeHandler?.(HOST_PROJECTION_COMMAND_SUBMIT_CHANNEL)
  ipc.handle(
    HOST_PROJECTION_COMMAND_SUBMIT_CHANNEL,
    async (_event, command: unknown): Promise<HostProjectionCommandResult> => {
      if (!isHostCommandShape(command)) {
        return { ok: false, error: 'host projection command payload is invalid' }
      }
      return broker.submitCommand(command)
    }
  )

  ipc.removeHandler?.(HOST_PROJECTION_RECEIPT_LOOKUP_CHANNEL)
  ipc.handle(
    HOST_PROJECTION_RECEIPT_LOOKUP_CHANNEL,
    async (_event, params: unknown): Promise<HostProjectionReceiptLookupResult> => {
      const commandId =
        params && typeof params === 'object'
          ? (params as { commandId?: unknown }).commandId
          : undefined
      if (typeof commandId !== 'string' || commandId.length === 0) {
        return { ok: false, error: 'host projection receipt lookup requires commandId' }
      }
      return broker.lookupReceipt(commandId)
    }
  )
}
