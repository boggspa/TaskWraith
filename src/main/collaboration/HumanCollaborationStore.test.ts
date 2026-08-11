import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HumanCollaborationStore,
  type HumanCollaboratorParticipant
} from './HumanCollaborationStore'
import {
  PeopleToChannelMigrationLegacyWriteGate,
  PeopleToChannelMigrationLegacyWriteGateError
} from './PeopleToChannelMigrationLegacyWriteGate'
import { buildHumanShareProjection } from './HumanShareProjection'

describe('HumanCollaborationStore', () => {
  it('quiesces every ordinary People mutation while retaining the scoped migration retirement seam', () => {
    const gate = new PeopleToChannelMigrationLegacyWriteGate()
    const store = new HumanCollaborationStore(undefined, { legacyWriteGate: gate })
    const active = store.createShare({ chatId: 'chat-active', mode: 'comments', now: 100 })
    expect(() => store.retireSharesForChannelMigration([active.share.shareId])).toThrow(
      /requires a quiesced legacy write gate/
    )
    const participant = store.consumeInvite({
      shareId: active.share.shareId,
      inviteToken: active.inviteToken,
      displayName: 'Alex',
      publicKeyId: 'ed25519:alex',
      now: 110
    }).participant
    const pending = store.createShare({ chatId: 'chat-pending', mode: 'comments', now: 120 })

    gate.quiesce()

    expect(() => store.createShare({ chatId: 'chat-new', mode: 'comments' })).toThrow(
      PeopleToChannelMigrationLegacyWriteGateError
    )
    expect(() =>
      store.consumeInvite({
        shareId: pending.share.shareId,
        inviteToken: pending.inviteToken,
        displayName: 'Blair',
        publicKeyId: 'ed25519:blair'
      })
    ).toThrow(PeopleToChannelMigrationLegacyWriteGateError)
    expect(() =>
      store.validateAppend({
        shareId: active.share.shareId,
        chatId: active.share.chatId,
        collaboratorId: participant.collaboratorId,
        clientMessageId: 'blocked-before-chat-write'
      })
    ).toThrow(PeopleToChannelMigrationLegacyWriteGateError)
    expect(() =>
      store.recordAppend({
        shareId: active.share.shareId,
        chatId: active.share.chatId,
        collaboratorId: participant.collaboratorId,
        clientMessageId: 'blocked-after-chat-write',
        messageId: 'message-one'
      })
    ).toThrow(PeopleToChannelMigrationLegacyWriteGateError)
    expect(() => store.revokeShare(active.share.shareId)).toThrow(
      PeopleToChannelMigrationLegacyWriteGateError
    )
    expect(() => store.purgeAllShares()).toThrow(PeopleToChannelMigrationLegacyWriteGateError)

    expect(store.retireSharesForChannelMigration([active.share.shareId])).toBe(1)
    expect(store.getShare(active.share.shareId)).toBeNull()
    expect(store.getShare(pending.share.shareId)).toMatchObject({ enabled: true })
  })

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

  it('lists reconnect candidates for active participants by collaborator identity', () => {
    const store = new HumanCollaborationStore()
    const created = store.createShare({ chatId: 'chat-1', mode: 'comments', now: 1000, inviteTtlMs: 10_000 })
    store.consumeInvite({
      shareId: created.share.shareId,
      inviteToken: created.inviteToken,
      displayName: 'Alex',
      publicKeyId: 'ed25519:alex',
      now: 1_005
    })
    const second = store.createShare({ chatId: 'chat-1', mode: 'comments', now: 2_000, inviteTtlMs: 10_000 })
    const secondConsume = store.consumeInvite({
      shareId: second.share.shareId,
      inviteToken: second.inviteToken,
      displayName: 'Alex',
      publicKeyId: 'ed25519:alex',
      now: 2_005
    })

    const candidates = store.listReconnectCandidates('ed25519:alex')
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      shareId: created.share.shareId,
      chatId: 'chat-1',
      mode: 'comments',
      inviteId: second.invite.inviteId,
      roomId: second.invite.roomId,
      inviteExpiresAt: second.invite.expiresAt,
      participant: {
        collaboratorId: secondConsume.participant.collaboratorId,
        displayName: 'Alex',
        publicKeyId: 'ed25519:alex',
        status: 'active'
      }
    })
  })

  it('excludes revoked participants and disabled shares from reconnect candidates', () => {
    const store = new HumanCollaborationStore()
    const created = store.createShare({ chatId: 'chat-1', mode: 'comments', now: 1000, inviteTtlMs: 10_000 })
    const consumed = store.consumeInvite({
      shareId: created.share.shareId,
      inviteToken: created.inviteToken,
      displayName: 'Alex',
      publicKeyId: 'ed25519:alex',
      now: 1001
    })
    expect(store.listReconnectCandidates('ed25519:alex')).toHaveLength(1)

    store.revokeParticipant({
      shareId: created.share.shareId,
      collaboratorId: consumed.participant.collaboratorId,
      now: 1002
    })
    expect(store.listReconnectCandidates('ed25519:alex')).toHaveLength(0)

    store.revokeShare(created.share.shareId, 1004)
    expect(store.listReconnectCandidates('ed25519:alex')).toHaveLength(0)
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
    // The two trust labels the UI itself renders. "External" is the static
    // badge the transcript paints beside a collaborator's name, and it is also
    // the DEFAULT a nameless joiner arrives with — so it has to be unclaimable
    // in both directions, or a collaborator can present as the badge and an
    // unnamed one renders as "External [External]". "Guest" was the old default
    // and was reserved; this test never covered it, which is how the rename to
    // "External" quietly opened the hole.
    expect(admit('External', 'k7')).toBe('External (collaborator)')
    expect(admit('guest', 'k8')).toBe('guest (collaborator)')
    expect(admit('Collaborator', 'k9')).toBe('Collaborator (collaborator)')
    // …and the badge word inside a real name is still fine.
    expect(admit('Externals Ltd', 'k10')).toBe('Externals Ltd')
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
  it('purges share records for erased chats and denies the runtime by absence', () => {
    const store = new HumanCollaborationStore()
    const erased = store.createShare({ chatId: 'chat-erased', mode: 'comments', now: 1000 })
    const child = store.createShare({ chatId: 'chat-child', mode: 'readOnly', now: 1000 })
    const survivor = store.createShare({ chatId: 'chat-live', mode: 'comments', now: 1000 })

    expect(store.purgeChatShares(['chat-erased', 'chat-child'])).toBe(2)
    expect(store.purgeChatShares(['chat-erased', 'chat-child'])).toBe(0)
    expect(store.getShare(erased.share.shareId)).toBeNull()
    expect(store.getShare(child.share.shareId)).toBeNull()
    expect(store.getShareForChat('chat-erased')).toBeNull()
    expect(store.getShare(survivor.share.shareId)).not.toBeNull()

    expect(store.purgeAllShares()).toBe(1)
    expect(store.listShares()).toEqual([])
  })

})

/*
 * Phase 2 (P2a) — contribution rules on shares: migration equivalence,
 * host-only updates, and fail-closed evaluation before every append.
 */
describe('HumanCollaborationStore contribution rules (P2a)', () => {
  const admit = (store: HumanCollaborationStore, chatId: string, mode: 'readOnly' | 'comments') => {
    const created = store.createShare({ chatId, mode, now: 1000 })
    const consumed = store.consumeInvite({
      shareId: created.share.shareId,
      inviteToken: created.inviteToken,
      displayName: 'Alex',
      publicKeyId: 'ed25519:alex',
      now: 1100
    })
    return { created, consumed }
  }

  it('stamps mode-derived rules at createShare (migration equivalence)', () => {
    const store = new HumanCollaborationStore()
    const comments = store.createShare({ chatId: 'c1', mode: 'comments', now: 1000 })
    expect(comments.share.contributionRules?.preset).toBe('comments')
    expect(comments.share.contributionRules?.appendComment).toBe(true)
    expect(comments.share.contributionRules?.providerDispatch).toBe('never')

    const readOnly = store.createShare({ chatId: 'c2', mode: 'readOnly', now: 1000 })
    expect(readOnly.share.contributionRules?.preset).toBe('readOnly')
    expect(readOnly.share.contributionRules?.appendComment).toBe(false)
  })

  it('accepts an explicit preset at createShare and derives mode from it', () => {
    const store = new HumanCollaborationStore()
    const created = store.createShare({ chatId: 'c1', mode: 'readOnly', preset: 'requestHostAction', now: 1000 })
    expect(created.share.contributionRules?.preset).toBe('requestHostAction')
    expect(created.share.mode).toBe('comments')
  })

  it('updateShareRules switches presets, keeps mode in lockstep, and persists', () => {
    const store = new HumanCollaborationStore()
    const { created } = admit(store, 'c1', 'comments')

    const updated = store.updateShareRules({ shareId: created.share.shareId, preset: 'readOnly', now: 2000 })
    expect(updated?.mode).toBe('readOnly')
    expect(updated?.contributionRules?.preset).toBe('readOnly')

    // Read-only rules now deny appends through the normal gate.
    expect(() =>
      store.validateAppend({
        shareId: created.share.shareId,
        chatId: 'c1',
        collaboratorId: 'anyone',
        clientMessageId: 'm1'
      })
    ).toThrow(/read-only/)

    const back = store.updateShareRules({ shareId: created.share.shareId, preset: 'autoDraft', now: 3000 })
    expect(back?.mode).toBe('comments')
    expect(back?.contributionRules?.createHostDraft).toBe('auto-draft')
  })

  it('rejects the direct-dispatch tier at updateShareRules (fail-closed until P2c)', () => {
    const store = new HumanCollaborationStore()
    const { created } = admit(store, 'c1', 'comments')
    expect(() =>
      store.updateShareRules({
        shareId: created.share.shareId,
        preset: 'directLimited' as never
      })
    ).toThrow(/not available/)
  })

  it('legacy shares without persisted rules behave exactly like Phase 1', () => {
    const store = new HumanCollaborationStore()
    const { created, consumed } = admit(store, 'c1', 'comments')
    // Simulate a legacy persisted share: strip rules directly from memory via
    // a fresh store loaded from a snapshot without the field.
    const share = store.getShare(created.share.shareId)!
    delete (share as { contributionRules?: unknown }).contributionRules
    // Validation still passes for comments mode via mode-derived rules.
    const validated = store.validateAppend({
      shareId: created.share.shareId,
      chatId: 'c1',
      collaboratorId: consumed.participant.collaboratorId,
      clientMessageId: 'm1'
    })
    expect(validated.participant.collaboratorId).toBe(consumed.participant.collaboratorId)
  })

  it('gates requestHostAction intent on the rules preset', () => {
    const store = new HumanCollaborationStore()
    const { created, consumed } = admit(store, 'c1', 'comments')
    expect(() =>
      store.validateAppend({
        shareId: created.share.shareId,
        chatId: 'c1',
        collaboratorId: consumed.participant.collaboratorId,
        clientMessageId: 'm1',
        intent: 'requestHostAction'
      })
    ).toThrow(/does not accept host-action requests/)

    store.updateShareRules({ shareId: created.share.shareId, preset: 'requestHostAction' })
    const ok = store.validateAppend({
      shareId: created.share.shareId,
      chatId: 'c1',
      collaboratorId: consumed.participant.collaboratorId,
      clientMessageId: 'm1',
      intent: 'requestHostAction'
    })
    expect(ok.share.contributionRules?.requestHostAction).toBe(true)
  })

  it('normalizes forged persisted rules fail-closed on load', () => {
    const store = new HumanCollaborationStore()
    const { created } = admit(store, 'c1', 'comments')
    const share = store.getShare(created.share.shareId)!
    // listShares round-trips through normalizeSnapshot — inject a forged
    // direct-dispatch rules object and confirm normalization clamps it.
    ;(share as { contributionRules?: unknown }).contributionRules = {
      preset: 'directLimited',
      providerDispatch: 'direct-limited',
      maxContributionBytes: 10_000_000
    }
    const snapshot = store.listShares('c1')[0]
    // getShare returned a clone, so the store itself was never mutated —
    // but the normalizer's behavior is what this test pins:
    expect(snapshot.contributionRules?.providerDispatch).not.toBe('direct-limited')
  })
})

/*
 * Seat presentation on the collaborator's own record: roster position
 * (`seatOrder`), palette index (`colorIndex`) and host-mute (`seatDisabled`).
 *
 * Every test below pins a REJECT-or-DROP decision, because the lazy alternative
 * is silent and plausible in each case: clamping a bad order to 0 promotes
 * someone to the front of the turn queue, clamping a bad colour honours a
 * request nobody made, coercing junk on load fabricates a position out of a
 * hand-edit, treating `null` as `undefined` makes "clear" a no-op, and folding
 * mute into revoke turns a reversible presentation toggle into an un-kickable
 * kick. A suite that only ever passes good values cannot see any of it.
 */
describe('HumanCollaborationStore participant seats', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    while (tempDirs.length) {
      const dir = tempDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  function tempStorePath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'tw-collab-seats-'))
    tempDirs.push(dir)
    return join(dir, 'human-collaboration.json')
  }

  /** A real admission: createShare + consumeInvite, no hand-built records. */
  const admit = (
    store: HumanCollaborationStore,
    chatId: string,
    publicKeyId = 'ed25519:olly'
  ): { shareId: string; collaboratorId: string } => {
    const created = store.createShare({ chatId, mode: 'comments', now: 1000 })
    const consumed = store.consumeInvite({
      shareId: created.share.shareId,
      inviteToken: created.inviteToken,
      displayName: 'Olly',
      publicKeyId,
      now: 1100
    })
    return { shareId: created.share.shareId, collaboratorId: consumed.participant.collaboratorId }
  }

  const seatOf = (
    store: HumanCollaborationStore,
    shareId: string,
    collaboratorId: string
  ): HumanCollaboratorParticipant | undefined =>
    store
      .getShare(shareId)
      ?.participants.find((participant) => participant.collaboratorId === collaboratorId)

  /** A hand-written on-disk snapshot — the shape a text editor can produce. */
  function writeSnapshot(path: string, participants: readonly unknown[]): void {
    writeFileSync(
      path,
      JSON.stringify({
        shares: [
          {
            shareId: 'share-1',
            chatId: 'chat-1',
            mode: 'comments',
            enabled: true,
            createdAt: 1000,
            updatedAt: 1000,
            nextSequence: 1,
            participants,
            invites: [],
            idempotency: {}
          }
        ]
      })
    )
  }

  it('seats an active participant, returns the updated share, and moves updatedAt', () => {
    const store = new HumanCollaborationStore()
    const { shareId, collaboratorId } = admit(store, 'chat-1')
    const before = store.getShare(shareId)?.updatedAt
    expect(before).toBe(1100)

    const updated = store.updateParticipantSeat({
      shareId,
      collaboratorId,
      seatOrder: 2,
      colorIndex: 5,
      seatDisabled: true,
      now: 5000
    })

    // The returned clone is what the IPC publish path ships, so it has to carry
    // the write — not just the store's private copy.
    expect(updated?.participants[0]).toMatchObject({
      status: 'active',
      seatOrder: 2,
      colorIndex: 5,
      seatDisabled: true
    })
    expect(seatOf(store, shareId, collaboratorId)).toMatchObject({
      status: 'active',
      seatOrder: 2,
      colorIndex: 5,
      seatDisabled: true
    })
    expect(store.getShare(shareId)?.updatedAt).toBe(5000)
  })

  it('REJECTS an out-of-range seatOrder instead of clamping it to the front of the queue', () => {
    const store = new HumanCollaborationStore()
    const { shareId, collaboratorId } = admit(store, 'chat-1')

    // 0 is a legitimate front position — a lazy `> 0` guard would reject it.
    expect(
      store.updateParticipantSeat({ shareId, collaboratorId, seatOrder: 0, now: 2000 })
    ).not.toBeNull()
    expect(seatOf(store, shareId, collaboratorId)?.seatOrder).toBe(0)
    store.updateParticipantSeat({ shareId, collaboratorId, seatOrder: 5, now: 2500 })

    for (const bad of [-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      // Clamping -1 or NaN to 0 would silently promote this person ahead of
      // every model seat; clamping +Infinity would park them at the end. Both
      // are positions the host never asked for, so the write must FAIL.
      expect(
        store.updateParticipantSeat({ shareId, collaboratorId, seatOrder: bad, now: 9000 })
      ).toBeNull()
      expect(seatOf(store, shareId, collaboratorId)?.seatOrder).toBe(5)
      // A rejected write is not a write: the share's mtime must not move either,
      // or every rejection looks like a change to anything watching updatedAt.
      expect(store.getShare(shareId)?.updatedAt).toBe(2500)
    }
  })

  it('REJECTS an out-of-palette colorIndex instead of clamping it into the palette', () => {
    const store = new HumanCollaborationStore()
    const { shareId, collaboratorId } = admit(store, 'chat-1')

    // 7 is the last slot in the 8-colour palette and must be accepted; 8 is off
    // the end. Pinning both sides catches an off-by-one in either direction.
    expect(
      store.updateParticipantSeat({ shareId, collaboratorId, colorIndex: 7, now: 2000 })
    ).not.toBeNull()
    expect(seatOf(store, shareId, collaboratorId)?.colorIndex).toBe(7)
    store.updateParticipantSeat({ shareId, collaboratorId, colorIndex: 4, now: 2500 })

    for (const bad of [-1, 8, 99, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      // Clamping 99 to 7 would paint this person the palette's last colour on
      // the strength of a value that means nothing.
      expect(
        store.updateParticipantSeat({ shareId, collaboratorId, colorIndex: bad, now: 9000 })
      ).toBeNull()
      expect(seatOf(store, shareId, collaboratorId)?.colorIndex).toBe(4)
      expect(store.getShare(shareId)?.updatedAt).toBe(2500)
    }
  })

  it('validates every field before applying any of them (a rejected write is atomic)', () => {
    const store = new HumanCollaborationStore()
    const { shareId, collaboratorId } = admit(store, 'chat-1')
    store.updateParticipantSeat({ shareId, collaboratorId, seatOrder: 1, colorIndex: 2, now: 2000 })

    // A good order paired with a bad colour must not land the order…
    expect(
      store.updateParticipantSeat({
        shareId,
        collaboratorId,
        seatOrder: 6,
        colorIndex: 99,
        now: 9000
      })
    ).toBeNull()
    // …and a good colour and a mute paired with a bad order must land neither.
    expect(
      store.updateParticipantSeat({
        shareId,
        collaboratorId,
        seatOrder: -1,
        colorIndex: 6,
        seatDisabled: true,
        now: 9000
      })
    ).toBeNull()

    const seat = seatOf(store, shareId, collaboratorId)
    expect(seat).toMatchObject({ seatOrder: 1, colorIndex: 2 })
    expect(seat && 'seatDisabled' in seat).toBe(false)
    expect(store.getShare(shareId)?.updatedAt).toBe(2000)
  })

  it('DROPS junk seat fields from a hand-edited snapshot instead of coercing them', () => {
    const path = tempStorePath()
    writeSnapshot(path, [
      {
        collaboratorId: 'good',
        displayName: 'Olly',
        publicKeyId: 'pk-good',
        status: 'active',
        seatOrder: 4,
        colorIndex: 7,
        seatDisabled: true
      },
      {
        collaboratorId: 'junk-range',
        displayName: 'Sam',
        publicKeyId: 'pk-range',
        status: 'active',
        seatOrder: -3,
        colorIndex: 99
      },
      {
        collaboratorId: 'junk-type',
        displayName: 'Nia',
        publicKeyId: 'pk-type',
        status: 'active',
        seatOrder: '2',
        colorIndex: 2.5,
        seatDisabled: 'yes'
      }
    ])

    const store = new HumanCollaborationStore(path)
    const share = store.getShare('share-1')
    const byId = (id: string): HumanCollaboratorParticipant | undefined =>
      share?.participants.find((participant) => participant.collaboratorId === id)

    // Valid values survive the load — without this the drop assertions below
    // would pass just as happily against a normalizer that dropped everything.
    expect(byId('good')).toMatchObject({ seatOrder: 4, colorIndex: 7, seatDisabled: true })

    // Junk is OMITTED, not coerced. The renderer's own fallbacks (append after
    // the model seats, derive a hue from the pubkey) are strictly better than a
    // fabricated 0 / a clamped 7 / a mute conjured out of a truthy string — and
    // they are only reachable if the field is actually absent.
    const range = byId('junk-range')
    expect(range && 'seatOrder' in range).toBe(false)
    expect(range && 'colorIndex' in range).toBe(false)
    const wrongType = byId('junk-type')
    expect(wrongType && 'seatOrder' in wrongType).toBe(false)
    expect(wrongType && 'colorIndex' in wrongType).toBe(false)
    expect(wrongType && 'seatDisabled' in wrongType).toBe(false)
  })

  it('treats null as CLEAR and an omitted field as LEAVE ALONE', () => {
    const store = new HumanCollaborationStore()
    const { shareId, collaboratorId } = admit(store, 'chat-1')
    store.updateParticipantSeat({
      shareId,
      collaboratorId,
      seatOrder: 3,
      colorIndex: 5,
      seatDisabled: true,
      now: 2000
    })

    // Clearing the colour must clear it — if `null` were folded into
    // `undefined`, colorIndex would still be 5 and "reset to default" would be
    // an operation the host cannot perform at all.
    expect(
      store.updateParticipantSeat({ shareId, collaboratorId, colorIndex: null, now: 3000 })
    ).not.toBeNull()
    let seat = seatOf(store, shareId, collaboratorId)
    expect(seat && 'colorIndex' in seat).toBe(false)
    // …and the fields it did not name must be untouched.
    expect(seat?.seatOrder).toBe(3)
    expect(seat?.seatDisabled).toBe(true)
    expect(store.getShare(shareId)?.updatedAt).toBe(3000)

    // Clearing the order must not resurrect the colour or drop the mute.
    store.updateParticipantSeat({ shareId, collaboratorId, seatOrder: null, now: 4000 })
    seat = seatOf(store, shareId, collaboratorId)
    expect(seat && 'seatOrder' in seat).toBe(false)
    expect(seat && 'colorIndex' in seat).toBe(false)
    expect(seat?.seatDisabled).toBe(true)

    // Unmuting leaves the position and colour it was not asked about alone.
    store.updateParticipantSeat({ shareId, collaboratorId, seatOrder: 6, colorIndex: 1, now: 5000 })
    store.updateParticipantSeat({ shareId, collaboratorId, seatDisabled: false, now: 6000 })
    seat = seatOf(store, shareId, collaboratorId)
    expect(seat?.seatOrder).toBe(6)
    expect(seat?.colorIndex).toBe(1)
    expect(seat && 'seatDisabled' in seat).toBe(false)
  })

  it('refuses to seat a REVOKED participant and leaves the old seat as it was', () => {
    const store = new HumanCollaborationStore()
    const { shareId, collaboratorId } = admit(store, 'chat-1')
    store.updateParticipantSeat({ shareId, collaboratorId, seatOrder: 2, now: 2000 })
    store.revokeParticipant({ shareId, collaboratorId, now: 3000 })

    expect(
      store.updateParticipantSeat({ shareId, collaboratorId, seatOrder: 0, now: 9000 })
    ).toBeNull()
    expect(seatOf(store, shareId, collaboratorId)).toMatchObject({
      status: 'revoked',
      seatOrder: 2
    })
    expect(store.getShare(shareId)?.updatedAt).toBe(3000)
  })

  it('refuses to seat a PENDING participant (no completed SAS, no seat)', () => {
    // No writer on this store produces a `pending` participant — consumeInvite
    // admits straight to `active` — so the only way a pending record exists at
    // runtime is on disk, where an absent/unknown status normalizes to pending.
    // That is the real path, so drive it: a real store over a real file, and
    // real updateParticipantSeat calls against what it loaded.
    const path = tempStorePath()
    writeSnapshot(path, [
      { collaboratorId: 'pending-1', displayName: 'Olly', publicKeyId: 'pk-pending' }
    ])

    const store = new HumanCollaborationStore(path)
    expect(store.getShare('share-1')?.participants[0]).toMatchObject({
      collaboratorId: 'pending-1',
      status: 'pending'
    })

    expect(
      store.updateParticipantSeat({
        shareId: 'share-1',
        collaboratorId: 'pending-1',
        seatOrder: 0,
        colorIndex: 3,
        now: 9000
      })
    ).toBeNull()
    const seat = seatOf(store, 'share-1', 'pending-1')
    expect(seat && 'seatOrder' in seat).toBe(false)
    expect(seat && 'colorIndex' in seat).toBe(false)
    expect(store.getShare('share-1')?.updatedAt).toBe(1000)
  })

  it('mute is NOT revoke: seatDisabled is reversible and never touches status', () => {
    const store = new HumanCollaborationStore()
    const { shareId, collaboratorId } = admit(store, 'chat-1')
    store.updateParticipantSeat({
      shareId,
      collaboratorId,
      seatOrder: 1,
      seatDisabled: true,
      now: 2000
    })

    const muted = seatOf(store, shareId, collaboratorId)
    expect(muted?.seatDisabled).toBe(true)
    // The whole point: muting is presentation. Trust is untouched.
    expect(muted?.status).toBe('active')
    expect(muted?.revokedAt).toBeUndefined()
    // A muted seat is still a seat — it keeps its position and stays a
    // reconnect target, where a revoked one drops off entirely.
    expect(muted?.seatOrder).toBe(1)
    expect(store.listReconnectCandidates('ed25519:olly')).toHaveLength(1)
    // …and a muted identity is still admissible on a fresh invite.
    const whileMuted = store.createShare({ chatId: 'chat-1', mode: 'comments', now: 2100 })
    expect(
      store.verifyInvite({
        shareId,
        inviteToken: whileMuted.inviteToken,
        displayName: 'Olly',
        publicKeyId: 'ed25519:olly',
        now: 2200
      }).existingParticipant
    ).toMatchObject({ status: 'active', seatDisabled: true })

    // Unmute restores exactly the pre-mute seat. Revoke has no such inverse.
    expect(
      store.updateParticipantSeat({ shareId, collaboratorId, seatDisabled: false, now: 3000 })
    ).not.toBeNull()
    const unmuted = seatOf(store, shareId, collaboratorId)
    expect(unmuted && 'seatDisabled' in unmuted).toBe(false)
    expect(unmuted?.status).toBe('active')
    expect(unmuted?.seatOrder).toBe(1)

    // Revoke is the other verb: it withdraws trust, permanently.
    store.revokeParticipant({ shareId, collaboratorId, now: 4000 })
    expect(seatOf(store, shareId, collaboratorId)).toMatchObject({
      status: 'revoked',
      revokedAt: 4000
    })
    expect(store.listReconnectCandidates('ed25519:olly')).toHaveLength(0)
    const afterRevoke = store.createShare({ chatId: 'chat-1', mode: 'comments', now: 5000 })
    expect(() =>
      store.verifyInvite({
        shareId,
        inviteToken: afterRevoke.inviteToken,
        displayName: 'Olly',
        publicKeyId: 'ed25519:olly',
        now: 5100
      })
    ).toThrow(/revoked/)
    // And the seat writer is not a back door to un-revoking.
    expect(
      store.updateParticipantSeat({ shareId, collaboratorId, seatDisabled: false, now: 6000 })
    ).toBeNull()
  })
})

/**
 * Follow-ups from the seat-field review: the guards that were asymmetric or
 * missing when the writer first landed.
 */
describe('HumanCollaborationStore participant seats — tightened guards', () => {
  function admitted() {
    const store = new HumanCollaborationStore()
    const created = store.createShare({ chatId: 'chat-seat', mode: 'comments', now: 1000 })
    const { participant } = store.consumeInvite({
      shareId: created.share.shareId,
      inviteToken: created.inviteToken,
      displayName: 'Olly',
      publicKeyId: 'pk-seat',
      now: 1001
    })
    return { store, shareId: created.share.shareId, collaboratorId: participant.collaboratorId }
  }

  /**
   * `1.9` used to be accepted and floored to `1`, tying with whoever already
   * held slot 1 — the exact quiet reordering the guard exists to prevent, and
   * asymmetric with colorIndex, which always rejected non-integers.
   */
  it('REJECTS a fractional seatOrder rather than flooring it into a tie', () => {
    const { store, shareId, collaboratorId } = admitted()
    expect(store.updateParticipantSeat({ shareId, collaboratorId, seatOrder: 1.9 })).toBeNull()
    const seat = store
      .listShares('chat-seat')[0]
      ?.participants.find((p) => p.collaboratorId === collaboratorId)
    expect(seat && 'seatOrder' in seat).toBe(false)
  })

  it('REJECTS an absurd seatOrder rather than storing it', () => {
    const { store, shareId, collaboratorId } = admitted()
    expect(store.updateParticipantSeat({ shareId, collaboratorId, seatOrder: 1e300 })).toBeNull()
    expect(store.updateParticipantSeat({ shareId, collaboratorId, seatOrder: 5000 })).toBeNull()
    // The bound is inclusive at the top and zero is legitimate (front of queue).
    expect(store.updateParticipantSeat({ shareId, collaboratorId, seatOrder: 0 })).not.toBeNull()
  })

  /**
   * A drag-reorder UI emits a great many no-ops. Persisting each one bumps
   * updatedAt and triggers a whole-snapshot synchronous write — the repo's known
   * main-thread stall class.
   */
  it('does not persist or move updatedAt when nothing actually changed', () => {
    const { store, shareId, collaboratorId } = admitted()
    store.updateParticipantSeat({ shareId, collaboratorId, seatOrder: 4, now: 2000 })
    const afterWrite = store.listShares('chat-seat')[0]?.updatedAt

    // Same value again, and a call carrying no seat fields at all.
    store.updateParticipantSeat({ shareId, collaboratorId, seatOrder: 4, now: 9999 })
    store.updateParticipantSeat({ shareId, collaboratorId, now: 9999 })
    expect(store.listShares('chat-seat')[0]?.updatedAt).toBe(afterWrite)

    // A real change still moves it.
    store.updateParticipantSeat({ shareId, collaboratorId, seatOrder: 5, now: 3000 })
    expect(store.listShares('chat-seat')[0]?.updatedAt).toBe(3000)
  })

  it('shares ONE palette bound with the contacts store', () => {
    const { store, shareId, collaboratorId } = admitted()
    expect(store.updateParticipantSeat({ shareId, collaboratorId, colorIndex: 7 })).not.toBeNull()
    expect(store.updateParticipantSeat({ shareId, collaboratorId, colorIndex: 8 })).toBeNull()
  })
})

describe('the full-history opt-in', () => {
  const SHARE_CREATED = Date.parse('2026-07-31T12:00:00.000Z')
  const chatWith = (messages: unknown[]) =>
    ({ appChatId: 'chat-1', title: 'Shared', messages, runs: [] }) as never
  const msg = (id: string, iso: string) =>
    ({ id, role: 'user', content: `content ${id}`, timestamp: iso }) as never

  function sharedStore() {
    const store = new HumanCollaborationStore()
    const created = store.createShare({
      chatId: 'chat-1',
      mode: 'comments',
      now: SHARE_CREATED,
      inviteTtlMs: 60_000
    })
    return { store, shareId: created.share.shareId }
  }

  it('moves the ACTUAL history floor, in both directions', () => {
    // The test that matters. A setter that writes a field nothing reads is the
    // defect this feature keeps shipping, so this asserts the user-visible
    // consequence — whether a row written BEFORE the share existed reaches a
    // collaborator — using the real projection builder and the real share the
    // store returns, not a hand-built object.
    const { store, shareId } = sharedStore()
    const messages = [
      msg('before-the-share', '2026-07-31T11:00:00.000Z'),
      msg('after-the-share', '2026-07-31T13:00:00.000Z')
    ]

    const floored = store.getShare(shareId)!
    expect(floored.fullHistory).toBeUndefined()
    expect(
      buildHumanShareProjection(chatWith(messages), floored, {}).rows.map((r) => r.id)
    ).toEqual(['after-the-share'])

    const opened = store.setFullHistory({ shareId, fullHistory: true, now: SHARE_CREATED + 1 })!
    expect(opened.fullHistory).toBe(true)
    expect(
      buildHumanShareProjection(chatWith(messages), opened, {}).rows.map((r) => r.id)
    ).toEqual(['before-the-share', 'after-the-share'])

    // And it re-floors. A consent decision has to be revocable, and the row
    // must stop crossing the moment it is.
    const closed = store.setFullHistory({ shareId, fullHistory: false, now: SHARE_CREATED + 2 })!
    expect(
      buildHumanShareProjection(chatWith(messages), closed, {}).rows.map((r) => r.id)
    ).toEqual(['after-the-share'])
  })

  it('never reports a share as opted-in from anything but a literal true', () => {
    // Absent and explicitly-off must be indistinguishable, or a share reads as
    // opted-in because of a stale key surviving a format change or a hand edit.
    //
    // Asserted against a RAW FILE rather than the setter's return value: the
    // guarantee lives in `normalizeSnapshot`, which emits the key only for a
    // literal `true`, and a test that went through the setter would pass even
    // if the setter stored `false` — the clone strips it on the way out. That
    // is exactly the shape of test this project keeps being bitten by.
    const dir = mkdtempSync(join(tmpdir(), 'tw-fullhistory-raw-'))
    try {
      const path = join(dir, 'collab.json')
      const base = {
        shareId: 'share-raw',
        chatId: 'chat-1',
        mode: 'comments',
        enabled: true,
        createdAt: SHARE_CREATED,
        updatedAt: SHARE_CREATED,
        nextSequence: 1,
        participants: [],
        invites: [],
        idempotency: {}
      }
      for (const value of [false, 'true', 1, null]) {
        writeFileSync(
          path,
          JSON.stringify({ shares: [{ ...base, fullHistory: value }] }),
          'utf8'
        )
        expect(
          new HumanCollaborationStore(path).getShare('share-raw')?.fullHistory,
          `fullHistory: ${JSON.stringify(value)} must not read as opted-in`
        ).toBeUndefined()
      }
      writeFileSync(path, JSON.stringify({ shares: [{ ...base, fullHistory: true }] }), 'utf8')
      expect(new HumanCollaborationStore(path).getShare('share-raw')?.fullHistory).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('survives a reload, because an opt-in that forgets is worse than none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-fullhistory-'))
    try {
      const path = join(dir, 'collab.json')
      const store = new HumanCollaborationStore(path)
      const created = store.createShare({ chatId: 'chat-1', mode: 'comments', now: SHARE_CREATED })
      store.setFullHistory({ shareId: created.share.shareId, fullHistory: true })
      expect(new HumanCollaborationStore(path).getShare(created.share.shareId)?.fullHistory).toBe(
        true
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a revoked share and an unknown one', () => {
    const { store, shareId } = sharedStore()
    store.revokeShare(shareId)
    expect(store.setFullHistory({ shareId, fullHistory: true })).toBeNull()
    expect(store.setFullHistory({ shareId: 'no-such-share', fullHistory: true })).toBeNull()
  })
})
