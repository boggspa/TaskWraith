import { randomUUID } from 'node:crypto'

import type { LaunchAttempt } from '../launch/types'
import {
  AppDriveSession,
  type AppDriveSessionBinding,
  type AppDriveSessionRendererStatus,
  type AppDriveSessionLifecycle
} from '../appDrive/AppDriveSession'
import {
  NativeWindowLeaseError,
  NativeWindowLeaseRegistry,
  type NativeWindowLeaseControlVerb,
  type NativeWindowLeaseExecutorContext,
  type NativeWindowLeaseOwnershipKind,
  type NativeWindowLeaseReadVerb,
  type NativeWindowLeaseRendererProjection,
  type NativeWindowLeaseRevocation,
  type NativeWindowLeaseSnapshot,
  type NativeWindowLeaseVerb
} from './NativeWindowLeaseRegistry'
import {
  ScopedAttachedWindowState,
  type ScopedAttachedWindowPick,
  type ScopedAttachedWindowRendererProjection,
  type ScopedAttachedWindowSnapshot,
  type ScopedAttachedWindowStreaming,
  type ScopedAttachedWindowStreamingUpdate
} from './ScopedAttachedWindowState'
import {
  createNativeWindowTargetOwnershipLeaseRevalidator,
  validateNativeWindowTargetOwnership,
  type NativeWindowTargetBinding,
  type NativeWindowTargetOwnershipInput
} from './NativeWindowTargetOwnership'
import type { NativeWindowProcessAncestryProof } from './NativeWindowProcessAncestry'
import type { NativeWindowProcessAncestryResolver } from './NativeWindowProcessAncestryClient'

export interface NativeWindowCoordinatorDaemon {
  status(): { running: boolean }
  request<T = unknown>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number }
  ): Promise<T>
}

export interface NativeWindowCoordinatorBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface NativeWindowCoordinatorFrameEgress {
  readonly provider: string
  readonly mayLeaveDevice: boolean
  readonly disclosure: string
}

export interface NativeWindowCoordinatorCaptureConsentRequest {
  /** Capture consent is always collected before an observation is activated. */
  readonly kind: 'capture'
  readonly chatId: string
  readonly provider: string
  readonly applicationName: string
  readonly windowTitle: string
  readonly frameEgress: NativeWindowCoordinatorFrameEgress
}

export interface NativeWindowCoordinatorControlConsentRequest {
  /** Omitted for compatibility with existing control-consent integrations. */
  readonly kind?: 'control'
  readonly chatId: string
  readonly runId: string
  readonly launchAttemptId: string
  readonly provider: string
  readonly applicationName: string
  readonly windowTitle: string
  readonly frameEgress: NativeWindowCoordinatorFrameEgress
  readonly allowedVerbs: readonly NativeWindowLeaseVerb[]
  readonly stepBudget: number
  readonly expiresInMs: number
}

export type NativeWindowCoordinatorConsentRequest =
  | NativeWindowCoordinatorCaptureConsentRequest
  | NativeWindowCoordinatorControlConsentRequest

export type NativeWindowCoordinatorConsentDecision = 'view' | 'control' | 'cancel'

export interface NativeWindowCoordinatorRendererWindow {
  readonly title: string
  readonly bundleID: string
  readonly applicationName: string
  readonly identityQuality: 'exact' | 'bestEffort'
}

export interface NativeWindowCoordinatorRendererObservation {
  readonly chatId: string
  /** Opaque version used to make stale renderer detach requests harmless. */
  readonly generation: number
  readonly attachedAt: string
  readonly window: NativeWindowCoordinatorRendererWindow
  readonly streaming?: {
    readonly fps: number
    readonly bufferSeconds: number
    readonly frameCount: number
    readonly startedAt: string
  }
}

export interface NativeWindowCoordinatorVirtualCursor {
  readonly x: number
  readonly y: number
  readonly label: string
  readonly verb: NativeWindowLeaseControlVerb
}

export type NativeWindowCoordinatorControlSessionAction = 'pause' | 'resume' | 'takeover' | 'stop'

export interface NativeWindowCoordinatorRendererControl {
  readonly chatId: string
  readonly runId: string
  readonly provider: string
  readonly participantId: string | null
  readonly launchAttemptId: string
  readonly approvedAt: number
  readonly approvedBy: 'user'
  readonly trustState: 'user-approved'
  readonly allowedVerbs: readonly NativeWindowLeaseVerb[]
  readonly expiresAt: number
  readonly stepBudget: number
  readonly stepsUsed: number
  readonly stepsRemaining: number
  readonly mode: 'foreground'
  readonly lifecycle: Exclude<AppDriveSessionLifecycle, 'idle' | 'stopped'>
  readonly canAdmitActions: boolean
  readonly virtualCursor: NativeWindowCoordinatorVirtualCursor | null
}

/**
 * Safe preload projection. It intentionally omits the daemon handle, scope id,
 * both consent epochs, process ids/start receipts/groups, bounds, and lease id.
 */
export interface NativeWindowCoordinatorRendererStatus {
  readonly pickerPending: boolean
  readonly observation: NativeWindowCoordinatorRendererObservation | null
  readonly control: NativeWindowCoordinatorRendererControl | null
  readonly warning?: string
}

export interface NativeWindowCoordinatorRendererEvent {
  readonly chatId: string
  readonly status: NativeWindowCoordinatorRendererStatus
  readonly warning?: string
}

export interface NativeWindowCoordinatorAccessParams {
  readonly handleID: string
  readonly scopeID: string
  readonly chatID: string
  readonly consentEpoch: number
  readonly generation: number
}

export interface NativeWindowCoordinatorAccessibilityTarget {
  readonly pid: number
  readonly windowID: number
  readonly bundleID: string
  readonly processLaunchTimeMicros: number
  readonly expectedBounds: NativeWindowCoordinatorBounds
}

export interface NativeWindowCoordinatorCanvasLeaseIdentity {
  readonly chatId: string
  readonly runId: string
  readonly attemptId: string
  readonly pid: number
  /** The launch process this window's authority descends from. */
  readonly expectedPid: number
  /** `descendant` when `pid` is a proved descendant of `expectedPid`. */
  readonly ownership: NativeWindowLeaseOwnershipKind
  readonly windowId: number
  readonly processStartedAt: string
  readonly instanceEpoch: string
  readonly consentEpoch: string
  readonly generation: number
}

export interface NativeWindowCoordinatorCanvasOwner {
  readonly chatId: string
  readonly runId: string
  readonly launchAttemptId: string
  readonly provider: string
  readonly participantId?: string | null
}

export interface NativeWindowCoordinatorCanvasAccess {
  readonly lease: NativeWindowCoordinatorCanvasLeaseIdentity
  readonly attachment: NativeWindowCoordinatorAccessParams
  readonly target: NativeWindowCoordinatorAccessibilityTarget
  readonly protectedHostPIDs: readonly number[]
}

export interface NativeWindowCoordinatorPickResult {
  readonly outcome: 'cancelled' | 'view' | 'control'
  readonly status: NativeWindowCoordinatorRendererStatus
  readonly warning?: string
}

export type NativeWindowCoordinatorCapability =
  | boolean
  | { readonly available: boolean; readonly reason?: string }

export interface NativeWindowCoordinatorOptions {
  instanceEpoch: string
  daemon: NativeWindowCoordinatorDaemon
  /** Screen Watch gates whether a user may start observation at all. */
  canScreenWatch: NativeWindowCoordinatorCapability | (() => NativeWindowCoordinatorCapability)
  /** AppDrive gates only the optional View & Control lease. */
  canAppDrive: NativeWindowCoordinatorCapability | (() => NativeWindowCoordinatorCapability)
  macosVersion: string
  getLaunchAttempts: () => readonly LaunchAttempt[]
  isRunActive: (chatId: string, runId: string) => boolean
  getHostProtectedPids: () => ReadonlySet<number> | readonly number[]
  /**
   * Proves that a picked window's process descends from a launch process.
   * Omitted, only an exact PID match can earn control — which is almost never
   * the app an agent just started, since the recorded PID is the spawn's direct
   * child (`npm`) and the window belongs to a descendant.
   */
  resolveProcessAncestry?: NativeWindowProcessAncestryResolver
  requestSecondConsent: (
    request: NativeWindowCoordinatorConsentRequest
  ) => Promise<NativeWindowCoordinatorConsentDecision>
  frameEgressForProvider?: (provider: string) => NativeWindowCoordinatorFrameEgress
  notifyRenderer?: (event: NativeWindowCoordinatorRendererEvent) => void
  now?: () => number
  createScopeID?: () => string
  createLeaseID?: () => string
  createControlConsentEpoch?: () => string
  controlLeaseTtlMs?: number
  controlStepBudget?: number
  pickerTimeoutMs?: number
}

export type NativeWindowCoordinatorErrorCode =
  | 'control-owner-mismatch'
  | 'daemon-unavailable'
  | 'invalid-input'
  | 'picker-already-active'
  | 'picker-protocol-mismatch'
  | 'screen-watch-unavailable'

export class NativeWindowCoordinatorError extends Error {
  constructor(
    readonly code: NativeWindowCoordinatorErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'NativeWindowCoordinatorError'
  }
}

interface PrivateAttachment {
  readonly snapshot: ScopedAttachedWindowSnapshot
}

interface CandidateControlTarget {
  readonly attachment: PrivateAttachment
  readonly attempt: LaunchAttempt
  readonly binding: NativeWindowTargetBinding
}

interface ActiveControlTarget extends CandidateControlTarget {
  readonly leaseId: string
}

interface ParsedPickResponse {
  readonly completion: {
    readonly handleID: string
    readonly scopeID: string
    readonly chatID: string
    readonly consentEpoch: number
    readonly generation: number
    readonly windowMeta: ScopedAttachedWindowSnapshot['windowMeta']
  }
}

const CONTROL_VERBS = Object.freeze<readonly NativeWindowLeaseVerb[]>([
  'observe',
  'inspect',
  'click',
  'fill'
])
const DEFAULT_CONTROL_LEASE_TTL_MS = 15 * 60 * 1000
const DEFAULT_CONTROL_STEP_BUDGET = 20
const DEFAULT_PICKER_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Electron-free lifecycle coordinator for one user-picked Screen Watch window
 * and its optional, strictly narrower AppDrive control lease.
 */
export class NativeWindowCoordinator {
  private readonly instanceEpoch: string
  private readonly daemon: NativeWindowCoordinatorDaemon
  private readonly canScreenWatch: NativeWindowCoordinatorOptions['canScreenWatch']
  private readonly canAppDrive: NativeWindowCoordinatorOptions['canAppDrive']
  private readonly macosVersion: string
  private readonly getLaunchAttempts: () => readonly LaunchAttempt[]
  private readonly isRunActive: (chatId: string, runId: string) => boolean
  private readonly getHostProtectedPids: NativeWindowCoordinatorOptions['getHostProtectedPids']
  private readonly resolveProcessAncestry?: NativeWindowProcessAncestryResolver
  /**
   * Verified descent proofs keyed by their exact endpoints. Ancestry is only
   * resolvable asynchronously, but ownership is revalidated synchronously
   * before every lease operation, so the proof is resolved once during the pick
   * and rechecked from here. A key that pins both birth receipts cannot survive
   * either process being replaced.
   */
  private readonly ancestryProofs = new Map<string, NativeWindowProcessAncestryProof>()
  private readonly requestSecondConsent: NativeWindowCoordinatorOptions['requestSecondConsent']
  private readonly frameEgressForProvider: (provider: string) => NativeWindowCoordinatorFrameEgress
  private readonly notifyRenderer?: NativeWindowCoordinatorOptions['notifyRenderer']
  private readonly now: () => number
  private readonly createControlConsentEpoch: () => string
  private readonly controlLeaseTtlMs: number
  private readonly controlStepBudget: number
  private readonly pickerTimeoutMs: number
  private readonly observationState: ScopedAttachedWindowState
  private readonly leaseRegistry: NativeWindowLeaseRegistry
  private readonly appDriveSession: AppDriveSession
  private virtualCursor: NativeWindowCoordinatorVirtualCursor | null = null

  private pendingPick: ScopedAttachedWindowPick | null = null
  private pickFlowChatId: string | null = null
  private privateAttachment: PrivateAttachment | null = null
  private candidateControlTarget: CandidateControlTarget | null = null
  private activeControlTarget: ActiveControlTarget | null = null
  private readonly warnings = new Map<string, string>()

  constructor(options: NativeWindowCoordinatorOptions) {
    if (!options || typeof options !== 'object') {
      throw new NativeWindowCoordinatorError('invalid-input', 'Coordinator options are required.')
    }
    this.instanceEpoch = requiredString(options.instanceEpoch, 'instanceEpoch')
    this.daemon = requireDaemon(options.daemon)
    this.canScreenWatch = options.canScreenWatch
    this.canAppDrive = options.canAppDrive
    this.macosVersion = requiredString(options.macosVersion, 'macosVersion')
    this.getLaunchAttempts = requiredFunction(options.getLaunchAttempts, 'getLaunchAttempts')
    this.isRunActive = requiredFunction(options.isRunActive, 'isRunActive')
    this.getHostProtectedPids = requiredFunction(
      options.getHostProtectedPids,
      'getHostProtectedPids'
    )
    this.resolveProcessAncestry =
      typeof options.resolveProcessAncestry === 'function'
        ? options.resolveProcessAncestry
        : undefined
    this.requestSecondConsent = requiredFunction(
      options.requestSecondConsent,
      'requestSecondConsent'
    )
    this.frameEgressForProvider = options.frameEgressForProvider ?? defaultFrameEgressForProvider
    this.notifyRenderer = options.notifyRenderer
    this.now = options.now ?? Date.now
    this.createControlConsentEpoch = options.createControlConsentEpoch ?? randomUUID
    this.controlLeaseTtlMs = positiveInteger(
      options.controlLeaseTtlMs ?? DEFAULT_CONTROL_LEASE_TTL_MS,
      'controlLeaseTtlMs'
    )
    this.controlStepBudget = positiveInteger(
      options.controlStepBudget ?? DEFAULT_CONTROL_STEP_BUDGET,
      'controlStepBudget'
    )
    this.pickerTimeoutMs = positiveInteger(
      options.pickerTimeoutMs ?? DEFAULT_PICKER_TIMEOUT_MS,
      'pickerTimeoutMs'
    )

    this.observationState = new ScopedAttachedWindowState({
      ...(options.createScopeID ? { createScopeID: options.createScopeID } : {}),
      now: () => new Date(this.now()).toISOString()
    })
    this.leaseRegistry = new NativeWindowLeaseRegistry({
      instanceEpoch: this.instanceEpoch,
      validateOwnership: (lease) => this.validateLeaseOwnership(lease),
      now: this.now,
      ...(options.createLeaseID ? { createLeaseId: options.createLeaseID } : {})
    })
    this.appDriveSession = new AppDriveSession({ now: this.now })
  }

  /**
   * Begin the direct-user picker flow. The selected native handle remains
   * unusable until the user explicitly grants capture consent. Exact run
   * ownership and a separate second decision are then required for control.
   */
  async pick(chatId: string): Promise<NativeWindowCoordinatorPickResult> {
    const canonicalChatId = requiredString(chatId, 'chatId')
    const screenWatchCapability = this.currentScreenWatchCapability()
    if (!screenWatchCapability.available) {
      throw new NativeWindowCoordinatorError(
        'screen-watch-unavailable',
        screenWatchCapability.reason || 'Screen Watch is unavailable on this host.'
      )
    }
    if (this.pickFlowChatId) {
      throw new NativeWindowCoordinatorError(
        'picker-already-active',
        'Another native-window picker flow is already active.'
      )
    }
    if (!this.isDaemonRunning()) {
      throw new NativeWindowCoordinatorError(
        'daemon-unavailable',
        'The native bridge daemon is not running.'
      )
    }

    this.warnings.delete(canonicalChatId)
    this.pickFlowChatId = canonicalChatId
    const pick = this.observationState.beginPick(canonicalChatId)
    this.pendingPick = pick
    const previousAttachment = this.privateAttachment

    try {
      const protectedPids = this.currentProtectedPids()
      let rawResponse: unknown
      try {
        rawResponse = await this.daemon.request(
          'attachedWindow.requestPick',
          {
            scopeID: pick.scopeID,
            chatID: pick.chatID,
            consentEpoch: pick.consentEpoch,
            protectedOwners: {
              pids: protectedPids,
              windowIDs: []
            }
          },
          { timeoutMs: this.pickerTimeoutMs }
        )
      } catch (error) {
        this.observationState.cancelPick(pick)
        this.pendingPick = null
        throw error
      }

      if (isCancelledPickResponse(rawResponse)) {
        this.observationState.cancelPick(pick)
        this.pendingPick = null
        return this.finishPick(canonicalChatId, 'cancelled')
      }
      if (!this.isDaemonRunning()) {
        await this.failClosedMalformedPick(pick, rawResponse, previousAttachment)
        throw new NativeWindowCoordinatorError(
          'daemon-unavailable',
          'The native bridge stopped during window selection.'
        )
      }

      let parsed: ParsedPickResponse
      try {
        parsed = parsePickResponse(rawResponse, pick)
      } catch (error) {
        await this.failClosedMalformedPick(pick, rawResponse, previousAttachment)
        throw error
      }

      let captureRequest: NativeWindowCoordinatorCaptureConsentRequest
      try {
        captureRequest = this.captureConsentRequest(pick, parsed)
      } catch {
        const warning =
          'Capture consent details could not be prepared; the selected window was not attached.'
        this.setWarning(canonicalChatId, warning)
        await this.discardUnconsentedPick(pick, parsed)
        return this.finishPick(canonicalChatId, 'cancelled', warning)
      }

      let captureDecision: NativeWindowCoordinatorConsentDecision
      try {
        captureDecision = await this.requestSecondConsent(captureRequest)
      } catch {
        const warning =
          'The Screen Watch capture-consent dialog could not be completed; the selected window was not attached.'
        this.setWarning(canonicalChatId, warning)
        await this.discardUnconsentedPick(pick, parsed)
        return this.finishPick(canonicalChatId, 'cancelled', warning)
      }
      if (!isCaptureConsentGranted(captureDecision)) {
        await this.discardUnconsentedPick(pick, parsed)
        return this.finishPick(canonicalChatId, 'cancelled')
      }
      if (!this.isDaemonRunning()) {
        await this.discardUnconsentedPick(pick, parsed)
        throw new NativeWindowCoordinatorError(
          'daemon-unavailable',
          'The native bridge stopped while capture consent was pending.'
        )
      }

      let completed: ReturnType<ScopedAttachedWindowState['completePick']>
      try {
        completed = this.observationState.completePick(parsed.completion)
      } catch (error) {
        await this.failClosedMalformedPick(pick, rawResponse, previousAttachment)
        throw error
      }
      this.pendingPick = null

      const nextAttachment: PrivateAttachment = Object.freeze({
        snapshot: completed.active
      })
      this.privateAttachment = nextAttachment

      const replacedControl = this.leaseRegistry.revokeActive('replaced')
      await this.handleControlRevocation(replacedControl)
      if (completed.replaced) {
        this.warnings.delete(completed.replaced.chatID)
        await this.detachDaemonAttachment(completed.replaced)
      }

      const selection = await this.findControlTarget(nextAttachment)
      if (!selection.target) {
        if (selection.warning) this.setWarning(canonicalChatId, selection.warning)
        return this.finishPick(canonicalChatId, 'view', selection.warning)
      }

      const consentRequest = this.consentRequest(selection.target)
      let decision: NativeWindowCoordinatorConsentDecision
      try {
        decision = await this.requestSecondConsent(consentRequest)
      } catch {
        const warning =
          'The native-control consent dialog could not be completed; Screen Watch remains view-only.'
        this.setWarning(canonicalChatId, warning)
        return this.finishPick(canonicalChatId, 'view', warning)
      }
      if (decision !== 'view' && decision !== 'control' && decision !== 'cancel') {
        const warning =
          'The native-control consent result was invalid; Screen Watch remains view-only.'
        this.setWarning(canonicalChatId, warning)
        return this.finishPick(canonicalChatId, 'view', warning)
      }
      if (!this.isCurrentAttachment(nextAttachment)) {
        const warning =
          'The selected window changed while consent was pending; no native-control lease was created.'
        this.setWarning(canonicalChatId, warning)
        return this.finishPick(canonicalChatId, 'view', warning)
      }
      if (decision === 'cancel') {
        await this.detach(canonicalChatId, nextAttachment.snapshot.generation)
        return this.finishPick(canonicalChatId, 'cancelled')
      }
      if (decision === 'view') {
        return this.finishPick(canonicalChatId, 'view')
      }

      const accessibility = await this.requestAccessibilityTrust()
      if (!accessibility.trusted) {
        const warning = 'Accessibility permission was not granted; Screen Watch remains view-only.'
        this.setWarning(canonicalChatId, warning)
        return this.finishPick(canonicalChatId, 'view', warning)
      }
      if (!this.isCurrentAttachment(nextAttachment)) {
        const warning =
          'The selected window changed while Accessibility permission was pending; no native-control lease was created.'
        this.setWarning(canonicalChatId, warning)
        return this.finishPick(canonicalChatId, 'view', warning)
      }

      const refreshed = await this.findControlTarget(nextAttachment)
      if (
        !refreshed.target ||
        refreshed.target.attempt.id !== selection.target.attempt.id ||
        !sameBinding(refreshed.target.binding, selection.target.binding)
      ) {
        const warning =
          'The launch/run owner changed while consent was pending; Screen Watch remains view-only.'
        this.setWarning(canonicalChatId, warning)
        return this.finishPick(canonicalChatId, 'view', warning)
      }

      const approvedAt = this.now()
      this.candidateControlTarget = refreshed.target
      try {
        const grant = this.leaseRegistry.grantOrReplace({
          instanceEpoch: this.instanceEpoch,
          chatId: refreshed.target.binding.chatId,
          runId: refreshed.target.binding.runId,
          provider: refreshed.target.attempt.provider,
          participantId: null,
          launchAttemptId: refreshed.target.binding.launchAttemptId,
          expectedPid: refreshed.target.binding.expectedPid,
          selectedPid: refreshed.target.binding.selectedPid,
          ownership: refreshed.target.binding.ownership,
          selectedProcessStartedAt: refreshed.target.binding.processStartedAt,
          windowId: refreshed.target.binding.windowId,
          windowHandleId: nextAttachment.snapshot.handleID,
          consentEpoch: requiredString(
            this.createControlConsentEpoch(),
            'generated control consent epoch'
          ),
          consentGeneration: nextAttachment.snapshot.consentEpoch,
          expiresAt: approvedAt + this.controlLeaseTtlMs,
          approvedAt,
          approvedBy: 'user',
          allowedVerbs: CONTROL_VERBS,
          stepBudget: this.controlStepBudget
        })
        this.activeControlTarget = Object.freeze({
          ...refreshed.target,
          leaseId: grant.lease.leaseId
        })
        await this.handleControlRevocation(grant.replaced)
        this.bindAppDriveSession(grant.lease, nextAttachment.snapshot)
      } finally {
        this.candidateControlTarget = null
      }

      this.warnings.delete(canonicalChatId)
      return this.finishPick(canonicalChatId, 'control')
    } finally {
      if (this.pendingPick === pick) {
        this.observationState.cancelPick(pick)
        this.pendingPick = null
      }
      if (this.pickFlowChatId === canonicalChatId) this.pickFlowChatId = null
    }
  }

  /** User detach is exact by chat plus the renderer-visible opaque generation. */
  async detach(chatId: string, generation: number): Promise<boolean> {
    const canonicalChatId = requiredString(chatId, 'chatId')
    const canonicalGeneration = positiveInteger(generation, 'generation')
    const active = this.observationState.getForChat(canonicalChatId)
    if (!active || active.generation !== canonicalGeneration) return false

    const detached = this.observationState.detach({
      chatID: canonicalChatId,
      scopeID: active.scopeID,
      generation: canonicalGeneration
    })
    if (!detached) return false

    const revocation = this.leaseRegistry.revokeActive('user-detached')
    await this.handleControlRevocation(revocation)
    if (this.privateAttachment?.snapshot === active) this.privateAttachment = null
    this.warnings.delete(canonicalChatId)
    await this.detachDaemonAttachment(detached)
    this.emitStatus(canonicalChatId)
    return true
  }

  statusForChat(chatId: string): NativeWindowCoordinatorRendererStatus {
    const canonicalChatId = requiredString(chatId, 'chatId')
    const attachment = this.observationState.getForChat(canonicalChatId)
    const leaseStatus = this.leaseRegistry.status()
    if (leaseStatus.expired) {
      const target =
        this.activeControlTarget?.leaseId === leaseStatus.expired.lease.leaseId
          ? this.activeControlTarget
          : null
      this.consumeControlRevocation(leaseStatus.expired)
      this.consumeAppDriveRevocation(leaseStatus.expired)
      void this.releaseAccessibilityTarget(leaseStatus.expired, target).catch(() => undefined)
    }
    const lease =
      leaseStatus.lease?.chatId === canonicalChatId &&
      this.activeControlTarget?.leaseId === leaseStatus.lease.leaseId
        ? leaseStatus.lease
        : null
    const warning = this.warnings.get(canonicalChatId)
    const appDriveStatus = lease ? this.currentAppDriveControlStatus(lease) : null

    return Object.freeze({
      pickerPending: this.pickFlowChatId === canonicalChatId,
      observation: attachment ? rendererObservation(attachment) : null,
      control:
        lease && appDriveStatus ? rendererControl(lease, appDriveStatus, this.virtualCursor) : null,
      ...(warning ? { warning } : {})
    })
  }

  /** Main-only observation state adapter for DesktopToolExecutors. */
  getObservationForChat(chatId: string | null | undefined): ScopedAttachedWindowSnapshot | null {
    return this.observationState.getForChat(chatId)
  }

  /** DesktopAttachedWindowState-compatible alias. */
  getForChat(chatId: string | null | undefined): ScopedAttachedWindowSnapshot | null {
    const attachment = this.observationState.getForChat(chatId)
    if (!attachment) return null

    // The protected-host set is live, not a picker-time snapshot. Every
    // DesktopToolExecutors request reads through this adapter before issuing a
    // capture and again before returning an awaited result. If a selected PID
    // becomes protected (or that supplier cannot be checked), drop the exact
    // attachment rather than let a stale Screen Watch result escape.
    try {
      if (!this.currentProtectedPids().includes(attachment.windowMeta.pid)) {
        return attachment
      }
      this.setWarning(
        attachment.chatID,
        'The attached window now belongs to a protected host process and was released.'
      )
    } catch {
      this.setWarning(
        attachment.chatID,
        'Protected host process identities could not be verified; the attached window was released.'
      )
    }
    // Revoke local authority synchronously before scheduling daemon cleanup.
    // The captured scope/generation makes this exact detach harmless if a new
    // picker result has already replaced the attachment by the time it runs.
    const cleared = this.clearExact(attachment)
    if (cleared) void this.detachDaemonAttachment(cleared)
    return null
  }

  /** Main-only observation state adapter for DesktopToolExecutors. */
  requireObservationForExecutor(chatId: string | null | undefined): ScopedAttachedWindowSnapshot {
    return this.observationState.requireForExecutor(chatId)
  }

  /** Full Swift access envelope; never expose through preload. */
  observationAccessForChat(
    chatId: string | null | undefined
  ): NativeWindowCoordinatorAccessParams | null {
    const attachment = this.observationState.getForChat(chatId)
    return attachment ? accessParams(attachment) : null
  }

  updateObservationStreaming(
    update: ScopedAttachedWindowStreamingUpdate
  ): ScopedAttachedWindowSnapshot | null {
    const updated = this.observationState.updateStreaming(update)
    if (updated) {
      this.refreshPrivateAttachment(updated)
      this.emitStatus(updated.chatID)
    }
    return updated
  }

  /**
   * DesktopAttachedWindowState-compatible exact streaming update. A stale
   * snapshot cannot update a replacement that happens to reuse a generation.
   */
  updateStreaming(
    exact: ScopedAttachedWindowSnapshot,
    streaming: ScopedAttachedWindowStreaming | null
  ): ScopedAttachedWindowSnapshot | null {
    if (!this.matchesCurrentSnapshot(exact)) return null
    const updated = this.observationState.updateStreaming({
      scopeID: exact.scopeID,
      generation: exact.generation,
      streaming
    })
    if (updated) {
      this.refreshPrivateAttachment(updated)
      this.emitStatus(updated.chatID)
    }
    return updated
  }

  /**
   * Synchronous fail-closed adapter for daemon revoked/gone errors. This clears
   * only the exact local snapshot, revokes control, and schedules AX cache
   * release without issuing a possibly cross-scope attachment detach.
   */
  clearExact(exact: ScopedAttachedWindowSnapshot): ScopedAttachedWindowSnapshot | null {
    if (!this.matchesCurrentSnapshot(exact)) return null
    const cleared = this.observationState.detach({
      chatID: exact.chatID,
      scopeID: exact.scopeID,
      generation: exact.generation
    })
    if (!cleared) return null

    const revocation = this.leaseRegistry.revokeActive('system-permission-lost')
    if (revocation) {
      const target =
        this.activeControlTarget?.leaseId === revocation.lease.leaseId
          ? this.activeControlTarget
          : null
      this.consumeControlRevocation(revocation)
      this.consumeAppDriveRevocation(revocation)
      void this.releaseAccessibilityTarget(revocation, target).catch(() => undefined)
    }
    if (this.privateAttachment?.snapshot === exact) this.privateAttachment = null
    this.emitStatus(cleared.chatID)
    return cleared
  }

  /** Safe observation-only projection expected by DesktopToolExecutors. */
  rendererProjectionForChat(
    chatId: string | null | undefined
  ): ScopedAttachedWindowRendererProjection | null {
    const snapshot = this.observationState.getForChat(chatId)
    if (!snapshot) return null
    const projection = this.observationState.status().active
    return projection?.chatID === snapshot.chatID ? projection : null
  }

  /**
   * Resolve a read lease plus the complete main-only Swift target envelope.
   * All four stable owner values are checked before returning.
   */
  resolveLeaseForCanvas(
    owner: NativeWindowCoordinatorCanvasOwner,
    verb: NativeWindowLeaseReadVerb = 'observe'
  ): NativeWindowCoordinatorCanvasAccess {
    try {
      this.assertExactCanvasOwner(owner)
      const lease = this.leaseRegistry.resolveForExecutor(this.executorContext(owner), verb)
      return this.canvasAccessForExactOwner(lease, owner)
    } catch (error) {
      this.handleRegistryError(error)
      throw error
    }
  }

  /** CanvasWindowLeaseAuthority-compatible current identity lookup. */
  currentCanvasLeaseIdentity(
    owner: NativeWindowCoordinatorCanvasOwner
  ): NativeWindowCoordinatorCanvasLeaseIdentity | null {
    try {
      return this.resolveLeaseForCanvas(owner, 'observe').lease
    } catch {
      return null
    }
  }
  /** Main-owned session lifecycle control. Stop revokes control but keeps Screen Watch attached. */
  async controlSession(
    chatId: string,
    action: NativeWindowCoordinatorControlSessionAction
  ): Promise<NativeWindowCoordinatorRendererStatus> {
    const canonicalChatId = requiredString(chatId, 'chatId')
    const status = this.appDriveSession.status()
    if (!status.chatId || status.chatId !== canonicalChatId) {
      throw new NativeWindowCoordinatorError(
        'control-owner-mismatch',
        'No Foreground Drive session is bound to this chat.'
      )
    }

    if (action === 'pause') {
      this.appDriveSession.pause()
      this.virtualCursor = null
    } else if (action === 'resume') {
      this.appDriveSession.resume()
    } else if (action === 'takeover') {
      this.appDriveSession.takeOver()
      this.virtualCursor = null
    } else if (action === 'stop') {
      this.appDriveSession.stop('user-stop')
      const revocation = this.leaseRegistry.revokeActive('user-control-stopped')
      await this.handleControlRevocation(revocation)
    } else {
      throw new NativeWindowCoordinatorError('invalid-input', 'Unknown App Drive session action.')
    }

    this.emitStatus(canonicalChatId)
    return this.statusForChat(canonicalChatId)
  }

  /** Fail-closed chrome gate before a native click/fill is admitted. */
  assertAppDriveActionAllowed(
    owner: NativeWindowCoordinatorCanvasOwner,
    verb: NativeWindowLeaseControlVerb
  ): void {
    this.assertExactCanvasOwner(owner)
    this.appDriveSession.assertCanAdmitActions(verb)
  }

  /** Record a normalized, display-only target; this never actuates or grants authority. */
  recordAppDriveActionTarget(
    owner: NativeWindowCoordinatorCanvasOwner,
    target: NativeWindowCoordinatorVirtualCursor
  ): void {
    this.assertAppDriveActionAllowed(owner, target.verb)
    if (
      !Number.isFinite(target.x) ||
      !Number.isFinite(target.y) ||
      target.x < 0 ||
      target.x > 1 ||
      target.y < 0 ||
      target.y > 1
    ) {
      throw new NativeWindowCoordinatorError(
        'invalid-input',
        'App Drive cursor coordinates must be normalized.'
      )
    }
    this.virtualCursor = Object.freeze({
      x: target.x,
      y: target.y,
      label: requiredString(target.label, 'target.label').slice(0, 300),
      verb: target.verb
    })
    this.emitStatus(owner.chatId)
  }

  /** Claim one click/fill step immediately before the corresponding Swift call. */
  consumeCanvasActionStep(
    owner: NativeWindowCoordinatorCanvasOwner,
    verb: NativeWindowLeaseControlVerb
  ): NativeWindowCoordinatorCanvasAccess {
    try {
      this.assertExactCanvasOwner(owner)
      this.appDriveSession.assertCanAdmitActions(verb)
      const grant = this.leaseRegistry.consumeControlStep(this.executorContext(owner), verb)
      this.appDriveSession.mirrorControlBudget(this.appDriveBudgetUpdate(grant.lease))
      this.emitStatus(owner.chatId)
      return this.canvasAccessForExactOwner(grant.lease, owner)
    } catch (error) {
      this.handleRegistryError(error)
      throw error
    }
  }

  async sweepExpired(): Promise<boolean> {
    const revocation = this.leaseRegistry.sweepExpired()
    if (!revocation) return false
    const chatId = revocation.lease.chatId
    await this.handleControlRevocation(revocation)
    this.emitStatus(chatId)
    return true
  }

  async onRunTerminal(chatId: string, runId: string): Promise<boolean> {
    const revocation = this.leaseRegistry.revokeForRun(
      { chatId: requiredString(chatId, 'chatId'), runId: requiredString(runId, 'runId') },
      'run-terminal'
    )
    if (!revocation) return false
    await this.handleControlRevocation(revocation)
    this.emitStatus(chatId)
    return true
  }

  async onLaunchAttemptTerminal(launchAttemptId: string): Promise<boolean> {
    const revocation = this.leaseRegistry.revokeForLaunchAttempt(
      requiredString(launchAttemptId, 'launchAttemptId'),
      'launch-terminal'
    )
    if (!revocation) return false
    await this.handleControlRevocation(revocation)
    this.emitStatus(revocation.lease.chatId)
    return true
  }

  /**
   * Revalidate the exact attempt after a LaunchManager snapshot. Missing,
   * terminal, or identity-drifted attempts revoke only control authority.
   */
  async onLaunchSnapshot(
    attempts: readonly LaunchAttempt[] = this.safeLaunchAttempts()
  ): Promise<boolean> {
    const target = this.activeControlTarget
    if (!target) return false
    const attempt = attempts.find((candidate) => candidate.id === target.binding.launchAttemptId)
    if (
      !attempt ||
      (attempt.status !== 'starting' && attempt.status !== 'running') ||
      !this.safeIsRunActive(target.binding.chatId, target.binding.runId)
    ) {
      return this.onLaunchAttemptTerminal(target.binding.launchAttemptId)
    }
    const ownership = validateNativeWindowTargetOwnership(
      this.ownershipInput(target.attachment, attempt)
    )
    if (!ownership.ok || !sameBinding(ownership.binding, target.binding)) {
      return this.onLaunchAttemptTerminal(target.binding.launchAttemptId)
    }
    try {
      this.leaseRegistry.resolveForExecutor(
        {
          instanceEpoch: this.instanceEpoch,
          chatId: target.binding.chatId,
          runId: target.binding.runId,
          provider: target.attempt.provider,
          participantId: null
        },
        'observe'
      )
      return false
    } catch (error) {
      const revocation = error instanceof NativeWindowLeaseError ? error.revocation : undefined
      if (!revocation) throw error
      await this.handleControlRevocation(revocation)
      this.emitStatus(revocation.lease.chatId)
      return true
    }
  }

  /** Daemon exit destroys both the observation resource and optional control. */
  async onDaemonGone(): Promise<void> {
    const pending = this.pendingPick
    if (pending) {
      this.observationState.cancelPick(pending)
      this.pendingPick = null
    }
    const attachment = this.observationState.clearActive()
    const revocation = this.leaseRegistry.revokeActive('daemon-stopped')
    await this.handleControlRevocation(revocation, false)
    this.privateAttachment = null
    const chatId = attachment?.chatID ?? this.pickFlowChatId
    this.pickFlowChatId = null
    if (chatId) {
      this.setWarning(chatId, 'The native bridge stopped; the attached window was released.')
      this.emitStatus(chatId)
    }
  }

  private async findControlTarget(attachment: PrivateAttachment): Promise<{
    target: CandidateControlTarget | null
    warning?: string
  }> {
    const capability = this.currentCapability()
    if (!capability.available) {
      return {
        target: null,
        warning:
          capability.reason ||
          'Native control is unavailable on this host; Screen Watch remains view-only.'
      }
    }
    if (
      attachment.snapshot.windowMeta.identityQuality !== 'exact' ||
      attachment.snapshot.windowMeta.processIdentity.source !== 'procBSDInfo' ||
      attachment.snapshot.windowMeta.pid <= 1 ||
      !attachment.snapshot.windowMeta.bundleID.trim() ||
      attachment.snapshot.windowMeta.bundleID.trim() !== attachment.snapshot.windowMeta.bundleID
    ) {
      return {
        target: null,
        warning:
          'This picker result does not have exact window, process-start, and bounds identity; Screen Watch remains view-only.'
      }
    }

    const attempts = this.safeLaunchAttempts()
    const candidates: CandidateControlTarget[] = []
    let ownershipWarning: string | undefined
    let consideredAnyAttempt = false
    for (const attempt of attempts) {
      if (
        !attempt.chatId ||
        attempt.chatId !== attachment.snapshot.chatID ||
        !attempt.runId ||
        !this.safeIsRunActive(attempt.chatId, attempt.runId)
      ) {
        continue
      }
      consideredAnyAttempt = true
      await this.cacheAncestryProof(attachment, attempt)
      const ownership = validateNativeWindowTargetOwnership(
        this.ownershipInput(attachment, attempt)
      )
      if (!ownership.ok) {
        // Record the first real reason. This used to be gated on the window's
        // PID already matching the attempt's, which meant the single most
        // common failure — a window owned by a descendant — produced no
        // warning at all and left the feature looking inert.
        ownershipWarning ??= ownership.error.message
        continue
      }
      candidates.push(
        Object.freeze({
          attachment,
          attempt,
          binding: ownership.binding
        })
      )
    }
    if (candidates.length === 1) return { target: candidates[0] }
    if (candidates.length > 1) {
      return {
        target: null,
        warning:
          'More than one active launch attempt owns the selected process; Screen Watch remains view-only.'
      }
    }
    if (ownershipWarning) {
      return { target: null, warning: `${ownershipWarning} Screen Watch remains view-only.` }
    }
    if (!consideredAnyAttempt) {
      return {
        target: null,
        warning:
          'This chat has no running launch to drive, so the selected window cannot be controlled; Screen Watch remains view-only.'
      }
    }
    return { target: null }
  }

  /**
   * Resolve and remember the descent proof for this window/launch pair.
   *
   * Failure is deliberately quiet: no proof simply means the ownership gate
   * falls back to requiring an exact PID, and it produces the refusal message.
   */
  private async cacheAncestryProof(
    attachment: PrivateAttachment,
    attempt: LaunchAttempt
  ): Promise<void> {
    const resolve = this.resolveProcessAncestry
    const window = attachment.snapshot.windowMeta
    const rootPid = attempt.pid
    const rootProcessStartedAt = attempt.processStartedAt
    if (!resolve || !rootPid || !rootProcessStartedAt) return
    if (window.pid === rootPid && window.processStartedAt === rootProcessStartedAt) return

    const key = ancestryKey(window.pid, window.processStartedAt, rootPid, rootProcessStartedAt)
    if (this.ancestryProofs.has(key)) return
    try {
      const proof = await resolve({
        leafPid: window.pid,
        leafProcessStartedAt: window.processStartedAt,
        rootPid,
        rootProcessStartedAt,
        hostProtectedPids: this.currentProtectedPids()
      })
      if (proof) this.ancestryProofs.set(key, proof)
    } catch {
      // An unavailable daemon must never widen authority, only withhold it.
    }
  }

  private ownershipInput(
    attachment: PrivateAttachment,
    attempt: LaunchAttempt
  ): NativeWindowTargetOwnershipInput {
    return {
      instanceEpoch: this.instanceEpoch,
      chatId: requiredString(attempt.chatId, 'attempt.chatId'),
      runId: requiredString(attempt.runId, 'attempt.runId'),
      launchAttemptId: attempt.id,
      macosVersion: this.macosVersion,
      hostProtectedPids: this.currentProtectedPids(),
      attempt,
      selectedWindow: {
        pid: attachment.snapshot.windowMeta.pid,
        windowId: attachment.snapshot.windowMeta.windowID,
        processStartedAt: attachment.snapshot.windowMeta.processStartedAt
      },
      ancestry:
        attempt.pid && attempt.processStartedAt
          ? (this.ancestryProofs.get(
              ancestryKey(
                attachment.snapshot.windowMeta.pid,
                attachment.snapshot.windowMeta.processStartedAt,
                attempt.pid,
                attempt.processStartedAt
              )
            ) ?? null)
          : null
    }
  }

  private validateLeaseOwnership(lease: NativeWindowLeaseSnapshot): true {
    const target =
      this.activeControlTarget?.leaseId === lease.leaseId
        ? this.activeControlTarget
        : this.candidateControlTarget
    if (!target || !this.isCurrentAttachment(target.attachment) || !this.isDaemonRunning()) {
      throw new Error('The exact attached-window target is no longer current.')
    }
    const attempt = this.safeLaunchAttempts().find(
      (candidate) => candidate.id === target.binding.launchAttemptId
    )
    if (!attempt || !this.safeIsRunActive(target.binding.chatId, target.binding.runId)) {
      throw new Error('The exact native-window run is no longer active.')
    }
    const revalidate = createNativeWindowTargetOwnershipLeaseRevalidator(target.binding, () =>
      this.ownershipInput(target.attachment, attempt)
    )
    return revalidate(lease)
  }

  private captureConsentRequest(
    pick: ScopedAttachedWindowPick,
    parsed: ParsedPickResponse
  ): NativeWindowCoordinatorCaptureConsentRequest {
    const providers = [
      ...new Set(
        this.safeLaunchAttempts()
          .filter((attempt) => {
            const runId = attempt.runId
            return (
              attempt.chatId === pick.chatID &&
              typeof runId === 'string' &&
              Boolean(runId) &&
              this.safeIsRunActive(attempt.chatId, runId)
            )
          })
          .map((attempt) => attempt.provider)
          .filter((provider) => typeof provider === 'string' && provider.trim())
      )
    ]
    const soleProvider = providers.length === 1 ? (providers[0] ?? null) : null
    const provider =
      soleProvider ??
      (providers.length > 1 ? providers.join(', ') : 'providers participating in this chat')
    const frameEgress = soleProvider
      ? freezeFrameEgress(this.frameEgressForProvider(soleProvider), soleProvider)
      : captureFrameEgressForChat(pick.chatID, provider)
    const meta = parsed.completion.windowMeta
    return Object.freeze({
      kind: 'capture',
      chatId: pick.chatID,
      provider,
      applicationName: meta.applicationName,
      windowTitle: meta.title,
      frameEgress
    })
  }

  private async discardUnconsentedPick(
    pick: ScopedAttachedWindowPick,
    parsed: ParsedPickResponse
  ): Promise<void> {
    this.observationState.cancelPick(pick)
    this.pendingPick = null
    await this.detachDaemonAccess(accessParamsFromCompletion(parsed.completion))
  }

  private consentRequest(
    target: CandidateControlTarget
  ): NativeWindowCoordinatorControlConsentRequest {
    const meta = target.attachment.snapshot.windowMeta
    return Object.freeze({
      chatId: target.binding.chatId,
      runId: target.binding.runId,
      launchAttemptId: target.binding.launchAttemptId,
      provider: target.attempt.provider,
      applicationName: meta.applicationName,
      windowTitle: meta.title,
      frameEgress: freezeFrameEgress(
        this.frameEgressForProvider(target.attempt.provider),
        target.attempt.provider
      ),
      allowedVerbs: CONTROL_VERBS,
      stepBudget: this.controlStepBudget,
      expiresInMs: this.controlLeaseTtlMs
    })
  }

  private async requestAccessibilityTrust(): Promise<{ trusted: boolean }> {
    try {
      const response = await this.daemon.request<unknown>('nativeWindow.requestAccessibility', {})
      const candidate = asRecord(response)
      return { trusted: candidate?.trusted === true }
    } catch {
      return { trusted: false }
    }
  }

  private canvasAccessForExactOwner(
    lease: NativeWindowLeaseSnapshot,
    owner: NativeWindowCoordinatorCanvasOwner
  ): NativeWindowCoordinatorCanvasAccess {
    const target = this.activeControlTarget
    if (
      !target ||
      target.leaseId !== lease.leaseId ||
      lease.launchAttemptId !== requiredString(owner.launchAttemptId, 'launchAttemptId') ||
      lease.provider !== requiredString(owner.provider, 'provider')
    ) {
      throw new NativeWindowCoordinatorError(
        'control-owner-mismatch',
        'The native-window lease does not match this Canvas owner.'
      )
    }
    const processIdentity = target.attachment.snapshot.windowMeta.processIdentity
    const canvasLease: NativeWindowCoordinatorCanvasLeaseIdentity = Object.freeze({
      chatId: lease.chatId,
      runId: lease.runId,
      attemptId: lease.launchAttemptId,
      pid: lease.selectedPid,
      expectedPid: lease.expectedPid,
      ownership: lease.ownership,
      windowId: lease.windowId,
      processStartedAt: lease.selectedProcessStartedAt,
      instanceEpoch: lease.instanceEpoch,
      consentEpoch: lease.consentEpoch,
      generation: target.attachment.snapshot.generation
    })
    const accessibilityTarget: NativeWindowCoordinatorAccessibilityTarget = Object.freeze({
      pid: lease.selectedPid,
      windowID: lease.windowId,
      bundleID: target.attachment.snapshot.windowMeta.bundleID,
      processLaunchTimeMicros: processIdentity.launchTimeMicros,
      expectedBounds: target.attachment.snapshot.windowMeta.bounds
    })
    return Object.freeze({
      lease: canvasLease,
      attachment: accessParams(target.attachment.snapshot),
      target: accessibilityTarget,
      protectedHostPIDs: Object.freeze(this.currentProtectedPids())
    })
  }

  private executorContext(
    owner: NativeWindowCoordinatorCanvasOwner
  ): NativeWindowLeaseExecutorContext {
    return {
      instanceEpoch: this.instanceEpoch,
      chatId: requiredString(owner?.chatId, 'chatId'),
      runId: requiredString(owner?.runId, 'runId'),
      provider: requiredString(owner?.provider, 'provider'),
      participantId: owner?.participantId ?? null
    }
  }

  private assertExactCanvasOwner(owner: NativeWindowCoordinatorCanvasOwner): void {
    const target = this.activeControlTarget
    const chatId = requiredString(owner?.chatId, 'chatId')
    const runId = requiredString(owner?.runId, 'runId')
    const launchAttemptId = requiredString(owner?.launchAttemptId, 'launchAttemptId')
    const provider = requiredString(owner?.provider, 'provider')
    if (
      !target ||
      target.binding.chatId !== chatId ||
      target.binding.runId !== runId ||
      target.binding.launchAttemptId !== launchAttemptId ||
      target.attempt.provider !== provider ||
      (owner?.participantId ?? null) !== null
    ) {
      throw new NativeWindowCoordinatorError(
        'control-owner-mismatch',
        'The native-window lease does not match this Canvas owner.'
      )
    }
  }

  private async failClosedMalformedPick(
    pick: ScopedAttachedWindowPick,
    rawResponse: unknown,
    previousAttachment: PrivateAttachment | null
  ): Promise<void> {
    this.observationState.cancelPick(pick)
    this.pendingPick = null
    const cleared = this.observationState.clearActive()
    const revocation = this.leaseRegistry.revokeActive('ownership-invalid')
    await this.handleControlRevocation(revocation)
    this.privateAttachment = null

    const candidate = cleanupAccessFromResponse(rawResponse, pick)
    if (candidate) await this.detachDaemonAccess(candidate)
    if (cleared) await this.detachDaemonAttachment(cleared)
    else if (previousAttachment) await this.detachDaemonAttachment(previousAttachment.snapshot)
  }

  private async handleControlRevocation(
    revocation: NativeWindowLeaseRevocation | null | undefined,
    release = true
  ): Promise<void> {
    if (!revocation) return
    const target =
      this.activeControlTarget?.leaseId === revocation.lease.leaseId
        ? this.activeControlTarget
        : null
    this.consumeControlRevocation(revocation)
    this.consumeAppDriveRevocation(revocation)
    if (release) await this.releaseAccessibilityTarget(revocation, target)
  }

  private consumeControlRevocation(revocation: NativeWindowLeaseRevocation): void {
    if (this.activeControlTarget?.leaseId === revocation.lease.leaseId) {
      this.activeControlTarget = null
      this.virtualCursor = null
    }
  }
  private consumeAppDriveRevocation(revocation: NativeWindowLeaseRevocation): void {
    const status = this.appDriveSession.status()
    if (
      status.chatId !== revocation.lease.chatId ||
      status.runId !== revocation.lease.runId ||
      status.launchAttemptId !== revocation.lease.launchAttemptId
    ) {
      return
    }
    if (status.lifecycle !== 'stopped') {
      this.appDriveSession.stop(appDriveStopReason(revocation.reason))
    }
    this.appDriveSession.clearStopped()
  }

  private bindAppDriveSession(
    lease: NativeWindowLeaseSnapshot,
    attachment: ScopedAttachedWindowSnapshot
  ): void {
    const binding: AppDriveSessionBinding = {
      chatId: lease.chatId,
      runId: lease.runId,
      provider: lease.provider || 'unknown',
      launchAttemptId: lease.launchAttemptId,
      approvedAt: lease.approvedAt,
      allowedVerbs: lease.allowedVerbs,
      expiresAt: lease.expiresAt,
      stepBudget: lease.stepBudget,
      stepsUsed: lease.stepsUsed,
      target: {
        applicationName: attachment.windowMeta.applicationName,
        windowTitle: attachment.windowMeta.title,
        bundleID: attachment.windowMeta.bundleID
      }
    }
    this.appDriveSession.bind(binding)
    this.virtualCursor = null
  }

  private appDriveBudgetUpdate(
    lease: Pick<
      NativeWindowLeaseSnapshot | NativeWindowLeaseRendererProjection,
      'chatId' | 'runId' | 'launchAttemptId' | 'expiresAt' | 'stepBudget' | 'stepsUsed'
    >
  ): Parameters<AppDriveSession['mirrorControlBudget']>[0] {
    return {
      chatId: lease.chatId,
      runId: lease.runId,
      launchAttemptId: lease.launchAttemptId,
      expiresAt: lease.expiresAt,
      stepBudget: lease.stepBudget,
      stepsUsed: lease.stepsUsed
    }
  }

  private currentAppDriveControlStatus(
    lease: NativeWindowLeaseRendererProjection
  ): AppDriveSessionRendererStatus | null {
    try {
      this.appDriveSession.mirrorControlBudget(this.appDriveBudgetUpdate(lease))
      const status = this.appDriveSession.status()
      if (
        status.chatId !== lease.chatId ||
        status.runId !== lease.runId ||
        status.launchAttemptId !== lease.launchAttemptId ||
        (status.lifecycle !== 'active' &&
          status.lifecycle !== 'paused' &&
          status.lifecycle !== 'takeover')
      ) {
        return null
      }
      return status
    } catch {
      return null
    }
  }

  private handleRegistryError(error: unknown): void {
    if (!(error instanceof NativeWindowLeaseError) || !error.revocation) return
    const target =
      this.activeControlTarget?.leaseId === error.revocation.lease.leaseId
        ? this.activeControlTarget
        : null
    this.consumeControlRevocation(error.revocation)
    this.consumeAppDriveRevocation(error.revocation)
    void this.releaseAccessibilityTarget(error.revocation, target).catch(() => undefined)
    this.emitStatus(error.revocation.lease.chatId)
  }

  private async releaseAccessibilityTarget(
    revocation: NativeWindowLeaseRevocation,
    target: ActiveControlTarget | null
  ): Promise<void> {
    const attachment = target?.attachment
    if (
      !attachment ||
      attachment.snapshot.handleID !== revocation.lease.windowHandleId ||
      !this.isDaemonRunning()
    ) {
      return
    }
    try {
      await this.daemon.request('nativeWindow.release', accessParams(attachment.snapshot))
    } catch {
      // Control is already revoked in main. Cleanup is best effort.
    }
  }

  private async detachDaemonAttachment(snapshot: ScopedAttachedWindowSnapshot): Promise<void> {
    await this.detachDaemonAccess(accessParams(snapshot))
  }

  private async detachDaemonAccess(params: NativeWindowCoordinatorAccessParams): Promise<void> {
    if (!this.isDaemonRunning()) return
    try {
      await this.daemon.request('attachedWindow.detach', params)
    } catch {
      // Main has already revoked local authority; stale daemon cleanup is harmless.
    }
  }

  private currentCapability(): { available: boolean; reason?: string } {
    let value: NativeWindowCoordinatorCapability
    try {
      value = typeof this.canAppDrive === 'function' ? this.canAppDrive() : this.canAppDrive
    } catch {
      return { available: false, reason: 'AppDrive capability could not be verified.' }
    }
    if (typeof value === 'boolean') return { available: value }
    if (!value || typeof value !== 'object' || typeof value.available !== 'boolean') {
      return { available: false, reason: 'AppDrive capability could not be verified.' }
    }
    return {
      available: value.available,
      ...(typeof value.reason === 'string' && value.reason ? { reason: value.reason } : {})
    }
  }

  private currentScreenWatchCapability(): { available: boolean; reason?: string } {
    let value: NativeWindowCoordinatorCapability
    try {
      value =
        typeof this.canScreenWatch === 'function' ? this.canScreenWatch() : this.canScreenWatch
    } catch {
      return { available: false, reason: 'Screen Watch capability could not be verified.' }
    }
    if (typeof value === 'boolean') return { available: value }
    if (!value || typeof value !== 'object' || typeof value.available !== 'boolean') {
      return { available: false, reason: 'Screen Watch capability could not be verified.' }
    }
    return {
      available: value.available,
      ...(typeof value.reason === 'string' && value.reason ? { reason: value.reason } : {})
    }
  }

  private currentProtectedPids(): number[] {
    let values: ReadonlySet<number> | readonly number[]
    try {
      values = this.getHostProtectedPids()
    } catch {
      throw new NativeWindowCoordinatorError(
        'invalid-input',
        'Protected host process identities are unavailable.'
      )
    }
    const pids = Array.from(values)
    if (pids.length === 0 || pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) {
      throw new NativeWindowCoordinatorError(
        'invalid-input',
        'Protected host process identities must contain positive PIDs.'
      )
    }
    return [...new Set(pids)].sort((left, right) => left - right)
  }

  private safeLaunchAttempts(): readonly LaunchAttempt[] {
    try {
      const attempts = this.getLaunchAttempts()
      return Array.isArray(attempts) ? attempts : []
    } catch {
      return []
    }
  }

  private safeIsRunActive(chatId: string, runId: string): boolean {
    try {
      return this.isRunActive(chatId, runId) === true
    } catch {
      return false
    }
  }

  private isCurrentAttachment(candidate: PrivateAttachment): boolean {
    return (
      this.privateAttachment === candidate &&
      this.observationState.getForChat(candidate.snapshot.chatID) === candidate.snapshot &&
      this.isDaemonRunning()
    )
  }

  private matchesCurrentSnapshot(candidate: ScopedAttachedWindowSnapshot): boolean {
    const current = this.observationState.getForChat(candidate?.chatID)
    return Boolean(
      current &&
      current === candidate &&
      current.handleID === candidate.handleID &&
      current.scopeID === candidate.scopeID &&
      current.consentEpoch === candidate.consentEpoch &&
      current.generation === candidate.generation
    )
  }

  private refreshPrivateAttachment(updated: ScopedAttachedWindowSnapshot): void {
    const previous = this.privateAttachment
    if (
      !previous ||
      previous.snapshot.scopeID !== updated.scopeID ||
      previous.snapshot.generation !== updated.generation
    ) {
      return
    }
    const next: PrivateAttachment = Object.freeze({ snapshot: updated })
    this.privateAttachment = next
    if (this.candidateControlTarget?.attachment === previous) {
      this.candidateControlTarget = Object.freeze({
        ...this.candidateControlTarget,
        attachment: next
      })
    }
    if (this.activeControlTarget?.attachment === previous) {
      this.activeControlTarget = Object.freeze({
        ...this.activeControlTarget,
        attachment: next
      })
    }
  }

  private isDaemonRunning(): boolean {
    try {
      return this.daemon.status().running === true
    } catch {
      return false
    }
  }

  private setWarning(chatId: string, warning: string): void {
    this.warnings.set(chatId, warning)
  }

  private finishPick(
    chatId: string,
    outcome: NativeWindowCoordinatorPickResult['outcome'],
    warning?: string
  ): NativeWindowCoordinatorPickResult {
    if (this.pickFlowChatId === chatId) this.pickFlowChatId = null
    const status = this.statusForChat(chatId)
    this.emitStatus(chatId, warning)
    return Object.freeze({
      outcome,
      status,
      ...(warning ? { warning } : {})
    })
  }

  private emitStatus(chatId: string, warning?: string): void {
    if (!this.notifyRenderer) return
    try {
      const status = this.statusForChat(chatId)
      this.notifyRenderer(
        Object.freeze({
          chatId,
          status,
          ...(warning ? { warning } : {})
        })
      )
    } catch {
      // Renderer notification is a projection side effect, never authority.
    }
  }
}

function parsePickResponse(value: unknown, pick: ScopedAttachedWindowPick): ParsedPickResponse {
  const response = asRecord(value)
  if (
    !response ||
    response.ok !== true ||
    response.scopeID !== pick.scopeID ||
    response.chatID !== pick.chatID ||
    response.consentEpoch !== pick.consentEpoch
  ) {
    throw new NativeWindowCoordinatorError(
      'picker-protocol-mismatch',
      'The native picker did not echo the exact main-issued scope.'
    )
  }
  const handleID = requiredString(response.handleID, 'picker handleID')
  const generation = positiveInteger(response.generation, 'picker generation')
  const windowMeta = asRecord(response.windowMeta)
  if (!windowMeta) {
    throw new NativeWindowCoordinatorError(
      'picker-protocol-mismatch',
      'The native picker returned no window metadata.'
    )
  }

  return Object.freeze({
    completion: {
      handleID,
      scopeID: pick.scopeID,
      chatID: pick.chatID,
      consentEpoch: pick.consentEpoch,
      generation,
      windowMeta: windowMeta as unknown as ScopedAttachedWindowSnapshot['windowMeta']
    }
  })
}

function cleanupAccessFromResponse(
  value: unknown,
  pick: ScopedAttachedWindowPick
): NativeWindowCoordinatorAccessParams | null {
  const response = asRecord(value)
  if (
    !response ||
    response.scopeID !== pick.scopeID ||
    response.chatID !== pick.chatID ||
    response.consentEpoch !== pick.consentEpoch ||
    typeof response.handleID !== 'string' ||
    !response.handleID.trim() ||
    !Number.isSafeInteger(response.generation) ||
    Number(response.generation) <= 0
  ) {
    return null
  }
  return {
    handleID: response.handleID,
    scopeID: pick.scopeID,
    chatID: pick.chatID,
    consentEpoch: pick.consentEpoch,
    generation: Number(response.generation)
  }
}

function accessParams(snapshot: ScopedAttachedWindowSnapshot): NativeWindowCoordinatorAccessParams {
  return Object.freeze({
    handleID: snapshot.handleID,
    scopeID: snapshot.scopeID,
    chatID: snapshot.chatID,
    consentEpoch: snapshot.consentEpoch,
    generation: snapshot.generation
  })
}

function accessParamsFromCompletion(
  completion: ParsedPickResponse['completion']
): NativeWindowCoordinatorAccessParams {
  return Object.freeze({
    handleID: completion.handleID,
    scopeID: completion.scopeID,
    chatID: completion.chatID,
    consentEpoch: completion.consentEpoch,
    generation: completion.generation
  })
}

function isCaptureConsentGranted(decision: NativeWindowCoordinatorConsentDecision): boolean {
  // Existing integrations use the same callback for capture and control. The
  // capture dialog returns `view`; accepting `control` here preserves a
  // conservative compatibility path for integrations that predate the
  // capture/control distinction. Neither value grants control by itself.
  return decision === 'view' || decision === 'control'
}

function rendererObservation(
  snapshot: ScopedAttachedWindowSnapshot
): NativeWindowCoordinatorRendererObservation {
  const window: NativeWindowCoordinatorRendererWindow = Object.freeze({
    title: snapshot.windowMeta.title,
    bundleID: snapshot.windowMeta.bundleID,
    applicationName: snapshot.windowMeta.applicationName,
    identityQuality: snapshot.windowMeta.identityQuality
  })
  return Object.freeze({
    chatId: snapshot.chatID,
    generation: snapshot.generation,
    attachedAt: snapshot.attachedAt,
    window,
    ...(snapshot.streaming ? { streaming: snapshot.streaming } : {})
  })
}

function rendererControl(
  lease: NativeWindowLeaseRendererProjection,
  session: AppDriveSessionRendererStatus,
  virtualCursor: NativeWindowCoordinatorVirtualCursor | null
): NativeWindowCoordinatorRendererControl {
  return Object.freeze({
    chatId: lease.chatId,
    runId: lease.runId,
    provider: lease.provider || 'unknown',
    participantId: lease.participantId,
    launchAttemptId: lease.launchAttemptId,
    approvedAt: lease.approvedAt,
    approvedBy: lease.approvedBy,
    trustState: lease.trustState,
    allowedVerbs: Object.freeze([...lease.allowedVerbs]),
    expiresAt: lease.expiresAt,
    stepBudget: lease.stepBudget,
    stepsUsed: lease.stepsUsed,
    stepsRemaining: lease.stepsRemaining,
    mode: 'foreground',
    lifecycle: session.lifecycle as Exclude<AppDriveSessionLifecycle, 'idle' | 'stopped'>,
    canAdmitActions: session.canAdmitActions,
    virtualCursor
  })
}

function appDriveStopReason(reason: NativeWindowLeaseRevocation['reason']) {
  if (reason === 'user-control-stopped') return 'user-stop' as const
  if (reason === 'user-detached') return 'user-detach' as const
  if (reason === 'expired') return 'expired' as const
  if (reason === 'replaced') return 'replaced' as const
  return 'binding-cleared' as const
}

function freezeFrameEgress(
  value: NativeWindowCoordinatorFrameEgress,
  expectedProvider: string
): NativeWindowCoordinatorFrameEgress {
  if (!value || typeof value !== 'object') {
    throw new NativeWindowCoordinatorError(
      'invalid-input',
      'Frame-egress consent metadata is unavailable.'
    )
  }
  const provider = requiredString(value.provider, 'frameEgress.provider')
  if (provider !== expectedProvider || typeof value.mayLeaveDevice !== 'boolean') {
    throw new NativeWindowCoordinatorError(
      'invalid-input',
      'Frame-egress consent metadata does not match the active provider.'
    )
  }
  return Object.freeze({
    provider,
    mayLeaveDevice: value.mayLeaveDevice,
    disclosure: requiredString(value.disclosure, 'frameEgress.disclosure')
  })
}

function defaultFrameEgressForProvider(provider: string): NativeWindowCoordinatorFrameEgress {
  return {
    provider,
    mayLeaveDevice: true,
    disclosure:
      `Window frames and accessibility metadata become available to the ${provider} run ` +
      'and may leave this device when that provider is hosted.'
  }
}

function captureFrameEgressForChat(
  chatId: string,
  provider: string
): NativeWindowCoordinatorFrameEgress {
  return Object.freeze({
    provider,
    mayLeaveDevice: true,
    disclosure:
      `Window frames are scoped to chat “${chatId}” and may leave this device ` +
      'when a participating provider is hosted.'
  })
}

function sameBinding(left: NativeWindowTargetBinding, right: NativeWindowTargetBinding): boolean {
  return (
    left.instanceEpoch === right.instanceEpoch &&
    left.chatId === right.chatId &&
    left.runId === right.runId &&
    left.launchAttemptId === right.launchAttemptId &&
    left.expectedPid === right.expectedPid &&
    left.selectedPid === right.selectedPid &&
    left.windowId === right.windowId &&
    left.processStartedAt === right.processStartedAt &&
    left.ownership === right.ownership &&
    left.ancestryDepth === right.ancestryDepth
  )
}

/** Both birth receipts are in the key, so neither process can be swapped. */
function ancestryKey(
  leafPid: number,
  leafProcessStartedAt: string,
  rootPid: number,
  rootProcessStartedAt: string
): string {
  return `${leafPid}\u0000${leafProcessStartedAt}\u0000${rootPid}\u0000${rootProcessStartedAt}`
}

function isCancelledPickResponse(value: unknown): boolean {
  return asRecord(value)?.cancelled === true
}

function requireDaemon(value: unknown): NativeWindowCoordinatorDaemon {
  const daemon = value as Partial<NativeWindowCoordinatorDaemon> | null
  if (!daemon || typeof daemon.status !== 'function' || typeof daemon.request !== 'function') {
    throw new NativeWindowCoordinatorError(
      'invalid-input',
      'A native bridge request/status interface is required.'
    )
  }
  return daemon as NativeWindowCoordinatorDaemon
}

function requiredFunction<T extends (...args: never[]) => unknown>(value: T, label: string): T {
  if (typeof value !== 'function') {
    throw new NativeWindowCoordinatorError('invalid-input', `${label} must be a function.`)
  }
  return value
}

function requiredString(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim() !== value ||
    value.normalize('NFC') !== value
  ) {
    throw new NativeWindowCoordinatorError(
      'invalid-input',
      `${label} must be a non-empty canonical string.`
    )
  }
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new NativeWindowCoordinatorError('invalid-input', `${label} must be a positive integer.`)
  }
  return Number(value)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
