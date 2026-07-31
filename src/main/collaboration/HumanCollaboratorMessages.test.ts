import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../store/types'
import {
  EXTERNAL_SEAT_TURN_KIND,
  isDeliveredExternalContribution,
  isExternalUntrustedMessage,
  isHumanCollaboratorComment,
  makeDeliveredExternalContribution,
  makeHumanCollaboratorComment
} from './HumanCollaboratorMessages'
import { conversationCompactionEligibleMessageIds } from '../PromptComposition'

const BASE = {
  shareId: 'share-1',
  collaboratorId: 'collab-1',
  collaboratorDisplayName: 'Alex',
  clientMessageId: 'client-1',
  sequence: 1,
  timestamp: '2026-07-31T00:00:00.000Z'
}

const delivered = (content = 'please re-run the migration test'): ChatMessage =>
  makeDeliveredExternalContribution({ id: 'msg-1', content, ...BASE })

/**
 * A delivered contribution has to thread a needle that the two predicates were
 * built to allow: it must REACH the ensemble panel (so the exclusion predicate
 * must not catch it) while still arriving FRAMED as untrusted (so the wrapping
 * predicate must). Getting either half wrong is silent — the message simply
 * never appears, or appears with no frame around attacker-chosen text.
 */
describe('a delivered external contribution', () => {
  it('is not the exclusion predicate’s business', () => {
    // Reusing the comment kind would keep it excluded from provider history and
    // deliver nothing at all.
    expect(isHumanCollaboratorComment(delivered())).toBe(false)
    expect(isDeliveredExternalContribution(delivered())).toBe(true)
    expect(delivered().metadata?.kind).toBe(EXTERNAL_SEAT_TURN_KIND)
  })

  it('still earns the untrusted frame', () => {
    // Keyed on sourceTrust, not the kind — which is why the two predicates are
    // allowed to disagree about this row.
    expect(isExternalUntrustedMessage(delivered())).toBe(true)
  })

  it('never takes the host’s voice', () => {
    // `role: 'user'` IS the host in every renderer, serializer and export.
    expect(delivered().role).toBe('system')
    expect(makeHumanCollaboratorComment({ id: 'm', content: 'c', ...BASE }).role).toBe('system')
  })

  it('carries the attribution the transcript header needs', () => {
    expect(delivered().metadata?.displayParticipantLabel).toBe('Alex / External')
    expect(delivered().metadata).toMatchObject({
      shareId: 'share-1',
      collaboratorId: 'collab-1',
      clientMessageId: 'client-1',
      promotedBy: 'host'
    })
  })

  it('is still refused outright by solo composition', () => {
    // Solo has no untrusted frame to fall back on, so external text must never
    // reach it — delivery to an ensemble panel does not change that.
    const eligible = conversationCompactionEligibleMessageIds([
      { id: 'u1', role: 'user', content: 'host turn', timestamp: BASE.timestamp },
      delivered()
    ])
    expect(eligible).toEqual(['u1'])
  })

  it('would still be refused if it ever carried a user role', () => {
    // The check above passes on the ROLE gate alone, so on its own it proves
    // less than it looks: it would keep passing with the sourceTrust stamp
    // removed. This is the assertion that actually pins the stamp — and a
    // user-role row carrying external text is not hypothetical, it is the shape
    // the mid-run steering builder used to produce (P2c F1).
    const asUserRole = { ...delivered(), role: 'user' as const }
    expect(isExternalUntrustedMessage(asUserRole)).toBe(true)
    const eligible = conversationCompactionEligibleMessageIds([
      { id: 'u1', role: 'user', content: 'host turn', timestamp: BASE.timestamp },
      asUserRole
    ])
    expect(eligible).toEqual(['u1'])
  })
})
