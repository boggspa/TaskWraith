import { describe, expect, it } from 'vitest'

import { ThreadOwnershipLineage } from './ThreadOwnershipLineage'

function confirmed() {
  const ledger = new ThreadOwnershipLineage()
  const connection = {}
  ledger.connectionChanged(connection)
  const lineage = ledger.reanchorFromConfirmedHost('thread', {
    revision: 7,
    compatibilitySequence: 10
  })
  return { ledger, connection, lineage }
}

describe('ThreadOwnershipLineage', () => {
  it('starts empty and never infers confirmation from an optimistic head', () => {
    const ledger = new ThreadOwnershipLineage()
    ledger.connectionChanged({})
    expect(ledger.snapshot()).toEqual({ threads: 0, confirmedThreads: 0, activePublications: 0 })
    ledger.replaceUnconfirmed('thread', { headRevision: 20, compatibilitySequence: 4 })
    expect(ledger.captureCandidate('thread')).toBeNull()
    expect(ledger.snapshot()).toEqual({ threads: 1, confirmedThreads: 0, activePublications: 0 })
  })

  it('bootstraps confirmation from an exact successful publication without a prior Host confirmation', () => {
    const ledger = new ThreadOwnershipLineage()
    ledger.connectionChanged({})
    ledger.replaceUnconfirmed('thread', { headRevision: 20, compatibilitySequence: 4 })
    const target = ledger.capturePublicationTarget('thread')!
    expect(ledger.beginPublication(target, { expectedRevision: 21 })).toBeNull()
    const attempt = ledger.beginPublication(target, { expectedRevision: 17 })!
    expect(attempt).not.toBeNull()
    expect(ledger.captureCandidate('thread')).toBeNull()
    const confirmation = ledger.publicationSucceeded(attempt, { revision: 20 })!
    expect(ledger.captureCandidate('thread')).toMatchObject({
      confirmationToken: confirmation,
      confirmedHostRevision: 20,
      headRevision: 20
    })
  })

  it('binds a successful publication to its captured prefix while later appends continue', () => {
    const { ledger, lineage, connection } = confirmed()
    expect(
      ledger.appended('thread', {
        lineageToken: lineage,
        baseRevision: 7,
        headRevision: 8,
        compatibilitySequence: 11
      })
    ).toBe(true)
    const attempt = ledger.beginPublication(ledger.capturePublicationTarget('thread')!, {
      expectedRevision: 7
    })!
    expect(attempt).toMatchObject({
      threadId: 'thread',
      lineageToken: lineage,
      expectedRevision: 7,
      revision: 8,
      compatibilitySequence: 11
    })
    expect(
      ledger.appended('thread', {
        lineageToken: lineage,
        baseRevision: 8,
        headRevision: 9,
        compatibilitySequence: 12
      })
    ).toBe(true)
    const confirmation = ledger.publicationSucceeded(attempt, { revision: attempt.revision })!
    expect(confirmation).toMatchObject({
      threadId: 'thread',
      lineageToken: lineage,
      revision: 8,
      compatibilitySequence: 11
    })
    const candidate = ledger.captureCandidate('thread')!
    expect(candidate).toMatchObject({
      lineageToken: lineage,
      confirmationToken: confirmation,
      confirmedHostRevision: 8,
      headRevision: 9,
      compatibilitySequence: 12,
      connectionToken: connection
    })
    expect(ledger.candidateIsCurrent(candidate)).toBe(true)
    expect(
      ledger.appended('thread', {
        lineageToken: lineage,
        baseRevision: 9,
        headRevision: 10,
        compatibilitySequence: 13
      })
    ).toBe(true)
    expect(ledger.candidateIsCurrent(candidate)).toBe(false)
    expect(ledger.captureCandidate('thread')?.lineageToken).toBe(lineage)
    expect(ledger.snapshot().activePublications).toBe(0)
  })

  it('starts captured pending B after A settles while local head C continues', () => {
    const { ledger, lineage } = confirmed()
    const append = (baseRevision: number, headRevision: number, compatibilitySequence: number) => {
      expect(
        ledger.appended('thread', {
          lineageToken: lineage,
          baseRevision,
          headRevision,
          compatibilitySequence
        })
      ).toBe(true)
    }
    append(7, 8, 11)
    const targetA = ledger.capturePublicationTarget('thread')!
    const attemptA = ledger.beginPublication(targetA, { expectedRevision: 7 })!
    append(8, 9, 12)
    const targetB = ledger.capturePublicationTarget('thread')!
    append(9, 10, 13)
    expect(ledger.beginPublication(targetB, { expectedRevision: 7 })).toBeNull()
    expect(ledger.publicationSucceeded(attemptA, { revision: 8 })?.revision).toBe(8)
    const attemptB = ledger.beginPublication(targetB, { expectedRevision: 8 })!
    expect(attemptB.targetToken).toBe(targetB)
    expect(attemptB).toMatchObject({ revision: 9, compatibilitySequence: 12 })
    expect(ledger.publicationSucceeded(attemptB, { revision: 9 })?.revision).toBe(9)
    expect(ledger.captureCandidate('thread')).toMatchObject({
      confirmedHostRevision: 9,
      headRevision: 10,
      compatibilitySequence: 13
    })
    expect(ledger.snapshot().activePublications).toBe(0)
  })

  it('rejects cloned, foreign and old-lineage publication targets', () => {
    const { ledger } = confirmed()
    const target = ledger.capturePublicationTarget('thread')!
    expect(Object.isFrozen(target)).toBe(true)
    expect(ledger.beginPublication({ ...target }, { expectedRevision: 7 })).toBeNull()
    const other = confirmed().ledger
    expect(other.beginPublication(target, { expectedRevision: 7 })).toBeNull()
    ledger.reanchorFromConfirmedHost('thread', { revision: 7, compatibilitySequence: 10 })
    expect(ledger.beginPublication(target, { expectedRevision: 7 })).toBeNull()
    expect(ledger.snapshot().activePublications).toBe(0)
  })

  it('mints immutable attempt, confirmation and candidate tokens', () => {
    const { ledger, lineage } = confirmed()
    const input = { expectedRevision: 7 }
    const attempt = ledger.beginPublication(ledger.capturePublicationTarget('thread')!, input)!
    input.expectedRevision = 99
    expect(attempt.expectedRevision).toBe(7)
    const confirmation = ledger.publicationSucceeded(attempt, { revision: attempt.revision })!
    const candidate = ledger.captureCandidate('thread')!
    expect([lineage, attempt, confirmation, candidate].every(Object.isFrozen)).toBe(true)
    expect(candidate.confirmationToken).toBe(confirmation)
    expect('owns' in ledger || 'canAppend' in ledger || 'ready' in ledger).toBe(false)
  })

  it('keeps at most one live publication per thread and consumes it exactly once', () => {
    const { ledger } = confirmed()
    const first = ledger.beginPublication(ledger.capturePublicationTarget('thread')!, {
      expectedRevision: 7
    })!
    expect(
      ledger.beginPublication(ledger.capturePublicationTarget('thread')!, { expectedRevision: 7 })
    ).toBeNull()
    expect(ledger.snapshot().activePublications).toBe(1)
    expect(ledger.publicationSucceeded(first, { revision: first.revision })).not.toBeNull()
    expect(ledger.publicationSucceeded(first, { revision: first.revision })).toBeNull()
    expect(ledger.publicationAbandoned(first)).toBe(false)
    expect(ledger.snapshot().activePublications).toBe(0)
  })

  it('abandons an attempt without granting confirmation and rejects its late success', () => {
    const ledger = new ThreadOwnershipLineage()
    ledger.replaceUnconfirmed('new', { headRevision: 0, compatibilitySequence: 1 })
    const old = ledger.beginPublication(ledger.capturePublicationTarget('new')!, {
      expectedRevision: 0
    })!
    expect(ledger.publicationAbandoned(old)).toBe(true)
    expect(ledger.publicationSucceeded(old, { revision: old.revision })).toBeNull()
    expect(ledger.snapshot().confirmedThreads).toBe(0)
    const next = ledger.beginPublication(ledger.capturePublicationTarget('new')!, {
      expectedRevision: 0
    })!
    expect(next).not.toBe(old)
    expect(ledger.publicationSucceeded(next, { revision: next.revision })?.revision).toBe(0)
    expect(ledger.snapshot()).toEqual({ threads: 1, confirmedThreads: 1, activePublications: 0 })
  })

  it.each(['replace', 'reanchor', 'erase'] as const)(
    'rejects a late success after %s, including identical revision numbers',
    (change) => {
      const { ledger, lineage } = confirmed()
      const oldCandidate = ledger.captureCandidate('thread')!
      const attempt = ledger.beginPublication(ledger.capturePublicationTarget('thread')!, {
        expectedRevision: 7
      })!
      const next =
        change === 'replace'
          ? ledger.replaceUnconfirmed('thread', { headRevision: 7, compatibilitySequence: 10 })
          : change === 'reanchor'
            ? ledger.reanchorFromConfirmedHost('thread', { revision: 7, compatibilitySequence: 10 })
            : (ledger.forget('thread'),
              ledger.replaceUnconfirmed('thread', { headRevision: 7, compatibilitySequence: 10 }))
      expect(next).not.toBe(lineage)
      expect(ledger.publicationSucceeded(attempt, { revision: attempt.revision })).toBeNull()
      expect(ledger.candidateIsCurrent(oldCandidate)).toBe(false)
      expect(ledger.snapshot().activePublications).toBe(0)
      expect(ledger.snapshot().confirmedThreads).toBe(change === 'reanchor' ? 1 : 0)
    }
  )

  it('retains logical identity and a pending publication through verified equivalent compaction', () => {
    const { ledger, lineage } = confirmed()
    const candidate = ledger.captureCandidate('thread')!
    const attempt = ledger.beginPublication(ledger.capturePublicationTarget('thread')!, {
      expectedRevision: 7
    })!
    expect(ledger.noteEquivalentCompaction('thread', lineage)).toBe(true)
    expect(ledger.candidateIsCurrent(candidate)).toBe(true)
    expect(ledger.publicationSucceeded(attempt, { revision: attempt.revision })?.lineageToken).toBe(
      lineage
    )
    expect(ledger.noteEquivalentCompaction('thread', {} as typeof lineage)).toBe(false)
  })

  it('invalidates exact candidates on every connection change, including token reuse', () => {
    const { ledger, connection } = confirmed()
    const first = ledger.captureCandidate('thread')!
    ledger.connectionChanged(null)
    expect(ledger.captureCandidate('thread')).toBeNull()
    expect(ledger.candidateIsCurrent(first)).toBe(false)
    ledger.connectionChanged(connection)
    expect(ledger.candidateIsCurrent(first)).toBe(false)
    const second = ledger.captureCandidate('thread')!
    ledger.connectionChanged(connection)
    expect(ledger.candidateIsCurrent(second)).toBe(false)
    const nextConnection = {}
    ledger.connectionChanged(nextConnection)
    const third = ledger.captureCandidate('thread')!
    expect(third.connectionToken).toBe(nextConnection)
    expect(ledger.candidateIsCurrent(third)).toBe(true)
  })

  it('a newer confirmation invalidates the earlier exact candidate without changing lineage', () => {
    const { ledger, lineage } = confirmed()
    const candidate = ledger.captureCandidate('thread')!
    const attempt = ledger.beginPublication(ledger.capturePublicationTarget('thread')!, {
      expectedRevision: 7
    })!
    const confirmedAgain = ledger.publicationSucceeded(attempt, { revision: attempt.revision })!
    expect(ledger.candidateIsCurrent(candidate)).toBe(false)
    const next = ledger.captureCandidate('thread')!
    expect(next.lineageToken).toBe(lineage)
    expect(next.confirmationToken).toBe(confirmedAgain)
  })

  it('rejects copied attempt and candidate objects even when all fields match', () => {
    const { ledger } = confirmed()
    const attempt = ledger.beginPublication(ledger.capturePublicationTarget('thread')!, {
      expectedRevision: 7
    })!
    expect(ledger.publicationSucceeded({ ...attempt }, { revision: attempt.revision })).toBeNull()
    expect(ledger.snapshot().activePublications).toBe(1)
    const candidate = ledger.captureCandidate('thread')!
    expect(ledger.candidateIsCurrent({ ...candidate })).toBe(false)
    expect(ledger.publicationSucceeded(attempt, { revision: attempt.revision })).not.toBeNull()
  })

  it('rejects stale-lineage and skipped-base appends without changing current facts', () => {
    const { ledger, lineage } = confirmed()
    const candidate = ledger.captureCandidate('thread')!
    expect(
      ledger.appended('thread', {
        lineageToken: {} as typeof lineage,
        baseRevision: 7,
        headRevision: 8,
        compatibilitySequence: 11
      })
    ).toBe(false)
    expect(
      ledger.appended('thread', {
        lineageToken: lineage,
        baseRevision: 6,
        headRevision: 8,
        compatibilitySequence: 11
      })
    ).toBe(false)
    expect(
      ledger.appended('thread', {
        lineageToken: lineage,
        baseRevision: 7,
        headRevision: 8,
        compatibilitySequence: 10
      })
    ).toBe(false)
    expect(ledger.candidateIsCurrent(candidate)).toBe(true)
  })

  it('rejects a publication whose expected base contradicts its confirmed Host base', () => {
    const { ledger } = confirmed()
    expect(
      ledger.beginPublication(ledger.capturePublicationTarget('thread')!, { expectedRevision: 6 })
    ).toBeNull()
    expect(
      ledger.beginPublication(ledger.capturePublicationTarget('thread')!, { expectedRevision: 8 })
    ).toBeNull()
    expect(ledger.snapshot().activePublications).toBe(0)
    expect(ledger.capturePublicationTarget('missing')).toBeNull()
  })

  it.each([
    { localRevision: 12, actualRevision: 0 },
    { localRevision: 7, actualRevision: 8 }
  ])(
    'requires verified re-anchor when Host stamps $actualRevision instead of $localRevision',
    ({ localRevision, actualRevision }) => {
      const { ledger } = confirmed()
      ledger.replaceUnconfirmed('thread', {
        headRevision: localRevision,
        compatibilitySequence: 12
      })
      const attempt = ledger.beginPublication(ledger.capturePublicationTarget('thread')!, {
        expectedRevision: 0
      })!
      expect(ledger.publicationSucceeded(attempt, { revision: actualRevision })).toBeNull()
      expect(ledger.requiresReanchor('thread')).toBe(true)
      expect(ledger.publicationSucceeded(attempt, { revision: localRevision })).toBeNull()
      expect(ledger.captureCandidate('thread')).toBeNull()
      expect(
        ledger.beginPublication(ledger.capturePublicationTarget('thread')!, { expectedRevision: 0 })
      ).toBeNull()
      ledger.replaceUnconfirmed('thread', {
        headRevision: localRevision,
        compatibilitySequence: 13
      })
      expect(
        ledger.beginPublication(ledger.capturePublicationTarget('thread')!, { expectedRevision: 0 })
      ).toBeNull()
      ledger.reanchorFromConfirmedHost('thread', {
        revision: actualRevision,
        compatibilitySequence: 14
      })
      expect(ledger.requiresReanchor('thread')).toBe(false)
      expect(ledger.publicationSucceeded(attempt, { revision: localRevision })).toBeNull()
      expect(ledger.captureCandidate('thread')?.confirmedHostRevision).toBe(actualRevision)
      expect(ledger.snapshot().activePublications).toBe(0)
    }
  )

  it('a known receipt mismatch invalidates an existing candidate and confirmation', () => {
    const { ledger, lineage } = confirmed()
    ledger.appended('thread', {
      lineageToken: lineage,
      baseRevision: 7,
      headRevision: 8,
      compatibilitySequence: 11
    })
    const candidate = ledger.captureCandidate('thread')!
    const attempt = ledger.beginPublication(ledger.capturePublicationTarget('thread')!, {
      expectedRevision: 7
    })!
    expect(ledger.publicationSucceeded(attempt, { revision: 9 })).toBeNull()
    expect(ledger.candidateIsCurrent(candidate)).toBe(false)
    expect(ledger.snapshot()).toEqual({ threads: 1, confirmedThreads: 0, activePublications: 0 })
    expect(
      ledger.appended('thread', {
        lineageToken: lineage,
        baseRevision: 8,
        headRevision: 10,
        compatibilitySequence: 12
      })
    ).toBe(true)
    expect(
      ledger.beginPublication(ledger.capturePublicationTarget('thread')!, { expectedRevision: 9 })
    ).toBeNull()
  })

  it('forgets all strong per-thread state and attempts on retirement', () => {
    const ledger = new ThreadOwnershipLineage()
    const attempts = []
    for (let index = 0; index < 100; index++) {
      const id = `thread-${index}`
      ledger.reanchorFromConfirmedHost(id, { revision: 1, compatibilitySequence: index })
      attempts.push(
        ledger.beginPublication(ledger.capturePublicationTarget(id)!, { expectedRevision: 1 })!
      )
      expect(ledger.forget(id)).toBe(true)
      expect(ledger.forget(id)).toBe(false)
    }
    expect(ledger.snapshot()).toEqual({ threads: 0, confirmedThreads: 0, activePublications: 0 })
    expect(
      attempts.every(
        (attempt) => ledger.publicationSucceeded(attempt, { revision: attempt.revision }) === null
      )
    ).toBe(true)
  })

  it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid revision/sequence %s before retaining state',
    (bad) => {
      const ledger = new ThreadOwnershipLineage()
      expect(() =>
        ledger.replaceUnconfirmed('thread', { headRevision: bad, compatibilitySequence: 1 })
      ).toThrow()
      expect(() =>
        ledger.reanchorFromConfirmedHost('thread', { revision: 1, compatibilitySequence: bad })
      ).toThrow()
      expect(ledger.snapshot().threads).toBe(0)
    }
  )
})
