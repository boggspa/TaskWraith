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
import { HostBridgeCommandExecutor, type HostBridgeActionPort } from './HostBridgeCommandExecutor'
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
  createHostProductionContextResolvers,
  type HostProductionContextResolverDeps
} from './HostProductionContextResolvers'
import {
  createHostProductionSuppliers,
  type HostProductionApprovalListPort,
  type HostProductionArtifactListPort,
  type HostProductionChatListPort,
  type HostProductionMissionListPort,
  type HostProductionParticipantListPort,
  type HostProductionProviderListPort,
  type HostProductionQuestionListPort,
  type HostProductionRoundListPort,
  type HostProductionRunListPort,
  type HostProductionScheduleListPort
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
 * Base transport/receipt caps and Host-native deferred approvals are always
 * offered. Optional projection families are advertised only when the real
 * production ports that populate them are present. `compact-export` is backed
 * by the composition's integrity-verified snapshot capture. Still withheld:
 * `usage` (availability unavailable). Advertising an unavailable family is
 * fabricated telemetry — forbidden by the arc goal.
 */

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
   * Wave 5c Phase 3 — optional RemoteQuestionRegistry pending-question
   * shadow port. Optional: when absent, questions is an honest empty array.
   * The guard checks the METHOD (typeof listQuestions === 'function').
   */
  readonly questions?: HostProductionQuestionListPort
  /** Track3 Mixed — optional family shadows. Omitted → honest empty arrays. */
  readonly runs?: HostProductionRunListPort
  readonly missions?: HostProductionMissionListPort
  readonly rounds?: HostProductionRoundListPort
  readonly schedules?: HostProductionScheduleListPort
  /** Track4 Mixed — optional family shadows. Omitted → honest empty arrays. */
  readonly participants?: HostProductionParticipantListPort
  readonly artifacts?: HostProductionArtifactListPort
  /**
   * Live Bridge action surface. The root passes its BridgeActionExecutor
   * singleton directly; this module builds the HostBridgeCommandExecutor
   * over it so the root never constructs a Host type.
   */
  readonly bridge: HostBridgeActionPort
  /**
   * Live main-owned context sources for governed mutations. The bootstrap
   * constructs the Host resolver so the composition root supplies only its
   * canonical store/service callbacks, never Host domain logic.
   */
  readonly contextSources: HostProductionContextResolverDeps
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

function hostProductionCapabilityOffer(
  options: HostProductionBootstrapOptions
): readonly HostCapability[] {
  const capabilities: HostCapability[] = [
    'bootstrap',
    'snapshot',
    'deltas',
    'commands',
    'receipts',
    'health'
  ]
  if (options.missions) capabilities.push('missions')
  if (options.rounds && options.participants) capabilities.push('ensemble')
  // Deferred Host commands always project their own approval challenges even
  // when the optional AppStore pending-approval shadow is absent.
  capabilities.push('approvals')
  if (options.questions) capabilities.push('questions')
  if (options.schedules) capabilities.push('schedules')
  if (options.artifacts) capabilities.push('artifacts')
  capabilities.push('compact-export', 'recovery')
  return capabilities
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
  if (!options.contextSources || typeof options.contextSources !== 'object') {
    throw new Error('HostProductionBootstrap requires injected contextSources')
  }
  if (typeof options.contextSources.getChat !== 'function') {
    throw new Error('HostProductionBootstrap requires contextSources.getChat')
  }
  if (typeof options.contextSources.getApproval !== 'function') {
    throw new Error('HostProductionBootstrap requires contextSources.getApproval')
  }
  if (typeof options.contextSources.getQuestion !== 'function') {
    throw new Error('HostProductionBootstrap requires contextSources.getQuestion')
  }
  if (options.providers !== undefined && typeof options.providers.getProviders !== 'function') {
    throw new Error('HostProductionBootstrap requires providers.getProviders to be a function')
  }
  if (options.approvals !== undefined && typeof options.approvals.listApprovals !== 'function') {
    throw new Error('HostProductionBootstrap requires approvals.listApprovals to be a function')
  }
  if (options.questions !== undefined && typeof options.questions.listQuestions !== 'function') {
    throw new Error('HostProductionBootstrap requires questions.listQuestions to be a function')
  }
  if (options.runs !== undefined && typeof options.runs.listRuns !== 'function') {
    throw new Error('HostProductionBootstrap requires runs.listRuns to be a function')
  }
  if (options.missions !== undefined && typeof options.missions.listMissions !== 'function') {
    throw new Error('HostProductionBootstrap requires missions.listMissions to be a function')
  }
  if (options.rounds !== undefined && typeof options.rounds.listRounds !== 'function') {
    throw new Error('HostProductionBootstrap requires rounds.listRounds to be a function')
  }
  if (options.schedules !== undefined && typeof options.schedules.listSchedules !== 'function') {
    throw new Error('HostProductionBootstrap requires schedules.listSchedules to be a function')
  }
  if (
    options.participants !== undefined &&
    typeof options.participants.listParticipants !== 'function'
  ) {
    throw new Error(
      'HostProductionBootstrap requires participants.listParticipants to be a function'
    )
  }
  if (options.artifacts !== undefined && typeof options.artifacts.listArtifacts !== 'function') {
    throw new Error('HostProductionBootstrap requires artifacts.listArtifacts to be a function')
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
    ...(options.approvals ? { approvals: options.approvals } : {}),
    ...(options.questions ? { questions: options.questions } : {}),
    ...(options.runs ? { runs: options.runs } : {}),
    ...(options.missions ? { missions: options.missions } : {}),
    ...(options.rounds ? { rounds: options.rounds } : {}),
    ...(options.schedules ? { schedules: options.schedules } : {}),
    ...(options.participants ? { participants: options.participants } : {}),
    ...(options.artifacts ? { artifacts: options.artifacts } : {})
  })
  const authorityEvaluator = createHostProductionAuthorityEvaluator()
  const contextResolvers = createHostProductionContextResolvers(options.contextSources)

  const bridgeExecutor = new HostBridgeCommandExecutor({
    bridge: options.bridge,
    resolvers: contextResolvers,
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
    hostCapabilityOffer: hostProductionCapabilityOffer(options),
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
