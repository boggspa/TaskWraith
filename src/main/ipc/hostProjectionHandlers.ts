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

import type {
  HostCommand,
  HostCommandReceipt,
  HostCursorPosition,
  HostDeltasSinceResult,
  HostSnapshot
} from '../../shared/hostProtocol'
import { HostProjectionClient } from '../host/HostProjectionClient'

/** Read channel — HostSnapshot. */
export const HOST_PROJECTION_SNAPSHOT_CHANNEL = 'host-projection:snapshot'

/** Ordered delta catch-up from a renderer-held generation/cursor. */
export const HOST_PROJECTION_DELTAS_SINCE_CHANNEL = 'host-projection:deltas-since'

/** Wave 4.3b — submit a HostCommand; returns the initial receipt. */
export const HOST_PROJECTION_COMMAND_SUBMIT_CHANNEL = 'host-projection:command-submit'

/** Wave 4.3b — lookup a durable receipt by commandId. */
export const HOST_PROJECTION_RECEIPT_LOOKUP_CHANNEL = 'host-projection:receipt-lookup'

/**
 * Capability request for Desktop after Wave 4.3b.
 *
 * Host intersects this with its own offer, so asking for less than Host offers
 * is a real narrowing. `commands` and `receipts` are required for mutation
 * cutover; without them Host withholds the request kinds.
 */
const DESKTOP_HOST_CAPABILITIES = [
  'bootstrap',
  'snapshot',
  'deltas',
  'health',
  'commands',
  'receipts'
] as const

/** Typed IPC result. Never a thrown Error, never a fabricated snapshot. */
export type HostProjectionSnapshotResult =
  | { readonly ok: true; readonly snapshot: HostSnapshot }
  | { readonly ok: false; readonly error: string }

export type HostProjectionDeltasResult =
  | { readonly ok: true; readonly result: HostDeltasSinceResult }
  | { readonly ok: false; readonly error: string }

export type HostProjectionCommandResult =
  | { readonly ok: true; readonly receipt: HostCommandReceipt }
  | { readonly ok: false; readonly error: string }

export type HostProjectionReceiptLookupResult =
  | { readonly ok: true; readonly receipt: HostCommandReceipt }
  | { readonly ok: false; readonly error: string }

/** The narrow slice of HostProjectionClient this bridge uses. */
export interface HostProjectionClientPort {
  connect(): Promise<unknown>
  getSnapshot(): Promise<{ snapshot: HostSnapshot }>
  getDeltasSince(position: HostCursorPosition): Promise<{ result: HostDeltasSinceResult }>
  submitCommand(command: HostCommand): Promise<HostCommandReceipt>
  lookupReceipt(params: { commandId: string }): Promise<HostCommandReceipt>
  close(): void
}

export interface HostProjectionHandlersDeps {
  /** Absolute userData path — the client reads Host discovery from it. */
  readonly userDataPath: string
  /** App version, presented as the client version in the hello frame. */
  readonly appVersion: string
  /** Client factory seam; defaults to a real HostProjectionClient. */
  readonly createClient?: () => HostProjectionClientPort
  /** ipcMain seam for tests. */
  readonly ipc?: Pick<typeof ipcMain, 'handle' | 'removeHandler'>
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  const text = String(error)
  return text.length > 0 ? text : 'unknown host projection failure'
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

  const createClient =
    deps.createClient ??
    ((): HostProjectionClientPort =>
      new HostProjectionClient({
        client: {
          clientId: 'taskwraith-desktop-renderer',
          clientClass: 'desktop',
          clientVersion: deps.appVersion
        },
        capabilities: [...DESKTOP_HOST_CAPABILITIES],
        userDataPath: deps.userDataPath
      }) as unknown as HostProjectionClientPort)

  // One client, reused across requests. Rebuilt only after a failure, so a
  // transient Host restart heals on the next fetch instead of pinning a dead
  // socket forever.
  let client: HostProjectionClientPort | null = null

  const discardClient = (): void => {
    const previous = client
    client = null
    if (!previous) return
    try {
      previous.close()
    } catch {
      // close() is best-effort teardown; a throw here must not mask the
      // original fetch failure the caller is about to be told about.
    }
  }

  const ensureClient = async (): Promise<HostProjectionClientPort> => {
    if (client) return client
    const next = createClient()
    await next.connect()
    client = next
    return next
  }

  const withClient = async <T>(
    run: (active: HostProjectionClientPort) => Promise<T>
  ): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
    try {
      const active = await ensureClient()
      const value = await run(active)
      return { ok: true, value }
    } catch (error) {
      discardClient()
      return { ok: false, error: errorText(error) }
    }
  }

  ipc.removeHandler?.(HOST_PROJECTION_SNAPSHOT_CHANNEL)
  ipc.handle(HOST_PROJECTION_SNAPSHOT_CHANNEL, async (): Promise<HostProjectionSnapshotResult> => {
    const outcome = await withClient((active) => active.getSnapshot())
    if (!outcome.ok) return { ok: false, error: outcome.error }
    return { ok: true, snapshot: outcome.value.snapshot }
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
      const outcome = await withClient((active) =>
        active.getDeltasSince({
          generation: Number(candidate.generation),
          cursor: Number(candidate.cursor)
        })
      )
      if (!outcome.ok) return { ok: false, error: outcome.error }
      return { ok: true, result: outcome.value.result }
    }
  )

  ipc.removeHandler?.(HOST_PROJECTION_COMMAND_SUBMIT_CHANNEL)
  ipc.handle(
    HOST_PROJECTION_COMMAND_SUBMIT_CHANNEL,
    async (_event, command: unknown): Promise<HostProjectionCommandResult> => {
      if (!isHostCommandShape(command)) {
        return { ok: false, error: 'host projection command payload is invalid' }
      }
      const outcome = await withClient((active) => active.submitCommand(command))
      if (!outcome.ok) return { ok: false, error: outcome.error }
      return { ok: true, receipt: outcome.value }
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
      const outcome = await withClient((active) => active.lookupReceipt({ commandId }))
      if (!outcome.ok) return { ok: false, error: outcome.error }
      return { ok: true, receipt: outcome.value }
    }
  )
}
