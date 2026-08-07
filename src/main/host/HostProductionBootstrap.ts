/**
 * Host Arc Wave 3.6c — HostProductionBootstrap (Gate 2).
 *
 * WHAT THIS IS. The production bootstrap that assembles every composition
 * port, wraps the W36-S2 AllowPipeline chain, resolves the healthProvider
 * circularity, and returns a HostSupervisor with allowCrashRestart pinned
 * to false.
 *
 * WHY IT EXISTS. The composition root (index.ts) must contain ONLY wiring —
 * import + call + will-quit → stopSync. Every domain decision lives here or
 * in the modules it assembles. This is how we turn Host ON without violating
 * the goal's "no domain logic in composition roots" rule.
 *
 * WHAT THE ROOT MAY HAND OVER (R1). Only things the root UNIQUELY HOLDS and
 * cannot itself construct: the Electron userData path, host identity, the
 * live Bridge action singleton, and the chat-list accessor. Everything else —
 * the Bridge command executor, the capability offer, the authority evaluator,
 * the snapshot donor and the whole deferred-allow chain — is built HERE.
 * A root that has to `new` a Host type, author a capability array or wrap a
 * store has already become a domain module, which is the thing R1 forbids.
 *
 * CONSTRUCTION ORDER (load-bearing, matches HostMainComposition.ts):
 *   1. snapshotDonor + authorityEvaluator + commandExecutor built internally
 *   2. healthProvider forwarder (circularity: supervisor owns the truth)
 *   3. pipelineFactory closure (W36-S2 realChain, lazy compositionRef)
 *   4. HostMainCompositionInput assembled
 *   5. createHostSupervisor with wrapped createComposition (back-patches
 *      compositionRef for the pipeline chain)
 *   6. healthProviderRef back-patched from supervisor.healthProvider
 *
 * LIFECYCLE ANCHOR. This module is Electron-free BY IMPORT. That is not
 * style: it is the structural proof that the Host is anchored to the PROCESS
 * and never to a window, so a renderer reload cannot interrupt an active
 * mission. A module that cannot name a window surface cannot bind to one.
 *
 * BOUNDARIES:
 * - zero `electron` imports
 * - zero AppStore / BridgeActionExecutor / provider / store VALUE imports
 * - zero edits to HostMainComposition, HostSupervisor, HostLocalServer,
 *   HostProductionAuthorityEvaluator, HostProductionSuppliers, or any
 *   peer host file
 * - zero composition-root edits
 */

import { resolve as resolvePath } from 'node:path'

import type { HostActorIdentity, HostCapability } from '../../shared/hostProtocol'
import type {
  AppStoreHostAuthorityExecutor,
  AppStoreHostAuthorityHealthProvider
} from './AppStoreHostAuthority'
import type { HostAuthorityCallContext } from './HostAuthority'
import {
  HostBridgeCommandExecutor,
  type HostBridgeActionPort,
  type HostBridgeContextResolvers
} from './HostBridgeCommandExecutor'
import { HostCommandMutationPipeline } from './HostCommandMutationPipeline'
import { HostDeferredAllowPipeline } from './HostDeferredAllowPipeline'
import { HostDeferredCommandEnvelopeResolver } from './HostDeferredCommandEnvelopeResolver'
import { HostDomainDeltaPublisher } from './HostDomainDeltaPublisher'
import { HostLocalServer, type HostLocalServerOptions } from './HostLocalServer'
import {
  createHostMainComposition,
  hostRuntimeDataDir,
  type HostMainComposition,
  type HostMainCompositionInput
} from './HostMainComposition'
import { HostMutationCompletionCoordinator } from './HostMutationCompletionCoordinator'
import { HostObservedMutationExecutor } from './HostObservedMutationExecutor'
import { createHostProductionAuthorityEvaluator } from './HostProductionAuthorityEvaluator'
import {
  createHostProductionSuppliers,
  type HostProductionApprovalListPort,
  type HostProductionChatListPort,
  type HostProductionProviderListPort
} from './HostProductionSuppliers'
import type { HostRuntimeBootstrap } from './HostRuntimeBootstrap'
import type { HostSessionHostIdentity } from './HostSession'
import {
  createHostSupervisor,
  type HostSupervisor,
  type HostSupervisorInput
} from './HostSupervisor'

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

/**
 * Host-internal actor identity used for snapshot observation.
 *
 * The ObservedMutationExecutor captures before/after snapshots to diff
 * domain effects. This is an internal Host operation — it does not serve
 * a specific client request. The actor is fixed at bootstrap time and
 * represents the Host observing its own state.
 *
 * HONEST GAP: HostClientClass has no `host-internal` member and adding one
 * is a protocol change outside this slice, so `desktop` is used for a local
 * in-process read. Recorded here rather than hidden so a Wave-6 audit can
 * decide whether the union should grow.
 */
const HOST_INTERNAL_ACTOR: HostActorIdentity = {
  actorId: 'host',
  clientId: 'host',
  clientClass: 'desktop'
}

/** Context the Host uses when observing its own domain state. */
const HOST_INTERNAL_CONTEXT: HostAuthorityCallContext = {
  actor: HOST_INTERNAL_ACTOR,
  client: {
    clientId: 'host',
    clientClass: 'desktop',
    clientVersion: '0.0.0'
  }
}

/**
 * The capability offer a production Host advertises.
 *
 * Mirrors DEFAULT_CLIENT_CAPABILITIES in HostProjectionClient.ts verbatim —
 * an existing in-repo authority rather than a fresh list invented here.
 *
 * The wider HOST_CAPABILITY_ORDER union is deliberately NOT offered:
 * `missions`, `ensemble`, `schedules` and `artifacts` are families the 3.6b
 * donor returns empty because no store port feeds them yet; `usage` reports
 * `availability: 'unavailable'`; `questions` is held by PIN S4-Q until
 * question answer-payload semantics land. Advertising any of those would be
 * fabricated telemetry, which the arc goal forbids outright. Each is a named
 * gap a later slice must consciously open.
 */
const HOST_PRODUCTION_CAPABILITY_OFFER: readonly HostCapability[] = [
  'bootstrap',
  'snapshot',
  'deltas',
  'commands',
  'receipts',
  'health',
  'recovery'
]

/**
 * Fail-closed Host context resolvers.
 *
 * MEASURED GAP: the repository contains no production implementation of
 * HostBridgeContextResolvers — HostBridgeCommandExecutor declares the
 * interface and nothing satisfies it. Requiring the root to author six
 * resolver methods would put substantial domain logic in the composition
 * root, which R1 forbids, so the bootstrap installs this honest refusal and
 * accepts a real implementation through `options.resolvers` when one exists.
 *
 * This does not weaken any wall. Every governed mutation is already
 * `deferred` by the production evaluator, so it must clear an approval
 * before execution is attempted; this refusal then fails the execution
 * closed with a named reason instead of fabricating a success.
 */
const UNWIRED_CONTEXT_RESOLUTION = 'host-context-resolution-not-wired'

function createUnwiredContextResolvers(): HostBridgeContextResolvers {
  const refuse = (): { ok: false; error: string } => ({
    ok: false,
    error: UNWIRED_CONTEXT_RESOLUTION
  })
  return {
    resolveComposerSend: refuse,
    resolveRunCancel: refuse,
    resolveApprovalDecide: refuse,
    resolveQuestionAnswer: refuse,
    resolveEnsembleSeatToggle: refuse,
    resolveThreadSelect: refuse
  } as unknown as HostBridgeContextResolvers
}

/* ------------------------------------------------------------------ */
/*  Options                                                          */
/* ------------------------------------------------------------------ */

/**
 * Everything the bootstrap needs from the composition root.
 *
 * Deliberately narrow (R1): only values the root uniquely holds. It does NOT
 * take a pre-built command executor or a capability list — those are domain
 * assembly and are built inside this module.
 */
export interface HostProductionBootstrapOptions {
  /** Absolute userData path. The Host data directory is derived from it. */
  readonly userDataPath: string
  /** Host identity for session binding and discovery. */
  readonly host: HostSessionHostIdentity
  /**
   * Chat-list accessor. `AppStore` satisfies this structurally via its
   * static `getChatList`, so the root passes the class directly — the
   * guard checks the METHOD (`typeof getChatList === 'function'`), not
   * the container, precisely so a class-with-statics is a valid port
   * without an adapter.
   */
  readonly chatList: HostProductionChatListPort
  /**
   * Provider-list accessor. The composition root adapts the real provider
   * admission state to this port. Optional: when absent, providers is an
   * honest empty array. The guard checks the METHOD (typeof getProviders
   * === 'function'), not the container — the Step 3 lesson applied to the
   * new port.
   */
  readonly providers?: HostProductionProviderListPort
  /**
   * Wave 5c Phase 2 — optional AppStore pending-approval shadow port.
   * Optional: when absent, approvals is an honest empty array. The guard
   * checks the METHOD (typeof listApprovals === 'function'), not the
   * container — same lesson as providers.
   */
  readonly approvals?: HostProductionApprovalListPort
  /**
   * Live Bridge action surface. The root passes its BridgeActionExecutor
   * singleton directly; this module builds the HostBridgeCommandExecutor
   * over it so the root never constructs a Host type.
   */
  readonly bridge: HostBridgeActionPort
  /**
   * Host-owned context resolvers. Optional: none exists in the tree yet, so
   * omitting it installs the fail-closed refusal above.
   */
  readonly resolvers?: HostBridgeContextResolvers
  /** Extra durable-state flush performed after the Host's own flush. */
  readonly onShutdown?: () => void | Promise<void>
  /** Optional diagnostic logger. */
  readonly log?: (line: string) => void
  /**
   * ISO clock for the COMPOSITION (deferred records, receipts). Deliberately
   * distinct from `nowMs`: crossing an ISO clock with a millisecond clock is
   * a silent corruption, so the two never share a name.
   */
  readonly nowIso?: () => string
  /** Millisecond clock for the SUPERVISOR and the Bridge executor. */
  readonly nowMs?: () => number
  /** Composition factory seam; defaults to createHostMainComposition. */
  readonly createComposition?: (input: HostMainCompositionInput) => HostMainComposition
  /** Server factory seam; defaults to `new HostLocalServer(options)`. */
  readonly createServer?: (options: HostLocalServerOptions) => HostLocalServer
  /** Supervisor factory seam; defaults to createHostSupervisor. */
  readonly createSupervisor?: (input: HostSupervisorInput) => HostSupervisor
}

/* ------------------------------------------------------------------ */
/*  Re-entrancy registry                                              */
/* ------------------------------------------------------------------ */

/**
 * One live supervisor per host data directory.
 *
 * Two supervisors over one directory means two HostRuntimeBootstraps over one
 * journal — the forbidden second journal — plus two listeners racing for one
 * socket. Dev-mode re-initialisation or a double-wire in the root would
 * otherwise reproduce exactly that.
 *
 * The key is a RESOLVED, normalised path: `/data` and `/data/` are the same
 * directory, and keying on the raw string would silently admit two
 * supervisors onto one journal.
 *
 * Entries are PURGED on stop. Explicit stop stays persistent for the handle
 * the user stopped — `isStopped` remains true on it forever — but the user
 * must be able to start the Host again afterwards, and a registry that kept
 * the stopped entry would hand every later caller a permanently dead handle.
 */
const SUPERVISOR_REGISTRY = new Map<string, HostSupervisor>()

/** Registry key: the resolved, normalised host data directory. */
function registryKey(userDataPath: string): string {
  return resolvePath(hostRuntimeDataDir(userDataPath))
}

/** Test-only registry reset. Production code must never call this. */
export function resetHostProductionBootstrapForTests(): void {
  SUPERVISOR_REGISTRY.clear()
}

/* ------------------------------------------------------------------ */
/*  Factory                                                          */
/* ------------------------------------------------------------------ */

/**
 * Create the production Host supervisor.
 *
 * Assembles every composition port, wraps the W36-S2 AllowPipeline chain,
 * resolves the healthProvider circularity, and returns a HostSupervisor with
 * allowCrashRestart passed literally as false.
 *
 * Construction is side-effect free: no server is opened, no store is touched
 * and no journal is created until `start()` is called. Calling this twice for
 * the same host data directory returns the SAME supervisor.
 *
 * @returns A HostSupervisor handle suitable for wiring into index.ts
 *          as: import + call + will-quit → stopSync.
 */
export function createHostProductionBootstrap(
  options: HostProductionBootstrapOptions
): HostSupervisor {
  /* ---- validate options ---- */
  if (!options || typeof options !== 'object') {
    throw new Error('HostProductionBootstrap requires an options object')
  }
  if (typeof options.userDataPath !== 'string' || options.userDataPath.length === 0) {
    throw new Error('HostProductionBootstrap requires an injected userDataPath')
  }
  if (!options.chatList || typeof options.chatList.getChatList !== 'function') {
    throw new Error('HostProductionBootstrap requires an injected chatList')
  }
  if (!options.bridge || typeof options.bridge !== 'object') {
    throw new Error('HostProductionBootstrap requires an injected bridge')
  }
  if (options.providers !== undefined && typeof options.providers.getProviders !== 'function') {
    throw new Error('HostProductionBootstrap requires providers.getProviders to be a function')
  }
  if (options.approvals !== undefined && typeof options.approvals.listApprovals !== 'function') {
    throw new Error('HostProductionBootstrap requires approvals.listApprovals to be a function')
  }
  if (
    !options.host ||
    typeof options.host.hostId !== 'string' ||
    options.host.hostId.length === 0 ||
    typeof options.host.hostVersion !== 'string' ||
    options.host.hostVersion.length === 0
  ) {
    throw new Error('HostProductionBootstrap requires an injected host identity')
  }

  /* ---- re-entrancy: one live supervisor per resolved data dir ---- */
  const key = registryKey(options.userDataPath)
  const existing = SUPERVISOR_REGISTRY.get(key)
  if (existing) return existing

  const log = options.log
  const createComposition = options.createComposition ?? createHostMainComposition
  const createServer =
    options.createServer ??
    ((serverOptions: HostLocalServerOptions) => new HostLocalServer(serverOptions))
  const createSupervisor = options.createSupervisor ?? createHostSupervisor

  /* ---- 1. domain ports built HERE, not by the root (R1) ---- */
  const snapshotDonor = createHostProductionSuppliers({
    chatList: options.chatList,
    ...(options.providers ? { providers: options.providers } : {}),
    ...(options.approvals ? { approvals: options.approvals } : {})
  })
  const authorityEvaluator = createHostProductionAuthorityEvaluator()

  const bridgeExecutor = new HostBridgeCommandExecutor({
    bridge: options.bridge,
    resolvers: options.resolvers ?? createUnwiredContextResolvers(),
    ...(options.nowMs ? { nowMs: options.nowMs } : {})
  })
  const commandExecutor: AppStoreHostAuthorityExecutor = (command, context) =>
    bridgeExecutor.execute(command, context)

  /* ---- 2. healthProvider circularity ---- */
  // The supervisor owns the honest health projection (it alone knows whether
  // it is running). The composition input needs a provider before the
  // supervisor exists, so this forwarder is back-patched at step 6.
  //
  // There is deliberately NO fallback projection here. A fallback would be
  // unreachable for every post-construction consumer — back-patching happens
  // before this factory returns — so it could only ever be dead code wearing
  // a vacuous test. The invariant is named and fails loudly instead.
  let healthProviderRef: AppStoreHostAuthorityHealthProvider | null = null
  const healthProvider: AppStoreHostAuthorityHealthProvider = () => {
    if (!healthProviderRef) {
      throw new Error(
        'HostProductionBootstrap: health requested before supervisor assembly completed'
      )
    }
    return healthProviderRef()
  }

  /* ---- 3. pipelineFactory (W36-S2 realChain) ---- */
  // The pipelineFactory runs DURING createHostMainComposition, before the
  // composition is returned. The captureSnapshot closure reads compositionRef
  // lazily — null at construction, back-patched before any deferred command
  // can execute (the server starts after the composition is created).
  let compositionRef: HostMainComposition | null = null

  const pipelineFactory = (runtime: HostRuntimeBootstrap): HostDeferredAllowPipeline => {
    const resolver = new HostDeferredCommandEnvelopeResolver({
      envelopeStore: runtime.envelopeStore,
      receiptStore: runtime.receiptStore,
      // The raw resolver executor must never run under the AllowPipeline.
      // If this ever executes, a second execution route has been opened.
      executor: {
        execute: async () => {
          throw new Error('raw resolver executor must never run under the AllowPipeline')
        }
      } as unknown as ConstructorParameters<
        typeof HostDeferredCommandEnvelopeResolver
      >[0]['executor']
    })

    const publisher = new HostDomainDeltaPublisher({ store: runtime.deltaStore })

    const coordinator = new HostMutationCompletionCoordinator({
      publishEffects: (effects) => publisher.publish(effects),
      getPosition: () => runtime.getPosition(),
      completeReceipt: (i) => runtime.receiptStore.complete(i),
      markIndeterminate: (i) => runtime.receiptStore.markIndeterminate(i)
    })

    const mutation = new HostCommandMutationPipeline({
      observe: async (command) =>
        new HostObservedMutationExecutor({
          captureSnapshot: async () => {
            const composition = compositionRef
            if (!composition) {
              throw new Error('HostProductionBootstrap: snapshot capture before composition exists')
            }
            const snap = await composition.authority.snapshot(HOST_INTERNAL_CONTEXT)
            if (!snap.ok) throw new Error('snapshot capture failed')
            return snap.value
          },
          executeCommand: (c) => commandExecutor(c, HOST_INTERNAL_CONTEXT)
        }).execute(command),
      complete: (i) => coordinator.complete(i)
    })

    return new HostDeferredAllowPipeline({
      verifyCommand: (i) => resolver.verifyCommand(i),
      pipeline: mutation
    })
  }

  /* ---- 4. assemble compositionInput ---- */
  const compositionInput: HostMainCompositionInput = {
    userDataPath: options.userDataPath,
    commandExecutor,
    snapshotDonor,
    authorityEvaluator,
    healthProvider,
    host: options.host,
    hostCapabilityOffer: HOST_PRODUCTION_CAPABILITY_OFFER,
    pipelineFactory,
    ...(options.onShutdown ? { onShutdown: options.onShutdown } : {}),
    ...(options.nowIso ? { now: options.nowIso } : {})
  }

  /* ---- 5. create supervisor ---- */
  // Wrap createComposition to back-patch compositionRef so the pipeline
  // chain's captureSnapshot closure can reach the Authority.
  const wrappedCreateComposition = (input: HostMainCompositionInput): HostMainComposition => {
    const composition = createComposition(input)
    compositionRef = composition
    return composition
  }

  const supervisor = createSupervisor({
    createComposition: wrappedCreateComposition,
    createServer,
    compositionInput,
    // Passed LITERALLY, never left to the supervisor's default. Explicit stop
    // is persistent; the goal forbids an undeclared background service that
    // resurrects itself after a crash. HostSupervisor already treats only
    // `=== true` as restart-on, so this is regression insurance rather than a
    // live behaviour fix — but an implicit default is not a pin.
    allowCrashRestart: false,
    ...(log ? { log } : {}),
    ...(options.nowMs ? { now: options.nowMs } : {})
  })

  /* ---- 6. back-patch healthProvider ---- */
  healthProviderRef = supervisor.healthProvider

  /* ---- 7. lifecycle wrapper: registry purge + idempotent teardown ---- */
  // Purging on stop is what makes stop→start work. Without it the registry
  // would hand a later caller the supervisor the user already stopped, and
  // restarting the Host from the UI would silently return a dead handle.
  const purge = (): void => {
    if (SUPERVISOR_REGISTRY.get(key) === handle) {
      SUPERVISOR_REGISTRY.delete(key)
    }
  }

  const handle: HostSupervisor = {
    start: () => supervisor.start(),
    stop: async () => {
      // try/finally: a throwing port must not strand the registry entry.
      try {
        await supervisor.stop()
      } finally {
        compositionRef = null
        purge()
      }
    },
    stopSync: () => {
      // will-quit contract: fully synchronous, and never throws — an
      // exception escaping here would abort application quit. Failures are
      // surfaced to the diagnostic log rather than swallowed silently.
      try {
        supervisor.stopSync()
      } catch (err) {
        log?.(`[host-bootstrap] stopSync error: ${String(err)}`)
      } finally {
        compositionRef = null
        purge()
      }
    },
    get isRunning(): boolean {
      return supervisor.isRunning
    },
    get isStopped(): boolean {
      return supervisor.isStopped
    },
    healthProvider: supervisor.healthProvider
  }

  SUPERVISOR_REGISTRY.set(key, handle)
  return handle
}
