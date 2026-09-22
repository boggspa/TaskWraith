/**
 * In-main Bridge queued-start ACK executor (Independent Threads M2, producer
 * step 3b).
 *
 * UNWIRED BY CONSTRUCTION. Nothing builds this yet: no composition root, no
 * `src/main/index.ts` call, no flag. It takes injected FUNCTION ports only
 * (Bridge action port, composer-send resolver, the 2b queued-start adapter,
 * and the Authority-facing publication port) and never reaches for a
 * composition bind, so landing it cannot change any live route. The bootstrap
 * ON-path wiring is separate work and is DEFERRED: Review3's ruling
 * (blackboard ruling-step3-indeterminate-terminalization) traced that
 * HostMainComposition.ts:582-584's third bind forwards only
 * (commandId, result) and drops startEntities, so an in-main ON path wired
 * through those binds would silently strip run/round evidence. This module is
 * exact and disjoint from that defect.
 *
 * WHAT IT DOES. Turns `composer.send` into the short-start ACK path for the
 * in-main Bridge route: register the Host↔Bridge correlation with the
 * queued-start adapter BEFORE any Bridge call, dispatch exactly once, then
 * classify the raw Bridge result into adapter events:
 *
 * - ensemble steer (ctx.mode === 'ensemble') → LEGACY: executeEnsembleSteer
 *   directly, NO registration, byte-compatible with HostBridgeCommandExecutor.
 * - busy-queue (data.queuedBehindActiveRun === true + queueId) → adapter
 *   `queued` event. The queue job's runId IS its queueId (index.ts
 *   queueRemoteComposerPrompt mints `runId: queueId`), so reservedRunId is
 *   the queueId itself — the same reservation the adapter's prepared gate
 *   later checks against the solo start.
 * - dispatched (data.appRunId) → adapter `prepared` event carrying the
 *   literal `durablePromptAndStartPersisted: true` assertion plus the solo
 *   start ref and its run+thread effect refs.
 * - Bridge success with NEITHER identity (case 2 of the ruling) → the prompt
 *   may have been delivered but no run row or queue reservation exists to
 *   prove it. Call authority.abortQueuedStart(commandId) EXACTLY ONCE and
 *   NEVER handleQueuedStartDispatchSettled — `failed` would be a lie about a
 *   prompt that was in fact delivered. Without an abort port the refusal is
 *   pinned as `queued_start_unprovable`.
 * - Bridge throw → same unproven route: abort once, never settle. A throwing
 *   Bridge call cannot certify "no execution".
 * - Bridge-reported failure/cancelled → adapter `settled` EXACTLY ONCE
 *   (settled-once fence), which drives the glue's terminalizing settlement.
 *
 * NEVER-THROW. execute() always resolves to a HostCommandExecutionResult;
 * every foreign port call is try/catch-contained. beginShutdown() fences new
 * executes; drain() awaits the adapter's in-flight tails.
 */

import type { HostCommand } from '../../shared/hostProtocol'
import { HOST_PROTOCOL_MAX_ID } from '../../shared/hostProtocol'
import type { AppStoreHostAuthorityExecutor } from '../../host-runtime/AppStoreHostAuthority'
import type { HostAuthorityCallContext } from '../../host-runtime/HostAuthority'
import { fingerprintHostCommand } from '../../host-runtime/HostCommandFingerprint'
import type { HostCommandExecutionResult } from '../../host-runtime/HostCommandExecutionResult'
import type {
  BridgeComposerPromptAction,
  BridgeEnsembleSteerAction
} from '../BridgeActionPayload'
import type { BridgeActionExecutionResult } from '../BridgeActionExecutor'
import { isSafeHostIdentifier, isHostUuid } from './HostCommandIdentity'
import {
  mapBridgeExecutionResult,
  type HostBridgeActionPort,
  type HostBridgeContextResolvers
} from './HostBridgeCommandExecutor'
import type {
  HostBridgePreparedEvent,
  HostBridgeQueuedEvent,
  HostBridgeQueuedStartAdapter,
  HostBridgeQueuedStartRegistration,
  HostBridgeSettledEvent
} from './HostBridgeQueuedStartAdapter'
import type { HostBridgeQueuedStartAuthorityPort } from './HostBridgeQueuedStartPublicationBridge'

const BRIDGE_ACTION_TTL_MS = 120_000

/** Authority-facing port: the glue's exact slice plus the optional abort. */
export interface HostBridgeQueuedComposerSendAuthorityPort
  extends HostBridgeQueuedStartAuthorityPort {
  /**
   * Promote the original pending receipt to indeterminate
   * (`deferred_execution_may_have_begun`) when the prompt may have been
   * delivered but no run identity or queue reservation exists to prove it.
   * Optional: absent, the unprovable case is refused with
   * `queued_start_unprovable` rather than settled as a lie.
   */
  readonly abortQueuedStart?: (commandId: string) => void
}

/** Narrow adapter slice this executor may call. */
export type HostBridgeQueuedComposerSendAdapterPort = Pick<
  HostBridgeQueuedStartAdapter,
  'register' | 'queued' | 'prepared' | 'settled' | 'beginShutdown' | 'drain'
>

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

function boundText(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length <= 200 ? trimmed : trimmed.slice(0, 200)
}

export function createHostBridgeQueuedComposerSend(
  options: HostBridgeQueuedComposerSendOptions
): AppStoreHostAuthorityExecutor {
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
    typeof adapter.beginShutdown !== 'function' ||
    typeof adapter.drain !== 'function'
  ) {
    throw new Error('HostBridgeQueuedComposerSend requires a complete adapter port')
  }
  const authority = options.authority
  if (
    !authority ||
    typeof authority.handleQueuedStartStarting !== 'function' ||
    typeof authority.handleQueuedStartDispatchSettled !== 'function'
  ) {
    throw new Error('HostBridgeQueuedComposerSend requires a complete authority port')
  }
  if (
    authority.abortQueuedStart !== undefined &&
    typeof authority.abortQueuedStart !== 'function'
  ) {
    throw new Error('HostBridgeQueuedComposerSend requires abortQueuedStart to be a function')
  }
  const nowMs = typeof options.nowMs === 'function' ? options.nowMs : () => Date.now()

  let shuttingDown = false
  /** Settled-once fence: one terminal adapter event per commandId. */
  const settled = new Set<string>()
  /** Abort-once fence: one indeterminate promotion per commandId. */
  const aborted = new Set<string>()

  const settleOnce = async (
    hostCommandActionId: string,
    threadId: string,
    status: 'failed' | 'cancelled',
    errorCode?: string
  ): Promise<void> => {
    if (settled.has(hostCommandActionId)) return
    settled.add(hostCommandActionId)
    const event: HostBridgeSettledEvent = {
      kind: 'settled',
      hostCommandActionId,
      threadId,
      status,
      ...(errorCode ? { errorCode } : {})
    }
    try {
      await adapter.settled(event)
    } catch {
      // Never-throw: the adapter's own failure path already fences the record.
    }
  }

  const abortOnce = (commandId: string): boolean => {
    if (aborted.has(commandId)) return true
    if (typeof authority.abortQueuedStart !== 'function') return false
    aborted.add(commandId)
    try {
      authority.abortQueuedStart(commandId)
      return true
    } catch {
      return false
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
      ...(typeof command.arguments?.model === 'string'
        ? { model: command.arguments.model }
        : {}),
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
    // dispatch can publish queued/prepared/settled against it.
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
    const registered = adapter.register(registration)
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
    } catch (error) {
      // Unproven: a throwing Bridge call cannot certify "no execution".
      const message = error instanceof Error ? boundText(error.message) : undefined
      if (!abortOnce(commandId)) {
        return failResult('queued_start_unprovable', 'abort port unavailable or threw')
      }
      return failResult('bridge_adapter_threw', message || 'bridge adapter threw')
    }

    const mapped = mapBridgeExecutionResult(raw)
    if (mapped.status === 'succeeded') {
      const data = raw?.data
      if (data?.queuedBehindActiveRun === true && typeof data.queueId === 'string' && data.queueId.length > 0) {
        // Busy-queue: the durable queue job's runId IS its queueId, so the
        // reservation is the queueId itself.
        const event: HostBridgeQueuedEvent = {
          kind: 'queued',
          hostCommandActionId: actionId,
          threadId,
          queueId: data.queueId,
          reservedRunId: data.queueId
        }
        try {
          await adapter.queued(event)
        } catch {
          // Never-throw: the adapter's failure path fences the record.
        }
        return { status: 'succeeded', resultSummary: 'run_queued' }
      }
      if (typeof data?.appRunId === 'string' && data.appRunId.length > 0) {
        const event: HostBridgePreparedEvent = {
          kind: 'prepared',
          hostCommandActionId: actionId,
          threadId,
          durablePromptAndStartPersisted: true,
          start: { kind: 'solo', runId: data.appRunId },
          effectRefs: [
            { family: 'run', entityId: data.appRunId },
            { family: 'thread', entityId: threadId }
          ]
        }
        try {
          await adapter.prepared(event)
        } catch {
          // Never-throw: the adapter's failure path fences the record.
        }
        return { status: 'succeeded', resultSummary: 'run_queued' }
      }
      // Case 2 (ruling): Bridge success with neither run identity nor queue
      // reservation. The prompt may have been delivered; `failed` would be a
      // lie. Abort once, never settle, never handleQueuedStartDispatchSettled.
      if (!abortOnce(commandId)) {
        return failResult('queued_start_unprovable', 'abort port unavailable or threw')
      }
      return failResult(
        'run_identity_unavailable',
        'Bridge reported success without a run identity or queue reservation'
      )
    }

    // Bridge-reported failure/cancelled: settle the adapter record exactly
    // once so the glue terminalizes the original receipt.
    await settleOnce(
      actionId,
      threadId,
      mapped.status === 'cancelled' ? 'cancelled' : 'failed',
      mapped.errorCode
    )
    return mapped
  }

  const executor = execute as AppStoreHostAuthorityExecutor & {
    beginShutdown(): void
    drain(): Promise<void>
  }
  executor.beginShutdown = (): void => {
    shuttingDown = true
  }
  executor.drain = async (): Promise<void> => {
    await adapter.drain()
  }
  return executor
}
