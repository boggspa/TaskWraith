/**
 * Inert, one-thread custody model for a reversible compatibility-publication
 * pause. An eventual adapter transfers its existing slots here; this is not
 * an additional production queue. No timers, I/O, retries or ownership grants.
 *
 * Records are opaque immutable references. The caller must supply the genuine
 * ledger target corresponding to each record, and merge CAS/detail/fallback
 * obligations from every returned displaced entry into the retained entry.
 * Nothing here verifies record contents or turns a barrier into a receipt.
 * The adapter must generation-check its own ordinary timers: after resume,
 * their untagged select calls are indistinguishable from a valid new request.
 * Attempt lifecycle belongs here; external re-anchor invalidates the lineage.
 */
import {
  ThreadOwnershipLineage,
  type ThreadOwnershipConfirmation,
  type ThreadOwnershipLineageToken,
  type ThreadOwnershipPublicationAttempt,
  type ThreadOwnershipPublicationTarget
} from '../host/ThreadOwnershipLineage'

export interface HostCompatibilityFenceEntry<RecordRef> {
  readonly record: RecordRef
  readonly target: ThreadOwnershipPublicationTarget
}

declare const pauseBrand: unique symbol
declare const selectionBrand: unique symbol

export interface HostCompatibilityPublicationPause {
  readonly [pauseBrand]: true
  readonly prefixSequence: number
}

export interface HostCompatibilityPublicationSelection<RecordRef> {
  readonly [selectionBrand]: true
  readonly entry: HostCompatibilityFenceEntry<RecordRef>
  readonly attempt: ThreadOwnershipPublicationAttempt
}

export type HostCompatibilityPublicationCustody = 'selected' | 'submitted' | 'uncertain'

export interface HostCompatibilityFenceRetention<RecordRef> {
  readonly retained: HostCompatibilityFenceEntry<RecordRef> | null
  /** Returned synchronously: the adapter still owns these refs and their obligations. */
  readonly displaced: readonly HostCompatibilityFenceEntry<RecordRef>[]
}

export type HostCompatibilityPublicationOutcome =
  | { readonly kind: 'uncertain' }
  /** Caller has definite evidence that this exact attempt did not commit. */
  | { readonly kind: 'not_committed' }
  /** Actual revision from the exact matched success, never copied from input.record. */
  | { readonly kind: 'succeeded'; readonly revision: number }

export type HostCompatibilityFenceSettlement<RecordRef> =
  | { readonly kind: 'stale' }
  | { readonly kind: 'uncertain' }
  | ({ readonly kind: 'retryable' } & HostCompatibilityFenceRetention<RecordRef>)
  | { readonly kind: 'confirmed'; readonly confirmation: ThreadOwnershipConfirmation }
  | { readonly kind: 'reanchor_required' }

interface Flight<RecordRef> {
  readonly selection: HostCompatibilityPublicationSelection<RecordRef>
  custody: HostCompatibilityPublicationCustody
}

export type HostCompatibilityFenceResume<RecordRef> =
  | { readonly kind: 'stale' | 'already_resumed' }
  | (HostCompatibilityFenceRetention<RecordRef> & {
      readonly kind: 'resumed'
      /** Safe to withdraw before enqueue; includes the old CAS base and attempt identity. */
      readonly withdrawn: HostCompatibilityPublicationSelection<RecordRef> | null
      /** Remains owned until a definite outcome. Resume never cancels it. */
      readonly flight: Readonly<Flight<RecordRef>> | null
    })

/**
 * Three bounded slots: one selected/submitted flight, the frozen prefix tail,
 * and the latest successor. Every continuation must present its exact token.
 * Publication is always an explicit select + submitted handoff, never a side
 * effect of stage, settlement, pause or resume.
 */
export class HostCompatibilityPublicationFence<RecordRef> {
  private lineage: ThreadOwnershipLineageToken | null = null
  private latest: HostCompatibilityFenceEntry<RecordRef> | null = null
  private frozen: HostCompatibilityFenceEntry<RecordRef> | null = null
  private flight: Flight<RecordRef> | null = null
  private pauseToken: HostCompatibilityPublicationPause | null = null
  private readonly resumed = new WeakSet<HostCompatibilityPublicationPause>()
  private confirmation: ThreadOwnershipConfirmation | null = null
  private blocked = false

  constructor(
    private readonly threadId: string,
    private readonly ledger: ThreadOwnershipLineage
  ) {
    if (typeof threadId !== 'string' || !threadId)
      throw new Error('A publication fence requires a thread id')
  }

  stage(
    record: RecordRef,
    target: ThreadOwnershipPublicationTarget
  ): HostCompatibilityFenceRetention<RecordRef> {
    if (target.threadId !== this.threadId || (this.lineage && target.lineageToken !== this.lineage))
      throw new Error('Publication fence lineage changed; transfer custody before replacing it')
    this.lineage ??= target.lineageToken
    const incoming = Object.freeze({ record, target })
    const newest = this.latest ?? this.frozen ?? this.flight?.selection.entry ?? null
    const highest = Math.max(
      newest?.target.compatibilitySequence ?? -1,
      this.confirmation?.compatibilitySequence ?? -1
    )
    if (target.compatibilitySequence <= highest) return { retained: newest, displaced: [incoming] }
    const displaced = this.latest ? [this.latest] : []
    this.latest = incoming
    return { retained: incoming, displaced }
  }

  pause(): HostCompatibilityPublicationPause {
    if (this.pauseToken) return this.pauseToken
    const prefixSequence = Math.max(
      this.latest?.target.compatibilitySequence ?? 0,
      this.flight?.selection.entry.target.compatibilitySequence ?? 0,
      this.confirmation?.compatibilitySequence ?? 0
    )
    this.frozen = this.latest
    this.latest = null
    this.pauseToken = Object.freeze({ prefixSequence }) as HostCompatibilityPublicationPause
    return this.pauseToken
  }

  /** While paused, only its exact token may select the frozen prefix; never latest. */
  select(
    expectedRevision: number,
    pause?: HostCompatibilityPublicationPause
  ): HostCompatibilityPublicationSelection<RecordRef> | null {
    if (this.flight || this.blocked || !this.currentLineage()) return null
    if (this.pauseToken ? pause !== this.pauseToken : pause !== undefined) return null
    const entry = this.pauseToken ? this.frozen : this.latest
    if (!entry) return null
    const attempt = this.ledger.beginPublication(entry.target, { expectedRevision })
    if (!attempt) return null
    const selection = Object.freeze({
      entry,
      attempt
    }) as HostCompatibilityPublicationSelection<RecordRef>
    this.flight = { selection, custody: 'selected' }
    if (this.pauseToken) this.frozen = null
    else this.latest = null
    return selection
  }

  /**
   * Final synchronous check immediately before custody crosses enqueue. During
   * a pause even an older detail completion needs the explicit prefix token.
   * Caller must not insert an await between this check and the actual handoff.
   */
  submitted(
    selection: HostCompatibilityPublicationSelection<RecordRef>,
    pause?: HostCompatibilityPublicationPause
  ): boolean {
    if (this.flight?.selection !== selection || this.flight.custody !== 'selected') return false
    if (this.blocked || !this.currentLineage()) return false
    if (this.pauseToken ? pause !== this.pauseToken : pause !== undefined) return false
    this.flight.custody = 'submitted'
    return true
  }

  settle(
    selection: HostCompatibilityPublicationSelection<RecordRef>,
    outcome: HostCompatibilityPublicationOutcome
  ): HostCompatibilityFenceSettlement<RecordRef> {
    if (this.flight?.selection !== selection) return { kind: 'stale' }
    if (outcome.kind === 'uncertain') {
      if (this.flight.custody === 'selected') return { kind: 'stale' }
      this.flight.custody = 'uncertain'
      return { kind: 'uncertain' }
    }
    if (outcome.kind === 'not_committed') {
      this.ledger.publicationAbandoned(selection.attempt)
      this.flight = null
      const slot = this.pauseToken ? 'frozen' : 'latest'
      const retained = this.retainNewest([selection.entry, this[slot]])
      this[slot] = retained.retained
      return { kind: 'retryable', ...retained }
    }
    if (this.flight.custody === 'selected') return { kind: 'stale' }
    const confirmation = this.ledger.publicationSucceeded(selection.attempt, {
      revision: outcome.revision
    })
    this.flight = null
    if (!confirmation) {
      this.blocked = true
      return { kind: 'reanchor_required' }
    }
    this.confirmation = confirmation
    return { kind: 'confirmed', confirmation }
  }

  /**
   * Exact receipt evidence only; an empty prefix has no synthetic confirmation.
   * This is not claim-ready: a newer unmarked journal head still needs source
   * admission, publication and confirmation before claiming that exact head.
   */
  prefixConfirmed(pause: HostCompatibilityPublicationPause): ThreadOwnershipConfirmation | null {
    if (pause !== this.pauseToken || this.blocked || !this.currentLineage()) return null
    if (this.flight || this.frozen) return null
    return this.confirmation && this.confirmation.compatibilitySequence >= pause.prefixSequence
      ? this.confirmation
      : null
  }

  /**
   * Release this pause only. A pre-enqueue selection is withdrawn; an enqueued
   * or uncertain flight remains. Newest body wins, but displaced refs are handed
   * back for the adapter's debt/base merge before it selects anything again.
   */
  resume(pause: HostCompatibilityPublicationPause): HostCompatibilityFenceResume<RecordRef> {
    if (pause !== this.pauseToken)
      return { kind: this.resumed.has(pause) ? 'already_resumed' : 'stale' }
    let withdrawn: HostCompatibilityPublicationSelection<RecordRef> | null = null
    if (this.flight?.custody === 'selected') {
      withdrawn = this.flight.selection
      this.ledger.publicationAbandoned(withdrawn.attempt)
      this.flight = null
    }
    const retained = this.retainNewest([withdrawn?.entry ?? null, this.frozen, this.latest])
    this.latest = retained.retained
    this.frozen = null
    this.pauseToken = null
    this.resumed.add(pause)
    return {
      kind: 'resumed',
      ...retained,
      withdrawn,
      flight: this.flight ? Object.freeze({ ...this.flight }) : null
    }
  }

  snapshot(): {
    paused: boolean
    blocked: boolean
    cutoff: number | null
    flight: { sequence: number; custody: HostCompatibilityPublicationCustody } | null
    frozenSequence: number | null
    latestSequence: number | null
    retainedRecords: number
  } {
    return {
      paused: this.pauseToken !== null,
      blocked: this.blocked,
      cutoff: this.pauseToken?.prefixSequence ?? null,
      flight: this.flight
        ? {
            sequence: this.flight.selection.entry.target.compatibilitySequence,
            custody: this.flight.custody
          }
        : null,
      frozenSequence: this.frozen?.target.compatibilitySequence ?? null,
      latestSequence: this.latest?.target.compatibilitySequence ?? null,
      retainedRecords:
        Number(this.flight !== null) + Number(this.frozen !== null) + Number(this.latest !== null)
    }
  }

  private currentLineage(): boolean {
    return (
      this.lineage !== null &&
      this.ledger.capturePublicationTarget(this.threadId)?.lineageToken === this.lineage
    )
  }

  private retainNewest(
    entries: readonly (HostCompatibilityFenceEntry<RecordRef> | null)[]
  ): HostCompatibilityFenceRetention<RecordRef> {
    const present = entries.filter(
      (entry): entry is HostCompatibilityFenceEntry<RecordRef> => entry !== null
    )
    const retained = present.reduce<HostCompatibilityFenceEntry<RecordRef> | null>(
      (latest, entry) =>
        !latest || entry.target.compatibilitySequence > latest.target.compatibilitySequence
          ? entry
          : latest,
      null
    )
    return { retained, displaced: present.filter((entry) => entry !== retained) }
  }
}
