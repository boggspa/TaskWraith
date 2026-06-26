import { describe, expect, it } from 'vitest'
import { HumanCollaborationStore } from './HumanCollaborationStore'

describe('HumanCollaborationStore', () => {
  it('creates single-use high-entropy invites and pins collaborator identity', () => {
    const store = new HumanCollaborationStore()
    const created = store.createShare({
      chatId: 'chat-1',
      mode: 'comments',
      now: 1000,
      inviteTtlMs: 1000
    })

    expect(created.inviteToken.length).toBeGreaterThan(20)
    const consumed = store.consumeInvite({
      shareId: created.share.shareId,
      inviteToken: created.inviteToken,
      displayName: 'Alex',
      publicKeyId: 'ed25519:alex',
      now: 1200
    })

    expect(consumed.participant).toMatchObject({
      displayName: 'Alex',
      publicKeyId: 'ed25519:alex',
      status: 'active'
    })
    expect(() =>
      store.consumeInvite({
        shareId: created.share.shareId,
        inviteToken: created.inviteToken,
        displayName: 'Mallory',
        publicKeyId: 'ed25519:mallory',
        now: 1300
      })
    ).toThrow(/already been used/)
  })

  it('rejects expired invites and enforces the two active collaborator cap', () => {
    const store = new HumanCollaborationStore()
    const expired = store.createShare({
      chatId: 'chat-1',
      mode: 'comments',
      now: 1000,
      inviteTtlMs: 10
    })
    expect(() =>
      store.consumeInvite({
        shareId: expired.share.shareId,
        inviteToken: expired.inviteToken,
        displayName: 'Late',
        publicKeyId: 'late',
        now: 2000
      })
    ).toThrow(/expired/)

    const one = store.createShare({ chatId: 'chat-2', mode: 'comments', now: 3000 })
    store.consumeInvite({
      shareId: one.share.shareId,
      inviteToken: one.inviteToken,
      displayName: 'A',
      publicKeyId: 'a',
      now: 3001
    })
    const two = store.createShare({ chatId: 'chat-2', mode: 'comments', now: 3002 })
    store.consumeInvite({
      shareId: two.share.shareId,
      inviteToken: two.inviteToken,
      displayName: 'B',
      publicKeyId: 'b',
      now: 3003
    })
    const three = store.createShare({ chatId: 'chat-2', mode: 'comments', now: 3004 })
    expect(() =>
      store.consumeInvite({
        shareId: three.share.shareId,
        inviteToken: three.inviteToken,
        displayName: 'C',
        publicKeyId: 'c',
        now: 3005
      })
    ).toThrow(/maximum/)
  })

  it('validates append permissions and records idempotency', () => {
    const store = new HumanCollaborationStore()
    const created = store.createShare({ chatId: 'chat-1', mode: 'comments', now: 1000 })
    const { participant } = store.consumeInvite({
      shareId: created.share.shareId,
      inviteToken: created.inviteToken,
      displayName: 'Alex',
      publicKeyId: 'alex-key',
      now: 1001
    })

    const validated = store.validateAppend({
      shareId: created.share.shareId,
      chatId: 'chat-1',
      collaboratorId: participant.collaboratorId,
      clientMessageId: 'client-1'
    })
    expect(validated.existingMessageId).toBeUndefined()

    const seq = store.recordAppend({
      shareId: created.share.shareId,
      chatId: 'chat-1',
      collaboratorId: participant.collaboratorId,
      clientMessageId: 'client-1',
      messageId: 'message-1'
    })
    expect(seq).toBe(1)
    expect(
      store.validateAppend({
        shareId: created.share.shareId,
        chatId: 'chat-1',
        collaboratorId: participant.collaboratorId,
        clientMessageId: 'client-1'
      }).existingMessageId
    ).toBe('message-1')

    store.revokeParticipant({
      shareId: created.share.shareId,
      collaboratorId: participant.collaboratorId,
      now: 2000
    })
    expect(() =>
      store.validateAppend({
        shareId: created.share.shareId,
        chatId: 'chat-1',
        collaboratorId: participant.collaboratorId,
        clientMessageId: 'client-2'
      })
    ).toThrow(/not active/)
  })

  it('does not reactivate a revoked identity with a later invite', () => {
    const store = new HumanCollaborationStore()
    const created = store.createShare({ chatId: 'chat-1', mode: 'comments', now: 1000 })
    const consumed = store.consumeInvite({
      shareId: created.share.shareId,
      inviteToken: created.inviteToken,
      displayName: 'Alex',
      publicKeyId: 'alex-key',
      now: 1001
    })
    store.revokeParticipant({
      shareId: created.share.shareId,
      collaboratorId: consumed.participant.collaboratorId,
      now: 1002
    })
    const nextInvite = store.createShare({ chatId: 'chat-1', mode: 'comments', now: 1003 })

    expect(() =>
      store.consumeInvite({
        shareId: created.share.shareId,
        inviteToken: nextInvite.inviteToken,
        displayName: 'Alex',
        publicKeyId: 'alex-key',
        now: 1004
      })
    ).toThrow(/revoked/)
  })

  it('supports non-consuming invite verification for admission handshakes', () => {
    const store = new HumanCollaborationStore()
    const created = store.createShare({
      chatId: 'chat-1',
      mode: 'comments',
      now: 1000,
      inviteTtlMs: 1000
    })

    const check = store.verifyInvite({
      shareId: created.share.shareId,
      inviteToken: created.inviteToken,
      displayName: 'Alex',
      publicKeyId: 'ed25519:alex',
      now: 1200
    })

    expect(check.existingParticipant).toBeNull()
    const fresh = store.getShare(created.share.shareId)
    expect(fresh?.invites[0]?.consumedAt).toBeUndefined()
    store.consumeInvite({
      shareId: created.share.shareId,
      inviteToken: created.inviteToken,
      displayName: 'Alex',
      publicKeyId: 'ed25519:alex',
      now: 1200
    })
    const consumed = store.getShare(created.share.shareId)
    expect(consumed?.invites[0]?.consumedAt).toBe(1200)
  })

  it('blocks display names that impersonate the host/assistant/providers', () => {
    const store = new HumanCollaborationStore()
    const admit = (displayName: string, publicKeyId: string): string => {
      const created = store.createShare({ chatId: `c-${publicKeyId}`, mode: 'comments', now: 1000 })
      return store.consumeInvite({
        shareId: created.share.shareId,
        inviteToken: created.inviteToken,
        displayName,
        publicKeyId,
        now: 1001
      }).participant.displayName
    }
    expect(admit('You', 'k1')).toBe('You (collaborator)')
    expect(admit('assistant', 'k2')).toBe('assistant (collaborator)')
    expect(admit('the Host', 'k3')).toBe('the Host (collaborator)')
    expect(admit('Claude', 'k4')).toBe('Claude (collaborator)')
    // Legitimate names that merely contain a reserved token are untouched.
    expect(admit('Claudia', 'k5')).toBe('Claudia')
    expect(admit('Yousef', 'k6')).toBe('Yousef')
  })

  it('hasShareForChat is a cheap existence check', () => {
    const store = new HumanCollaborationStore()
    expect(store.hasShareForChat('chat-1')).toBe(false)
    store.createShare({ chatId: 'chat-1', mode: 'comments', now: 1000 })
    expect(store.hasShareForChat('chat-1')).toBe(true)
    expect(store.hasShareForChat('chat-2')).toBe(false)
  })

  it('bounds the idempotency map under a flood of unique clientMessageIds', () => {
    const store = new HumanCollaborationStore()
    const created = store.createShare({ chatId: 'chat-1', mode: 'comments', now: 1000 })
    const { participant } = store.consumeInvite({
      shareId: created.share.shareId,
      inviteToken: created.inviteToken,
      displayName: 'Alex',
      publicKeyId: 'alex-key',
      now: 1001
    })
    for (let i = 0; i < 600; i++) {
      store.recordAppend({
        shareId: created.share.shareId,
        chatId: 'chat-1',
        collaboratorId: participant.collaboratorId,
        clientMessageId: `client-${i}`,
        messageId: `message-${i}`
      })
    }
    const share = store.getShare(created.share.shareId)
    const keys = Object.keys(share?.idempotency || {})
    expect(keys.length).toBeLessThanOrEqual(512)
    // The oldest entries are evicted; the most recent survive (so legitimate
    // in-flight retries still dedupe).
    expect(keys).not.toContain(`${participant.collaboratorId}:client-0`)
    expect(keys).toContain(`${participant.collaboratorId}:client-599`)
  })

  it('prunes consumed invites that are long past expiry on the next createShare', () => {
    const store = new HumanCollaborationStore()
    const first = store.createShare({
      chatId: 'chat-1',
      mode: 'comments',
      now: 1000,
      inviteTtlMs: 1000
    })
    store.consumeInvite({
      shareId: first.share.shareId,
      inviteToken: first.inviteToken,
      displayName: 'Alex',
      publicKeyId: 'alex-key',
      now: 1500
    })
    // Far past expiry (2000) + the 24h retention grace → the consumed invite is
    // dead and pruned when a new invite is minted on the same share.
    const dayMs = 24 * 60 * 60 * 1000
    store.createShare({ chatId: 'chat-1', mode: 'comments', now: 2000 + dayMs + 1 })
    const share = store.getShare(first.share.shareId)
    expect(share?.invites.length).toBe(1)
    expect(share?.invites[0]?.consumedAt).toBeUndefined()
  })

  it('prunes unconsumed invites that are long past expiry on the next createShare', () => {
    const store = new HumanCollaborationStore()
    const first = store.createShare({
      chatId: 'chat-1',
      mode: 'comments',
      now: 1000,
      inviteTtlMs: 1000
    })
    // The first invite is NEVER consumed; it simply expired (at 2000) and the
    // 24h retention grace has elapsed. It can no longer admit anyone, so minting
    // a fresh invite on the same share drops the dead one (was kept forever).
    const dayMs = 24 * 60 * 60 * 1000
    store.createShare({ chatId: 'chat-1', mode: 'comments', now: 2000 + dayMs + 1 })
    const share = store.getShare(first.share.shareId)
    expect(share?.invites.length).toBe(1)
    expect(share?.invites[0]?.consumedAt).toBeUndefined()
    // The surviving invite is the fresh one, not the long-expired original.
    expect(share?.invites[0]?.expiresAt).toBeGreaterThan(2000 + dayMs)
  })
})
