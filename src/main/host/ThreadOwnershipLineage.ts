/**
 * Confirmed Host prefixes and local logical lineages, without touching records.
 *
 * The caller supplies facts only after the corresponding operation happened.
 * A completed barrier is not a Host confirmation: a publication success must
 * name the exact minted attempt and the actual revision of its matched durable
 * receipt. An unexpected revision requires a verified Host re-anchor.
 *
 * Replacements always mint a new lineage, even at the same revision. Ordinary
 * appends and verified equivalent compaction keep it. This distinguishes two
 * different records carrying the same number without cloning or hashing them.
 * These facts do not grant ownership or permission to append.
 */

declare const lineageBrand: unique symbol
declare const targetBrand: unique symbol
declare const attemptBrand: unique symbol
declare const confirmationBrand: unique symbol
declare const candidateBrand: unique symbol

export interface ThreadOwnershipLineageToken {
  readonly [lineageBrand]: true
}

export interface ThreadOwnershipPublicationAttempt {
  readonly [attemptBrand]: true
  readonly targetToken: ThreadOwnershipPublicationTarget
  readonly threadId: string
  readonly lineageToken: ThreadOwnershipLineageToken
  readonly expectedRevision: number
  readonly revision: number
  readonly compatibilitySequence: number
}

/** The record prefix selected for publication, before another append may replace it. */
export interface ThreadOwnershipPublicationTarget {
  readonly [targetBrand]: true
  readonly threadId: string
  readonly lineageToken: ThreadOwnershipLineageToken
  readonly revision: number
  readonly compatibilitySequence: number
}

export interface ThreadOwnershipConfirmation {
  readonly [confirmationBrand]: true
  readonly threadId: string
  readonly lineageToken: ThreadOwnershipLineageToken
  readonly revision: number
  readonly compatibilitySequence: number
  /** Null only for an explicitly verified Host read and completed re-anchor. */
  readonly publicationAttempt: ThreadOwnershipPublicationAttempt | null
}

export interface ThreadOwnershipPromotionCandidate {
  readonly [candidateBrand]: true
  readonly threadId: string
  readonly lineageToken: ThreadOwnershipLineageToken
  readonly confirmationToken: ThreadOwnershipConfirmation
  readonly confirmedHostRevision: number
  readonly headRevision: number
  readonly compatibilitySequence: number
  readonly connectionToken: object
}

interface ThreadLineage {
  readonly token: ThreadOwnershipLineageToken
  headRevision: number
  compatibilitySequence: number
  confirmation: ThreadOwnershipConfirmation | null
  publication: ThreadOwnershipPublicationAttempt | null
  requiresReanchor: boolean
}

function count(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid lineage revision or sequence')
}

function threadId(value: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Invalid lineage thread id')
}

export class ThreadOwnershipLineage {
  private readonly threads = new Map<string, ThreadLineage>()
  /** Targets are retained by the caller's bounded publication slots, not by this ledger. */
  private readonly targets = new WeakSet<ThreadOwnershipPublicationTarget>()
  /** Weak keys retain no history of candidates their callers have dropped. */
  private readonly candidates = new WeakMap<ThreadOwnershipPromotionCandidate, number>()
  private connection: object | null = null
  private connectionSerial = 0

  /** Every call denotes a new connection lifetime, even if the token is reused. */
  connectionChanged(token: object | null): void {
    this.connection = token
    this.connectionSerial += 1
  }

  /** Replacement/rebase/external adoption: equal revisions do not preserve lineage. */
  replaceUnconfirmed(
    id: string,
    facts: { readonly headRevision: number; readonly compatibilitySequence: number }
  ): ThreadOwnershipLineageToken {
    threadId(id)
    count(facts.headRevision)
    count(facts.compatibilitySequence)
    const token = Object.freeze({}) as ThreadOwnershipLineageToken
    this.threads.set(id, {
      token,
      headRevision: facts.headRevision,
      compatibilitySequence: facts.compatibilitySequence,
      confirmation: null,
      publication: null,
      requiresReanchor: this.threads.get(id)?.requiresReanchor ?? false
    })
    return token
  }

  /** Only after the exact Host record was verified and the local log re-anchored to it. */
  reanchorFromConfirmedHost(
    id: string,
    facts: { readonly revision: number; readonly compatibilitySequence: number }
  ): ThreadOwnershipLineageToken {
    const token = this.replaceUnconfirmed(id, {
      headRevision: facts.revision,
      compatibilitySequence: facts.compatibilitySequence
    })
    const state = this.threads.get(id)!
    state.requiresReanchor = false
    state.confirmation = Object.freeze({
      threadId: id,
      lineageToken: token,
      revision: facts.revision,
      compatibilitySequence: facts.compatibilitySequence,
      publicationAttempt: null
    }) as ThreadOwnershipConfirmation
    return token
  }

  /** Record a completed append; this method performs no append or admission. */
  appended(
    id: string,
    facts: {
      readonly lineageToken: ThreadOwnershipLineageToken
      readonly baseRevision: number
      readonly headRevision: number
      readonly compatibilitySequence: number
    }
  ): boolean {
    count(facts.baseRevision)
    count(facts.headRevision)
    count(facts.compatibilitySequence)
    const state = this.threads.get(id)
    if (
      !state ||
      state.token !== facts.lineageToken ||
      state.headRevision !== facts.baseRevision ||
      facts.headRevision <= facts.baseRevision ||
      facts.compatibilitySequence <= state.compatibilitySequence
    )
      return false
    state.headRevision = facts.headRevision
    state.compatibilitySequence = facts.compatibilitySequence
    return true
  }

  /** Caller already proved equivalent contents; physical file changes do not change this token. */
  noteEquivalentCompaction(id: string, token: ThreadOwnershipLineageToken): boolean {
    return this.threads.get(id)?.token === token
  }

  /** Capture while this record is selected; it may wait behind an earlier publication. */
  capturePublicationTarget(id: string): ThreadOwnershipPublicationTarget | null {
    const state = this.threads.get(id)
    if (!state) return null
    const target = Object.freeze({
      threadId: id,
      lineageToken: state.token,
      revision: state.headRevision,
      compatibilitySequence: state.compatibilitySequence
    }) as ThreadOwnershipPublicationTarget
    this.targets.add(target)
    return target
  }

  /** Begin the selected prefix, possibly after later appends, against the now-confirmed base. */
  beginPublication(
    target: ThreadOwnershipPublicationTarget,
    facts: { readonly expectedRevision: number }
  ): ThreadOwnershipPublicationAttempt | null {
    count(facts.expectedRevision)
    if (!this.targets.has(target)) return null
    const state = this.threads.get(target.threadId)
    if (
      !state ||
      state.publication ||
      state.requiresReanchor ||
      state.token !== target.lineageToken ||
      target.revision > state.headRevision ||
      target.compatibilitySequence > state.compatibilitySequence ||
      facts.expectedRevision > target.revision ||
      (state.confirmation && state.confirmation.revision !== facts.expectedRevision)
    )
      return null
    const attempt = Object.freeze({
      targetToken: target,
      threadId: target.threadId,
      lineageToken: target.lineageToken,
      expectedRevision: facts.expectedRevision,
      revision: target.revision,
      compatibilitySequence: target.compatibilitySequence
    }) as ThreadOwnershipPublicationAttempt
    state.publication = attempt
    return attempt
  }

  /**
   * Caller verified that this exact attempt durably succeeded. Supply the
   * actual Host revision, never the optimistic input revision or barrier result.
   * A late acknowledgement can confirm an earlier prefix after further appends.
   */
  publicationSucceeded(
    attempt: ThreadOwnershipPublicationAttempt,
    receipt: { readonly revision: number }
  ): ThreadOwnershipConfirmation | null {
    count(receipt.revision)
    const state = this.threads.get(attempt.threadId)
    if (!state || state.publication !== attempt || state.token !== attempt.lineageToken) return null
    state.publication = null
    if (receipt.revision !== attempt.revision) {
      state.confirmation = null
      state.requiresReanchor = true
      return null
    }
    const confirmation = Object.freeze({
      threadId: attempt.threadId,
      lineageToken: attempt.lineageToken,
      revision: receipt.revision,
      compatibilitySequence: attempt.compatibilitySequence,
      publicationAttempt: attempt
    }) as ThreadOwnershipConfirmation
    state.confirmation = confirmation
    return confirmation
  }

  /** Ending a failed/cancelled attempt cannot acknowledge it or a later retry. */
  publicationAbandoned(attempt: ThreadOwnershipPublicationAttempt): boolean {
    const state = this.threads.get(attempt.threadId)
    if (!state || state.publication !== attempt) return false
    state.publication = null
    return true
  }

  requiresReanchor(id: string): boolean {
    return this.threads.get(id)?.requiresReanchor ?? false
  }

  /** Immutable negotiation facts; these do not prove publication quiescence or append readiness. */
  captureCandidate(id: string): ThreadOwnershipPromotionCandidate | null {
    const state = this.threads.get(id)
    if (!state?.confirmation || state.requiresReanchor || !this.connection) return null
    const candidate = Object.freeze({
      threadId: id,
      lineageToken: state.token,
      confirmationToken: state.confirmation,
      confirmedHostRevision: state.confirmation.revision,
      headRevision: state.headRevision,
      compatibilitySequence: state.compatibilitySequence,
      connectionToken: this.connection
    }) as ThreadOwnershipPromotionCandidate
    this.candidates.set(candidate, this.connectionSerial)
    return candidate
  }

  /** Exact captured facts: a later append, confirmation, replacement or reconnect invalidates them. */
  candidateIsCurrent(candidate: ThreadOwnershipPromotionCandidate): boolean {
    if (this.candidates.get(candidate) !== this.connectionSerial) return false
    const state = this.threads.get(candidate.threadId)
    return Boolean(
      state &&
      !state.requiresReanchor &&
      state.token === candidate.lineageToken &&
      state.confirmation === candidate.confirmationToken &&
      state.headRevision === candidate.headRevision &&
      state.compatibilitySequence === candidate.compatibilitySequence &&
      this.connection === candidate.connectionToken
    )
  }

  /** Erased or retired threads retain no strong ledger state or live attempt. */
  forget(id: string): boolean {
    return this.threads.delete(id)
  }

  snapshot(): { threads: number; confirmedThreads: number; activePublications: number } {
    let confirmedThreads = 0
    let activePublications = 0
    for (const state of this.threads.values()) {
      if (state.confirmation) confirmedThreads += 1
      if (state.publication) activePublications += 1
    }
    return { threads: this.threads.size, confirmedThreads, activePublications }
  }
}
