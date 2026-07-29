import { createHash } from 'node:crypto'

import type { CanonicalWorkspaceLockPathVerification } from './CanonicalWorkspaceLockPath'
import {
  canonicalizeWorkspaceLockClaim,
  compareWorkspaceLockClaims,
  workspaceLockClaimsConflict,
  type WorkspaceLockClaimPathCanonicalizer
} from './LockClaimModel'
import type { NodeWorkspaceLockPersistence } from './NodeWorkspaceLockPersistence'
import {
  projectWorkspaceLockMarkers,
  workspaceLockRuntimeMarkerFilename
} from './WorkspaceLockMarkerProjection'
import type {
  CanonicalWorkspaceLockClaim,
  WorkspaceLockAcquireResult,
  WorkspaceLockAuthorityDependencies,
  WorkspaceLockAuthorityFence,
  WorkspaceLockClaimRequest,
  WorkspaceLockLease,
  WorkspaceLockMutationCapability,
  WorkspaceLockMutationVerificationResult,
  WorkspaceLockOwner,
  WorkspaceLockProcessObservation,
  WorkspaceLockReleaseResult,
  WorkspaceLockSnapshot,
  WorkspaceLockToken
} from './WorkspaceLockTypes'
import { workspaceLockToken } from './WorkspaceLockTypes'
import {
  appendWorkspaceLockWalEvent,
  decodeWorkspaceLockWal,
  historicalWorkspaceLockWalEvent,
  type WorkspaceLockWalEvent,
  type WorkspaceLockWalMarker,
  type WorkspaceLockWalRecoveryDecision,
  type WorkspaceLockWalState
} from './WorkspaceLockWal'

export interface WorkspaceLockAuthorityOptions {
  persistence: Pick<
    NodeWorkspaceLockPersistence,
    | 'readEvents'
    | 'appendEvent'
    | 'confirmEventsDurable'
    | 'repairTornEventTail'
    | 'acquireInstanceFence'
    | 'replaceInstanceFence'
    | 'recoverStaleReclaimGuard'
    | 'releaseInstanceFence'
    | 'writeDerivedMarker'
    | 'removeDerivedMarker'
  >
  dependencies: WorkspaceLockAuthorityDependencies
  /** Renewable derived-marker lifetime. Durable leases themselves do not expire. */
  markerLifetimeMs?: number
  /** Bounded UI/audit visibility; the WAL remains the durable history. */
  recoveredVisibilityMs?: number
}

export interface WorkspaceLockAcquireOptions {
  /** Caller-stable operation id. Replaying the exact request is idempotent. */
  transitionId?: string
}

export interface WorkspaceLockReleaseOptions {
  transitionId?: string
  /** Human-confirmed override for old live/uninspectable owners. */
  forceOrphaned?: boolean
}

export interface WorkspaceLockRecoveryResult {
  transitionId?: string
  decisions: WorkspaceLockWalRecoveryDecision[]
}

export type WorkspaceLockAuthorityListener = (snapshot: WorkspaceLockSnapshot) => void

interface CanonicalizedRequest {
  claim: CanonicalWorkspaceLockClaim
  verify?: () => CanonicalWorkspaceLockPathVerification
}

interface DurableTransition<T> {
  value: T
  previous: WorkspaceLockWalState
  next: WorkspaceLockWalState
  reconcileMarkers?: boolean
}

interface PreparedMarkerState {
  state: WorkspaceLockWalState
  byteLength: number
}

const DEFAULT_MARKER_LIFETIME_MS = 60 * 60 * 1000
const DEFAULT_RECOVERED_VISIBILITY_MS = 24 * 60 * 60 * 1000
const PROVISIONAL_MARKER_EXPIRES_AT = '9999-12-31T23:59:59.999Z'

export class WorkspaceLockAuthorityBusyError extends Error {
  readonly existing: WorkspaceLockAuthorityFence | null

  constructor(existing: WorkspaceLockAuthorityFence | null) {
    super('Another TaskWraith instance is committing a workspace-lock transition.')
    this.name = 'WorkspaceLockAuthorityBusyError'
    this.existing = existing
  }
}

/**
 * Crash-durable, multi-process workspace write authority.
 *
 * Every mutation is serialized behind a short O_EXCL transition mutex, then
 * replays the WAL while holding that mutex before deciding and appending one
 * atomic event. The mutex is never held for a provider run. Leases are the
 * durable authority; a WAL-inventoried conservative marker is projected
 * before acquisition commit and replaced by the exact derived view afterward.
 */
export class WorkspaceLockAuthority {
  private readonly persistence: WorkspaceLockAuthorityOptions['persistence']
  private readonly dependencies: WorkspaceLockAuthorityDependencies
  private readonly markerLifetimeMs: number
  private readonly recoveredVisibilityMs: number
  private readonly listeners = new Set<WorkspaceLockAuthorityListener>()
  private projectionErrors: string[] = []
  private generation = 0
  private bootFence: WorkspaceLockAuthorityFence | null = null
  private state: WorkspaceLockWalState = decodeWorkspaceLockWal('')
  private markerRenewalTimer: ReturnType<typeof setTimeout> | null = null

  private constructor(options: WorkspaceLockAuthorityOptions) {
    this.persistence = options.persistence
    this.dependencies = options.dependencies
    this.markerLifetimeMs = options.markerLifetimeMs ?? DEFAULT_MARKER_LIFETIME_MS
    this.recoveredVisibilityMs = options.recoveredVisibilityMs ?? DEFAULT_RECOVERED_VISIBILITY_MS
    if (!Number.isSafeInteger(this.markerLifetimeMs) || this.markerLifetimeMs <= 0) {
      throw new Error('Workspace-lock marker lifetime must be a positive integer.')
    }
    if (!Number.isSafeInteger(this.recoveredVisibilityMs) || this.recoveredVisibilityMs <= 0) {
      throw new Error('Workspace-lock recovered visibility must be a positive integer.')
    }
    validateInstance(options.dependencies)
  }

  /**
   * Async construction is intentional: exact macOS process-birth observation
   * comes from the native resolver and must never degrade to PID-only liveness.
   */
  static async open(options: WorkspaceLockAuthorityOptions): Promise<WorkspaceLockAuthority> {
    const authority = new WorkspaceLockAuthority(options)
    await authority.boot()
    await authority.recoverStaleClaims()
    authority.startMarkerRenewal()
    return authority
  }

  async acquire(
    owner: WorkspaceLockOwner,
    request: WorkspaceLockClaimRequest,
    options?: WorkspaceLockAcquireOptions
  ): Promise<WorkspaceLockAcquireResult> {
    return this.acquireMany(owner, [request], options)
  }

  /**
   * Deterministic all-or-nothing acquisition. No lease is appended until every
   * target has been canonicalized, reverified, and checked against the same
   * WAL snapshot while the transition mutex is held.
   */
  async acquireMany(
    owner: WorkspaceLockOwner,
    requests: readonly WorkspaceLockClaimRequest[],
    options: WorkspaceLockAcquireOptions = {}
  ): Promise<WorkspaceLockAcquireResult> {
    const ownerError = validateOwner(owner)
    if (ownerError) return invalidAcquire('invalid_request', ownerError)
    if (!requests.length) {
      return invalidAcquire('invalid_request', 'Workspace-lock acquisition requires a claim.')
    }

    const observation = await this.dependencies.observeProcess(owner.pid)
    if (observation.state === 'identity_unavailable') {
      return invalidAcquire(
        'owner_identity_unavailable',
        `Exact process-birth identity is unavailable for owner PID ${owner.pid}.`
      )
    }
    if (
      observation.state === 'dead' ||
      observation.processBirthIdentity !== owner.processBirthIdentity
    ) {
      return invalidAcquire(
        'owner_not_live',
        `Owner PID ${owner.pid} is dead or no longer has the supplied process-birth identity.`
      )
    }

    let canonicalized: CanonicalizedRequest[]
    try {
      canonicalized = requests.map((request) => this.canonicalize(request))
    } catch (error) {
      return invalidAcquire('invalid_request', errorMessage(error))
    }
    canonicalized.sort((left, right) => compareWorkspaceLockClaims(left.claim, right.claim))
    for (const entry of canonicalized) {
      if (entry.claim.kind !== 'hunk') continue
      if (
        !this.dependencies.validateHunkBaseline ||
        !(await this.dependencies.validateHunkBaseline(entry.claim))
      ) {
        return invalidAcquire(
          'invalid_request',
          'A hunk claim requires a verified current-file baseline digest.'
        )
      }
    }

    try {
      const committed = await this.commitUnderFence((state, byteLength) => {
        for (const entry of canonicalized) {
          const verification = entry.verify?.()
          if (verification && !verification.ok) {
            return {
              value: invalidAcquire(
                'invalid_request',
                `Workspace-lock target changed during acquisition: ${verification.message}`
              ),
              previous: state,
              next: state
            }
          }
        }

        const claims = deduplicateClaims(canonicalized.map((entry) => entry.claim))
        const transitionId = options.transitionId || this.nextId('transition')
        const replay = replayedAcquire(state, transitionId, owner, claims)
        if (replay) {
          this.persistence.confirmEventsDurable(byteLength)
          return { value: replay, previous: state, next: state, reconcileMarkers: true }
        }
        if (state.transitionIds.includes(transitionId)) {
          return {
            value: invalidAcquire(
              'invalid_request',
              `Transition ${transitionId} was already used for a different operation.`
            ),
            previous: state,
            next: state
          }
        }

        const existing = state.activeLeases
        const freshClaims: CanonicalWorkspaceLockClaim[] = []
        for (const claim of claims) {
          const holders = existing
            .filter(
              (lease) =>
                !sameLeaseOwner(lease.owner, owner) &&
                workspaceLockClaimsConflict(lease.claim, claim)
            )
            .sort(compareLeases)
          if (holders.length) {
            return {
              value: {
                ok: false,
                reason: 'conflict',
                message: `Workspace-lock ${claim.kind} claim conflicts with ${holders.length} active lease(s).`,
                conflict: {
                  requested: claim,
                  holders: holders.map(cloneLease),
                  reason: 'The canonical targets overlap and at least one claim is a writer.'
                }
              } satisfies WorkspaceLockAcquireResult,
              previous: state,
              next: state
            }
          }
          freshClaims.push(claim)
        }

        const timestamp = this.nowIso()
        const leases = freshClaims.map(
          (claim): WorkspaceLockLease => ({
            leaseId: this.nextId('lease'),
            acquiredTransitionId: transitionId,
            authorityInstanceId: this.dependencies.instance.instanceId,
            authorityGeneration: this.generation,
            owner: cloneOwner(owner),
            claim: cloneClaim(claim),
            acquiredAt: timestamp,
            status: 'held',
            statusChangedAt: timestamp
          })
        )
        const next = this.appendAcquireWithPreparedMarkers(
          state,
          byteLength,
          leases,
          transitionId,
          timestamp,
          leases
        )
        return {
          value: acquireResult(transitionId, leases),
          previous: state,
          next
        }
      })
      this.afterTransition(committed)
      return committed.value
    } catch (error) {
      if (error instanceof WorkspaceLockAuthorityBusyError) {
        return invalidAcquire('authority_busy', error.message)
      }
      throw error
    }
  }

  /**
   * Atomically supersedes one operation-scoped acquisition with freshly
   * canonicalized claims. Callers hold the global mutation commit fence while
   * re-deriving the new baseline/path, so no release gap can admit a rival.
   */
  async replaceAcquisition(
    owner: WorkspaceLockOwner,
    previousAcquiredTransitionId: string,
    requests: readonly WorkspaceLockClaimRequest[],
    options: WorkspaceLockAcquireOptions = {}
  ): Promise<WorkspaceLockAcquireResult> {
    const ownerError = validateOwner(owner)
    if (ownerError) return invalidAcquire('invalid_request', ownerError)
    if (!previousAcquiredTransitionId?.trim() || !requests.length) {
      return invalidAcquire(
        'invalid_request',
        'Replacement requires a prior acquisition transition and at least one claim.'
      )
    }

    const observation = await this.dependencies.observeProcess(owner.pid)
    if (observation.state === 'identity_unavailable') {
      return invalidAcquire(
        'owner_identity_unavailable',
        `Exact process-birth identity is unavailable for owner PID ${owner.pid}.`
      )
    }
    if (
      observation.state === 'dead' ||
      observation.processBirthIdentity !== owner.processBirthIdentity
    ) {
      return invalidAcquire(
        'owner_not_live',
        `Owner PID ${owner.pid} is dead or no longer has the supplied process-birth identity.`
      )
    }

    let canonicalized: CanonicalizedRequest[]
    try {
      canonicalized = requests.map((request) => this.canonicalize(request))
    } catch (error) {
      return invalidAcquire('invalid_request', errorMessage(error))
    }
    canonicalized.sort((left, right) => compareWorkspaceLockClaims(left.claim, right.claim))
    for (const entry of canonicalized) {
      if (entry.claim.kind !== 'hunk') continue
      if (
        !this.dependencies.validateHunkBaseline ||
        !(await this.dependencies.validateHunkBaseline(entry.claim))
      ) {
        return invalidAcquire(
          'invalid_request',
          'A hunk claim requires a verified current-file baseline digest.'
        )
      }
    }

    try {
      const committed = await this.commitUnderFence((state, byteLength) => {
        for (const entry of canonicalized) {
          const verification = entry.verify?.()
          if (verification && !verification.ok) {
            return {
              value: invalidAcquire(
                'invalid_request',
                `Workspace-lock target changed during replacement: ${verification.message}`
              ),
              previous: state,
              next: state
            }
          }
        }

        const claims = deduplicateClaims(canonicalized.map((entry) => entry.claim))
        const transitionId = options.transitionId || this.nextId('transition')
        const replay = replayedAcquire(state, transitionId, owner, claims)
        if (replay) {
          this.persistence.confirmEventsDurable(byteLength)
          return { value: replay, previous: state, next: state, reconcileMarkers: true }
        }
        if (state.transitionIds.includes(transitionId)) {
          return {
            value: invalidAcquire(
              'invalid_request',
              `Transition ${transitionId} was already used for a different operation.`
            ),
            previous: state,
            next: state
          }
        }

        const previous = state.activeLeases
          .filter(
            (lease) =>
              lease.acquiredTransitionId === previousAcquiredTransitionId &&
              lease.authorityInstanceId === this.dependencies.instance.instanceId &&
              lease.authorityGeneration === this.generation &&
              sameLeaseOwner(lease.owner, owner)
          )
          .sort(compareLeases)
        if (!previous.length) {
          return {
            value: invalidAcquire(
              'invalid_request',
              'The prior acquisition is stale, foreign, or already superseded.'
            ),
            previous: state,
            next: state
          }
        }
        const replacedIds = new Set(previous.map((lease) => lease.leaseId))
        for (const claim of claims) {
          const holders = state.activeLeases
            .filter(
              (lease) =>
                !replacedIds.has(lease.leaseId) &&
                !sameLeaseOwner(lease.owner, owner) &&
                workspaceLockClaimsConflict(lease.claim, claim)
            )
            .sort(compareLeases)
          if (holders.length) {
            return {
              value: {
                ok: false,
                reason: 'conflict',
                message: `Workspace-lock ${claim.kind} replacement conflicts with ${holders.length} active lease(s).`,
                conflict: {
                  requested: claim,
                  holders: holders.map(cloneLease),
                  reason: 'The canonical targets overlap and at least one claim is a writer.'
                }
              } satisfies WorkspaceLockAcquireResult,
              previous: state,
              next: state
            }
          }
        }

        const timestamp = this.nowIso()
        const leases = claims.map(
          (claim): WorkspaceLockLease => ({
            leaseId: this.nextId('lease'),
            acquiredTransitionId: transitionId,
            authorityInstanceId: this.dependencies.instance.instanceId,
            authorityGeneration: this.generation,
            owner: cloneOwner(owner),
            claim: cloneClaim(claim),
            acquiredAt: timestamp,
            status: 'held',
            statusChangedAt: timestamp
          })
        )
        const next = this.appendAcquireWithPreparedMarkers(
          state,
          byteLength,
          [...previous, ...leases],
          transitionId,
          timestamp,
          leases,
          previous.map((lease) => lease.leaseId)
        )
        return {
          value: acquireResult(transitionId, leases),
          previous: state,
          next
        }
      })
      this.afterTransition(committed)
      return committed.value
    } catch (error) {
      if (error instanceof WorkspaceLockAuthorityBusyError) {
        return invalidAcquire('authority_busy', error.message)
      }
      throw error
    }
  }

  /**
   * Rebinds a long-lived native/background acquisition from its admitting
   * process to the exact spawned child incarnation without a lease gap.
   */
  async transferAcquisition(
    previousOwner: WorkspaceLockOwner,
    acquiredTransitionId: string,
    nextOwner: WorkspaceLockOwner,
    options: WorkspaceLockAcquireOptions = {}
  ): Promise<WorkspaceLockAcquireResult> {
    const previousError = validateOwner(previousOwner)
    const nextError = validateOwner(nextOwner)
    if (previousError || nextError) {
      return invalidAcquire('invalid_request', previousError || nextError || 'Invalid owner.')
    }
    if (!acquiredTransitionId?.trim()) {
      return invalidAcquire('invalid_request', 'An acquisition transition id is required.')
    }
    if (
      previousOwner.runId !== nextOwner.runId ||
      previousOwner.lockOwnerId !== nextOwner.lockOwnerId
    ) {
      return invalidAcquire(
        'invalid_request',
        'Lease transfer must preserve the exact run and lock-owner identities.'
      )
    }
    const transferredOwner: WorkspaceLockOwner = {
      ...nextOwner,
      lifecycle: 'child'
    }

    const [previousObservation, nextObservation] = await Promise.all([
      this.dependencies.observeProcess(previousOwner.pid),
      this.dependencies.observeProcess(transferredOwner.pid)
    ])
    if (
      previousObservation.state === 'identity_unavailable' ||
      nextObservation.state === 'identity_unavailable'
    ) {
      return invalidAcquire(
        'owner_identity_unavailable',
        'Exact process-birth identity is unavailable for a lease-transfer owner.'
      )
    }
    if (
      previousObservation.state === 'dead' ||
      previousObservation.processBirthIdentity !== previousOwner.processBirthIdentity ||
      nextObservation.state === 'dead' ||
      nextObservation.processBirthIdentity !== transferredOwner.processBirthIdentity
    ) {
      return invalidAcquire(
        'owner_not_live',
        'Both lease-transfer owners must match exact live process incarnations.'
      )
    }

    try {
      const committed = await this.commitUnderFence((state, byteLength) => {
        const transitionId = options.transitionId || this.nextId('transition')
        const replay = replayedTransfer(
          state,
          transitionId,
          previousOwner,
          acquiredTransitionId,
          transferredOwner
        )
        if (replay) {
          this.persistence.confirmEventsDurable(byteLength)
          return { value: replay, previous: state, next: state, reconcileMarkers: true }
        }
        if (state.transitionIds.includes(transitionId)) {
          return {
            value: invalidAcquire(
              'invalid_request',
              `Transition ${transitionId} was already used for a different operation.`
            ),
            previous: state,
            next: state
          }
        }
        const previous = state.activeLeases
          .filter(
            (lease) =>
              lease.acquiredTransitionId === acquiredTransitionId &&
              lease.authorityInstanceId === this.dependencies.instance.instanceId &&
              lease.authorityGeneration === this.generation &&
              lease.status === 'held' &&
              sameLeaseOwner(lease.owner, previousOwner)
          )
          .sort(compareLeases)
        const claims = previous.map((lease) => cloneClaim(lease.claim))
        if (!previous.length) {
          return {
            value: invalidAcquire(
              'invalid_request',
              'The transfer source is stale, foreign, recovered, or already transferred.'
            ),
            previous: state,
            next: state
          }
        }
        if (claims.some((claim) => claim.kind === 'hunk')) {
          return {
            value: invalidAcquire(
              'invalid_request',
              'Hunk leases are operation-scoped and cannot transfer to a long-lived process.'
            ),
            previous: state,
            next: state
          }
        }
        for (const claim of claims) {
          if (!claim.pathEvidence) {
            return {
              value: invalidAcquire(
                'invalid_request',
                'A transferred lease is missing durable path evidence.'
              ),
              previous: state,
              next: state
            }
          }
          const verification = this.dependencies.verifyTargetPath(claim.pathEvidence)
          if (!verification.ok) {
            return {
              value: invalidAcquire(
                'invalid_request',
                `Transferred workspace-lock target changed: ${verification.message}`
              ),
              previous: state,
              next: state
            }
          }
        }

        const replacedIds = new Set(previous.map((lease) => lease.leaseId))
        const transferredRoots = new Set(previous.map((lease) => lease.claim.worktreeCanonicalPath))
        const splitMarkerLease = state.activeLeases.find(
          (lease) =>
            !replacedIds.has(lease.leaseId) &&
            lease.authorityInstanceId === this.dependencies.instance.instanceId &&
            lease.owner.lockOwnerId === previousOwner.lockOwnerId &&
            transferredRoots.has(lease.claim.worktreeCanonicalPath)
        )
        if (splitMarkerLease) {
          return {
            value: invalidAcquire(
              'invalid_request',
              'Transfer would split one marker owner across process incarnations.'
            ),
            previous: state,
            next: state
          }
        }
        for (const claim of claims) {
          const holders = state.activeLeases
            .filter(
              (lease) =>
                !replacedIds.has(lease.leaseId) &&
                !sameLeaseOwner(lease.owner, transferredOwner) &&
                workspaceLockClaimsConflict(lease.claim, claim)
            )
            .sort(compareLeases)
          if (holders.length) {
            return {
              value: {
                ok: false,
                reason: 'conflict',
                message: `Workspace-lock transfer conflicts with ${holders.length} active lease(s).`,
                conflict: {
                  requested: claim,
                  holders: holders.map(cloneLease),
                  reason: 'The canonical targets overlap and at least one claim is a writer.'
                }
              } satisfies WorkspaceLockAcquireResult,
              previous: state,
              next: state
            }
          }
        }

        const timestamp = this.nowIso()
        const leases = claims.map(
          (claim): WorkspaceLockLease => ({
            leaseId: this.nextId('lease'),
            acquiredTransitionId: transitionId,
            authorityInstanceId: this.dependencies.instance.instanceId,
            authorityGeneration: this.generation,
            owner: cloneOwner(transferredOwner),
            claim,
            acquiredAt: timestamp,
            status: 'held',
            statusChangedAt: timestamp
          })
        )
        const next = this.appendAcquireWithPreparedMarkers(
          state,
          byteLength,
          [...previous, ...leases],
          transitionId,
          timestamp,
          leases,
          previous.map((lease) => lease.leaseId)
        )
        return {
          value: acquireResult(transitionId, leases),
          previous: state,
          next
        }
      })
      this.afterTransition(committed)
      return committed.value
    } catch (error) {
      if (error instanceof WorkspaceLockAuthorityBusyError) {
        return invalidAcquire('authority_busy', error.message)
      }
      throw error
    }
  }

  /**
   * Re-resolves an operation's complete path capability immediately before
   * broker execution. The caller must invoke this while holding
   * WorkspaceMutationCommitFence and must execute only against the returned
   * exact paths.
   */
  async verifyAcquisitionForMutation(
    owner: WorkspaceLockOwner,
    acquiredTransitionId: string
  ): Promise<WorkspaceLockMutationVerificationResult> {
    const ownerError = validateOwner(owner)
    if (ownerError) {
      return { ok: false, reason: 'invalid_request', message: ownerError }
    }
    if (!acquiredTransitionId?.trim()) {
      return {
        ok: false,
        reason: 'invalid_request',
        message: 'An acquisition transition id is required.'
      }
    }
    const observation = await this.dependencies.observeProcess(owner.pid)
    if (observation.state === 'identity_unavailable') {
      return {
        ok: false,
        reason: 'owner_identity_unavailable',
        message: `Exact process-birth identity is unavailable for owner PID ${owner.pid}.`
      }
    }
    if (
      observation.state === 'dead' ||
      observation.processBirthIdentity !== owner.processBirthIdentity
    ) {
      return {
        ok: false,
        reason: 'owner_not_live',
        message: `Owner PID ${owner.pid} is dead or no longer has the supplied process-birth identity.`
      }
    }

    const before = this.readWal(false)
      .state.activeLeases.filter(
        (lease) =>
          lease.acquiredTransitionId === acquiredTransitionId &&
          lease.authorityInstanceId === this.dependencies.instance.instanceId &&
          lease.authorityGeneration === this.generation &&
          lease.status === 'held' &&
          sameLeaseOwner(lease.owner, owner)
      )
      .sort(compareLeases)
    if (!before.length) {
      return {
        ok: false,
        reason: 'stale_acquisition',
        message: 'The acquisition is stale, foreign, recovered, or already released.'
      }
    }

    const capabilities: WorkspaceLockMutationCapability[] = []
    for (const lease of before) {
      if (!lease.claim.pathEvidence) {
        return {
          ok: false,
          reason: 'path_changed',
          message: `Lease ${lease.leaseId} lacks durable path evidence.`
        }
      }
      const verification = this.dependencies.verifyTargetPath(lease.claim.pathEvidence)
      if (!verification.ok) {
        return {
          ok: false,
          reason: 'path_changed',
          message: `Lease ${lease.leaseId} path verification failed: ${verification.message}`
        }
      }
      if (
        lease.claim.kind === 'hunk' &&
        (!this.dependencies.validateHunkBaseline ||
          !(await this.dependencies.validateHunkBaseline(lease.claim)))
      ) {
        return {
          ok: false,
          reason: 'baseline_changed',
          message: `Lease ${lease.leaseId} hunk baseline is no longer current.`
        }
      }
      capabilities.push({
        token: workspaceLockToken(lease),
        leaseId: lease.leaseId,
        kind: lease.claim.kind,
        executableTargetPath: verification.resolution.canonicalPath,
        verifiedPathEvidence: cloneClaim({
          ...lease.claim,
          pathEvidence: verification.resolution
        }).pathEvidence!,
        ...(lease.claim.hunk ? { hunk: { ...lease.claim.hunk } } : {})
      })
    }

    const after = this.readWal(false)
      .state.activeLeases.filter(
        (lease) =>
          lease.acquiredTransitionId === acquiredTransitionId && sameLeaseOwner(lease.owner, owner)
      )
      .sort(compareLeases)
    if (
      after.length !== before.length ||
      after.some((lease, index) => lease.leaseId !== before[index].leaseId)
    ) {
      return {
        ok: false,
        reason: 'stale_acquisition',
        message: 'The acquisition changed while its mutation capability was being verified.'
      }
    }
    return { ok: true, acquiredTransitionId, capabilities }
  }

  async release(
    token: WorkspaceLockToken,
    options: WorkspaceLockReleaseOptions = {}
  ): Promise<WorkspaceLockReleaseResult> {
    try {
      const committed = await this.commitUnderFence((state, byteLength) => {
        const transitionId = options.transitionId || this.nextId('transition')
        const replay = replayedDirectRelease(state, transitionId, token)
        if (replay) {
          this.persistence.confirmEventsDurable(byteLength)
          return { value: replay, previous: state, next: state, reconcileMarkers: true }
        }
        if (state.transitionIds.includes(transitionId)) {
          return unchangedRelease(
            state,
            'stale_token',
            `Transition ${transitionId} was already used for a different operation.`
          )
        }
        if (token.authorityInstanceId !== this.dependencies.instance.instanceId) {
          return unchangedRelease(
            state,
            'foreign_authority',
            'A lease token may only be directly released by its issuing authority instance.'
          )
        }
        if (token.authorityGeneration !== this.generation) {
          return unchangedRelease(
            state,
            'stale_generation',
            'The lease token belongs to a stale authority generation.'
          )
        }
        const lease = state.activeLeases.find((candidate) => candidate.leaseId === token.leaseId)
        if (!lease || lease.acquiredTransitionId !== token.acquiredTransitionId) {
          return unchangedRelease(state, 'stale_token', 'The lease token is stale or unknown.')
        }
        if (lease.owner.runId !== token.ownerRunId) {
          return unchangedRelease(state, 'foreign_owner', 'The lease belongs to another run.')
        }
        const timestamp = this.nowIso()
        const appended = appendWorkspaceLockWalEvent(state, {
          transitionId,
          timestamp,
          authority: this.walAuthority(),
          kind: 'release',
          payload: { leaseIds: [lease.leaseId] }
        })
        this.persistence.appendEvent(appended.line, byteLength)
        return {
          value: {
            ok: true,
            transitionId,
            released: [cloneLease(lease)]
          } satisfies WorkspaceLockReleaseResult,
          previous: state,
          next: appended.nextState
        }
      })
      this.afterTransition(committed)
      return committed.value
    } catch (error) {
      if (error instanceof WorkspaceLockAuthorityBusyError) {
        return { ok: false, reason: 'authority_busy', message: error.message }
      }
      throw error
    }
  }

  /** Atomically releases every lease acquired by one tool/operation transition. */
  async releaseAcquisition(
    ownerRunId: string,
    acquiredTransitionId: string,
    options: WorkspaceLockReleaseOptions = {}
  ): Promise<WorkspaceLockReleaseResult> {
    if (!ownerRunId?.trim() || !acquiredTransitionId?.trim()) {
      return {
        ok: false,
        reason: 'foreign_owner',
        message: 'Run id and acquisition transition id are required.'
      }
    }
    try {
      const committed = await this.commitUnderFence((state, byteLength) => {
        const transitionId = options.transitionId || this.nextId('transition')
        const replay = replayedAcquisitionRelease(
          state,
          transitionId,
          ownerRunId,
          acquiredTransitionId
        )
        if (replay) {
          this.persistence.confirmEventsDurable(byteLength)
          return { value: replay, previous: state, next: state, reconcileMarkers: true }
        }
        if (state.transitionIds.includes(transitionId)) {
          return unchangedRelease(
            state,
            'stale_token',
            `Transition ${transitionId} was already used for a different operation.`
          )
        }
        const leases = state.activeLeases
          .filter(
            (lease) =>
              lease.owner.runId === ownerRunId &&
              lease.acquiredTransitionId === acquiredTransitionId &&
              lease.authorityInstanceId === this.dependencies.instance.instanceId &&
              lease.authorityGeneration === this.generation
          )
          .sort(compareLeases)
        if (!leases.length) {
          return unchangedRelease(
            state,
            'stale_token',
            'The acquisition is stale, foreign, or already released.'
          )
        }
        const appended = appendWorkspaceLockWalEvent(state, {
          transitionId,
          timestamp: this.nowIso(),
          authority: this.walAuthority(),
          kind: 'release',
          payload: {
            leaseIds: leases.map((lease) => lease.leaseId),
            ownerRunId,
            acquiredTransitionId
          }
        })
        this.persistence.appendEvent(appended.line, byteLength)
        return {
          value: {
            ok: true,
            transitionId,
            released: leases.map(cloneLease)
          } satisfies WorkspaceLockReleaseResult,
          previous: state,
          next: appended.nextState
        }
      })
      this.afterTransition(committed)
      return committed.value
    } catch (error) {
      if (error instanceof WorkspaceLockAuthorityBusyError) {
        return { ok: false, reason: 'authority_busy', message: error.message }
      }
      throw error
    }
  }

  /**
   * Exact human-approved recovery seam. Integration owns approval provenance
   * and fresh containment probing; core durably binds its opaque receipt to
   * one complete recovery-blocked child acquisition.
   */
  async forceReleaseRecoveryBlockedAcquisition(
    ownerRunId: string,
    acquiredTransitionId: string,
    leaseIds: readonly string[],
    approvalReceiptId: string,
    options: WorkspaceLockAcquireOptions = {}
  ): Promise<WorkspaceLockReleaseResult> {
    if (
      !ownerRunId?.trim() ||
      !acquiredTransitionId?.trim() ||
      !approvalReceiptId?.trim() ||
      !leaseIds.length ||
      new Set(leaseIds).size !== leaseIds.length
    ) {
      return {
        ok: false,
        reason: 'foreign_owner',
        message:
          'Exact run, acquisition, unique lease ids, and human approval receipt are required.'
      }
    }
    try {
      const committed = await this.commitUnderFence((state, byteLength) => {
        const transitionId = options.transitionId || this.nextId('transition')
        const replay = replayedAcquisitionRelease(
          state,
          transitionId,
          ownerRunId,
          acquiredTransitionId,
          approvalReceiptId,
          leaseIds
        )
        if (replay) {
          this.persistence.confirmEventsDurable(byteLength)
          return { value: replay, previous: state, next: state, reconcileMarkers: true }
        }
        if (state.transitionIds.includes(transitionId)) {
          return unchangedRelease(
            state,
            'stale_token',
            `Transition ${transitionId} was already used for a different operation.`
          )
        }
        const expected = state.activeLeases
          .filter(
            (lease) =>
              lease.owner.runId === ownerRunId &&
              lease.acquiredTransitionId === acquiredTransitionId
          )
          .sort(compareLeases)
        if (
          !expected.length ||
          !sameStringSet(
            expected.map((lease) => lease.leaseId),
            leaseIds
          ) ||
          expected.some(
            (lease) =>
              lease.status !== 'recovery_blocked' ||
              (lease.owner.lifecycle !== 'launching-child' && lease.owner.lifecycle !== 'child')
          )
        ) {
          return unchangedRelease(
            state,
            'foreign_owner',
            'Force release must name the complete exact recovery-blocked child acquisition.'
          )
        }
        const appended = appendWorkspaceLockWalEvent(state, {
          transitionId,
          timestamp: this.nowIso(),
          authority: this.walAuthority(),
          kind: 'release',
          payload: {
            leaseIds: expected.map((lease) => lease.leaseId),
            ownerRunId,
            acquiredTransitionId,
            forceApprovalReceiptId: approvalReceiptId
          }
        })
        this.persistence.appendEvent(appended.line, byteLength)
        return {
          value: {
            ok: true,
            transitionId,
            released: expected.map(cloneLease)
          } satisfies WorkspaceLockReleaseResult,
          previous: state,
          next: appended.nextState
        }
      })
      this.afterTransition(committed)
      return committed.value
    } catch (error) {
      if (error instanceof WorkspaceLockAuthorityBusyError) {
        return { ok: false, reason: 'authority_busy', message: error.message }
      }
      throw error
    }
  }

  /**
   * Terminal cleanup intentionally crosses authority generations. A restarted
   * main process can settle an orphan by durable runId without forging its old
   * per-lease token.
   */
  async releaseAllForRun(
    runId: string,
    options: WorkspaceLockReleaseOptions = {}
  ): Promise<WorkspaceLockReleaseResult> {
    if (!runId?.trim()) {
      return { ok: false, reason: 'foreign_owner', message: 'Run id is required.' }
    }
    const observed = this.readWal(false).state.activeLeases.filter(
      (lease) => lease.owner.runId === runId
    )
    const observations = new Map<number, WorkspaceLockProcessObservation>()
    await Promise.all(
      [...new Set(observed.map((lease) => lease.owner.pid))].map(async (pid) => {
        observations.set(pid, await this.dependencies.observeProcess(pid))
      })
    )
    try {
      const committed = await this.commitUnderFence((state, byteLength) => {
        const transitionId = options.transitionId || this.nextId('transition')
        const replay = replayedRunRelease(
          state,
          transitionId,
          runId,
          options.forceOrphaned === true
        )
        if (replay) {
          this.persistence.confirmEventsDurable(byteLength)
          return { value: replay, previous: state, next: state, reconcileMarkers: true }
        }
        if (state.transitionIds.includes(transitionId)) {
          return unchangedRelease(
            state,
            'stale_token',
            `Transition ${transitionId} was already used for a different operation.`
          )
        }
        const owned = state.activeLeases
          .filter((lease) => lease.owner.runId === runId)
          .sort(compareLeases)
        const retainedLaunchingChildren = owned.filter(
          (lease) => !options.forceOrphaned && lease.owner.lifecycle === 'launching-child'
        )
        const protectedOrphans = owned.filter(
          (lease) =>
            !options.forceOrphaned &&
            lease.owner.lifecycle !== 'child' &&
            lease.owner.lifecycle !== 'launching-child' &&
            lease.status !== 'held' &&
            ownerMayStillBeLive(
              lease,
              observations.get(lease.owner.pid) || { state: 'identity_unavailable' }
            )
        )
        if (protectedOrphans.length) {
          return unchangedRelease(
            state,
            'foreign_owner',
            `Run ${runId} retains ${protectedOrphans.length} live or uninspectable child/orphan lock(s); verified death or explicit human force release is required.`
          )
        }
        const retainedChildren = owned.filter(
          (lease) => !options.forceOrphaned && lease.owner.lifecycle === 'child'
        )
        const retained = [...retainedLaunchingChildren, ...retainedChildren].sort(compareLeases)
        const retainedReason = retainedReleaseReason(retained)
        const leases = owned.filter((lease) => !retained.includes(lease))
        if (!leases.length) {
          return {
            value: {
              ok: true,
              transitionId: options.transitionId || state.lastTransitionId,
              released: [],
              ...(retained.length
                ? {
                    retained: retained.map(cloneLease),
                    retainedReason
                  }
                : {})
            } satisfies WorkspaceLockReleaseResult,
            previous: state,
            next: state
          }
        }
        const timestamp = this.nowIso()
        const appended = appendWorkspaceLockWalEvent(state, {
          transitionId,
          timestamp,
          authority: this.walAuthority(),
          kind: 'release_run',
          payload: {
            runId,
            leaseIds: leases.map((lease) => lease.leaseId),
            forceOrphaned: options.forceOrphaned === true,
            ...(retained.length ? { retainedLeaseIds: retained.map((lease) => lease.leaseId) } : {})
          }
        })
        this.persistence.appendEvent(appended.line, byteLength)
        return {
          value: {
            ok: true,
            transitionId,
            released: leases.map(cloneLease),
            ...(retained.length
              ? {
                  retained: retained.map(cloneLease),
                  retainedReason
                }
              : {})
          } satisfies WorkspaceLockReleaseResult,
          previous: state,
          next: appended.nextState
        }
      })
      this.afterTransition(committed)
      return committed.value
    } catch (error) {
      if (error instanceof WorkspaceLockAuthorityBusyError) {
        return { ok: false, reason: 'authority_busy', message: error.message }
      }
      throw error
    }
  }

  /**
   * Truth table: dead/reused => recovered; exact live => retained (orphan when
   * issued elsewhere); identity unavailable => recovery_blocked.
   */
  async recoverStaleClaims(): Promise<WorkspaceLockRecoveryResult> {
    const observed = this.readWal(false).state.activeLeases
    const observations = new Map<number, WorkspaceLockProcessObservation>()
    await Promise.all(
      [...new Set(observed.map((lease) => lease.owner.pid))].map(async (pid) => {
        observations.set(pid, await this.dependencies.observeProcess(pid))
      })
    )

    const committed = await this.commitUnderFence<WorkspaceLockRecoveryResult>(
      (state, byteLength) => {
        const decisions = state.activeLeases
          .map((lease) =>
            recoveryDecision(
              lease,
              observations.get(lease.owner.pid) || { state: 'identity_unavailable' },
              this.dependencies.instance.instanceId,
              this.generation
            )
          )
          .filter((decision): decision is WorkspaceLockWalRecoveryDecision => Boolean(decision))
          .sort((left, right) => left.leaseId.localeCompare(right.leaseId))
        if (!decisions.length) {
          return {
            value: { decisions: [] },
            previous: state,
            next: state
          }
        }
        const transitionId = this.nextId('transition')
        const timestamp = this.nowIso()
        const appended = appendWorkspaceLockWalEvent(state, {
          transitionId,
          timestamp,
          authority: this.walAuthority(),
          kind: 'recover',
          payload: { decisions }
        })
        this.persistence.appendEvent(appended.line, byteLength)
        return {
          value: { transitionId, decisions },
          previous: state,
          next: appended.nextState
        }
      }
    )
    this.afterTransition(committed)
    return committed.value
  }

  snapshot(): WorkspaceLockSnapshot {
    this.state = this.readWal(false).state
    return this.snapshotFromState()
  }

  onChange(listener: WorkspaceLockAuthorityListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async renewDerivedMarkers(): Promise<void> {
    const fence = this.newFence(this.generation)
    await this.acquireTransitionFence(fence)
    let released = false
    try {
      const current = this.readWal(true)
      this.state = current.state
      this.syncMarkers(current.state)
      released = this.persistence.releaseInstanceFence(fence.fenceId)
      if (!released) {
        throw new Error('Workspace-lock renewal fence was replaced before exact release.')
      }
    } finally {
      if (!released) this.persistence.releaseInstanceFence(fence.fenceId)
    }
  }

  dispose(): void {
    if (this.markerRenewalTimer) clearTimeout(this.markerRenewalTimer)
    this.markerRenewalTimer = null
    this.listeners.clear()
  }

  private async boot(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = this.readWal(false).state
      const generation = before.maxGeneration + 1
      const fence = this.newFence(generation)
      await this.acquireTransitionFence(fence)
      let released = false
      try {
        const current = this.readWal(true)
        if (current.state.maxGeneration >= generation) {
          released = this.persistence.releaseInstanceFence(fence.fenceId)
          if (!released) throw new Error('Workspace-lock boot fence was replaced before release.')
          continue
        }
        this.generation = generation
        this.bootFence = fence
        const transitionId = this.nextId('transition')
        const timestamp = this.nowIso()
        const appended = appendWorkspaceLockWalEvent(current.state, {
          transitionId,
          timestamp,
          authority: this.walAuthority(),
          kind: 'boot',
          payload: { fence }
        })
        this.persistence.appendEvent(appended.line, current.byteLength)
        this.state = appended.nextState
        this.syncMarkers(appended.nextState)
        released = this.persistence.releaseInstanceFence(fence.fenceId)
        if (!released) throw new Error('Workspace-lock boot fence was replaced before release.')
        return
      } finally {
        if (!released) this.persistence.releaseInstanceFence(fence.fenceId)
      }
    }
    throw new Error('Workspace-lock generation changed repeatedly during startup.')
  }

  private async commitUnderFence<T>(
    action: (state: WorkspaceLockWalState, byteLength: number) => DurableTransition<T>
  ): Promise<DurableTransition<T>> {
    const fence = this.newFence(this.generation)
    await this.acquireTransitionFence(fence)
    let released = false
    try {
      const current = this.readWal(true)
      const result = action(current.state, current.byteLength)
      this.state = result.next
      if (result.next !== result.previous || result.reconcileMarkers) {
        this.syncMarkers(result.next)
        result.next = this.state
      }
      released = this.persistence.releaseInstanceFence(fence.fenceId)
      if (!released) {
        throw new Error('Workspace-lock transition fence was replaced before exact release.')
      }
      return result
    } finally {
      if (!released) this.persistence.releaseInstanceFence(fence.fenceId)
    }
  }

  private async acquireTransitionFence(fence: WorkspaceLockAuthorityFence): Promise<void> {
    let existing: WorkspaceLockAuthorityFence | null = null
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const acquired = this.persistence.acquireInstanceFence(fence)
      if (acquired.ok) return
      existing = acquired.existing
      if (existing) {
        const observation = await this.dependencies.observeProcess(existing.pid)
        const conclusivelyStale =
          observation.state === 'dead' ||
          (observation.state === 'live' &&
            observation.processBirthIdentity !== existing.processBirthIdentity)
        if (conclusivelyStale) {
          const replaced = this.persistence.replaceInstanceFence(existing.fenceId, fence)
          if (replaced.ok) return
          existing = replaced.existing
          await this.persistence.recoverStaleReclaimGuard(async (guardOwner) => {
            const guardObservation = await this.dependencies.observeProcess(guardOwner.pid)
            return (
              guardObservation.state === 'dead' ||
              (guardObservation.state === 'live' &&
                guardObservation.processBirthIdentity !== guardOwner.processBirthIdentity)
            )
          })
        }
      }
      await new Promise<void>((resolveDelay) => {
        setTimeout(resolveDelay, 2 ** attempt)
      })
    }
    throw new WorkspaceLockAuthorityBusyError(existing)
  }

  private readWal(repairTail: boolean): {
    state: WorkspaceLockWalState
    byteLength: number
  } {
    let snapshot = this.persistence.readEvents()
    if (snapshot.raw && !snapshot.raw.endsWith('\n')) {
      const lastNewline = snapshot.raw.lastIndexOf('\n')
      const prefix = lastNewline < 0 ? '' : snapshot.raw.slice(0, lastNewline + 1)
      const state = decodeWorkspaceLockWal(prefix)
      if (!repairTail) return { state, byteLength: snapshot.byteLength }
      const repairedLength = this.persistence.repairTornEventTail(snapshot.byteLength, prefix)
      snapshot = this.persistence.readEvents()
      if (snapshot.byteLength !== repairedLength || snapshot.raw !== prefix) {
        throw new Error('Workspace-lock WAL changed during torn-tail repair.')
      }
    }
    return { state: decodeWorkspaceLockWal(snapshot.raw), byteLength: snapshot.byteLength }
  }

  private canonicalize(request: WorkspaceLockClaimRequest): CanonicalizedRequest {
    let resolution: ReturnType<typeof this.dependencies.resolveTargetPath> | undefined
    const canonicalizer: WorkspaceLockClaimPathCanonicalizer = {
      canonicalizePath: this.dependencies.canonicalizePath,
      resolveTargetPath: (rootPath, targetPath) => {
        resolution = this.dependencies.resolveTargetPath(rootPath, targetPath)
        return resolution
      }
    }
    const claim = canonicalizeWorkspaceLockClaim(request, canonicalizer)
    return {
      claim,
      ...(resolution ? { verify: () => this.dependencies.verifyTargetPath(resolution!) } : {})
    }
  }

  private afterTransition<T>(transition: DurableTransition<T>): void {
    this.state = transition.next
    if (transition.next !== transition.previous) {
      const snapshot = this.snapshotFromState()
      for (const listener of this.listeners) {
        try {
          listener(snapshot)
        } catch {
          // Observers cannot roll back a durable transition or make its caller
          // believe a committed acquisition failed.
        }
      }
    }
  }

  private syncMarkers(next: WorkspaceLockWalState): void {
    const projectedAt = this.nowIso()
    const expiresAt = new Date(Date.parse(projectedAt) + this.markerLifetimeMs).toISOString()
    const projections = projectWorkspaceLockMarkers(next.activeLeases, {
      projectedAt,
      expiresAt
    })
    const active = new Map(
      projections.map((projection) => [
        markerKey(projection.root, projection.rootObjectIdentity, projection.filename),
        projection
      ])
    )
    const known = new Map<string, WorkspaceLockWalMarker>()
    for (const marker of next.knownMarkers) {
      known.set(
        markerKey(marker.worktreeIdentity, marker.worktreeObjectIdentity, marker.markerName),
        marker
      )
    }
    for (const projection of projections) {
      known.set(markerKey(projection.root, projection.rootObjectIdentity, projection.filename), {
        worktreeIdentity: projection.root,
        worktreeObjectIdentity: projection.rootObjectIdentity,
        markerName: projection.filename
      })
    }

    const activeErrors: string[] = []
    for (const projection of projections) {
      try {
        this.persistence.writeDerivedMarker(
          projection.root,
          projection.filename,
          projection.content,
          projection.rootObjectIdentity
        )
      } catch (error) {
        const message = `${projection.filename}: ${errorMessage(error)}`
        activeErrors.push(message)
      }
    }
    if (activeErrors.length) {
      this.projectionErrors = activeErrors
      throw new AggregateError(
        activeErrors.map((message) => new Error(message)),
        'Active marker projection failed; conservative markers were retained.'
      )
    }

    const removalErrors: string[] = []
    const removed: WorkspaceLockWalMarker[] = []
    for (const [key, marker] of known) {
      if (active.has(key)) continue
      try {
        this.persistence.removeDerivedMarker(
          marker.worktreeIdentity,
          marker.markerName,
          marker.worktreeObjectIdentity
        )
        removed.push(marker)
      } catch (error) {
        const message = `${marker.markerName}: ${errorMessage(error)}`
        removalErrors.push(message)
      }
    }
    let retirementError: Error | null = null
    if (removed.length) {
      try {
        this.retireKnownMarkers(removed)
      } catch (error) {
        retirementError = asError(error)
      }
    }
    this.projectionErrors = [
      ...removalErrors,
      ...(retirementError ? [retirementError.message] : [])
    ]
    if (removalErrors.length || retirementError) {
      throw new AggregateError(
        [
          ...removalErrors.map((message) => new Error(message)),
          ...(retirementError ? [retirementError] : [])
        ],
        'Inactive marker cleanup or durable retirement failed; pending inventory was retained.'
      )
    }
  }

  private retireKnownMarkers(markers: readonly WorkspaceLockWalMarker[]): void {
    const current = this.readWal(true)
    const pending = new Map(
      current.state.knownMarkers.map((marker) => [
        markerKey(marker.worktreeIdentity, marker.worktreeObjectIdentity, marker.markerName),
        marker
      ])
    )
    const retiring = markers.filter((marker) =>
      pending.has(
        markerKey(marker.worktreeIdentity, marker.worktreeObjectIdentity, marker.markerName)
      )
    )
    if (!retiring.length) {
      this.state = current.state
      return
    }
    const appended = appendWorkspaceLockWalEvent(current.state, {
      transitionId: this.nextId('transition'),
      timestamp: this.nowIso(),
      authority: this.walAuthority(),
      kind: 'cleanup',
      payload: { markers: retiring }
    })
    this.persistence.appendEvent(appended.line, current.byteLength)
    this.state = appended.nextState
  }

  private appendAcquireWithPreparedMarkers(
    state: WorkspaceLockWalState,
    byteLength: number,
    protectedLeases: readonly WorkspaceLockLease[],
    transitionId: string,
    timestamp: string,
    leases: readonly WorkspaceLockLease[],
    replacesLeaseIds?: readonly string[]
  ): WorkspaceLockWalState {
    const prepared = this.prepareProvisionalMarkers(
      state,
      byteLength,
      protectedLeases,
      transitionId
    )
    const markers = markersForLeases(leases)
    const appended = appendWorkspaceLockWalEvent(prepared.state, {
      transitionId,
      timestamp,
      authority: this.walAuthority(),
      kind: 'acquire',
      payload: {
        leases: leases.map(cloneLease),
        ...(replacesLeaseIds?.length ? { replacesLeaseIds: [...replacesLeaseIds] } : {}),
        ...(markers.length ? { markers } : {})
      }
    })
    try {
      this.persistence.appendEvent(appended.line, prepared.byteLength)
    } catch (appendError) {
      let observed: ReturnType<WorkspaceLockAuthority['readWal']>
      try {
        observed = this.readWal(true)
      } catch (observationError) {
        throw new AggregateError(
          [asError(appendError), asError(observationError)],
          'Workspace-lock acquisition append outcome is ambiguous; conservative markers were retained.'
        )
      }
      this.state = observed.state
      const committed = observed.state.events.find((event) => event.transitionId === transitionId)
      if (committed?.digest === appended.event.digest) {
        try {
          this.persistence.confirmEventsDurable(observed.byteLength)
        } catch (durabilityError) {
          throw new AggregateError(
            [asError(appendError), asError(durabilityError)],
            'Workspace-lock acquisition is visible but not durably confirmed; conservative markers were retained.'
          )
        }
        return observed.state
      }
      if (committed) {
        throw new AggregateError(
          [asError(appendError), new Error('Transition id was committed with different content.')],
          'Workspace-lock acquisition append outcome conflicts with the durable WAL; conservative markers were retained.'
        )
      }
      try {
        this.syncMarkers(observed.state)
      } catch (cleanupError) {
        throw new AggregateError(
          [asError(appendError), asError(cleanupError)],
          'Workspace-lock acquisition append and conservative-marker cleanup both failed.'
        )
      }
      throw appendError
    }
    return appended.nextState
  }

  private prepareProvisionalMarkers(
    state: WorkspaceLockWalState,
    byteLength: number,
    leases: readonly WorkspaceLockLease[],
    operationTransitionId: string
  ): PreparedMarkerState {
    const projectedAt = this.nowIso()
    const provisionalLeases = leases.map(
      (lease): WorkspaceLockLease => ({
        ...cloneLease(lease),
        owner: {
          ...cloneOwner(lease.owner),
          lockOwnerId: provisionalLockOwnerId(lease.owner, operationTransitionId)
        }
      })
    )
    const projections = projectWorkspaceLockMarkers(provisionalLeases, {
      projectedAt,
      expiresAt: PROVISIONAL_MARKER_EXPIRES_AT
    })
    const markers = projections.map(
      (projection): WorkspaceLockWalMarker => ({
        worktreeIdentity: projection.root,
        worktreeObjectIdentity: projection.rootObjectIdentity,
        markerName: projection.filename
      })
    )
    const prepared = appendWorkspaceLockWalEvent(state, {
      transitionId: this.nextId('transition'),
      timestamp: projectedAt,
      authority: this.walAuthority(),
      kind: 'prepare',
      payload: { markers }
    })
    const preparedByteLength = this.persistence.appendEvent(prepared.line, byteLength)
    this.state = prepared.nextState

    try {
      for (const projection of projections) {
        this.persistence.writeDerivedMarker(
          projection.root,
          projection.filename,
          projection.content,
          projection.rootObjectIdentity
        )
      }
    } catch (projectionError) {
      try {
        this.syncMarkers(prepared.nextState)
      } catch (cleanupError) {
        throw new AggregateError(
          [asError(projectionError), asError(cleanupError)],
          'Provisional marker projection and durable-inventory cleanup both failed.'
        )
      }
      throw new AggregateError(
        [asError(projectionError)],
        'Provisional workspace-lock marker projection failed before WAL commit.'
      )
    }
    return { state: prepared.nextState, byteLength: preparedByteLength }
  }

  private startMarkerRenewal(): void {
    const ordinaryDelay = Math.max(1_000, Math.floor(this.markerLifetimeMs / 2))
    const schedule = (delay: number): void => {
      this.markerRenewalTimer = setTimeout(() => {
        void this.renewDerivedMarkers().then(
          () => schedule(ordinaryDelay),
          (error) => {
            this.projectionErrors = [errorMessage(error)]
            schedule(Math.min(5_000, Math.max(250, Math.floor(this.markerLifetimeMs / 10))))
          }
        )
      }, delay)
      this.markerRenewalTimer.unref?.()
    }
    schedule(ordinaryDelay)
  }

  private snapshotFromState(): WorkspaceLockSnapshot {
    if (!this.bootFence) throw new Error('Workspace-lock authority has not booted.')
    const recoveredCutoff = Date.now() - this.recoveredVisibilityMs
    return {
      authority: { ...this.bootFence },
      sequence: this.state.sequence,
      lastTransitionId: this.state.lastTransitionId,
      leases: this.state.leases
        .filter(
          (lease) =>
            lease.status !== 'recovered' || Date.parse(lease.statusChangedAt) >= recoveredCutoff
        )
        .map(cloneLease),
      projectionErrors: [...this.projectionErrors]
    }
  }

  private walAuthority(): { instanceId: string; generation: number } {
    return {
      instanceId: this.dependencies.instance.instanceId,
      generation: this.generation
    }
  }

  private newFence(generation: number): WorkspaceLockAuthorityFence {
    return {
      instanceId: this.dependencies.instance.instanceId,
      generation,
      pid: this.dependencies.instance.pid,
      processBirthIdentity: this.dependencies.instance.processBirthIdentity,
      fenceId: this.nextId('fence'),
      acquiredAt: this.nowIso()
    }
  }

  private nextId(kind: 'fence' | 'lease' | 'transition'): string {
    const id = this.dependencies.nextId(kind)
    if (!id || /[\u0000\r\n]/.test(id)) {
      throw new Error(`Workspace-lock ${kind} id generator returned an invalid id.`)
    }
    return id
  }

  private nowIso(): string {
    const value = this.dependencies.nowIso()
    if (new Date(value).toISOString() !== value) {
      throw new Error('Workspace-lock clock must return a canonical ISO timestamp.')
    }
    return value
  }
}

function validateInstance(dependencies: WorkspaceLockAuthorityDependencies): void {
  const { instance } = dependencies
  if (
    !instance.instanceId?.trim() ||
    !Number.isSafeInteger(instance.pid) ||
    instance.pid <= 0 ||
    !instance.processBirthIdentity?.trim() ||
    typeof dependencies.resolveTargetPath !== 'function' ||
    typeof dependencies.verifyTargetPath !== 'function'
  ) {
    throw new Error(
      'Workspace-lock authority requires instance identity, exact process observation, and path resolution/verification.'
    )
  }
}

function validateOwner(owner: WorkspaceLockOwner): string | null {
  if (!owner?.lockOwnerId?.trim()) return 'Workspace-lock owner lockOwnerId is required.'
  if (!owner?.runId?.trim()) return 'Workspace-lock owner runId is required.'
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
    return 'Workspace-lock owner PID must be a positive safe integer.'
  }
  if (!owner.processBirthIdentity?.trim()) {
    return 'Workspace-lock owner process-birth identity is required.'
  }
  if (
    owner.lifecycle !== undefined &&
    owner.lifecycle !== 'run' &&
    owner.lifecycle !== 'launching-child' &&
    owner.lifecycle !== 'child'
  ) {
    return 'Workspace-lock owner lifecycle must be run, launching-child, or child when provided.'
  }
  return null
}

function invalidAcquire(
  reason: 'invalid_request' | 'owner_not_live' | 'owner_identity_unavailable' | 'authority_busy',
  message: string
): WorkspaceLockAcquireResult {
  return { ok: false, reason, message }
}

function unchangedRelease(
  state: WorkspaceLockWalState,
  reason: 'foreign_authority' | 'stale_generation' | 'stale_token' | 'foreign_owner',
  message: string
): DurableTransition<WorkspaceLockReleaseResult> {
  return { value: { ok: false, reason, message }, previous: state, next: state }
}

function acquireResult(
  transitionId: string,
  leases: readonly WorkspaceLockLease[]
): WorkspaceLockAcquireResult {
  const copies = leases.map(cloneLease)
  return {
    ok: true,
    transitionId,
    tokens: copies.map(workspaceLockToken),
    leases: copies
  }
}

function replayedDirectRelease(
  state: WorkspaceLockWalState,
  transitionId: string,
  token: WorkspaceLockToken
): WorkspaceLockReleaseResult | null {
  const historical = historicalWalEvent(state, transitionId)
  if (
    !historical ||
    historical.event.kind !== 'release' ||
    historical.event.payload.ownerRunId !== undefined ||
    historical.event.payload.acquiredTransitionId !== undefined ||
    historical.event.payload.leaseIds.length !== 1
  ) {
    return null
  }
  const released = historicalLeases(historical.previous, historical.event.payload.leaseIds)
  if (!released || stableJson(workspaceLockToken(released[0])) !== stableJson(token)) {
    return null
  }
  return { ok: true, transitionId, released }
}

function replayedAcquisitionRelease(
  state: WorkspaceLockWalState,
  transitionId: string,
  ownerRunId: string,
  acquiredTransitionId: string,
  forceApprovalReceiptId?: string,
  expectedLeaseIds?: readonly string[]
): WorkspaceLockReleaseResult | null {
  const historical = historicalWalEvent(state, transitionId)
  if (
    !historical ||
    historical.event.kind !== 'release' ||
    historical.event.payload.ownerRunId !== ownerRunId ||
    historical.event.payload.acquiredTransitionId !== acquiredTransitionId ||
    historical.event.payload.forceApprovalReceiptId !== forceApprovalReceiptId
  ) {
    return null
  }
  const eligible = historical.previous.activeLeases.filter(
    (lease) =>
      lease.owner.runId === ownerRunId &&
      lease.acquiredTransitionId === acquiredTransitionId &&
      (forceApprovalReceiptId !== undefined ||
        (lease.authorityInstanceId === historical.event.authority.instanceId &&
          lease.authorityGeneration === historical.event.authority.generation))
  )
  if (
    !sameStringSet(
      eligible.map((lease) => lease.leaseId),
      historical.event.payload.leaseIds
    )
  ) {
    return null
  }
  if (expectedLeaseIds && !sameStringSet(expectedLeaseIds, historical.event.payload.leaseIds)) {
    return null
  }
  const released = historicalLeases(historical.previous, historical.event.payload.leaseIds)
  return released ? { ok: true, transitionId, released } : null
}

function replayedRunRelease(
  state: WorkspaceLockWalState,
  transitionId: string,
  runId: string,
  forceOrphaned: boolean
): WorkspaceLockReleaseResult | null {
  const historical = historicalWalEvent(state, transitionId)
  if (
    !historical ||
    historical.event.kind !== 'release_run' ||
    historical.event.payload.runId !== runId ||
    historical.event.payload.forceOrphaned !== forceOrphaned
  ) {
    return null
  }
  const retainedIds = historical.event.payload.retainedLeaseIds || []
  const owned = historical.previous.activeLeases.filter((lease) => lease.owner.runId === runId)
  if (
    !sameStringSet(
      owned.map((lease) => lease.leaseId),
      [...historical.event.payload.leaseIds, ...retainedIds]
    )
  ) {
    return null
  }
  const released = historicalLeases(historical.previous, historical.event.payload.leaseIds)
  const retained = historicalLeases(historical.previous, retainedIds)
  if (!released || !retained) return null
  return {
    ok: true,
    transitionId,
    released,
    ...(retained.length ? { retained, retainedReason: retainedReleaseReason(retained) } : {})
  }
}

function historicalWalEvent(
  state: WorkspaceLockWalState,
  transitionId: string
): { event: WorkspaceLockWalEvent; previous: WorkspaceLockWalState } | null {
  return historicalWorkspaceLockWalEvent(state, transitionId)
}

function historicalLeases(
  state: WorkspaceLockWalState,
  leaseIds: readonly string[]
): WorkspaceLockLease[] | null {
  const active = new Map(state.activeLeases.map((lease) => [lease.leaseId, lease]))
  const leases: WorkspaceLockLease[] = []
  for (const leaseId of leaseIds) {
    const lease = active.get(leaseId)
    if (!lease) return null
    leases.push(cloneLease(lease))
  }
  return leases
}

function replayedAcquire(
  state: WorkspaceLockWalState,
  transitionId: string,
  owner: WorkspaceLockOwner,
  claims: readonly CanonicalWorkspaceLockClaim[]
): WorkspaceLockAcquireResult | null {
  const event = state.events.find((candidate) => candidate.transitionId === transitionId)
  if (!event) return null
  if (event.kind !== 'acquire') return null
  const currentLeases = state.activeLeases
    .filter(
      (lease) => lease.acquiredTransitionId === transitionId && sameLeaseOwner(lease.owner, owner)
    )
    .sort(compareLeases)
  if (
    event.payload.leases.every((lease) => sameLeaseOwner(lease.owner, owner)) &&
    sameClaimSet(
      event.payload.leases.map((lease) => lease.claim),
      claims
    ) &&
    sameClaimSet(
      currentLeases.map((lease) => lease.claim),
      claims
    )
  ) {
    return acquireResult(transitionId, currentLeases)
  }
  return null
}

function replayedTransfer(
  state: WorkspaceLockWalState,
  transitionId: string,
  previousOwner: WorkspaceLockOwner,
  previousAcquiredTransitionId: string,
  nextOwner: WorkspaceLockOwner
): WorkspaceLockAcquireResult | null {
  const source = state.events.find(
    (candidate) =>
      candidate.transitionId === previousAcquiredTransitionId && candidate.kind === 'acquire'
  )
  const transfer = state.events.find((candidate) => candidate.transitionId === transitionId)
  if (!source || source.kind !== 'acquire' || !transfer || transfer.kind !== 'acquire') return null
  if (!transfer.payload.replacesLeaseIds) return null
  const sourceIds = source.payload.leases.map((lease) => lease.leaseId).sort()
  const replacedIds = [...transfer.payload.replacesLeaseIds].sort()
  if (
    sourceIds.length !== replacedIds.length ||
    sourceIds.some((leaseId, index) => leaseId !== replacedIds[index]) ||
    !source.payload.leases.every((lease) => sameLeaseOwner(lease.owner, previousOwner)) ||
    !transfer.payload.leases.every((lease) => sameLeaseOwner(lease.owner, nextOwner)) ||
    !transfer.payload.leases.every((lease) =>
      state.activeLeases.some((active) => active.leaseId === lease.leaseId)
    ) ||
    !sameClaimSet(
      source.payload.leases.map((lease) => lease.claim),
      transfer.payload.leases.map((lease) => lease.claim)
    )
  ) {
    return null
  }
  return acquireResult(transitionId, transfer.payload.leases)
}

function ownerMayStillBeLive(
  lease: WorkspaceLockLease,
  observation: WorkspaceLockProcessObservation
): boolean {
  return (
    observation.state === 'identity_unavailable' ||
    (observation.state === 'live' &&
      observation.processBirthIdentity === lease.owner.processBirthIdentity)
  )
}

function retainedReleaseReason(
  retained: readonly WorkspaceLockLease[]
): 'managed_child' | 'launching_child' | 'managed_children' {
  const hasLaunching = retained.some((lease) => lease.owner.lifecycle === 'launching-child')
  const hasManagedChild = retained.some((lease) => lease.owner.lifecycle === 'child')
  if (hasLaunching && hasManagedChild) return 'managed_children'
  return hasLaunching ? 'launching_child' : 'managed_child'
}

function recoveryDecision(
  lease: WorkspaceLockLease,
  observation: WorkspaceLockProcessObservation,
  currentInstanceId: string,
  currentGeneration: number
): WorkspaceLockWalRecoveryDecision | null {
  if (lease.owner.lifecycle === 'launching-child' || lease.owner.lifecycle === 'child') {
    return lease.status === 'recovery_blocked'
      ? null
      : { leaseId: lease.leaseId, status: 'recovery_blocked' }
  }
  if (observation.state === 'dead') {
    return lease.status === 'recovered'
      ? null
      : { leaseId: lease.leaseId, status: 'recovered', reason: 'owner_dead' }
  }
  if (observation.state === 'identity_unavailable') {
    return lease.status === 'recovery_blocked'
      ? null
      : { leaseId: lease.leaseId, status: 'recovery_blocked' }
  }
  if (observation.processBirthIdentity !== lease.owner.processBirthIdentity) {
    return { leaseId: lease.leaseId, status: 'recovered', reason: 'pid_reused' }
  }
  const issuedHere =
    lease.authorityInstanceId === currentInstanceId &&
    lease.authorityGeneration === currentGeneration
  const desired = issuedHere ? 'held' : 'orphan_live'
  if (desired === 'held' || lease.status === desired) return null
  return { leaseId: lease.leaseId, status: desired }
}

function markersForLeases(leases: readonly WorkspaceLockLease[]): WorkspaceLockWalMarker[] {
  const markers = new Map<string, WorkspaceLockWalMarker>()
  for (const lease of leases) {
    const marker: WorkspaceLockWalMarker = {
      worktreeIdentity: lease.claim.worktreeCanonicalPath,
      worktreeObjectIdentity: lease.claim.worktreeObjectIdentity!,
      markerName: workspaceLockRuntimeMarkerFilename(
        lease.authorityInstanceId,
        lease.owner.lockOwnerId
      )
    }
    markers.set(
      markerKey(marker.worktreeIdentity, marker.worktreeObjectIdentity, marker.markerName),
      marker
    )
  }
  return [...markers.values()].sort((left, right) =>
    markerKey(left.worktreeIdentity, left.worktreeObjectIdentity, left.markerName).localeCompare(
      markerKey(right.worktreeIdentity, right.worktreeObjectIdentity, right.markerName)
    )
  )
}

function markerKey(root: string, rootObjectIdentity: string, filename: string): string {
  return `${root}\u0000${rootObjectIdentity}\u0000${filename}`
}

function provisionalLockOwnerId(owner: WorkspaceLockOwner, operationTransitionId: string): string {
  const birthHash = createHash('sha256').update(owner.processBirthIdentity, 'utf8').digest('hex')
  return `${owner.lockOwnerId}::provisional::${operationTransitionId}::${
    owner.lifecycle || 'run'
  }::pid-${owner.pid}::birth-${birthHash}`
}

function deduplicateClaims(
  claims: readonly CanonicalWorkspaceLockClaim[]
): CanonicalWorkspaceLockClaim[] {
  const result: CanonicalWorkspaceLockClaim[] = []
  for (const claim of claims) {
    if (!result.some((candidate) => sameClaim(candidate, claim))) result.push(claim)
  }
  return result
}

function sameClaimSet(
  left: readonly CanonicalWorkspaceLockClaim[],
  right: readonly CanonicalWorkspaceLockClaim[]
): boolean {
  if (left.length !== right.length) return false
  const a = [...left].sort(compareWorkspaceLockClaims)
  const b = [...right].sort(compareWorkspaceLockClaims)
  return a.every((claim, index) => sameClaim(claim, b[index]))
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const a = [...left].sort()
  const b = [...right].sort()
  return a.every((value, index) => value === b[index])
}

function sameClaim(left: CanonicalWorkspaceLockClaim, right: CanonicalWorkspaceLockClaim): boolean {
  return stableJson(left) === stableJson(right)
}

function sameLeaseOwner(left: WorkspaceLockOwner, right: WorkspaceLockOwner): boolean {
  return (
    left.lockOwnerId === right.lockOwnerId &&
    left.runId === right.runId &&
    (left.lifecycle || 'run') === (right.lifecycle || 'run') &&
    left.pid === right.pid &&
    left.processBirthIdentity === right.processBirthIdentity
  )
}

function compareLeases(left: WorkspaceLockLease, right: WorkspaceLockLease): number {
  return (
    compareWorkspaceLockClaims(left.claim, right.claim) ||
    left.owner.runId.localeCompare(right.owner.runId) ||
    (left.owner.laneId || '').localeCompare(right.owner.laneId || '') ||
    left.leaseId.localeCompare(right.leaseId)
  )
}

function cloneOwner(owner: WorkspaceLockOwner): WorkspaceLockOwner {
  return { ...owner }
}

function cloneClaim(claim: CanonicalWorkspaceLockClaim): CanonicalWorkspaceLockClaim {
  return {
    ...claim,
    ...(claim.hunk ? { hunk: { ...claim.hunk } } : {}),
    ...(claim.pathEvidence
      ? {
          pathEvidence: {
            ...claim.pathEvidence,
            targetIdentity:
              claim.pathEvidence.targetIdentity.kind === 'existing'
                ? {
                    ...claim.pathEvidence.targetIdentity,
                    file: { ...claim.pathEvidence.targetIdentity.file }
                  }
                : {
                    ...claim.pathEvidence.targetIdentity,
                    existingAncestor: {
                      ...claim.pathEvidence.targetIdentity.existingAncestor
                    }
                  },
            containment: {
              ...claim.pathEvidence.containment,
              rootIdentity: { ...claim.pathEvidence.containment.rootIdentity },
              existingAncestorIdentity: {
                ...claim.pathEvidence.containment.existingAncestorIdentity
              }
            }
          }
        }
      : {})
  }
}

function cloneLease(lease: WorkspaceLockLease): WorkspaceLockLease {
  return {
    ...lease,
    owner: cloneOwner(lease.owner),
    claim: cloneClaim(lease.claim)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
