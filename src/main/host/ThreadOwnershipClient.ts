/**
 * Desktop-side negotiation of thread ownership, without activating it.
 *
 * A network grant is not permission to append: the integration must first
 * settle the old save path, prove the log's lineage and durably write the
 * authority file. This client only retains the grant and the confirmed facts
 * it was requested against. It writes no files and exposes no append gate.
 *
 * The caller owns the persistent transport and tells this client about every
 * welcome and disconnect, including deliberate closes. A reconnect to the
 * same Host still means a different socket, so the local connection counter
 * fences replies independently of the Host's boot epoch. Future owned copies
 * must use this same connection, not a broker that silently reconnects.
 */
import {
  HostProjectionTransportError,
  type HostProjectionClient
} from '../../host-client/HostProjectionClient'
import {
  DesktopThreadClaims,
  type ThreadClaimRefusalReason,
  type ThreadOwnerEpoch
} from '../../host-shared/thread-log/ThreadOwnership'
import type { HostBootstrapWelcome } from '../../shared/hostProtocol'

export interface ThreadOwnershipClaimFacts {
  /** Last Host full-copy revision confirmed by an acknowledgment or re-anchor. */
  readonly baseRevision: number
  readonly headRevision: number
  /** Caller-owned identity for this exact log lineage, not a revision number. */
  readonly lineageToken: object
}

/** A Host answer only; it has not made the thread safe to append to. */
export interface ThreadOwnershipNetworkGrant {
  readonly threadId: string
  readonly epoch: ThreadOwnerEpoch
  readonly facts: ThreadOwnershipClaimFacts
}

type UnavailableReason =
  | 'disabled'
  | 'disconnected'
  | 'missing_boot_epoch'
  | 'unsupported'
  | 'host_disabled'

export type ThreadOwnershipClaimOutcome =
  | { readonly kind: 'network_grant'; readonly grant: ThreadOwnershipNetworkGrant }
  | {
      readonly kind: 'not_requested'
      readonly reason: UnavailableReason | 'no_confirmed_base' | 'retry_pending'
    }
  | {
      readonly kind: 'refused'
      readonly reason: ThreadClaimRefusalReason
      readonly revision: number | null
    }
  | { readonly kind: 'stale' }
  | { readonly kind: 'failed' }

export type ThreadOwnershipNegotiationState =
  | { readonly kind: 'unclaimed' }
  | { readonly kind: 'claiming' }
  | Extract<ThreadOwnershipClaimOutcome, { kind: 'network_grant' }>

export interface ThreadOwnershipClientOptions {
  readonly enabled: boolean
  /** New for this app process; never inferred from the shared Desktop actor. */
  readonly writerId: string
  readonly transport: Pick<HostProjectionClient, 'requestThreadOwner'>
  /** Null until this process has a confirmed Host base for the thread. */
  readClaimFacts(threadId: string): ThreadOwnershipClaimFacts | null
  readonly now?: () => number
}

function copyFacts(facts: ThreadOwnershipClaimFacts): ThreadOwnershipClaimFacts {
  const { baseRevision, headRevision, lineageToken } = facts
  if (
    !Number.isSafeInteger(baseRevision) ||
    baseRevision < 0 ||
    !Number.isSafeInteger(headRevision) ||
    headRevision < baseRevision
  ) {
    throw new Error('Invalid confirmed claim revisions')
  }
  return Object.freeze({ baseRevision, headRevision, lineageToken })
}

export class ThreadOwnershipClient {
  private readonly claims: DesktopThreadClaims
  private readonly grants = new Map<string, ThreadOwnershipNetworkGrant>()
  private readonly now: () => number
  private connection = 0
  private unavailable: UnavailableReason | null

  constructor(private readonly options: ThreadOwnershipClientOptions) {
    this.claims = new DesktopThreadClaims({ writerId: options.writerId })
    this.now = options.now ?? Date.now
    this.unavailable = options.enabled ? 'disconnected' : 'disabled'
  }

  /** Every welcome starts a fresh connection, even if the Host did not restart. */
  onWelcome(welcome: Pick<HostBootstrapWelcome, 'bootEpoch'>): void {
    this.dropConnection()
    if (!this.options.enabled) return
    if (!welcome.bootEpoch) {
      this.unavailable = 'missing_boot_epoch'
      return
    }
    this.claims.hostChanged(welcome.bootEpoch)
    this.unavailable = null
  }

  /** Includes intentional closes: transport close() does not emit disconnected. */
  onDisconnected(): void {
    this.dropConnection()
  }

  stateOf(threadId: string): ThreadOwnershipNegotiationState {
    const grant = this.grants.get(threadId)
    if (grant) return { kind: 'network_grant', grant }
    return { kind: this.claims.stateOf(threadId) === 'claiming' ? 'claiming' : 'unclaimed' }
  }

  /** One caller-driven attempt; no timer, reconnect, file write or save suppression. */
  async requestClaim(threadId: string): Promise<ThreadOwnershipClaimOutcome> {
    if (this.unavailable) return { kind: 'not_requested', reason: this.unavailable }
    const held = this.grants.get(threadId)
    if (held) return { kind: 'network_grant', grant: held }
    const currentFacts = this.options.readClaimFacts(threadId)
    if (!currentFacts) return { kind: 'not_requested', reason: 'no_confirmed_base' }
    const facts = copyFacts(currentFacts)
    const request = this.claims.claim(threadId, facts, this.now())
    if (!request) return { kind: 'not_requested', reason: 'retry_pending' }
    const connection = this.connection
    try {
      const result = await this.options.transport.requestThreadOwner({
        action: request.action,
        threadId: request.threadId,
        writerId: request.writerId,
        claimId: request.claimId,
        baseRevision: request.baseRevision,
        headRevision: request.headRevision
      })
      if (connection !== this.connection) return { kind: 'stale' }
      if (
        result.action !== 'claim' ||
        result.reply.threadId !== threadId ||
        result.reply.claimId !== request.claimId
      )
        return { kind: 'failed' }
      const outcome = this.claims.claimReply(result.reply)
      if (outcome.kind === 'ignored') return { kind: 'stale' }
      if (outcome.kind === 'refused') {
        if (outcome.reason === 'disabled') this.unavailable = 'host_disabled'
        return outcome
      }
      const grant = Object.freeze({
        threadId,
        epoch: Object.freeze({ ...outcome.epoch }),
        facts
      })
      this.grants.set(threadId, grant)
      return { kind: 'network_grant', grant }
    } catch (error) {
      if (connection !== this.connection) return { kind: 'stale' }
      if (error instanceof HostProjectionTransportError && error.code === 'unknown_request_kind') {
        this.unavailable = 'unsupported'
        return { kind: 'not_requested', reason: 'unsupported' }
      }
      return { kind: 'failed' }
    }
  }

  private dropConnection(): void {
    this.connection += 1
    this.claims.hostChanged(null)
    this.grants.clear()
    this.unavailable = this.options.enabled ? 'disconnected' : 'disabled'
  }
}
