/**
 * In-main Bridge queued-start ACK executor. Register the exact Host action
 * before the single Bridge dispatch. Queue reservations may publish queued;
 * an early appRunId ACK never publishes prepared or asserts persistence.
 * HostBridgeQueuedStartProducer owns that proof after adapter invocation.
 *
 * Ensemble steering retains the legacy lane without queued-start registration.
 * Bridge-proven rejection/cancellation settles once; uncertain dispatches and
 * refused publication abandon proof through abortQueuedStart. Their succeeded
 * ACK with run_queued_unproven is internal acknowledgement only, so it cannot
 * race a false failed settlement against the indeterminate receipt.
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
 * Internal ACK after abandoning proof. The Authority projects indeterminate
 * through abortQueuedStart; if that port fails, shutdown/restart owns recovery.
 * Returning a failed ACK here could race that abort and falsely fail a prompt
 * which took effect. This ACK never certifies a start or reaches the wire.
 */
function unprovenResult(): HostCommandExecutionResult {
  return { status: 'succeeded', resultSummary: 'run_queued_unproven' }
}

function boundText(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length <= 200 ? trimmed : trimmed.slice(0, 200)
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

  const alreadyPrepared = (actionId: string, threadId: string, runId: string): boolean => {
    const view = getView(actionId)
    return Boolean(
      view?.hostCommandActionId === actionId &&
      view.threadId === threadId &&
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
        if (result.kind === 'applied' || result.kind === 'unchanged') return true
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

    // Ensemble steer stays on the legacy lane: no registration, no adapter
    // event, byte-compatible with HostBridgeCommandExecutor.executeComposerSend.
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
      try {
        return mapBridgeExecutionResult(await bridge.executeEnsembleSteer(action))
      } catch (error) {
        const message = error instanceof Error ? boundText(error.message) : undefined
        return failResult('bridge_adapter_threw', message || 'bridge adapter threw')
      }
    }

    // Solo: fingerprint BEFORE registration so the adapter's authority record
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
      // Unproven: a throwing Bridge call cannot certify "no execution", so the
      // receipt goes indeterminate and the ACK must not re-fail it. The error
      // text is deliberately dropped — it would describe a transport fault, not
      // the receipt outcome, and nothing reads an errorMessage off a succeeded
      // ACK.
      abortOnce(commandId)
      return unprovenResult()
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
          abortOnce(commandId)
          return unprovenResult()
        }
        if (queuedResult.kind === 'refused' || queuedResult.kind === 'failed') {
          // Queue flushing can invoke and persist the exact reserved run
          // before the early queue ACK gets here. Do not regress that proof.
          if (
            queuedResult.kind === 'refused' &&
            (queuedResult.reason === 'regression' || queuedResult.reason === 'terminal') &&
            alreadyPrepared(actionId, threadId, data.queueId)
          ) {
            return { status: 'succeeded', resultSummary: 'run_queued' }
          }
          // Audit N3: a refused event leaves the receipt pending forever.
          // Abort (indeterminate) instead of reporting a false success.
          abortOnce(commandId)
          return unprovenResult()
        }
        return { status: 'succeeded', resultSummary: 'run_queued' }
      }
      if (isSafeHostIdentifier(data?.appRunId)) {
        // Dispatch is still asynchronous. Only the producer may certify the
        // original persisted prompt/start after observing adapter invocation.
        const view = getView(actionId)
        if (
          !view ||
          view.hostCommandActionId !== actionId ||
          view.threadId !== threadId ||
          (view.queued && view.queued.reservedRunId !== data.appRunId) ||
          (view.prepared &&
            (view.prepared.start.kind !== 'solo' || view.prepared.start.runId !== data.appRunId))
        ) {
          abortOnce(commandId)
          return unprovenResult()
        }
        return { status: 'succeeded', resultSummary: 'run_queued' }
      }
      // Case 2 (ruling): Bridge success with neither run identity nor queue
      // reservation. The prompt may have been delivered; `failed` would be a
      // lie. Abort once, never settle, never handleQueuedStartDispatchSettled.
      abortOnce(commandId)
      return unprovenResult()
    }

    // Bridge-reported failure/cancelled: settle the adapter record exactly
    // once so the glue terminalizes the original receipt.
    const applied = await settleOnce(
      actionId,
      threadId,
      mapped.status === 'cancelled' ? 'cancelled' : 'failed',
      mapped.errorCode
    )
    if (!applied) {
      abortOnce(commandId)
      return unprovenResult()
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
