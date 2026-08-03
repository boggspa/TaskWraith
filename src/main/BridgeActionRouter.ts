import type {
  RemoteWorkspaceAllowlist,
  RemoteWorkspaceCapability
} from './RemoteWorkspaceAllowlist'
import {
  BridgeActionPayloadDecodeError,
  actionIdFromPayload,
  decodeBridgeActionPayload,
  expiresAtFromPayload,
  payloadIsMutating,
  payloadRequiresWorkspaceGating,
  workspaceIdFromPayload,
  type BridgeActionPayload
} from './BridgeActionPayload'
import {
  NoopActionExecutor,
  type BridgeActionDispatchContext,
  type BridgeActionExecutionResult,
  type BridgeActionExecutor
} from './BridgeActionExecutor'
import {
  createDefaultRemoteDeviceAuditLedger,
  type RemoteDeviceAuditDecision,
  type RemoteDeviceAuditLedgerWriter
} from './remote/RemoteDeviceAuditLedger'
import {
  isRemoteProviderDispatchable,
  type RemoteProviderDispatchability
} from './remote/RemoteProviderAdmission'

/**
 * BridgeActionRouter — Electron-side handler for daemon→Electron requests.
 *
 * Phase C3.6 introduced the round-trip contract. Phase C4 wires the
 * `RemoteWorkspaceAllowlist` into the prepare-start-turn path: an iOS
 * device that names a workspace must have that workspace explicitly
 * allowlisted by the desktop user, or its request is denied with a
 * structured reason. This is per-action revalidation — the allowlist is
 * consulted on every iOS request, not just at session open, so a
 * desktop-side allowlist change takes effect on the next iOS action with
 * no daemon restart.
 *
 * Known methods:
 *   - `bridge.requestActionAck`         → typed iOS-side action; returns
 *                                          `BridgeActionAckV1` while keeping
 *                                          `{accepted, message?, executed?}`
 *   - `bridge.requestPrepareStartTurnAck`→ iOS wants to start a turn against
 *                                          a workspace/thread; returns a
 *                                          v1 ack with legacy `accepted`.
 *
 * Default policy (Phase C4 v1):
 *   - **`requestPrepareStartTurnAck`**: deny unless the allowlist holds an
 *     entry for the requested workspace, provider / approval-mode are allowed,
 *     the `startTurn` capability is present, and the entry has not expired.
 *   - **`requestActionAck`**: decode the typed `BridgeActionPayload`, reject
 *     stale/replayed actionIds, then evaluate the payload's required
 *     capability against the workspace allowlist before execution.
 *
 * Dev-mode opt-in: setting `TASKWRAITH_BRIDGE_PERMISSIVE=1` (or `true`) flips
 * the policy to accept-all. This bypasses the allowlist entirely — useful
 * for testing the round-trip with a real iOS device before any allowlist
 * entries are configured. **Never** enable in production. The console
 * logs a one-time WARN at construction so it's obvious when active.
 *
 * Three-state approval: `scope?: 'once' | 'session' | 'workspace'` is emitted
 * for approval replies. The daemon-side Swift types can ignore it and keep
 * reading `accepted`, so the contract is additive.
 */

export type BridgeActionAckScope = 'once' | 'session' | 'workspace'

export type BridgeActionAckReasonCode =
  | 'accepted'
  | 'permissiveDev'
  | 'malformedPayload'
  | 'payloadDecodeFailed'
  | 'unknownAction'
  | 'missingWorkspaceId'
  | 'allowlistUnavailable'
  | 'workspaceDenied'
  | 'capabilityDenied'
  | 'providerNotDispatchable'
  | 'ownershipDenied'
  | 'actionExpired'
  | 'actionReplayed'
  | 'approvalAlreadyResolved'
  | 'approvalDispatchFailed'
  | 'userDeclined'

export type BridgeActionAckActionKind = BridgeActionPayload['kind'] | 'prepareStartTurn'

export interface BridgeActionAckV1 {
  v: 1
  schemaVersion: 1
  accepted: boolean
  /** Stable machine-readable reason. Existing Swift keeps reading only
   * `accepted`; newer clients can branch without parsing `message`. */
  reasonCode: BridgeActionAckReasonCode
  actionKind?: BridgeActionAckActionKind
  actionId?: string
  workspaceId?: string
  threadId?: string
  runId?: string
  appRunId?: string
  providerRunId?: string
  approvalId?: string
  questionId?: string
  roundId?: string
  participantId?: string
  wakeupId?: string
  pairId?: string
  correlationId?: string
  scope?: BridgeActionAckScope
  message?: string
  executed?: boolean
  data?: Record<string, unknown>
}

export type BridgeActionAckResult = BridgeActionAckV1

export interface BridgePrepareStartTurnAckResult {
  v: 1
  schemaVersion: 1
  accepted: boolean
  reasonCode: BridgeActionAckReasonCode
  actionKind: 'prepareStartTurn'
  workspaceId?: string
  threadId?: string
  pairId?: string
  message?: string
}

export type BridgeOwnershipValidationResult =
  | { allowed: true }
  | { allowed: false; reason: string; reasonCode?: BridgeActionAckReasonCode }

export interface BridgeActionOwnershipCheck {
  pairID: string
  action: BridgeActionPayload
  actionKind: BridgeActionAckActionKind
  actionId?: string
  workspaceId: string
  threadId?: string
  runId?: string
  approvalId?: string
  questionId?: string
  roundId?: string
  participantId?: string
  wakeupId?: string
}

export interface BridgePrepareStartTurnOwnershipCheck {
  pairID: string
  workspaceId: string
  threadId?: string
  provider?: string
  approvalMode?: string
}

export interface BridgeActionOwnershipValidator {
  validateActionOwnership?: (
    check: BridgeActionOwnershipCheck
  ) => BridgeOwnershipValidationResult | Promise<BridgeOwnershipValidationResult>
  validatePrepareStartTurnOwnership?: (
    check: BridgePrepareStartTurnOwnershipCheck
  ) => BridgeOwnershipValidationResult | Promise<BridgeOwnershipValidationResult>
}

export type BridgeActionAuthorizationResolution =
  | {
      allowed: true
      workspaceId: string
      provider?: string
      approvalMode?: string
    }
  | {
      allowed: false
      reason: string
      reasonCode?: BridgeActionAckReasonCode
    }

export type BridgeActionAuthorizationResolver = (
  payload: BridgeActionPayload
) =>
  | BridgeActionAuthorizationResolution
  | null
  | Promise<BridgeActionAuthorizationResolution | null>

export interface BridgeActionRouterOptions {
  /** When true, ALL ack requests are accepted regardless of payload OR
   * allowlist state. For local end-to-end testing only — never enable in
   * production. */
  permissiveDev?: boolean
  /** Optional logger sink. Defaults to no-op; production wires
   * `console.log` so routing decisions show up in the dev terminal. */
  log?: (line: string) => void
  /** Phase C4: workspace allowlist consulted on every prepare-start-turn
   * decision. When omitted, prepare-start-turn falls back to deny-by-default
   * (same behavior as Phase C3.6). When provided, allowlist entries gate
   * which workspaces iOS may initiate turns against. */
  allowlist?: RemoteWorkspaceAllowlist
  /** Phase C-late: action executor used after policy authorization to
   * actually do the thing (cancel a run, resolve an approval, etc.).
   * Defaults to `NoopActionExecutor` so routing decisions remain stable
   * without an executor wired in (router accepts → executor declines with
   * "not yet wired" → iOS sees a clear message). */
  executor?: BridgeActionExecutor
  /** Optional seam for verifying that the target thread/run/approval/question
   * belongs to the named workspace before the store-level integration lands. */
  ownershipValidator?: BridgeActionOwnershipValidator
  /** Resolve canonical authorization fields from Mac-owned records for actions
   * that intentionally carry no client-trusted workspace/posture (workflows).
   * Returning null keeps the ordinary payload-derived path. */
  actionAuthorizationResolver?: BridgeActionAuthorizationResolver
  /** Clock injectable for stale/replay tests. */
  now?: () => number
  /** How long actionIds without an explicit expiresAt remain replay-blocked. */
  replayRetentionMs?: number
  /** Optional device-attributed audit sink for capability-gated remote actions. */
  auditLedger?: RemoteDeviceAuditLedgerWriter | null
  /** Runtime admission seam for conditionally offered providers. Additive:
   * static-live and retired continuation providers never depend on it. */
  isConditionallyDispatchableProvider?: RemoteProviderDispatchability
}

/** Error subclass the BridgeDaemonClient knows about — throwing one of these
 * surfaces a typed JSON-RPC error to the daemon side. Imported from
 * BridgeDaemonClient via a duck-typed re-throw so we don't introduce a
 * circular import; the runtime mapping there checks `instanceof
 * BridgeDaemonError`, which our throws here don't satisfy. We just throw
 * plain Error and accept the default `-32603 internalError` mapping. The
 * router never throws on policy decisions — only on unknown methods. */

/** Hard ceiling on a mutating action's accepted lifetime (security review):
 * caps how far past `now` an expiresAt may sit, so the in-memory replay cache
 * always still holds a consumed id at its expiry — bounding the post-restart
 * replay window. The phone stamps +120s; this leaves generous headroom. */
const MAX_ACTION_WINDOW_MS = 5 * 60 * 1000

export class BridgeActionRouter {
  private readonly permissiveDev: boolean
  private readonly log: (line: string) => void
  private readonly allowlist?: RemoteWorkspaceAllowlist
  private readonly executor: BridgeActionExecutor
  private readonly ownershipValidator?: BridgeActionOwnershipValidator
  private readonly actionAuthorizationResolver?: BridgeActionAuthorizationResolver
  private readonly now: () => number
  private readonly replayRetentionMs: number
  private readonly auditLedger?: RemoteDeviceAuditLedgerWriter
  private readonly isConditionallyDispatchableProvider?: RemoteProviderDispatchability
  private readonly seenActionIds = new Map<string, { seenAt: number; expiresAt: number }>()

  constructor(options: BridgeActionRouterOptions = {}) {
    this.permissiveDev = options.permissiveDev ?? false
    this.log = options.log ?? (() => {})
    this.allowlist = options.allowlist
    this.executor = options.executor ?? new NoopActionExecutor()
    this.ownershipValidator = options.ownershipValidator
    this.actionAuthorizationResolver = options.actionAuthorizationResolver
    this.now = options.now ?? (() => Date.now())
    this.replayRetentionMs = options.replayRetentionMs ?? 24 * 60 * 60 * 1000
    this.isConditionallyDispatchableProvider = options.isConditionallyDispatchableProvider
    this.auditLedger =
      options.auditLedger === undefined
        ? createDefaultRemoteDeviceAuditLedger({ log: this.log }) ?? undefined
        : options.auditLedger ?? undefined
    if (this.permissiveDev) {
      this.log(
        '[BridgeActionRouter] WARN: permissive-dev mode is ON — every iOS action ack request will be accepted'
      )
    }
  }

  /** Read env vars and construct a router. Centralizes the env-flag contract
   * so it's not scattered across main/index.ts. */
  static fromEnvironment(
    log?: (line: string) => void,
    allowlist?: RemoteWorkspaceAllowlist,
    executor?: BridgeActionExecutor,
    ownershipValidator?: BridgeActionOwnershipValidator,
    actionAuthorizationResolver?: BridgeActionAuthorizationResolver,
    auditLedger?: RemoteDeviceAuditLedgerWriter | null,
    isConditionallyDispatchableProvider?: RemoteProviderDispatchability
  ): BridgeActionRouter {
    const permissiveDev =
      process.env.TASKWRAITH_BRIDGE_PERMISSIVE === '1' ||
      process.env.TASKWRAITH_BRIDGE_PERMISSIVE === 'true'
    return new BridgeActionRouter({
      permissiveDev,
      log,
      allowlist,
      executor,
      ownershipValidator,
      actionAuthorizationResolver,
      auditLedger,
      isConditionallyDispatchableProvider
    })
  }

  private canDispatchProvider(provider: string): boolean {
    try {
      return isRemoteProviderDispatchable(provider, this.isConditionallyDispatchableProvider)
    } catch (error) {
      this.log(
        `[BridgeActionRouter] conditional provider admission failed closed for "${provider}": ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return isRemoteProviderDispatchable(provider)
    }
  }

  /** Dispatch a daemon→Electron request to the right policy method. Throws
   * for unknown methods (BridgeDaemonClient maps generic Error throws to
   * `-32603 internalError`, which the daemon's awaiter sees and falls back
   * from). */
  async route(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'bridge.requestActionAck':
        return this.handleActionAck(params)
      case 'bridge.requestPrepareStartTurnAck':
        return this.handlePrepareStartTurnAck(params)
      default:
        await this.auditRawBridgeDecision({
          pairID: pairIdFromParams(params),
          action: method || 'unknownMethod',
          decision: 'denied',
          reasonCode: 'unknownAction',
          reason: `BridgeActionRouter: no handler for method "${method}"`,
          metadata: { method: method || 'unknown' }
        })
        throw new Error(`BridgeActionRouter: no handler for method "${method}"`)
    }
  }

  private async handleActionAck(rawParams: unknown): Promise<BridgeActionAckResult> {
    const dict = isRecord(rawParams) ? rawParams : {}
    const pairID = String(dict.pairID ?? '?')
    const bytes = Number(dict.payloadBytes ?? 0)
    const payloadBase64 = typeof dict.payloadBase64 === 'string' ? dict.payloadBase64 : ''
    // The runtime injects the AUTHENTICATED requesting device identity (the
    // pinned iphoneIdentityPubKey, same trust source as pairID) so a read-only
    // device-targeted action (fullProjectionResync) can re-push to exactly the
    // requesting device. Never client-supplied — it is spread AFTER the decoded
    // dict in handleInbound.
    const requestingDeviceKey =
      typeof dict.requestingDeviceKey === 'string' ? dict.requestingDeviceKey : null

    if (this.permissiveDev) {
      await this.auditRawBridgeDecision({
        pairID,
        action: 'actionAck',
        decision: 'allowed',
        reasonCode: 'permissiveDev',
        reason: 'permissive-dev: accepted without payload inspection',
        metadata: { payloadBytes: bytes }
      })
      this.log(
        `[BridgeActionRouter] permissive-dev ACCEPT actionAck pairID=${pairID} bytes=${bytes}`
      )
      return this.buildActionAck({
        pairID,
        accepted: true,
        reasonCode: 'permissiveDev',
        scope: 'once',
        message: 'permissive-dev: accepted without payload inspection'
      })
    }

    let payload: BridgeActionPayload
    try {
      payload = decodeBridgeActionPayload(payloadBase64).payload
      // Security review: the pairID INSIDE the encrypted payload is
      // client-controlled. The runtime injects the AUTHENTICATED pairID
      // into the outer params — stamp it over the decoded action so every
      // executor (registerApnsToken's token store especially) binds to the
      // transport identity, never a claimed one.
      if (pairID && pairID !== '?') {
        ;(payload as { pairID?: string }).pairID = pairID
      }
    } catch (err) {
      if (err instanceof BridgeActionPayloadDecodeError) {
        this.log(
          `[BridgeActionRouter] DENY actionAck pairID=${pairID} malformed payload (stage=${err.stage}): ${err.message}`
        )
        await this.auditRawBridgeDecision({
          pairID,
          action: 'actionAck',
          decision: 'denied',
          reasonCode: 'malformedPayload',
          reason: `Malformed action payload (${err.stage}): ${err.message}`,
          metadata: { decodeStage: err.stage, payloadBytes: bytes }
        })
        return this.buildActionAck({
          pairID,
          accepted: false,
          reasonCode: 'malformedPayload',
          scope: 'once',
          message: `Malformed action payload (${err.stage}): ${err.message}`
        })
      }
      this.log(
        `[BridgeActionRouter] DENY actionAck pairID=${pairID} payload decode threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`
      )
      await this.auditRawBridgeDecision({
        pairID,
        action: 'actionAck',
        decision: 'denied',
        reasonCode: 'payloadDecodeFailed',
        reason: 'Action payload decode failed',
        metadata: { payloadBytes: bytes }
      })
      return this.buildActionAck({
        pairID,
        accepted: false,
        reasonCode: 'payloadDecodeFailed',
        scope: 'once',
        message: 'Action payload decode failed'
      })
    }

    if (payload.kind === 'unknown') {
      const message = `Unrecognized action kind "${payload.rawKind}" — Electron may be older than the iOS client`
      this.log(
        `[BridgeActionRouter] DENY actionAck pairID=${pairID} unknown kind="${payload.rawKind}"`
      )
      await this.auditActionDecision({
        pairID,
        payload,
        capability: null,
        decision: 'denied',
        reasonCode: 'unknownAction',
        reason: message,
        metadata: { rawKind: payload.rawKind }
      })
      return this.buildActionAck({
        pairID,
        accepted: false,
        reasonCode: 'unknownAction',
        actionKind: 'unknown',
        scope: 'once',
        message
      })
    }

    // Security review: replay/expiry controls were OPTIONAL — a mutating
    // action without an actionId skipped replay tracking entirely, and one
    // without expiresAt lived forever. Mutating actions now REQUIRE both
    // (the phone stamps them in its shared encode helper; reads stay
    // lenient for older clients).
    if (payloadIsMutating(payload)) {
      const actionId = actionIdFromPayload(payload)
      const expiresAt = expiresAtFromPayload(payload)
      if (!actionId || expiresAt === null) {
        const message =
          'Mutating actions require actionId + expiresAt (update the companion app)'
        this.log(
          `[BridgeActionRouter] DENY actionAck pairID=${pairID} kind=${payload.kind} reason="${message}"`
        )
        await this.auditActionDecision({
          pairID,
          payload,
          capability: capabilityForPayload(payload),
          decision: 'denied',
          reasonCode: 'actionExpired',
          reason: message,
          metadata: {
            missingActionId: !actionId,
            missingExpiresAt: expiresAt === null
          }
        })
        return this.buildActionAck({
          pairID,
          accepted: false,
          reasonCode: 'actionExpired',
          payload,
          scope: 'once',
          message
        })
      }
    }

    const replayGuard = await this.reserveActionId(pairID, payload)
    if (replayGuard) return replayGuard

    const dispatchContext: BridgeActionDispatchContext = { requestingDeviceKey }
    let resolvedWorkspaceId: string | undefined
    if (payloadRequiresWorkspaceGating(payload)) {
      const capability = capabilityForPayload(payload)
      let resolvedAuthorization: BridgeActionAuthorizationResolution | null = null
      if (
        this.actionAuthorizationResolver &&
        (payload.kind === 'workflowSetEnabled' || payload.kind === 'workflowRunNow')
      ) {
        try {
          resolvedAuthorization = await this.actionAuthorizationResolver(payload)
        } catch (err) {
          resolvedAuthorization = {
            allowed: false,
            reason: `Action authorization resolution failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
            reasonCode: 'ownershipDenied'
          }
        }
      }
      if (resolvedAuthorization && !resolvedAuthorization.allowed) {
        await this.auditActionDecision({
          pairID,
          payload,
          capability,
          decision: 'denied',
          reasonCode: resolvedAuthorization.reasonCode ?? 'ownershipDenied',
          reason: resolvedAuthorization.reason
        })
        return this.buildActionAck({
          pairID,
          accepted: false,
          reasonCode: resolvedAuthorization.reasonCode ?? 'ownershipDenied',
          payload,
          scope: 'once',
          message: resolvedAuthorization.reason
        })
      }
      const workspaceId = resolvedAuthorization?.allowed
        ? resolvedAuthorization.workspaceId
        : workspaceIdFromPayload(payload)
      if (workspaceId === null) {
        this.log(
          `[BridgeActionRouter] DENY actionAck pairID=${pairID} kind=${payload.kind} missing workspaceId`
        )
        await this.auditActionDecision({
          pairID,
          payload,
          capability,
          decision: 'denied',
          reasonCode: 'missingWorkspaceId',
          reason: 'Action payload is missing workspaceId'
        })
        return this.buildActionAck({
          pairID,
          accepted: false,
          reasonCode: 'missingWorkspaceId',
          payload,
          scope: 'once',
          message: 'Action payload is missing workspaceId'
        })
      }
      if (!workspaceId.trim()) {
        return this.buildActionAck({
          pairID,
          accepted: false,
          reasonCode: 'missingWorkspaceId',
          payload,
          scope: 'once',
          message: 'Resolved action authorization is missing workspaceId'
        })
      }
      resolvedWorkspaceId = workspaceId
      dispatchContext.workspaceId = workspaceId
      dispatchContext.provider = resolvedAuthorization?.allowed
        ? resolvedAuthorization.provider
        : providerFromPayload(payload)
      dispatchContext.approvalMode = resolvedAuthorization?.allowed
        ? resolvedAuthorization.approvalMode
        : approvalModeFromPayload(payload)
      // Provider dispatchability is independent from the workspace grant:
      // conditional providers must clear their live runtime gate before the
      // allowlist is consulted. Retired providers (gemini) stay admissible:
      // retirement removes the OFFER, not the ability to continue an existing
      // chat, and legacy allowlist entries legitimately still grant them.
      if (dispatchContext.provider && !this.canDispatchProvider(dispatchContext.provider)) {
        const reason = `Provider "${dispatchContext.provider}" cannot be dispatched from a paired device.`
        this.log(
          `[BridgeActionRouter] DENY actionAck pairID=${pairID} kind=${payload.kind} ws=${workspaceId} reason="${reason}"`
        )
        await this.auditActionDecision({
          pairID,
          payload,
          capability,
          decision: 'denied',
          reasonCode: 'providerNotDispatchable',
          reason,
          metadata: { workspaceId }
        })
        return this.buildActionAck({
          pairID,
          accepted: false,
          reasonCode: 'providerNotDispatchable',
          payload,
          workspaceId,
          scope: 'once',
          message: reason
        })
      }
      if (this.allowlist) {
        const decision = this.allowlist.evaluate({
          workspaceId,
          provider: dispatchContext.provider,
          approvalMode: dispatchContext.approvalMode,
          capability: capability ?? undefined
        })
        if (!decision.allowed) {
          const reasonCode =
            capability !== null && decision.reason.includes(`Capability "${capability}"`)
              ? 'capabilityDenied'
              : 'workspaceDenied'
          this.log(
            `[BridgeActionRouter] DENY actionAck pairID=${pairID} kind=${payload.kind} ws=${workspaceId} reason="${decision.reason}"`
          )
          await this.auditActionDecision({
            pairID,
            payload,
            capability,
            decision: 'denied',
            reasonCode,
            reason: decision.reason,
            metadata: { workspaceId }
          })
          return this.buildActionAck({
            pairID,
            accepted: false,
            reasonCode,
            payload,
            workspaceId,
            scope: 'once',
            message: decision.reason
          })
        }

        const ownershipDecision = await this.validateActionOwnership(pairID, payload, workspaceId)
        if (!ownershipDecision.allowed) {
          this.log(
            `[BridgeActionRouter] DENY actionAck pairID=${pairID} kind=${payload.kind} ws=${workspaceId} ownership="${ownershipDecision.reason}"`
          )
          await this.auditActionDecision({
            pairID,
            payload,
            capability,
            decision: 'denied',
            reasonCode: ownershipDecision.reasonCode ?? 'ownershipDenied',
            reason: ownershipDecision.reason,
            metadata: { workspaceId }
          })
          return this.buildActionAck({
            pairID,
            accepted: false,
            reasonCode: ownershipDecision.reasonCode ?? 'ownershipDenied',
            payload,
            workspaceId,
            scope: 'once',
            message: ownershipDecision.reason
          })
        }
      } else {
        this.log(
          `[BridgeActionRouter] DENY actionAck pairID=${pairID} kind=${payload.kind} ws=${workspaceId} — no allowlist configured`
        )
        await this.auditActionDecision({
          pairID,
          payload,
          capability,
          decision: 'denied',
          reasonCode: 'allowlistUnavailable',
          reason: 'iOS action routing not yet enabled — no workspace allowlist configured',
          metadata: { workspaceId }
        })
        return this.buildActionAck({
          pairID,
          accepted: false,
          reasonCode: 'allowlistUnavailable',
          payload,
          workspaceId,
          scope: 'once',
          message: 'iOS action routing not yet enabled — no workspace allowlist configured'
        })
      }
    } else {
      this.log(
        `[BridgeActionRouter] system action accepted pairID=${pairID} kind=${payload.kind} (workspace-gate skipped)`
      )
    }

    const dispatch = await this.dispatch(payload, dispatchContext)
    const userDeclined = dispatch.reasonCode === 'userDeclined'
    const workspaceIdForLog = resolvedWorkspaceId ?? workspaceIdFromPayload(payload) ?? 'null'
    this.log(
      `[BridgeActionRouter] ACCEPT actionAck pairID=${pairID} kind=${payload.kind} ws=${workspaceIdForLog} executed=${dispatch.executed}`
    )
    await this.auditActionDecision({
      pairID,
      payload,
      capability: capabilityForPayload(payload),
      decision: userDeclined ? 'denied' : 'allowed',
      reasonCode: userDeclined ? 'userDeclined' : (dispatch.reasonCode ?? 'accepted'),
      reason: dispatch.message || 'accepted',
      ...(resolvedWorkspaceId ? { metadata: { workspaceId: resolvedWorkspaceId } } : {})
    })
    return this.buildActionAck({
      pairID,
      accepted: true,
      reasonCode: dispatch.reasonCode ?? 'accepted',
      payload,
      workspaceId: resolvedWorkspaceId,
      message: dispatch.message,
      executed: dispatch.executed,
      data: dispatch.data
    })
  }

  /** Dispatch a policy-cleared action through the executor. The big
   * switch keeps payload-kind narrowing TypeScript-checked. */
  private async dispatch(
    payload: BridgeActionPayload,
    ctx: BridgeActionDispatchContext
  ): Promise<BridgeActionExecutionResult> {
    switch (payload.kind) {
      case 'approvalReply':
        return this.executor.executeApprovalReply(payload)
      case 'questionReply':
        return this.executor.executeQuestionReply(payload)
      case 'questionReject':
        return this.executor.executeQuestionReject(payload)
      case 'composerPrompt':
        return this.executor.executeComposerPrompt(payload)
      case 'composerQueuePrompt':
      case 'composerSchedulePrompt':
        return this.executor.executeComposerQueuePrompt(payload)
      case 'composerQueueItem':
        return this.executor.executeComposerQueueItem(payload)
      case 'createThread':
        return this.executor.executeCreateThread(payload)
      case 'threadRowExpand':
        return this.executor.executeThreadRowExpand(payload)
      case 'threadMediaFetch':
        return this.executor.executeThreadMediaFetch(payload)
      case 'threadSnapshotRequest':
        return this.executor.executeThreadSnapshotRequest(payload)
      case 'threadMessage':
        return this.executor.executeThreadMessageSend(payload)
      case 'workspaceFileList':
        return this.executor.executeWorkspaceFileList(payload)
      case 'workspaceFileRead':
        return this.executor.executeWorkspaceFileRead(payload)
      case 'workspaceFileWrite':
        return this.executor.executeWorkspaceFileWrite(payload)
      case 'workspaceFileDelete':
        return this.executor.executeWorkspaceFileDelete(payload)
      case 'workspaceDiff':
        return this.executor.executeWorkspaceDiff(payload)
      case 'gitSnapshot':
        return this.executor.executeGitSnapshot(payload)
      case 'gitStageAll':
        return this.executor.executeGitStageAll(payload)
      case 'gitStagePaths':
        return this.executor.executeGitStagePaths(payload)
      case 'gitUnstagePaths':
        return this.executor.executeGitUnstagePaths(payload)
      case 'gitCommit':
        return this.executor.executeGitCommit(payload)
      case 'gitPush':
        return this.executor.executeGitPush(payload)
      case 'gitBranches':
        return this.executor.executeGitBranches(payload)
      case 'gitCheckout':
        return this.executor.executeGitCheckout(payload)
      case 'gitCreateBranch':
        return this.executor.executeGitCreateBranch(payload)
      case 'gitCreateWorktree':
        return this.executor.executeGitCreateWorktree(payload)
      case 'githubWatchPr':
        return this.executor.executeGithubWatchPr(payload)
      case 'githubPrStatus':
        return this.executor.executeGithubPrStatus(payload)
      case 'githubPrReadiness':
        return this.executor.executeGithubPrReadiness(payload)
      case 'githubCreatePr':
        return this.executor.executeGithubCreatePr(payload)
      case 'cancelRun':
        return this.executor.executeCancelRun(payload)
      case 'workflowSetEnabled':
        return this.executor.executeWorkflowSetEnabled(payload, ctx)
      case 'workflowRunNow':
        return this.executor.executeWorkflowRunNow(payload, ctx)
      case 'ensembleCancelRound':
        return this.executor.executeEnsembleCancelRound(payload)
      case 'ensembleSkipActiveParticipant':
        return this.executor.executeEnsembleSkipActiveParticipant(payload)
      case 'ensembleWakeNow':
        return this.executor.executeEnsembleWakeNow(payload)
      case 'ensembleCancelWakeup':
        return this.executor.executeEnsembleCancelWakeup(payload)
      case 'ensembleQueuePrompt':
        return this.executor.executeEnsembleQueuePrompt(payload)
      case 'ensembleSteer':
        return this.executor.executeEnsembleSteer(payload)
      case 'ensembleRosterUpdate':
        return this.executor.executeEnsembleRosterUpdate(payload)
      case 'ensembleSettingsUpdate':
        return this.executor.executeEnsembleSettingsUpdate(payload)
      case 'ensembleQueueItem':
        return this.executor.executeEnsembleQueueItem(payload)
      case 'createSideChat':
        return this.executor.executeCreateSideChat(payload)
      case 'setThreadNotes':
        return this.executor.executeSetThreadNotes(payload)
      case 'setThreadTitle':
        return this.executor.executeSetThreadTitle(payload)
      case 'setChatKind':
        return this.executor.executeSetChatKind(payload)
      case 'goalUpdate':
        return this.executor.executeGoalUpdate(payload)
      case 'blackboardPost':
        return this.executor.executeBlackboardPost(payload)
      case 'toggleMessagePin':
        return this.executor.executeToggleMessagePin(payload)
      case 'toggleMessageFeedback':
        return this.executor.executeToggleMessageFeedback(payload)
      case 'deleteTranscriptMessage':
        return this.executor.executeDeleteTranscriptMessage(payload)
      case 'promoteCollaboratorComment':
        return this.executor.executePromoteCollaboratorComment(payload)
      case 'proposedPlanDecision':
        return this.executor.executeProposedPlanDecision(payload)
      case 'canvasAction':
        return this.executor.executeCanvasAction(payload)
      case 'registerApnsToken':
        return this.executor.executeRegisterApnsToken(payload)
      case 'registerLiveActivityToken':
        return this.executor.executeRegisterLiveActivityToken(payload)
      case 'ensemblePresetMutate':
        return this.executor.executeEnsemblePresetMutate(payload)
      case 'discoverTailnetHosts':
        return this.executor.executeDiscoverTailnetHosts(payload)
      case 'fullProjectionResync':
        return this.executor.executeFullProjectionResync(payload, ctx)
      case 'setWatchedThread':
        return this.executor.executeSetWatchedThread(payload)
      case 'setYoloMode':
        return this.executor.executeSetYoloMode(payload)
      case 'setRemoteWorkspaceAccess':
        return this.executor.executeSetRemoteWorkspaceAccess(payload)
      case 'setTrustedSession':
        return this.executor.executeSetTrustedSession(payload)
      case 'togglePinChat':
        return this.executor.executeTogglePinChat(payload)
      case 'togglePinWorkspace':
        return this.executor.executeTogglePinWorkspace(payload)
      case 'setChatArchived':
        return this.executor.executeSetChatArchived(payload)
      case 'chatMarkdownTranscript':
        return this.executor.executeChatMarkdownTranscript(payload)
      case 'chatMessageTranscript':
        return this.executor.executeChatMessageTranscript(payload)
      case 'unknown':
        // Should never reach here — `handleActionAck` denies `unknown`
        // before dispatch. Defensive fallthrough.
        return {
          executed: false,
          message: `Unknown action kind "${payload.rawKind}" reached dispatch unexpectedly`
        }
    }
  }

  private async handlePrepareStartTurnAck(
    rawParams: unknown
  ): Promise<BridgePrepareStartTurnAckResult> {
    const dict = isRecord(rawParams) ? rawParams : {}
    const pairID = String(dict.pairID ?? '?')
    const workspaceID = String(dict.workspaceID ?? '?')
    const threadID = typeof dict.threadID === 'string' ? dict.threadID : undefined
    const provider = typeof dict.provider === 'string' ? dict.provider : undefined
    const approvalMode = typeof dict.approvalMode === 'string' ? dict.approvalMode : undefined

    // Same invariant as the actionAck path, and deliberately ABOVE the
    // permissive-dev bypass: a provider outside the live-selectable and
    // retired-continuable sets is never remotely dispatchable, in any mode.
    if (provider && !this.canDispatchProvider(provider)) {
      const reason = `Provider "${provider}" cannot be dispatched from a paired device.`
      this.log(
        `[BridgeActionRouter] DENY prepareStartTurn pairID=${pairID} ws=${workspaceID} reason="${reason}"`
      )
      await this.auditPrepareStartTurnDecision({
        pairID,
        workspaceId: workspaceID,
        threadId: threadID,
        decision: 'denied',
        reasonCode: 'providerNotDispatchable',
        reason
      })
      return {
        v: 1,
        schemaVersion: 1,
        accepted: false,
        reasonCode: 'providerNotDispatchable',
        actionKind: 'prepareStartTurn',
        workspaceId: workspaceID,
        threadId: threadID,
        pairId: pairID,
        message: reason
      }
    }

    if (this.permissiveDev) {
      await this.auditPrepareStartTurnDecision({
        pairID,
        workspaceId: workspaceID,
        threadId: threadID,
        decision: 'allowed',
        reasonCode: 'permissiveDev',
        reason: 'permissive-dev: accepted without allowlist check'
      })
      this.log(
        `[BridgeActionRouter] permissive-dev ACCEPT prepareStartTurn pairID=${pairID} ws=${workspaceID}`
      )
      return {
        v: 1,
        schemaVersion: 1,
        accepted: true,
        reasonCode: 'permissiveDev',
        actionKind: 'prepareStartTurn',
        workspaceId: workspaceID,
        threadId: threadID,
        pairId: pairID,
        message: 'permissive-dev: accepted without allowlist check'
      }
    }

    if (!this.allowlist) {
      this.log(
        `[BridgeActionRouter] DENY prepareStartTurn pairID=${pairID} ws=${workspaceID} — no allowlist configured`
      )
      await this.auditPrepareStartTurnDecision({
        pairID,
        workspaceId: workspaceID,
        threadId: threadID,
        decision: 'denied',
        reasonCode: 'allowlistUnavailable',
        reason: 'iOS-initiated turns not yet enabled — no workspace allowlist configured'
      })
      return {
        v: 1,
        schemaVersion: 1,
        accepted: false,
        reasonCode: 'allowlistUnavailable',
        actionKind: 'prepareStartTurn',
        workspaceId: workspaceID,
        threadId: threadID,
        pairId: pairID,
        message: 'iOS-initiated turns not yet enabled — no workspace allowlist configured'
      }
    }

    const decision = this.allowlist.evaluate({
      workspaceId: workspaceID,
      provider,
      approvalMode,
      capability: 'startTurn'
    })
    if (decision.allowed) {
      let ownershipDecision: BridgeOwnershipValidationResult | undefined
      try {
        ownershipDecision = await this.ownershipValidator?.validatePrepareStartTurnOwnership?.({
          pairID,
          workspaceId: workspaceID,
          threadId: threadID,
          provider,
          approvalMode
        })
      } catch (err) {
        ownershipDecision = {
          allowed: false,
          reason: `Ownership validation failed: ${err instanceof Error ? err.message : String(err)}`,
          reasonCode: 'ownershipDenied'
        }
      }
      if (ownershipDecision && !ownershipDecision.allowed) {
        this.log(
          `[BridgeActionRouter] DENY prepareStartTurn pairID=${pairID} ws=${workspaceID} ownership="${ownershipDecision.reason}"`
        )
        await this.auditPrepareStartTurnDecision({
          pairID,
          workspaceId: workspaceID,
          threadId: threadID,
          decision: 'denied',
          reasonCode: ownershipDecision.reasonCode ?? 'ownershipDenied',
          reason: ownershipDecision.reason
        })
        return {
          v: 1,
          schemaVersion: 1,
          accepted: false,
          reasonCode: ownershipDecision.reasonCode ?? 'ownershipDenied',
          actionKind: 'prepareStartTurn',
          workspaceId: workspaceID,
          threadId: threadID,
          pairId: pairID,
          message: ownershipDecision.reason
        }
      }
      this.log(
        `[BridgeActionRouter] ACCEPT prepareStartTurn pairID=${pairID} ws=${workspaceID} mode=${decision.entry.mode}`
      )
      await this.auditPrepareStartTurnDecision({
        pairID,
        workspaceId: workspaceID,
        threadId: threadID,
        decision: 'allowed',
        reasonCode: 'accepted',
        reason: `Workspace "${workspaceID}" allowed (${decision.entry.mode})`
      })
      return {
        v: 1,
        schemaVersion: 1,
        accepted: true,
        reasonCode: 'accepted',
        actionKind: 'prepareStartTurn',
        workspaceId: workspaceID,
        threadId: threadID,
        pairId: pairID,
        message: `Workspace "${workspaceID}" allowed (${decision.entry.mode})`
      }
    }
    this.log(
      `[BridgeActionRouter] DENY prepareStartTurn pairID=${pairID} ws=${workspaceID} reason="${decision.reason}"`
    )
    const reasonCode = decision.reason.includes('Capability "startTurn"')
      ? 'capabilityDenied'
      : 'workspaceDenied'
    await this.auditPrepareStartTurnDecision({
      pairID,
      workspaceId: workspaceID,
      threadId: threadID,
      decision: 'denied',
      reasonCode,
      reason: decision.reason
    })
    return {
      v: 1,
      schemaVersion: 1,
      accepted: false,
      reasonCode,
      actionKind: 'prepareStartTurn',
      workspaceId: workspaceID,
      threadId: threadID,
      pairId: pairID,
      message: decision.reason
    }
  }

  private buildActionAck(input: {
    accepted: boolean
    reasonCode: BridgeActionAckReasonCode
    pairID?: string
    payload?: BridgeActionPayload
    actionKind?: BridgeActionAckActionKind
    scope?: BridgeActionAckScope
    message?: string
    executed?: boolean
    data?: Record<string, unknown>
    workspaceId?: string
  }): BridgeActionAckResult {
    const descriptor = input.payload
      ? actionAckDescriptorFromPayload(input.payload, input.data, input.workspaceId)
      : undefined
    return {
      v: 1,
      schemaVersion: 1,
      accepted: input.accepted,
      reasonCode: input.reasonCode,
      actionKind: input.actionKind ?? descriptor?.actionKind,
      actionId: descriptor?.actionId,
      workspaceId: descriptor?.workspaceId,
      threadId: descriptor?.threadId,
      runId: descriptor?.runId,
      appRunId: descriptor?.appRunId,
      providerRunId: descriptor?.providerRunId,
      approvalId: descriptor?.approvalId,
      questionId: descriptor?.questionId,
      roundId: descriptor?.roundId,
      participantId: descriptor?.participantId,
      wakeupId: descriptor?.wakeupId,
      pairId: input.pairID,
      correlationId: descriptor?.actionId,
      scope: input.scope ?? (input.payload ? scopeForPayload(input.payload) : undefined),
      message: input.message,
      executed: input.executed,
      data: input.data
    }
  }

  private async auditActionDecision(input: {
    pairID: string
    payload: BridgeActionPayload
    capability: RemoteWorkspaceCapability | null
    decision: RemoteDeviceAuditDecision
    reasonCode: BridgeActionAckReasonCode
    reason: string
    metadata?: Record<string, string | number | boolean>
  }): Promise<void> {
    if (!this.auditLedger) return
    const descriptor = actionAckDescriptorFromPayload(input.payload)
    const actionId = actionIdFromPayload(input.payload)
    const capability = input.capability ?? 'system'
    const deterministicId = actionId
      ? `remote-action:${input.pairID}:${actionId}:${capability}:${input.decision}`
      : undefined
    try {
      await this.auditLedger.append({
        ...(deterministicId ? { id: deterministicId } : {}),
        deviceId: input.pairID,
        capability,
        action: input.payload.kind,
        chatId: chatIdFromPayload(input.payload) ?? descriptor.threadId,
        decision: input.decision,
        reasonCode: input.reasonCode,
        reason: input.reason,
        metadata: {
          actionKind: input.payload.kind,
          ...(descriptor.actionId ? { actionId: descriptor.actionId } : {}),
          ...(descriptor.workspaceId ? { workspaceId: descriptor.workspaceId } : {}),
          ...(input.metadata ?? {})
        },
        timestamp: formatTimestamp(this.now())
      })
    } catch (err) {
      this.log(
        `[BridgeActionRouter] remote device audit write failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  private async auditPrepareStartTurnDecision(input: {
    pairID: string
    workspaceId: string
    threadId?: string
    decision: RemoteDeviceAuditDecision
    reasonCode: BridgeActionAckReasonCode
    reason: string
  }): Promise<void> {
    if (!this.auditLedger) return
    try {
      await this.auditLedger.append({
        deviceId: input.pairID,
        capability: 'startTurn',
        action: 'prepareStartTurn',
        chatId: input.threadId,
        decision: input.decision,
        reasonCode: input.reasonCode,
        reason: input.reason,
        metadata: { workspaceId: input.workspaceId },
        timestamp: formatTimestamp(this.now())
      })
    } catch (err) {
      this.log(
        `[BridgeActionRouter] remote device audit write failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  private async auditRawBridgeDecision(input: {
    pairID: string
    action: string
    decision: RemoteDeviceAuditDecision
    reasonCode: BridgeActionAckReasonCode
    reason: string
    metadata?: Record<string, string | number | boolean>
  }): Promise<void> {
    if (!this.auditLedger) return
    try {
      await this.auditLedger.append({
        deviceId: input.pairID,
        capability: 'system',
        action: input.action,
        decision: input.decision,
        reasonCode: input.reasonCode,
        reason: input.reason,
        metadata: input.metadata,
        timestamp: formatTimestamp(this.now())
      })
    } catch (err) {
      this.log(
        `[BridgeActionRouter] remote device audit write failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  private async reserveActionId(
    pairID: string,
    payload: BridgeActionPayload
  ): Promise<BridgeActionAckResult | null> {
    const actionId = actionIdFromPayload(payload)
    if (!actionId) return null

    const now = this.now()
    const expiresAt = expiresAtFromPayload(payload)
    // Security review (MED): the replay cache is in-memory, so a captured
    // mutating action with a far-future expiresAt would replay after a Mac
    // restart. Cap the accepted window so a consumed id is always still
    // cache-resident at its expiry (bounds the post-restart replay gap to
    // MAX_ACTION_WINDOW_MS, not the phone's unbounded choice).
    if (expiresAt !== null && expiresAt > now + MAX_ACTION_WINDOW_MS) {
      const message = `Action "${actionId}" expiry too far in the future (max ${MAX_ACTION_WINDOW_MS}ms)`
      this.log(
        `[BridgeActionRouter] DENY actionAck pairID=${pairID} kind=${payload.kind} actionId=${actionId} reason="${message}"`
      )
      await this.auditActionDecision({
        pairID,
        payload,
        capability: capabilityForPayload(payload),
        decision: 'denied',
        reasonCode: 'actionExpired',
        reason: message
      })
      return this.buildActionAck({
        pairID,
        accepted: false,
        reasonCode: 'actionExpired',
        payload,
        scope: 'once',
        message
      })
    }
    if (expiresAt !== null && expiresAt <= now) {
      const message = `Action "${actionId}" expired at ${formatTimestamp(expiresAt)}`
      this.log(
        `[BridgeActionRouter] DENY actionAck pairID=${pairID} kind=${payload.kind} actionId=${actionId} reason="${message}"`
      )
      await this.auditActionDecision({
        pairID,
        payload,
        capability: capabilityForPayload(payload),
        decision: 'denied',
        reasonCode: 'actionExpired',
        reason: message
      })
      return this.buildActionAck({
        pairID,
        accepted: false,
        reasonCode: 'actionExpired',
        payload,
        scope: 'once',
        message
      })
    }

    this.pruneReplayCache(now)
    const replayKey = `${pairID}\u0000${actionId}`
    if (this.seenActionIds.has(replayKey)) {
      const message = `Action "${actionId}" has already been processed for this paired device`
      this.log(
        `[BridgeActionRouter] DENY actionAck pairID=${pairID} kind=${payload.kind} actionId=${actionId} reason="${message}"`
      )
      await this.auditActionDecision({
        pairID,
        payload,
        capability: capabilityForPayload(payload),
        decision: 'denied',
        reasonCode: 'actionReplayed',
        reason: message
      })
      return this.buildActionAck({
        pairID,
        accepted: false,
        reasonCode: 'actionReplayed',
        payload,
        scope: 'once',
        message
      })
    }

    this.seenActionIds.set(replayKey, {
      seenAt: now,
      expiresAt: expiresAt ?? now + this.replayRetentionMs
    })
    return null
  }

  private pruneReplayCache(now: number): void {
    for (const [key, record] of this.seenActionIds) {
      if (record.expiresAt <= now) this.seenActionIds.delete(key)
    }
  }

  private async validateActionOwnership(
    pairID: string,
    payload: BridgeActionPayload,
    workspaceId: string
  ): Promise<BridgeOwnershipValidationResult> {
    const validator = this.ownershipValidator?.validateActionOwnership
    if (!validator) return { allowed: true }
    const descriptor = actionAckDescriptorFromPayload(payload)
    try {
      return await validator({
        pairID,
        action: payload,
        actionKind: payload.kind,
        actionId: descriptor.actionId,
        workspaceId,
        threadId: descriptor.threadId,
        runId: descriptor.runId,
        approvalId: descriptor.approvalId,
        questionId: descriptor.questionId,
        roundId: descriptor.roundId,
        participantId: descriptor.participantId,
        wakeupId: descriptor.wakeupId
      })
    } catch (err) {
      return {
        allowed: false,
        reason: `Ownership validation failed: ${err instanceof Error ? err.message : String(err)}`,
        reasonCode: 'ownershipDenied'
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function pairIdFromParams(params: unknown): string {
  if (!isRecord(params)) return '?'
  return String(params.pairID ?? '?')
}

function providerFromPayload(payload: BridgeActionPayload): string | undefined {
  if (payload.kind === 'setTrustedSession' && !payload.enabled) return undefined
  return 'provider' in payload && typeof payload.provider === 'string'
    ? payload.provider
    : undefined
}

// Permission presets that resolve to the `auto_edit` approval tier — auto-applied
// file/shell changes with no per-action approval. Kept in lockstep with the
// canonical DEFAULT_PERMISSION_PRESETS in EffectiveRunPermissions.ts; the parity
// test in BridgeActionRouter.test.ts fails if a new auto_edit preset is added
// without being listed here, so a future preset can't silently slip the roster
// gate below. `full_access` additionally drops the OS sandbox; `workspace_write`
// stays contained — but both auto-edit, so both must clear an auto_edit-gated
// signed run posture.
export const AUTO_EDIT_TIER_PRESET_IDS: ReadonlySet<string> = new Set([
  'workspace_write',
  'full_access'
])

export function approvalModeFromPayload(payload: BridgeActionPayload): string | undefined {
  // A composer auto-edit-tier run may carry permissionPresetId:'workspace_write'
  // or :'full_access' and resolves to auto_edit on the Mac. Gate it as auto_edit
  // here so downstream posture resolution sees the real authority tier rather
  // than a lower approvalMode such as 'default'. Downstream, full_access still
  // needs a scoped Trusted Session receipt before host sandboxing is dropped.
  if (
    'permissionPresetId' in payload &&
    typeof (payload as { permissionPresetId?: unknown }).permissionPresetId === 'string' &&
    AUTO_EDIT_TIER_PRESET_IDS.has((payload as { permissionPresetId: string }).permissionPresetId)
  ) {
    return 'auto_edit'
  }
  // An ensemble roster update carries the preset PER PARTICIPANT (participants[].
  // permissionPresetId) and has NO top-level approvalMode, so the check above
  // misses it and this payload would otherwise gate as the 'default' fallback. A
  // participant set to an auto-edit-tier preset auto-applies changes when that seat
  // runs (full_access also drops the sandbox) — the same escalation class as a
  // composer Full-access turn. Gate it identically, so a phone holding only the
  // `steer` capability on a `default`-tier workspace cannot assign an auto-edit
  // participant without the workspace explicitly permitting auto_edit. Unlike the
  // composer, the roster HONORS workspace_write too, so both auto-edit presets gate
  // here. Generic over any payload that nests participant presets — createThread
  // participants carry no preset, so they are unaffected.
  if (
    'participants' in payload &&
    Array.isArray((payload as { participants?: unknown }).participants) &&
    (payload as { participants: ReadonlyArray<{ permissionPresetId?: unknown }> }).participants.some(
      (entry) =>
        entry != null &&
        typeof entry.permissionPresetId === 'string' &&
        AUTO_EDIT_TIER_PRESET_IDS.has(entry.permissionPresetId)
    )
  ) {
    return 'auto_edit'
  }
  return 'approvalMode' in payload && typeof payload.approvalMode === 'string'
    ? payload.approvalMode
    : undefined
}

function chatIdFromPayload(payload: BridgeActionPayload): string | undefined {
  if ('threadId' in payload && typeof payload.threadId === 'string') return payload.threadId
  if (
    payload.kind === 'togglePinChat' ||
    payload.kind === 'setChatArchived' ||
    payload.kind === 'chatMarkdownTranscript' ||
    payload.kind === 'chatMessageTranscript'
  ) {
    return payload.appChatId
  }
  return undefined
}

/**
 * Note on `threadMessage`: it maps to `startTurn`, not the read-only `monitor`
 * tier the neighbouring thread fetches use — a peer message puts content into
 * another thread and can lead to a turn there.
 */
function capabilityForPayload(payload: BridgeActionPayload): RemoteWorkspaceCapability | null {
  switch (payload.kind) {
    case 'approvalReply':
    case 'questionReject':
      return 'approve'
    case 'questionReply':
      return 'answer'
    case 'composerPrompt':
    case 'composerQueuePrompt':
    case 'composerSchedulePrompt':
    case 'createThread':
    case 'threadMessage':
      return 'startTurn'
    // Full-markdown transcript is a read of already-visible thread content
    // (built by the same scrubbing desktop builder) — monitor tier, like
    // the snapshot fetches above.
    case 'threadSnapshotRequest':
    case 'threadRowExpand':
    case 'threadMediaFetch':
    case 'chatMarkdownTranscript':
    case 'chatMessageTranscript':
      return 'monitor'
    case 'workspaceFileList':
      return 'fileBrowse'
    case 'workspaceFileRead':
      return 'fileRead'
    case 'workspaceFileWrite':
    case 'workspaceFileDelete':
      return 'fileWrite'
    case 'workspaceDiff':
      return 'diffReview'
    // Git reads are the same trust tier as reviewing diffs — they reveal
    // repo state but change nothing. `gitBranches` is a plain repo read.
    // `githubWatchPr` persists a standing PR READ subscription, so it takes
    // the capability that gates the one-shot PR reads: granting `pin` alone
    // must not buy a device polling it could not otherwise perform.
    case 'gitSnapshot':
    case 'githubPrStatus':
    case 'githubPrReadiness':
    case 'gitBranches':
    case 'githubWatchPr':
      return 'diffReview'
    // Git local mutations rewrite repo state and are covered by fileWrite —
    // including `gitCheckout`, which rewrites the working tree exactly as a
    // commit does and never leaves the machine. Publishing crosses the
    // workspace boundary, so push/PR-create require externalPublish.
    case 'gitStageAll':
    case 'gitStagePaths':
    case 'gitUnstagePaths':
    case 'gitCommit':
    case 'gitCheckout':
    case 'gitCreateBranch':
    case 'gitCreateWorktree':
      return 'fileWrite'
    case 'gitPush':
    case 'githubCreatePr':
      return 'externalPublish'
    case 'cancelRun':
    case 'ensembleCancelRound':
    case 'ensembleCancelWakeup':
      return 'cancel'
    case 'workflowSetEnabled':
      return payload.enabled ? 'startTurn' : 'cancel'
    case 'workflowRunNow':
      return 'startTurn'
    case 'ensembleSkipActiveParticipant':
    case 'ensembleWakeNow':
    case 'ensembleQueuePrompt':
    case 'ensembleSteer':
    case 'ensembleRosterUpdate':
    case 'ensembleSettingsUpdate':
    case 'ensembleQueueItem':
    case 'composerQueueItem':
      return 'steer'
    // Thread annotations, guests, and side-chat management are write-class but
    // less powerful than file writes. Gate them under startTurn so the default
    // read-write entry covers them.
    case 'setThreadNotes':
    case 'setThreadTitle':
    case 'setChatKind':
    case 'goalUpdate':
    case 'blackboardPost':
    case 'toggleMessagePin':
    case 'toggleMessageFeedback':
    case 'promoteCollaboratorComment':
    case 'proposedPlanDecision':
    case 'canvasAction':
    case 'createSideChat':
    case 'setTrustedSession':
      return 'startTurn'
    // Admin-only capabilities: these are intentionally NOT included in the
    // read-write task-console default set. A workspace entry must list them
    // explicitly before a paired device can change sidebar pinning or toggle
    // session YOLO.
    case 'setYoloMode':
      return 'yolo'
    case 'deleteTranscriptMessage':
      return 'deleteMessage'
    // setChatArchived rides the same `pin` capability by Boss ruling
    // (ios-lifecycle-capability-ruling): reversible + non-destructive =
    // same organizational trust tier as pinning. Destructive delete is
    // Batch-2 behind its own default-off capability.
    case 'togglePinChat':
    case 'togglePinWorkspace':
    case 'setChatArchived':
      return 'pin'
    // Paired-device-level system actions — no workspace capability applies
    // (auth is the pair binding at the transport layer). discoverTailnetHosts
    // enumerates the tailnet on the phone's behalf; it touches no workspace.
    case 'registerApnsToken':
    case 'registerLiveActivityToken':
    case 'ensemblePresetMutate':
    case 'discoverTailnetHosts':
    case 'fullProjectionResync':
    case 'setWatchedThread':
    case 'setRemoteWorkspaceAccess':
    case 'unknown':
      return null
  }
}

function scopeForPayload(payload: BridgeActionPayload): BridgeActionAckScope {
  if (payload.kind === 'approvalReply') {
    if (payload.decision === 'acceptForSession') return 'session'
    if (payload.decision === 'acceptForWorkspace') return 'workspace'
  }
  return 'once'
}

function actionAckDescriptorFromPayload(
  payload: BridgeActionPayload,
  data?: Record<string, unknown>,
  resolvedWorkspaceId?: string
): Pick<
  BridgeActionAckV1,
  | 'actionKind'
  | 'actionId'
  | 'workspaceId'
  | 'threadId'
  | 'runId'
  | 'appRunId'
  | 'providerRunId'
  | 'approvalId'
  | 'questionId'
  | 'roundId'
  | 'participantId'
  | 'wakeupId'
> {
  const descriptor: Pick<
    BridgeActionAckV1,
    | 'actionKind'
    | 'actionId'
    | 'workspaceId'
    | 'threadId'
    | 'runId'
    | 'appRunId'
    | 'providerRunId'
    | 'approvalId'
    | 'questionId'
    | 'roundId'
    | 'participantId'
    | 'wakeupId'
  > = {
    actionKind: payload.kind,
    actionId: actionIdFromPayload(payload) ?? undefined,
    workspaceId: resolvedWorkspaceId ?? workspaceIdFromPayload(payload) ?? undefined
  }

  if ('threadId' in payload && typeof payload.threadId === 'string') {
    descriptor.threadId = payload.threadId
  }
  if (payload.kind === 'setWatchedThread' && payload.appChatId !== null) {
    descriptor.threadId = payload.appChatId
  }
  if (payload.kind === 'createSideChat') {
    const result = isRecord(data?.result) ? data.result : null
    if (typeof result?.threadId === 'string') {
      descriptor.threadId = result.threadId
    }
  }
  if (payload.kind === 'approvalReply') {
    descriptor.approvalId = payload.toolCallId
  }
  if (payload.kind === 'questionReply' || payload.kind === 'questionReject') {
    descriptor.questionId = payload.promptId
  }
  if (payload.kind === 'cancelRun') {
    descriptor.runId = payload.runId
  } else if (typeof data?.runId === 'string') {
    descriptor.runId = data.runId
  }
  if ('roundId' in payload && typeof payload.roundId === 'string') {
    descriptor.roundId = payload.roundId
  }
  if (payload.kind === 'ensembleSkipActiveParticipant') {
    descriptor.participantId = payload.participantId
  }
  if (payload.kind === 'ensembleWakeNow' || payload.kind === 'ensembleCancelWakeup') {
    descriptor.wakeupId = payload.wakeupId
  }
  if (typeof data?.appRunId === 'string') {
    descriptor.appRunId = data.appRunId
  }
  if (typeof data?.providerRunId === 'string') {
    descriptor.providerRunId = data.providerRunId
  }

  return descriptor
}

function formatTimestamp(value: number): string {
  try {
    return new Date(value).toISOString()
  } catch {
    return String(value)
  }
}
