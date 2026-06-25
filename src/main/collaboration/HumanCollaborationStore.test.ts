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
})
