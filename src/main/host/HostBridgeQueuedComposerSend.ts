/**
 * In-main Bridge queued-start ACK executor. Register the exact Host action
 * before the single Bridge dispatch. Queue reservations may publish queued;
 * an early appRunId or Ensemble roundId ACK never publishes prepared or asserts
 * persistence. The detached producers own that proof after observing a start.
 *
 * Solo rejection/cancellation without prepared proof settles once. Ensemble outcomes
 * other than an exact fresh started round remain unproven; queued, steered or
 * absorbed ACKs cannot certify a new round. Uncertain ACKs in both modes preserve
 * exact producer proof while Authority publication is pending; without proof
 * they abandon through abortQueuedStart. Their succeeded ACK with
 * run_queued_unproven is internal acknowledgement only, so it cannot race a
 * false failed settlement against the original receipt.
 *
 * An abort port can mutate then throw. That never proves failure: the receipt
 * may remain pending until shutdown/restart recovery marks it indeterminate.
 * beginShutdown fences new sends; drain waits for active Bridge ACKs before
 * draining the adapter events those sends can still publish.
 */

import type { HostCommand } from '../../shared/hostProtocol'
import { HOST_PROTOCOL_MAX_ID } from '../../shared/hostProtocol'
import type { AppStoreHostAuthorityExecutor } from '../../host-runtime/AppStoreHostAuthority'
import type { HostAuthorityCallContext } from '../../host-runtime/HostAuthority'
import { fingerprintHostCommand } from '../../host-runtime/HostCommandFingerprint'
import type { HostCommandExecutionResult } from '../../host-runtime/HostCommandExecutionResult'
import type { BridgeComposerPromptAction, BridgeEnsembleSteerAction } from '../BridgeActionPayload'
import type { BridgeActionExecutionResult } from '../BridgeActionExecutor'
import { isSafeHostIdentifier, isHostUuid } from './HostCommandIdentity'
import {
  mapBridgeExecutionResult,
  type HostBridgeActionPort,
  type HostBridgeContextResolvers
} from './HostBridgeCommandExecutor'
import {
  createHostBridgeQueuedStartAdapter,
  type HostBridgeQueuedEvent,
  type HostBridgeQueuedStartEventResult,
  type HostBridgeQueuedStartRegisterResult,
  type HostBridgeQueuedStartRegistration,
  type HostBridgeSettledEvent,
  type HostBridgeQueuedStartView
} from './HostBridgeQueuedStartAdapter'

const BRIDGE_ACTION_TTL_MS = 120_000

/**
 * Authority-facing port, SELF-DECLARED (audit 8374a93d2-3b N2): the executor
 * never calls handleQueuedStartStarting/handleQueuedStartDispatchSettled, so
 * it must not extend the glue's port type — the glue's abortQueuedStart is
 * required and an `extends` + optional override would be TS2430 the moment
 * the 3t tree lands. The abort port is REQUIRED here too (audit N1): without
 * it the unprovable case would compile into a false `failed` terminalization.
 */
export interface HostBridgeQueuedComposerSendAuthorityPort {
  /**
   * Promote the original pending receipt to indeterminate
   * (`deferred_execution_may_have_begun`) when the prompt may have been
   * delivered but no run identity or queue reservation exists to prove it.
   */
  abortQueuedStart(commandId: string): void
}

/** Narrow adapter slice this executor may call. */
export type HostBridgeQueuedComposerSendAdapterPort = Pick<
  ReturnType<typeof createHostBridgeQueuedStartAdapter>,
  'register' | 'queued' | 'prepared' | 'settled' | 'get' | 'beginShutdown' | 'drain'
>

/**
 * The executor plus its lifecycle handles. Named and EXPORTED because the
 * factory used to annotate itself as a bare AppStoreHostAuthorityExecutor and
 * augment the value internally, which erased `beginShutdown`/`drain` at the
 * boundary and forced every caller — the tests, and 3a's bootstrap next — to
 * cast them back. The shutdown fence and the drain tail are part of the
 * contract, so they belong in the signature.
 */
export type HostBridgeQueuedComposerSendExecutor = AppStoreHostAuthorityExecutor & {
  beginShutdown(): void
  drain(): Promise<void>
}

export interface HostBridgeQueuedComposerSendOptions {
  readonly bridge: HostBridgeActionPort
  readonly resolvers: HostBridgeContextResolvers
  readonly adapter: HostBridgeQueuedComposerSendAdapterPort
  readonly authority: HostBridgeQueuedComposerSendAuthorityPort
  /** Optional clock for Bridge action issuedAt (ms). */
  readonly nowMs?: () => number
}

function failResult(errorCode: string, errorMessage: string): HostCommandExecutionResult {
  return { status: 'failed', errorCode, errorMessage }
}

/**
 * Internal ACK without start evidence from Bridge. Existing producer proof
 * continues publishing; otherwise abortQueuedStart projects indeterminate and
 * shutdown/restart owns recovery if that port fails. Returning a failed ACK
 * here could falsely fail a prompt which took effect. This ACK never certifies
 * a start or reaches the wire.
 */
function unprovenResult(): HostCommandExecutionResult {
  return { status: 'succeeded', resultSummary: 'run_queued_unproven' }
}

export function createHostBridgeQueuedComposerSend(
  options: HostBridgeQueuedComposerSendOptions
): HostBridgeQueuedComposerSendExecutor {
  if (!options || typeof options !== 'object') {
    throw new Error('HostBridgeQueuedComposerSend requires options')
  }
  const bridge = options.bridge
  if (
    !bridge ||
    typeof bridge.executeComposerPrompt !== 'function' ||
    typeof bridge.executeEnsembleSteer !== 'function'
  ) {
    throw new Error('HostBridgeQueuedComposerSend requires a complete bridge port')
  }
  const resolvers = options.resolvers
  if (!resolvers || typeof resolvers.resolveComposerSend !== 'function') {
    throw new Error('HostBridgeQueuedComposerSend requires resolvers.resolveComposerSend')
  }
  const adapter = options.adapter
  if (
    !adapter ||
    typeof adapter.register !== 'function' ||
    typeof adapter.queued !== 'function' ||
    typeof adapter.prepared !== 'function' ||
    typeof adapter.settled !== 'function' ||
    typeof adapter.get !== 'function' ||
    typeof adapter.beginShutdown !== 'function' ||
    typeof adapter.drain !== 'function'
  ) {
    throw new Error('HostBridgeQueuedComposerSend requires a complete adapter port')
  }
  const authority = options.authority
  if (!authority || typeof authority.abortQueuedStart !== 'function') {
    throw new Error('HostBridgeQueuedComposerSend requires authority.abortQueuedStart')
  }
  const nowMs = typeof options.nowMs === 'function' ? options.nowMs : () => Date.now()

  let shuttingDown = false
  /** Settled-once fence: one terminal adapter event per commandId. */
  const settled = new Map<string, Promise<boolean>>()
  /** Abort-once fence: one indeterminate promotion per commandId. */
  const aborted = new Set<string>()
  const inFlight = new Set<Promise<HostCommandExecutionResult>>()

  const getView = (actionId: string): HostBridgeQueuedStartView | undefined => {
    try {
      return adapter.get(actionId)
    } catch {
      return undefined
    }
  }

  const alreadyPrepared = (view: HostBridgeQueuedStartView | undefined, runId: string): boolean => {
    return Boolean(
      view &&
      (view.phase === 'prepared' || view.phase === 'settled') &&
      (!view.queued || (view.queued.queueId === runId && view.queued.reservedRunId === runId)) &&
      view.prepared?.start.kind === 'solo' &&
      view.prepared.start.runId === runId
    )
  }

  const settleOnce = async (
    hostCommandActionId: string,
    threadId: string,
    status: 'failed' | 'cancelled',
    errorCode?: string
  ): Promise<boolean> => {
    const existing = settled.get(hostCommandActionId)
    if (existing) return existing
    const prior = getView(hostCommandActionId)
    if (
      !prior ||
      prior.hostCommandActionId !== hostCommandActionId ||
      prior.threadId !== threadId ||
      prior.prepared
    ) {
      return false
    }
    const event: HostBridgeSettledEvent = {
      kind: 'settled',
      hostCommandActionId,
      threadId,
      status,
      ...(errorCode ? { errorCode } : {})
    }
    const operation = (async (): Promise<boolean> => {
      try {
        const result = await adapter.settled(event)
        // A prepared event can win the adapter queue after the prior lookup.
        // Its proof still owns publication even if this settlement was applied.
        if (result.kind === 'applied' || result.kind === 'unchanged') return !result.view.prepared
        const view = getView(hostCommandActionId)
        return Boolean(
          view?.hostCommandActionId === hostCommandActionId &&
          view.threadId === threadId &&
          view.phase === 'settled' &&
          view.settled?.status === status &&
          !view.prepared
        )
      } catch {
        return false
      }
    })()
    settled.set(hostCommandActionId, operation)
    return operation
  }

  const abortOnce = (commandId: string): void => {
    if (aborted.has(commandId)) return
    aborted.add(commandId)
    try {
      authority.abortQueuedStart(commandId)
    } catch {
      // A void port can mutate and then throw. Never reinterpret that as
      // evidence that a delivered prompt failed or retry an unknown effect.
    }
  }

  const execute: AppStoreHostAuthorityExecutor = async (
    command: HostCommand,
    context: HostAuthorityCallContext
  ): Promise<HostCommandExecutionResult> => {
    if (shuttingDown) {
      return failResult('shutting_down', 'queued composer send is shutting down')
    }
    if (command?.name !== 'composer.send') {
      return failResult('not_governed_mutation', 'queued composer send accepts composer.send only')
    }
    const threadId = command.target?.threadId
    if (!threadId) {
      return failResult('invalid_command_arguments', 'composer.send target.threadId required')
    }
    const commandId = command.commandId
    if (!isSafeHostIdentifier(commandId) || !isHostUuid(commandId)) {
      return failResult('invalid_command_id', 'commandId is missing, unsafe, or not a UUID')
    }
    const actionId = `host:command:${commandId}`
    if (actionId.length > HOST_PROTOCOL_MAX_ID || !isSafeHostIdentifier(actionId)) {
      return failResult('invalid_command_id', 'actionId exceeds protocol bound or is unsafe')
    }
    const issuedAt = nowMs()
    const meta = { actionId, issuedAt, expiresAt: issuedAt + BRIDGE_ACTION_TTL_MS }

    const selection = {
      ...(typeof command.arguments?.model === 'string' ? { model: command.arguments.model } : {}),
      ...(typeof command.arguments?.reasoningEffort === 'string'
        ? { reasoningEffort: command.arguments.reasoningEffort }
        : {})
    }
    let resolved
    try {
      resolved = await resolvers.resolveComposerSend(threadId, selection)
    } catch {
      return failResult('context_resolve_failed', 'composer send context resolution threw')
    }
    if (!resolved.ok) {
      return failResult('context_resolve_failed', resolved.error)
    }
    const ctx = resolved.value

    // Fingerprint BEFORE registration so the adapter's authority record
    // carries the exact canonical fingerprint the receipt store holds.
    let fingerprint: string
    try {
      fingerprint = fingerprintHostCommand(command).fingerprint
    } catch {
      return failResult('invalid_command_arguments', 'composer.send fingerprint failed')
    }

    // Register BEFORE any Bridge call: the correlation must exist before the
    // dispatch can publish queued/prepared/settled against it. Contained
    // (audit N4): a throwing register must not escape execute().
    const registration: HostBridgeQueuedStartRegistration = {
      hostCommandActionId: actionId,
      threadId,
      authority: {
        actorId: context.actor.actorId,
        clientId: context.actor.clientId,
        clientClass: context.actor.clientClass,
        commandFingerprint: fingerprint
      }
    }
    let registered: HostBridgeQueuedStartRegisterResult
    try {
      registered = adapter.register(registration)
    } catch {
      return failResult('queued_start_registration_threw', 'queued start registration threw')
    }
    if (registered.kind === 'refused') {
      return failResult('queued_start_registration_refused', registered.reason)
    }

    const getRegisteredView = (): HostBridgeQueuedStartView | undefined => {
      const view = getView(actionId)
      return view?.hostCommandActionId === registration.hostCommandActionId &&
        view.threadId === registration.threadId &&
        view.authority.actorId === registration.authority.actorId &&
        view.authority.clientId === registration.authority.clientId &&
        view.authority.clientClass === registration.authority.clientClass &&
        view.authority.commandFingerprint === registration.authority.commandFingerprint
        ? view
        : undefined
    }
    const unprovenAck = (): HostCommandExecutionResult => {
      const view = getRegisteredView()
      const hasPreparedStart =
        (view?.phase === 'prepared' || view?.phase === 'settled') &&
        (ctx.mode === 'ensemble'
          ? view.prepared?.start.kind === 'ensemble' &&
            isSafeHostIdentifier(view.prepared.start.roundId)
          : view.prepared?.start.kind === 'solo' &&
            isSafeHostIdentifier(view.prepared.start.runId) &&
            (!view.queued || view.queued.reservedRunId === view.prepared.start.runId))
      // The adapter can hold exact proof while Authority publication is
      // still queued. A later Bridge ACK cannot invalidate that producer.
      if (!hasPreparedStart) abortOnce(commandId)
      return unprovenResult()
    }

    if (ctx.mode === 'ensemble') {
      const action: BridgeEnsembleSteerAction = {
        kind: 'ensembleSteer',
        ...meta,
        workspaceId: ctx.workspaceId,
        threadId,
        text: String(command.arguments?.text ?? ''),
        message: 'Sent via Host protocol',
        ...(ctx.roundId ? { roundId: ctx.roundId } : {})
      }
      let raw: BridgeActionExecutionResult
      try {
        raw = await bridge.executeEnsembleSteer(action)
      } catch {
        return unprovenAck()
      }
      // The production Bridge wraps the root's result under data.result.
      // This is only an ACK: the round producer proves persistence separately.
      const data = raw?.data
      const result = data?.result
      if (
        mapBridgeExecutionResult(raw).status === 'succeeded' &&
        data?.actionKind === 'ensembleSteer' &&
        result !== null &&
        typeof result === 'object' &&
        !Array.isArray(result) &&
        'status' in result &&
        result.status === 'started' &&
        'roundId' in result &&
        isSafeHostIdentifier(result.roundId)
      ) {
        const view = getRegisteredView()
        if (
          view &&
          (!view.prepared ||
            (view.prepared.start.kind === 'ensemble' &&
              view.prepared.start.roundId === result.roundId))
        ) {
          return { status: 'succeeded', resultSummary: 'run_queued' }
        }
      }
      // Even a failed/throwing Bridge result may follow round effects. Never
      // settle it as no-start or abort an exact start awaiting publication.
      return unprovenAck()
    }

    const action: BridgeComposerPromptAction = {
      kind: 'composerPrompt',
      ...meta,
      workspaceId: ctx.workspaceId,
      threadId,
      text: String(command.arguments?.text ?? ''),
      provider: ctx.provider,
      ...(ctx.approvalMode ? { approvalMode: ctx.approvalMode } : {}),
      ...(ctx.permissionPresetId ? { permissionPresetId: ctx.permissionPresetId } : {}),
      ...(ctx.workflowMode ? { workflowMode: ctx.workflowMode } : {}),
      ...(ctx.model ? { model: ctx.model } : {}),
      ...(ctx.reasoningEffort ? { reasoningEffort: ctx.reasoningEffort } : {})
    }

    // SINGLE dispatch. One Bridge call per execute, never retried.
    let raw: BridgeActionExecutionResult
    try {
      raw = await bridge.executeComposerPrompt(action)
    } catch {
      // A throwing Bridge call cannot certify no execution or invalidate
      // exact producer proof awaiting Authority publication.
      return unprovenAck()
    }

    const mapped = mapBridgeExecutionResult(raw)
    if (mapped.status === 'succeeded') {
      const data = raw?.data
      if (
        data?.queuedBehindActiveRun === true &&
        typeof data.queueId === 'string' &&
        data.queueId.length > 0
      ) {
        // Busy-queue: the durable queue job's runId IS its queueId, so the
        // reservation is the queueId itself.
        const event: HostBridgeQueuedEvent = {
          kind: 'queued',
          hostCommandActionId: actionId,
          threadId,
          queueId: data.queueId,
          reservedRunId: data.queueId
        }
        let queuedResult: HostBridgeQueuedStartEventResult
        try {
          queuedResult = await adapter.queued(event)
        } catch {
          return unprovenAck()
        }
        if (queuedResult.kind === 'refused' || queuedResult.kind === 'failed') {
          // Queue flushing can invoke and persist the exact reserved run
          // before the early queue ACK gets here. Do not regress that proof.
          if (
            queuedResult.kind === 'refused' &&
            (queuedResult.reason === 'regression' || queuedResult.reason === 'terminal') &&
            alreadyPrepared(getRegisteredView(), data.queueId)
          ) {
            return { status: 'succeeded', resultSummary: 'run_queued' }
          }
          // Without exact producer proof a refused event cannot leave the
          // receipt pending forever; an existing proof keeps publishing.
          return unprovenAck()
        }
        return { status: 'succeeded', resultSummary: 'run_queued' }
      }
      if (isSafeHostIdentifier(data?.appRunId)) {
        // Dispatch is still asynchronous. Only the producer may certify the
        // original persisted prompt/start after observing adapter invocation.
        const view = getRegisteredView()
        if (
          !view ||
          (view.queued && view.queued.reservedRunId !== data.appRunId) ||
          (view.prepared &&
            (view.prepared.start.kind !== 'solo' || view.prepared.start.runId !== data.appRunId))
        ) {
          return unprovenAck()
        }
        return { status: 'succeeded', resultSummary: 'run_queued' }
      }
      // Case 2 (ruling): Bridge success with neither run identity nor queue
      // reservation. The prompt may have been delivered; `failed` would be a
      // lie. Preserve exact proof if present, otherwise abort once.
      return unprovenAck()
    }

    // Settle a Bridge-reported failure/cancellation only without prepared
    // proof. A producer which wins the adapter queue keeps its publication.
    const applied = await settleOnce(
      actionId,
      threadId,
      mapped.status === 'cancelled' ? 'cancelled' : 'failed',
      mapped.errorCode
    )
    if (!applied) {
      return unprovenAck()
    }
    return mapped
  }

  const executor: HostBridgeQueuedComposerSendExecutor = Object.assign(
    (command: HostCommand, context: HostAuthorityCallContext) => {
      const operation = Promise.resolve(execute(command, context))
      inFlight.add(operation)
      void operation.finally(() => inFlight.delete(operation)).catch(() => undefined)
      return operation
    },
    { beginShutdown: () => undefined, drain: async () => undefined }
  )
  executor.beginShutdown = (): void => {
    shuttingDown = true
  }
  executor.drain = async (): Promise<void> => {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight])
    await adapter.drain()
  }
  return executor
}
