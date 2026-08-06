/**
 * Host Arc Wave 4.3a-adapter — renderer transport over the Host IPC bridge.
 *
 * WHAT THIS IS. The one piece that connects the pure Desktop projection layer
 * to a real Host. It implements `HostProjectionTransport` by calling the
 * preload conduit `window.api.hostProjectionSnapshot()`, which main answers
 * from a real `HostProjectionClient` over the authenticated local socket.
 *
 * WAVE 4.3b COMMANDS live in `HostCommandClient` (same preload surface:
 * `hostProjectionCommandSubmit` / `hostProjectionReceiptLookup`). This module
 * stays snapshot-only so the read path remains independently testable.
 *
 * WHY IT IS A SEPARATE MODULE. The store and mapper are pure and provable
 * without Electron; this is the only place that knows a bridge exists. Keeping
 * the impurity in one small adapter is what let the rest of the layer be
 * tested at all — the renderer has no jsdom environment here.
 *
 * THE ONE RULE THAT MATTERS. A `{ ok: false }` from the bridge becomes a
 * REJECTED promise. It must never become a resolved empty snapshot.
 *
 * That is not a style choice. `HostProjectionStore` turns a rejection into
 * `status: 'unavailable'` and re-labels any retained projection `cached`; a
 * resolved empty snapshot would instead be published as LIVE and render as
 * "there are no workspaces, no threads, no runs". One is "we could not reach
 * Host", the other asserts an empty world. The goal forbids exactly that
 * substitution: unavailable telemetry is not zero, and cached state is not
 * live state. Every failure path here therefore rejects with a named reason.
 *
 * TYPE-BOUNDARY NOTE. The result shape is declared twice on purpose: once here
 * for the renderer and once in `src/preload/index.d.ts` for `window.api`. The
 * renderer cannot import from `src/main/ipc/**` (tsconfig.web does not include
 * it, and a renderer reaching into main would be the coupling this arc is
 * removing), so the boundary is a structural contract rather than a shared
 * import. The `.d.ts` entry is the authoritative declaration of the channel.
 */

import type { HostSnapshot } from '../../../../shared/hostProtocol'
import type { HostProjectionTransport } from './HostProjectionStore'

/**
 * Exactly what the main-process handler returns.
 *
 * Mirrors `HostProjectionSnapshotResult` in
 * `src/main/ipc/hostProjectionHandlers.ts`. Kept structurally identical; see
 * the type-boundary note above for why it is not imported.
 */
export type HostProjectionBridgeResult =
  | { readonly ok: true; readonly snapshot: HostSnapshot }
  | { readonly ok: false; readonly error: string }

/** The single method this adapter needs from `window.api`. */
export interface HostProjectionSnapshotBridge {
  hostProjectionSnapshot(): Promise<HostProjectionBridgeResult>
}

/** Reason surfaced when the preload conduit is not present at all. */
export const HOST_PROJECTION_BRIDGE_UNAVAILABLE = 'host projection bridge unavailable'

/** Reason surfaced when the bridge answers with something unrecognisable. */
export const HOST_PROJECTION_BRIDGE_MALFORMED = 'host projection bridge returned an invalid result'

/**
 * Read the bridge off `window.api` without assuming a browser global exists.
 *
 * Returns null rather than throwing when the conduit is absent — that happens
 * legitimately in tests and in any non-Electron host, and it is a transport
 * absence, not a Host failure.
 */
function defaultBridge(): HostProjectionSnapshotBridge | null {
  const api = (globalThis as { window?: { api?: unknown } }).window?.api as
    | Partial<HostProjectionSnapshotBridge>
    | undefined
  if (!api || typeof api.hostProjectionSnapshot !== 'function') return null
  return api as HostProjectionSnapshotBridge
}

/**
 * Create the IPC-backed transport for `HostProjectionStore`.
 *
 * @param bridge Explicit bridge, for tests. Omit to read `window.api`.
 */
export function createHostProjectionIpcTransport(
  bridge?: HostProjectionSnapshotBridge | null
): HostProjectionTransport {
  const resolveBridge = (): HostProjectionSnapshotBridge | null =>
    bridge === undefined ? defaultBridge() : bridge

  return {
    async fetchSnapshot(): Promise<HostSnapshot> {
      // Resolved per call, not captured once: `window.api` is installed by
      // preload before the renderer runs, but a store may be constructed by a
      // module that loaded earlier. Re-reading costs nothing and avoids
      // pinning a null bridge for the lifetime of the app.
      const active = resolveBridge()
      if (!active) {
        throw new Error(HOST_PROJECTION_BRIDGE_UNAVAILABLE)
      }

      const result = await active.hostProjectionSnapshot()

      if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
        throw new Error(HOST_PROJECTION_BRIDGE_MALFORMED)
      }

      if (!result.ok) {
        // The honesty hinge: surface Host's failure as a rejection so the
        // store reports `unavailable` and marks any retained data `cached`.
        throw new Error(result.error || HOST_PROJECTION_BRIDGE_MALFORMED)
      }

      if (!result.snapshot || typeof result.snapshot !== 'object') {
        // `ok: true` with no snapshot is a broken contract, not an empty
        // world. Refuse it rather than publishing a hollow projection.
        throw new Error(HOST_PROJECTION_BRIDGE_MALFORMED)
      }

      return result.snapshot
    }
  }
}
