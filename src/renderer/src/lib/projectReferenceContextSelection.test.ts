import { afterEach, describe, expect, it } from 'vitest'

import {
  MAX_PROJECT_REFERENCE_CONTEXT_ITEMS,
  claimProjectReferenceContextSelection,
  clearProjectReferenceContextSelection,
  getProjectReferenceContextSelection,
  resetProjectReferenceContextSelectionForTests,
  setProjectReferenceContextSelection,
  settleProjectReferenceContextClaim,
  subscribeProjectReferenceContextSelection,
  toggleProjectReferenceContextSelection
} from './projectReferenceContextSelection'

afterEach(resetProjectReferenceContextSelectionForTests)

describe('projectReferenceContextSelection', () => {
  it('starts empty and normalizes a stable, capped reference order', () => {
    const input = [
      ' ref-a ',
      '',
      'ref-b',
      'ref-a',
      null,
      ...Array.from({ length: 20 }, (_, index) => `ref-${index + 3}`)
    ]

    expect(getProjectReferenceContextSelection('chat-a')).toBeNull()
    const selection = setProjectReferenceContextSelection(' chat-a ', ' project-a ', input)

    expect(selection).toEqual({
      schemaVersion: 1,
      projectId: 'project-a',
      referenceIds: Array.from({ length: MAX_PROJECT_REFERENCE_CONTEXT_ITEMS }, (_, index) =>
        index === 0 ? 'ref-a' : index === 1 ? 'ref-b' : `ref-${index + 1}`
      )
    })
    expect(Object.isFrozen(selection)).toBe(true)
    expect(Object.isFrozen(selection?.referenceIds)).toBe(true)
    expect(getProjectReferenceContextSelection('chat-a')).toBe(selection)
  })

  it('atomically replaces the selected Project for one chat', () => {
    setProjectReferenceContextSelection('chat-a', 'project-a', ['ref-a', 'ref-b'])

    toggleProjectReferenceContextSelection('chat-a', 'project-b', 'ref-c')

    expect(getProjectReferenceContextSelection('chat-a')).toEqual({
      schemaVersion: 1,
      projectId: 'project-b',
      referenceIds: ['ref-c']
    })
  })

  it('toggles in insertion order, clears the empty bucket, and refuses a thirteenth item', () => {
    toggleProjectReferenceContextSelection('chat-a', 'project-a', 'ref-a')
    toggleProjectReferenceContextSelection('chat-a', 'project-a', 'ref-b')
    toggleProjectReferenceContextSelection('chat-a', 'project-a', 'ref-a')
    expect(getProjectReferenceContextSelection('chat-a')).toEqual({
      schemaVersion: 1,
      projectId: 'project-a',
      referenceIds: ['ref-b']
    })

    toggleProjectReferenceContextSelection('chat-a', 'project-a', 'ref-b')
    expect(getProjectReferenceContextSelection('chat-a')).toBeNull()

    const twelve = Array.from(
      { length: MAX_PROJECT_REFERENCE_CONTEXT_ITEMS },
      (_, index) => `ref-${index}`
    )
    const full = setProjectReferenceContextSelection('chat-a', 'project-a', twelve)
    const unchanged = toggleProjectReferenceContextSelection('chat-a', 'project-a', 'ref-overflow')
    expect(unchanged).toBe(full)
  })

  it('isolates chat subscriptions and suppresses no-op notifications', () => {
    let chatANotifications = 0
    let chatBNotifications = 0
    const stopA = subscribeProjectReferenceContextSelection('chat-a', () => {
      chatANotifications += 1
    })
    const stopB = subscribeProjectReferenceContextSelection('chat-b', () => {
      chatBNotifications += 1
    })

    setProjectReferenceContextSelection('chat-a', 'project-a', ['ref-a'])
    setProjectReferenceContextSelection('chat-a', 'project-a', ['ref-a'])
    setProjectReferenceContextSelection('chat-b', 'project-b', ['ref-b'])
    expect(chatANotifications).toBe(1)
    expect(chatBNotifications).toBe(1)

    stopA()
    clearProjectReferenceContextSelection('chat-a')
    expect(chatANotifications).toBe(1)
    expect(chatBNotifications).toBe(1)
    stopB()
  })

  it('allows only one in-flight claim and consumes it on acceptance', () => {
    const selection = setProjectReferenceContextSelection('chat-a', 'project-a', [
      'ref-a',
      'ref-b'
    ])
    const claim = claimProjectReferenceContextSelection('chat-a')

    expect(claim?.selection).toBe(selection)
    expect(claimProjectReferenceContextSelection('chat-a')).toBeNull()
    expect(getProjectReferenceContextSelection('chat-a')).toBe(selection)
    expect(settleProjectReferenceContextClaim(claim, 'accepted')).toBe(true)
    expect(getProjectReferenceContextSelection('chat-a')).toBeNull()
    expect(settleProjectReferenceContextClaim(claim, 'accepted')).toBe(false)
  })

  it('releases a rejected claim for another submission', () => {
    const selection = setProjectReferenceContextSelection('chat-a', 'project-a', ['ref-a'])
    const firstClaim = claimProjectReferenceContextSelection('chat-a')

    expect(settleProjectReferenceContextClaim(firstClaim, 'rejected')).toBe(true)
    expect(getProjectReferenceContextSelection('chat-a')).toBe(selection)

    const secondClaim = claimProjectReferenceContextSelection('chat-a')
    expect(secondClaim?.selection).toBe(selection)
    expect(secondClaim?.generation).toBe(firstClaim?.generation)
    expect(settleProjectReferenceContextClaim(firstClaim, 'rejected')).toBe(false)
    expect(getProjectReferenceContextSelection('chat-a')).toBe(selection)
  })

  it('protects an identical re-selection from an older acceptance', () => {
    setProjectReferenceContextSelection('chat-a', 'project-a', ['ref-a'])
    const staleClaim = claimProjectReferenceContextSelection('chat-a')

    clearProjectReferenceContextSelection('chat-a')
    const replacement = setProjectReferenceContextSelection('chat-a', 'project-a', ['ref-a'])

    expect(settleProjectReferenceContextClaim(staleClaim, 'accepted')).toBe(false)
    expect(getProjectReferenceContextSelection('chat-a')).toBe(replacement)
  })

  it('does not restore over a selection changed while an older claim was pending', () => {
    setProjectReferenceContextSelection('chat-a', 'project-a', ['ref-a'])
    const staleClaim = claimProjectReferenceContextSelection('chat-a')
    const replacement = setProjectReferenceContextSelection('chat-a', 'project-a', ['ref-b'])

    expect(settleProjectReferenceContextClaim(staleClaim, 'rejected')).toBe(false)
    expect(getProjectReferenceContextSelection('chat-a')).toBe(replacement)
  })

  it('defensively ignores malformed identifiers and clears only through valid state changes', () => {
    setProjectReferenceContextSelection('chat-a', 'project-a', ['ref-a'])

    expect(setProjectReferenceContextSelection('chat-a', ' ', ['ref-b'])).toEqual({
      schemaVersion: 1,
      projectId: 'project-a',
      referenceIds: ['ref-a']
    })
    expect(toggleProjectReferenceContextSelection('chat-a', 'project-a', ' ')).toEqual({
      schemaVersion: 1,
      projectId: 'project-a',
      referenceIds: ['ref-a']
    })
    expect(clearProjectReferenceContextSelection(' ')).toBe(false)
    expect(setProjectReferenceContextSelection('chat-a', 'project-a', 'not-an-array')).toBeNull()
    expect(getProjectReferenceContextSelection('chat-a')).toBeNull()
  })

  it('keeps state in renderer memory only and exposes a full reset seam', () => {
    setProjectReferenceContextSelection('chat-a', 'project-a', ['ref-a'])
    setProjectReferenceContextSelection('chat-b', 'project-b', ['ref-b'])

    resetProjectReferenceContextSelectionForTests()

    expect(getProjectReferenceContextSelection('chat-a')).toBeNull()
    expect(getProjectReferenceContextSelection('chat-b')).toBeNull()
  })
})
