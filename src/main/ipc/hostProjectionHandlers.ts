/**
 * Host Arc Wave 4.3a-wire — Desktop Host projection IPC bridge.
 *
 * WHAT THIS IS. The main-process broker that lets the sandboxed Desktop
 * renderer obtain a `HostSnapshot`. It owns one `HostProjectionClient` and
 * exposes exactly one read channel.
 *
 * WHY IT MUST EXIST IN MAIN. Every BrowserWindow runs `sandbox: true` with
 * `contextIsolation: true`, so preload has no Node access and the renderer can
 * never open the Host unix socket itself. `HostProjectionClient` imports
 * `node:net` and `node:fs`, so it is main-only. That leaves exactly one legal
 * shape: main holds the client, preload is a thin conduit, the renderer
 * consumes a plain object.
 *
 * WHY IT GOES THROUGH THE PROTOCOL, NOT THE STORES. This module connects over
 * the authenticated local Host socket like any other client, rather than
 * reaching into Host's composition or stores. The goal is explicit that
 * clients must not read Host stores directly or build competing authority —
 * and Desktop is a client. Brokering the real protocol keeps that true; a
 * shortcut into the authority object would have been faster and wrong.
 *
 * READ-ONLY. One channel, `snapshot.get` only. Capabilities requested are
 * bootstrap/snapshot/health. There is deliberately no command surface here:
 * Desktop command cutover is Wave 4.3b and is hard-gated on 4.2c approval
 * correlation. A command channel added "while we're here" would silently
 * un-gate that.
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

import type { HostSnapshot } from '../../shared/hostProtocol'
import { HostProjectionClient } from '../host/HostProjectionClient'

/** The single read channel this bridge exposes. */
export const HOST_PROJECTION_SNAPSHOT_CHANNEL = 'host-projection:snapshot'

/**
 * Read-only capability request.
 *
 * Host intersects this with its own offer, so asking for less than Host offers
 * is a real narrowing. `commands` and `receipts` are deliberately absent.
 */
const READ_ONLY_CAPABILITIES = ['bootstrap', 'snapshot', 'health'] as const

/** Typed IPC result. Never a thrown Error, never a fabricated snapshot. */
export type HostProjectionSnapshotResult =
  | { readonly ok: true; readonly snapshot: HostSnapshot }
  | { readonly ok: false; readonly error: string }

/** The narrow slice of HostProjectionClient this bridge uses. */
export interface HostProjectionClientPort {
  connect(): Promise<unknown>
  getSnapshot(): Promise<{ snapshot: HostSnapshot }>
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

/**
 * Register the Desktop Host projection bridge.
 *
 * Registration is idempotent: the channel is removed before it is added, so a
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
        capabilities: [...READ_ONLY_CAPABILITIES],
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

  ipc.removeHandler?.(HOST_PROJECTION_SNAPSHOT_CHANNEL)
  ipc.handle(HOST_PROJECTION_SNAPSHOT_CHANNEL, async (): Promise<HostProjectionSnapshotResult> => {
    try {
      const active = await ensureClient()
      const frame = await active.getSnapshot()
      return { ok: true, snapshot: frame.snapshot }
    } catch (error) {
      // Drop the client so the next call reconnects rather than reusing a
      // socket that has already failed once.
      discardClient()
      return { ok: false, error: errorText(error) }
    }
  })
}
