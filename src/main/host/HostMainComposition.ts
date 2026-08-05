/**
 * Host Arc Wave 3.4 — production in-main Host composition.
 *
 * WHAT THIS IS. The single factory that assembles the production Host out of
 * the durable stores, the deferred-command bridge, the Authority and the
 * session binder. It is the module a composition root (Wave 3.6, last) calls
 * once, so that the root itself contains wiring and no domain logic.
 *
 * WHY IT LOOKS LIKE THIS. Per the ratified placement ruling, this wave hosts
 * the Host IN-MAIN: domain execution cannot move unchanged, because the
 * production executor closes over main-process singletons at the composition
 * root. The seam that survives that ruling is the executor PORT — this module
 * therefore accepts an already-constructed executor and NEVER builds one from
 * AppStore/Bridge singletons. If a dedicated Host child ever ships, only the
 * injected port becomes RPC-backed; nothing here changes shape.
 *
 * BOUNDARIES (enforced by the import-isolation test alongside this file):
 * - zero `electron` imports;
 * - zero AppStore / BridgeActionExecutor / provider VALUE imports (the
 *   Authority class shares the historic `AppStoreHostAuthority` name but is
 *   itself an injected-ports module — it reads no AppStore);
 * - zero HostLocalServer construction: the listener's lifecycle belongs to the
 *   supervisor slice (3.5), not to composition;
 * - zero composition-root edits.
 *
 * POSITION AUTHORITY. Generation/cursor are read from HostRuntimeBootstrap,
 * which reads them from the sole delta journal. This module never counts.
 */

import { join } from 'node:path'

import type { HostCapability } from '../../shared/hostProtocol'
import {
  AppStoreHostAuthority,
  type AppStoreHostAuthorityEvaluator,
  type AppStoreHostAuthorityExecutor,
  type AppStoreHostAuthorityHealthProvider,
  type AppStoreHostAuthorityShutdownCallback,
  type AppStoreHostAuthoritySnapshotDonor
} from './AppStoreHostAuthority'
import type { HostAuthority } from './HostAuthority'
import {
  HostDeferredCommandBridge,
  type HostDeferredCommandBridgePorts
} from './HostDeferredCommandBridge'
import {
  HostRuntimeBootstrap,
  type HostRuntimeRecoverySummaryWithDeferred
} from './HostRuntimeBootstrap'
import { HostSession, type HostSessionHostIdentity, type HostSessionIdFactory } from './HostSession'

/**
 * Durable Host state lives in its own deterministic subdirectory of the
 * injected userData path.
 *
 * A dedicated directory (rather than loose files at the userData root) keeps
 * every Host journal, checkpoint and envelope under one prefix that a future
 * dedicated Host process can be granted wholesale. The name is deliberately
 * distinct from every existing userData entry, and from the Wave 3.1 v2
 * control artifacts (`taskwraith-host-v2.{sock,token,json}`), which remain
 * FILES at the userData root and never enter this directory.
 */
export const HOST_RUNTIME_DATA_DIR_NAME = 'host-runtime'

/** Absolute Host data directory for an injected userData path. Pure. */
export function hostRuntimeDataDir(userDataPath: string): string {
  return join(userDataPath, HOST_RUNTIME_DATA_DIR_NAME)
}

/**
 * Terminal code surfaced when a deferred challenge is resolved on a Host whose
 * deferred EXECUTION ports were never wired.
 *
 * Wiring the resolve half (execute / publish / complete) is a separate, later
 * scope. Until it lands, the honest behaviour for an `allow` decision is an
 * explicit non-success: never a silent acknowledgement, never a fabricated
 * success, and never a domain execution through an unwired path.
 */
export const HOST_DEFERRED_RESOLUTION_UNWIRED_CODE = 'host_deferred_resolution_unwired'

/**
 * Fail-closed default resolve-side bridge ports.
 *
 * Every port throws. The bridge converts a throwing executor into a terminal
 * `failed` record plus `{ kind: 'failed', code: 'executor_failed' }`, so the
 * ask still dies explicitly and can never be executed twice.
 *
 * Exported so the refusal is asserted directly rather than merely claimed.
 */
export function createUnwiredDeferredResolutionPorts(): HostDeferredCommandBridgePorts {
  const refuse = (): never => {
    throw new Error(HOST_DEFERRED_RESOLUTION_UNWIRED_CODE)
  }
  return {
    completeReceipt: refuse,
    executeCommand: refuse,
    publishEffects: refuse
  }
}

/**
 * Everything this factory needs, all injected. No singletons are read here:
 * the composition root owns singleton access and hands over ports.
 */
export interface HostMainCompositionInput {
  /** Absolute userData path. The Host data directory is derived from it. */
  readonly userDataPath: string
  /**
   * Already-constructed domain executor port. In production the composition
   * root supplies a HostBridgeCommandExecutor; this module never builds one.
   */
  readonly commandExecutor: AppStoreHostAuthorityExecutor
  readonly snapshotDonor: AppStoreHostAuthoritySnapshotDonor
  readonly authorityEvaluator: AppStoreHostAuthorityEvaluator
  readonly healthProvider: AppStoreHostAuthorityHealthProvider
  readonly host: HostSessionHostIdentity
  readonly hostCapabilityOffer: readonly HostCapability[]
  /** Extra durable-state flush performed after the Host's own flush. */
  readonly onShutdown?: AppStoreHostAuthorityShutdownCallback
  /**
   * Resolve-side deferred ports. Omitted ⇒ fail-closed refusal ports; an
   * allow decision then terminalizes as failed instead of executing.
   */
  readonly deferredResolution?: HostDeferredCommandBridgePorts
  readonly sessionIdFactory?: HostSessionIdFactory
  /** Injected ISO clock for tests. */
  readonly now?: () => string
}

/** The composed production Host, exposed only through stable surfaces. */
export interface HostMainComposition {
  /** Deterministic durable directory every Host store shares. */
  readonly hostDataDir: string
  /** Facade-typed: consumers see HostAuthority, never the concrete class. */
  readonly authority: HostAuthority
  /** Session binder for an authenticated transport (3.3 server, 3.5 wiring). */
  readonly session: HostSession
  /** Sole-journal position passthrough. */
  getPosition(): ReturnType<HostRuntimeBootstrap['getPosition']>
  /** Body-free recovery summary passthrough — counts and availability only. */
  getRecoverySummary(): HostRuntimeRecoverySummaryWithDeferred
  /** Idempotent durable flush. Listener lifecycle belongs to the supervisor. */
  shutdown(): Promise<void>
}

function requireFunction(value: unknown, label: string): void {
  if (typeof value !== 'function') {
    throw new Error(`HostMainComposition requires an injected ${label}`)
  }
}

/**
 * Compose the production in-main Host.
 *
 * Construction order matters: the bridge is built first so that bootstrap can
 * take its `list()` as the bridge half of deferred recovery, and the Authority
 * last so it can receive both durable halves as narrow ask ports.
 */
export function createHostMainComposition(input: HostMainCompositionInput): HostMainComposition {
  if (!input || typeof input !== 'object') {
    throw new Error('HostMainComposition requires an options object')
  }
  if (typeof input.userDataPath !== 'string' || input.userDataPath.length === 0) {
    throw new Error('HostMainComposition requires an injected userDataPath')
  }
  requireFunction(input.commandExecutor, 'commandExecutor')
  requireFunction(input.snapshotDonor, 'snapshotDonor')
  requireFunction(input.authorityEvaluator, 'authorityEvaluator')
  requireFunction(input.healthProvider, 'healthProvider')
  if (
    !input.host ||
    typeof input.host.hostId !== 'string' ||
    input.host.hostId.length === 0 ||
    typeof input.host.hostVersion !== 'string' ||
    input.host.hostVersion.length === 0
  ) {
    throw new Error('HostMainComposition requires an injected host identity')
  }
  if (!Array.isArray(input.hostCapabilityOffer)) {
    throw new Error('HostMainComposition requires an injected hostCapabilityOffer')
  }

  const hostDataDir = hostRuntimeDataDir(input.userDataPath)
  const now = input.now

  const deferredBridge = new HostDeferredCommandBridge({
    dataDir: hostDataDir,
    ports: input.deferredResolution ?? createUnwiredDeferredResolutionPorts(),
    ...(now ? { now } : {})
  })

  const runtime = new HostRuntimeBootstrap({
    hostDataDir,
    deferredRecovery: { list: () => deferredBridge.list() }
  })

  // Idempotent so an authoritative host shutdown and a supervisor stop cannot
  // double-flush, and so shutdown can never re-enter through the Authority.
  let stopped = false
  const flushDurableState = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    runtime.flush()
    await input.onShutdown?.()
  }

  const authority = new AppStoreHostAuthority({
    mode: 'in-process-migration',
    activationPermit: { hostOwnedStateMayHaveAdvanced: false },
    ...(now ? { now } : {}),
    ports: {
      runtime,
      snapshotDonor: input.snapshotDonor,
      authorityEvaluator: input.authorityEvaluator,
      commandExecutor: input.commandExecutor,
      healthProvider: input.healthProvider,
      onShutdown: flushDurableState,
      deferredAsk: {
        envelopeStorePut: (put) => runtime.envelopeStore.put(put),
        bridgeRegister: (register) => deferredBridge.register(register)
      }
    }
  })

  const session = new HostSession({
    host: input.host,
    runtime,
    hostCapabilityOffer: input.hostCapabilityOffer,
    ...(input.sessionIdFactory ? { sessionIdFactory: input.sessionIdFactory } : {})
  })

  return {
    hostDataDir,
    authority,
    session,
    getPosition: () => runtime.getPosition(),
    getRecoverySummary: () => runtime.getRecoverySummary(),
    shutdown: flushDurableState
  }
}
