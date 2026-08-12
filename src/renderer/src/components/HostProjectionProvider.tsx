/**
 * Host Arc Wave 4.3c — Desktop Host projection provider.
 *
 * WHAT THIS IS. The first UI call site for the Host projection chain. It
 * constructs one `HostProjectionStore` over the real IPC transport, holds it
 * for the lifetime of the renderer, and hands it to descendants by context.
 *
 * Until this existed, `createHostProjectionIpcTransport` and
 * `useHostProjection` had zero consumers outside their own tests: Desktop was
 * capable of projecting Host state but never actually did.
 *
 * The provider also owns one governed Host command controller for the same
 * renderer lifetime. Projection and mutation remain separate ports, but a
 * pending receipt can refresh this exact store and correlate its approval by
 * commandId. Native-only Desktop actions remain outside this context.
 *
 * ONE STORE PER RENDERER, AND THAT IS PER WINDOW. The store is created once
 * via a `useState` initialiser, so a re-render never rebuilds it and never
 * discards the cursor it has accumulated. Note the honest consequence: each
 * BrowserWindow is a separate renderer context, so each window gets its own
 * store and therefore its own Host client and cursor. That is correct — every
 * window is genuinely a separate client of one authoritative Host — but it is
 * a real property worth knowing rather than a hidden accident.
 *
 * WHY THE STORE IS NOT A MODULE SINGLETON. A module-level instance would be
 * created at import time, shared across tests, and impossible to reset without
 * an exported test hatch. Owning it in the provider keeps construction lazy,
 * keeps tests isolated, and makes the injection seam the ordinary React one.
 *
 * THE HONESTY RULE THIS MUST NOT WEAKEN: an unreachable Host renders as
 * UNAVAILABLE or CACHED. It must never render as an empty world. "No
 * workspaces, no threads, no runs" is a claim, and when Host is unreachable it
 * is a false one. The store already enforces that; the provider's job is
 * simply to deliver the real store rather than a hollow substitute.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

import { TASKWRAITH_DESKTOP_HOST_ACTOR } from '../../../shared/hostProtocol'
import { HostCommandClient } from '../lib/host/HostCommandClient'
import { HostCommandController } from '../lib/host/HostCommandController'
import { createHostProjectionIpcTransport } from '../lib/host/hostProjectionIpcTransport'
import { HostProjectionStore } from '../lib/host/HostProjectionStore'

/**
 * Null means "no provider above me".
 *
 * Deliberately distinct from "provider present, Host unreachable" — the latter
 * is a store with `status: 'unavailable'`. A consumer that cannot tell those
 * apart would report a wiring mistake as a Host outage.
 */
const HostProjectionContext = createContext<HostProjectionStore | null>(null)
const HostCommandContext = createContext<HostCommandController | null>(null)

export interface HostProjectionProviderProps {
  readonly children: ReactNode
  /** Injected store for tests. Omit in production to build the real chain. */
  readonly store?: HostProjectionStore
  /** Injected governed-command controller for tests. */
  readonly commandController?: HostCommandController
}

/**
 * Provide one Host projection store to the renderer tree.
 *
 * Mount this INSIDE the app's ErrorBoundary: a provider that throws outside
 * the boundary would take down the very thing meant to catch it.
 */
export function HostProjectionProvider({
  children,
  store,
  commandController
}: HostProjectionProviderProps) {
  // Initialiser form: runs once for the life of this provider. Constructing
  // inline in the render body would build a fresh store — and drop the
  // accumulated cursor — on every re-render.
  const [value] = useState(
    () => store ?? new HostProjectionStore(createHostProjectionIpcTransport())
  )
  const [commands] = useState(
    () =>
      commandController ??
      new HostCommandController({
        client: new HostCommandClient({
          actor: TASKWRAITH_DESKTOP_HOST_ACTOR,
          refreshSnapshot: async () => {
            await value.refresh()
            const source = value.getSourceSnapshot()
            if (!source) throw new Error('Host snapshot refresh did not produce a live snapshot.')
            return source
          }
        })
      })
  )

  useEffect(() => value.startSync(), [value])

  return (
    <HostProjectionContext.Provider value={value}>
      <HostCommandContext.Provider value={commands}>{children}</HostCommandContext.Provider>
    </HostProjectionContext.Provider>
  )
}

/**
 * Read the Host projection store.
 *
 * Returns null when no provider is mounted. Pair with `useHostProjection`,
 * which accepts null and reports `idle` rather than inventing a projection.
 */
export function useHostProjectionStore(): HostProjectionStore | null {
  return useContext(HostProjectionContext)
}

/** Read the renderer-lifetime governed Host command controller. */
export function useHostCommandController(): HostCommandController | null {
  return useContext(HostCommandContext)
}
