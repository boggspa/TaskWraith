/**
 * Run-owned Simulator Canvas controller tokens (hybrid ownership fork 2C).
 *
 * Chat keeps the session/preview; mutating control requires a controller token
 * bound to {chatId, runId, ownerParticipantId?}. Tokens persist across seat
 * yields inside the same run, transfer to Boss/Captain/solo authority, and
 * release on run terminal unless transferred away.
 *
 * Wire `releaseForRun(runId)` from the composition-root run-terminal path
 * (same seam as NativeWindowCoordinator.onRunTerminal) — do not grow index.ts
 * beyond a one-line registration.
 */
import {
  resolveAppDriveEnsembleAuthority,
  type AppDriveEnsembleRoster
} from '../appDrive/AppDriveEnsembleAuthority'
import {
  AppDriveLeaseRegistry,
  type AppDriveLeaseSnapshot,
  type AppDriveLeaseTarget
} from '../appDrive/AppDriveLease'
import type {
  AppDriveActionReport,
  AppDriveObservationReceipt,
  CompleteAppDriveActionReportInput
} from '../appDrive/AppDriveSessionReport'
import { randomUUID } from 'crypto'

/** Synthetic run id for human dock control — user is always authoritative. */
export const SIMULATOR_HUMAN_CONTROLLER_RUN_ID = '__human__' as const

export type SimulatorControllerKind = 'human' | 'run'

export interface SimulatorControllerToken {
  tokenId: string
  chatId: string
  runId: string
  kind: SimulatorControllerKind
  ownerParticipantId?: string
  provider?: string
  surfaceId?: string
  leaseId?: string
  target?: AppDriveLeaseTarget
  expiresAt?: number
  stepBudget?: number
  independentVerificationRequired?: boolean
  stepsUsed?: number
  stepsRemaining?: number
  mintedAt: number
  updatedAt: number
}

export type SimulatorControllerErrorCode =
  | 'invalid_input'
  | 'conflict'
  | 'not_holder'
  | 'not_found'
  | 'authority_denied'
  | 'consent_required'
  | 'lease_expired'
  | 'step_budget_exhausted'
  | 'independent_verifier_required'

export type SimulatorControllerResult =
  | {
      ok: true
      token: SimulatorControllerToken
      driveAction?: {
        leaseId: string
        reportId: string
        actionId: string
        independentVerificationRequired: boolean
      }
    }
  | {
      ok: false
      code: SimulatorControllerErrorCode
      error: string
      holder?: SimulatorControllerToken
    }

export interface SimulatorControllerLeaseDeps {
  now?: () => number
  createId?: () => string
  appDriveLeases?: AppDriveLeaseRegistry
  onAuthorityInvalidated?: (
    token: SimulatorControllerToken,
    reason: 'expired' | 'step-budget-exhausted' | 'human-takeover' | 'run-terminal' | 'user-revoked'
  ) => void
}

export interface SimulatorControllerMintInput {
  chatId: string
  runId: string
  provider: string
  surfaceId: string
  verb: string
  ownerParticipantId?: string
  kind?: SimulatorControllerKind
  independentVerificationRequired?: boolean
}

export interface SimulatorControllerAuthorizeInput {
  chatId: string
  runId: string
  provider: string
  surfaceId: string
  verb: string
  allowedVerbs: readonly string[]
  target: AppDriveLeaseTarget
  ownerParticipantId?: string
  approvalId?: string
  approvedBy: 'user'
  expiresAt?: number
  stepBudget?: number
  independentVerificationRequired?: boolean
}

export interface SimulatorControllerTransferInput {
  chatId: string
  fromRunId: string
  toRunId: string
  toProvider: string
  toOwnerParticipantId?: string
  /** When set, target must be Boss/Captain (solo/null ensemble always allowed). */
  ensemble?: AppDriveEnsembleRoster | null
}

function requireId(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value) return null
  return value
}

function cloneToken(token: SimulatorControllerToken): SimulatorControllerToken {
  return { ...token, ...(token.target ? { target: { ...token.target } } : {}) }
}

function tokenFromLease(
  tokenId: string,
  lease: AppDriveLeaseSnapshot,
  previous?: SimulatorControllerToken
): SimulatorControllerToken {
  return {
    tokenId,
    chatId: lease.chatId,
    runId: lease.runId,
    kind: 'run',
    ...(lease.participantId ? { ownerParticipantId: lease.participantId } : {}),
    provider: lease.provider,
    surfaceId: lease.surfaceId,
    leaseId: lease.leaseId,
    target: { ...lease.target },
    expiresAt: lease.expiresAt,
    stepBudget: lease.stepBudget,
    stepsUsed: lease.stepsUsed,
    stepsRemaining: lease.stepsRemaining,
    independentVerificationRequired: lease.independentVerificationRequired,
    mintedAt: previous?.mintedAt ?? lease.approvedAt,
    updatedAt: lease.updatedAt
  }
}

function fail(
  code: SimulatorControllerErrorCode,
  error: string,
  holder?: SimulatorControllerToken
): SimulatorControllerResult {
  return holder
    ? { ok: false, code, error, holder: cloneToken(holder) }
    : { ok: false, code, error }
}

export class SimulatorControllerLease {
  private readonly now: () => number
  private readonly createId: () => string
  private readonly appDriveLeases: AppDriveLeaseRegistry
  private readonly onAuthorityInvalidated?: SimulatorControllerLeaseDeps['onAuthorityInvalidated']
  private readonly byChat = new Map<string, SimulatorControllerToken>()

  constructor(deps: SimulatorControllerLeaseDeps = {}) {
    this.now = deps.now ?? (() => Date.now())
    this.createId = deps.createId ?? (() => randomUUID())
    this.appDriveLeases = deps.appDriveLeases ?? new AppDriveLeaseRegistry({ now: this.now })
    this.onAuthorityInvalidated = deps.onAuthorityInvalidated
  }

  peek(chatId: string): SimulatorControllerToken | null {
    const id = requireId(chatId)
    if (!id) return null
    const token = this.byChat.get(id)
    if (!token) return null
    if (token.kind === 'run' && token.surfaceId) {
      const lease = this.appDriveLeases.peek(token.surfaceId)
      if (!lease || lease.status !== 'active' || lease.leaseId !== token.leaseId) {
        this.byChat.delete(id)
        this.notifyInvalidated(
          token,
          lease?.revocationReason === 'step-budget-exhausted' ? 'step-budget-exhausted' : 'expired'
        )
        return null
      }
      const refreshed = tokenFromLease(token.tokenId, lease, token)
      this.byChat.set(id, refreshed)
      return cloneToken(refreshed)
    }
    return cloneToken(token)
  }

  isValid(input: { chatId: string; tokenId: string; runId?: string }): boolean {
    const chatId = requireId(input.chatId)
    const tokenId = requireId(input.tokenId)
    if (!chatId || !tokenId) return false
    const holder = this.peek(chatId)
    if (!holder || holder.tokenId !== tokenId) return false
    if (input.runId !== undefined) {
      const runId = requireId(input.runId)
      if (!runId || holder.runId !== runId) return false
    }
    return true
  }

  /** User approval is the only path that can mint a run controller lease. */
  authorizeUserLease(input: SimulatorControllerAuthorizeInput): SimulatorControllerResult {
    const chatId = requireId(input.chatId)
    const runId = requireId(input.runId)
    const provider = requireId(input.provider)
    const surfaceId = requireId(input.surfaceId)
    if (!chatId || !runId || !provider || !surfaceId || input.approvedBy !== 'user') {
      return fail(
        'invalid_input',
        'Simulator controller authorization requires exact user-approved chat/run/provider/surface authority.'
      )
    }
    try {
      const previous = this.byChat.get(chatId)
      if (previous?.kind === 'run' && previous.surfaceId && previous.surfaceId !== surfaceId) {
        this.appDriveLeases.revokeSurface(previous.surfaceId, 'replaced')
        this.notifyInvalidated(previous, 'user-revoked')
      }
      const lease = this.appDriveLeases.authorizeUserLease({
        surfaceId,
        surfaceKind: 'simulator',
        chatId,
        runId,
        provider,
        ...(requireId(input.ownerParticipantId) ? { participantId: input.ownerParticipantId } : {}),
        approvedBy: 'user',
        ...(requireId(input.approvalId) ? { approvalId: input.approvalId } : {}),
        allowedVerbs: input.allowedVerbs,
        independentVerificationRequired: input.independentVerificationRequired === true,
        target: input.target,
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        ...(input.stepBudget !== undefined ? { stepBudget: input.stepBudget } : {})
      })
      const token = tokenFromLease(this.createId(), lease)
      this.byChat.set(chatId, token)
      return { ok: true, token: cloneToken(token) }
    } catch (error) {
      return fail('invalid_input', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Acquire and consume one step from an already user-authorized lease.
   * This method deliberately cannot mint authority from an agent call.
   */
  mint(input: SimulatorControllerMintInput): SimulatorControllerResult {
    const chatId = requireId(input.chatId)
    const runId = requireId(input.runId)
    const provider = requireId(input.provider)
    const surfaceId = requireId(input.surfaceId)
    const verb = requireId(input.verb)
    if (!chatId || !runId || !provider || !surfaceId || !verb) {
      return fail(
        'invalid_input',
        'Simulator controller acquisition requires chatId, runId, provider, surfaceId, and verb.'
      )
    }
    const kind: SimulatorControllerKind =
      input.kind ?? (runId === SIMULATOR_HUMAN_CONTROLLER_RUN_ID ? 'human' : 'run')
    if (kind === 'human' && runId !== SIMULATOR_HUMAN_CONTROLLER_RUN_ID) {
      return fail(
        'invalid_input',
        `Human controller mint must use runId ${SIMULATOR_HUMAN_CONTROLLER_RUN_ID}.`
      )
    }
    if (kind === 'human') {
      return fail('invalid_input', 'Human control must be claimed through claimHuman().')
    }
    const existing = this.peek(chatId)
    if (!existing) {
      return fail(
        'consent_required',
        'Simulator control requires a current user-approved lease for this exact device/app.'
      )
    }
    if (existing.runId !== runId || existing.surfaceId !== surfaceId) {
      return fail('conflict', 'Simulator control is bound to another run or target.', existing)
    }
    const ownerParticipantId = requireId(input.ownerParticipantId) ?? undefined
    const consumed = this.appDriveLeases.acquireAndConsume({
      surfaceId,
      surfaceKind: 'simulator',
      chatId,
      runId,
      provider,
      ...(ownerParticipantId ? { participantId: ownerParticipantId } : {}),
      verb,
      independentVerificationRequired: input.independentVerificationRequired === true
    })
    if (!consumed.ok) {
      const code =
        consumed.code === 'expired'
          ? 'lease_expired'
          : consumed.code === 'step-budget-exhausted'
            ? 'step_budget_exhausted'
            : consumed.code === 'binding-mismatch'
              ? 'not_holder'
              : consumed.code === 'independent-verifier-required'
                ? 'independent_verifier_required'
                : 'consent_required'
      if (code === 'lease_expired' || code === 'step_budget_exhausted') {
        this.byChat.delete(chatId)
        this.notifyInvalidated(
          existing,
          code === 'lease_expired' ? 'expired' : 'step-budget-exhausted'
        )
      }
      return fail(code, consumed.error, existing)
    }
    const next = tokenFromLease(existing.tokenId, consumed.lease, existing)
    this.byChat.set(chatId, next)
    return {
      ok: true,
      token: cloneToken(next),
      driveAction: {
        leaseId: consumed.lease.leaseId,
        reportId: consumed.reportId,
        actionId: consumed.actionId,
        independentVerificationRequired: consumed.independentVerificationRequired
      }
    }
  }

  completeAction(input: CompleteAppDriveActionReportInput): AppDriveActionReport {
    return this.appDriveLeases.completeAction(input)
  }

  recordObservation(input: {
    chatId: string
    runId: string
    provider: string
    participantId?: string
    surfaceId: string
    actionId?: string
  }): AppDriveObservationReceipt | null {
    return this.appDriveLeases.recordObservation({
      chatId: input.chatId,
      surfaceId: input.surfaceId,
      surfaceKind: 'simulator',
      ...(input.actionId ? { actionId: input.actionId } : {}),
      observer: {
        runId: input.runId,
        provider: input.provider,
        participantId: input.participantId ?? null
      }
    })
  }

  /**
   * Human dock claim — always authoritative; takes over any run holder.
   * Always mints a fresh tokenId so a previous agent (or prior human) token
   * cannot continue to assert control after the dock claims.
   */
  claimHuman(chatId: string): SimulatorControllerResult {
    const id = requireId(chatId)
    if (!id) return fail('invalid_input', 'Simulator human claim requires chatId.')
    const previous = this.byChat.get(id)
    this.appDriveLeases.revokeForChat(id, 'human-takeover')
    if (previous?.kind === 'run') this.notifyInvalidated(previous, 'human-takeover')
    const at = this.now()
    const token: SimulatorControllerToken = {
      tokenId: this.createId(),
      chatId: id,
      runId: SIMULATOR_HUMAN_CONTROLLER_RUN_ID,
      kind: 'human',
      mintedAt: at,
      updatedAt: at
    }
    this.byChat.set(id, token)
    return { ok: true, token: cloneToken(token) }
  }

  /**
   * Transfer control to another run. Target must be Boss/Captain when an
   * Ensemble roster is supplied (mirrors App Drive / fan-out authority).
   * Solo parent (null/absent ensemble) always allowed.
   */
  transfer(input: SimulatorControllerTransferInput): SimulatorControllerResult {
    const chatId = requireId(input.chatId)
    const fromRunId = requireId(input.fromRunId)
    const toRunId = requireId(input.toRunId)
    const toProvider = requireId(input.toProvider)
    if (!chatId || !fromRunId || !toRunId || !toProvider) {
      return fail(
        'invalid_input',
        'Simulator controller transfer requires chatId, fromRunId, toRunId, and toProvider.'
      )
    }
    if (fromRunId === toRunId) {
      return fail('invalid_input', 'Simulator controller transfer requires a different toRunId.')
    }
    const holder = this.peek(chatId)
    if (!holder) return fail('not_found', 'No Simulator controller is held for this chat.')
    if (holder.runId !== fromRunId) {
      return fail('not_holder', 'Only the holding run may transfer Simulator control.', holder)
    }

    const toOwnerParticipantId = requireId(input.toOwnerParticipantId) ?? undefined
    const authority = resolveAppDriveEnsembleAuthority({
      ensemble: input.ensemble,
      callerParticipantId: toOwnerParticipantId
    })
    if (!authority.ok) {
      return fail(
        'authority_denied',
        authority.reason.replace(/App Drive/gi, 'Simulator Canvas'),
        holder
      )
    }

    if (!holder.surfaceId) {
      return fail(
        'not_holder',
        'The holding Simulator controller has no transferable lease.',
        holder
      )
    }
    const transferredLease = this.appDriveLeases.transfer({
      surfaceId: holder.surfaceId,
      fromRunId,
      fromProvider: holder.provider || '',
      toRunId,
      toProvider,
      ...(toOwnerParticipantId ? { toParticipantId: toOwnerParticipantId } : {})
    })
    if (!transferredLease.ok) return fail('not_holder', transferredLease.error, holder)
    const next: SimulatorControllerToken = {
      ...holder,
      runId: toRunId,
      provider: transferredLease.lease.provider,
      kind: toRunId === SIMULATOR_HUMAN_CONTROLLER_RUN_ID ? 'human' : 'run',
      ...(transferredLease.lease.participantId
        ? { ownerParticipantId: transferredLease.lease.participantId }
        : { ownerParticipantId: undefined }),
      expiresAt: transferredLease.lease.expiresAt,
      stepBudget: transferredLease.lease.stepBudget,
      stepsUsed: transferredLease.lease.stepsUsed,
      stepsRemaining: transferredLease.lease.stepsRemaining,
      updatedAt: transferredLease.lease.updatedAt
    }
    // Drop undefined owner so peek clones stay tidy.
    if (!toOwnerParticipantId) delete next.ownerParticipantId
    this.byChat.set(chatId, next)
    return { ok: true, token: cloneToken(next) }
  }

  release(input: { chatId: string; runId: string }): SimulatorControllerResult {
    const chatId = requireId(input.chatId)
    const runId = requireId(input.runId)
    if (!chatId || !runId) {
      return fail('invalid_input', 'Simulator controller release requires chatId and runId.')
    }
    const holder = this.peek(chatId)
    if (!holder) return fail('not_found', 'No Simulator controller is held for this chat.')
    if (holder.runId !== runId) {
      return fail('not_holder', 'Only the holding run may release Simulator control.', holder)
    }
    this.byChat.delete(chatId)
    if (holder.surfaceId) this.appDriveLeases.revokeSurface(holder.surfaceId, 'user-revoked')
    if (holder.kind === 'run') this.notifyInvalidated(holder, 'user-revoked')
    return { ok: true, token: cloneToken(holder) }
  }

  /** Release every chat still held by this run (run-terminal path). */
  releaseForRun(runId: string): SimulatorControllerToken[] {
    const id = requireId(runId)
    if (!id) return []
    const released: SimulatorControllerToken[] = []
    for (const [chatId, token] of this.byChat) {
      if (token.runId === id) {
        released.push(cloneToken(token))
        if (token.surfaceId) this.appDriveLeases.revokeSurface(token.surfaceId, 'run-terminal')
        if (token.kind === 'run') this.notifyInvalidated(token, 'run-terminal')
        this.byChat.delete(chatId)
      }
    }
    return released
  }

  private notifyInvalidated(
    token: SimulatorControllerToken,
    reason: 'expired' | 'step-budget-exhausted' | 'human-takeover' | 'run-terminal' | 'user-revoked'
  ): void {
    try {
      this.onAuthorityInvalidated?.(cloneToken(token), reason)
    } catch {
      // Grant cleanup is idempotent; never let a diagnostic callback mutate
      // the controller lifecycle result.
    }
  }
}
