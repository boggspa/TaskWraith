import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatService, type ChatServiceDeps, type ChatServiceStore } from './ChatService'
import { HumanCollaborationStore } from '../collaboration/HumanCollaborationStore'
import {
  ExternalContributionQueueStore,
  MAX_QUEUED_PER_COLLABORATOR,
  RESOLVED_RETENTION_MS
} from '../collaboration/ExternalContributionQueueStore'
import { HumanCollaborationDenialError } from '../collaboration/HumanContributionRules'
import {
  EXTERNAL_CONTRIBUTION_POSTAMBLE,
  EXTERNAL_CONTRIBUTION_PREAMBLE
} from '../collaboration/ExternalContributionContext'
import type { HumanCollaborationAuditInput } from '../collaboration/HumanCollaborationAuditLog'
import { isHumanCollaboratorComment } from '../collaboration/HumanCollaboratorMessages'
import type { ChatListItem, ChatRecord } from '../store/types'

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    scope: 'workspace',
    provider: 'gemini',
    title: 'Chat',
    workspaceId: 'workspace-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ...overrides
  }
}

/** A fixed, obviously-synthetic clock so every queue deadline in the suite is
 *  exact and no assertion depends on the wall clock. */
const QUEUE_NOW = 1_700_000_000_000

/**
 * `withQueue` is OPT-IN, not the default. A ChatService built with no review
 * queue is a real production shape (main only started passing one in this
 * slice), and it is also the fail-closed case behaviour 7 pins — so the
 * pre-existing tests keep exactly the deps they had, and a test that wants the
 * queue says so.
 */
function harness(options: { withQueue?: boolean } = {}) {
  const chats = new Map<string, ChatRecord>([['chat-1', chat()]])
  const store: ChatServiceStore = {
    getChats: vi.fn(() => Array.from(chats.values())),
    getChatList: vi.fn(() => []),
    getPinnedMessages: vi.fn(() => []),
    getChat: vi.fn((chatId) => chats.get(chatId) || null),
    createChat: vi.fn(),
    createGlobalChat: vi.fn(),
    createEnsembleChat: vi.fn(),
    createSubThread: vi.fn(),
    createSideChat: vi.fn(),
    setChatKind: vi.fn(),
    getChildChats: vi.fn(() => []),
    getSideChats: vi.fn(() => []),
    saveChat: vi.fn((next: ChatRecord) => {
      chats.set(next.appChatId, next)
      return next
    }),
    deleteChat: vi.fn(),
    clearChats: vi.fn()
  }
  const collaboration = new HumanCollaborationStore()
  // In-memory: no storage path means load() and persist() both no-op, so the
  // queue needs no temp directory and no cleanup. The clock is a mutable holder
  // rather than a constant so a test can age the queue past its retention
  // window without ever touching the wall clock.
  const queueClock = { now: QUEUE_NOW }
  const queue = new ExternalContributionQueueStore(undefined, undefined, () => queueClock.now)
  const auditEvents: HumanCollaborationAuditInput[] = []
  const deps: ChatServiceDeps = {
    appStore: store,
    humanCollaborationStore: collaboration,
    humanCollaborationAudit: {
      append: (event) => {
        auditEvents.push(event)
      }
    },
    findRegisteredWorkspace: vi.fn(),
    canonicalPath: vi.fn((value) => value),
    prepareForkMessages: vi.fn(({ copiedMessages }) => copiedMessages),
    sanitizeChatForSave: vi.fn((value) => value),
    appendDurableRunEventForRoute: vi.fn(),
    ...(options.withQueue ? { externalContributionQueue: queue } : {})
  }
  return {
    service: new ChatService(deps),
    store,
    collaboration,
    chats,
    queue,
    queueClock,
    auditEvents
  }
}

/** Audit rows of one kind, in the order they were written. */
function auditKinds(events: readonly HumanCollaborationAuditInput[]): string[] {
  return events.map((event) => event.kind)
}

function admitted(service: ChatService) {
  const created = service.createHumanCollaborationShare({ chatId: 'chat-1', mode: 'comments' })
  const consumed = service.consumeHumanCollaborationInvite({
    shareId: created.share.shareId,
    inviteToken: created.inviteToken,
    displayName: 'Alex',
    publicKeyId: 'alex-key'
  })
  return { shareId: created.share.shareId, collaboratorId: consumed.participant.collaboratorId }
}

describe('ChatService collaborator comments', () => {
  it('appends comments through the host-side path and dedupes retries', () => {
    const { service, store } = harness()
    const { shareId, collaboratorId } = admitted(service)

    const first = service.appendCollaboratorComment({
      shareId,
      chatId: 'chat-1',
      collaboratorId,
      clientMessageId: 'client-1',
      content: 'Please review this'
    })

    expect(first.deduped).toBe(false)
    expect(first.message!).toMatchObject({
      role: 'system',
      content: 'Please review this',
      metadata: expect.objectContaining({
        kind: 'humanCollaboratorComment',
        sourceTrust: 'external_untrusted',
        sequence: 1
      })
    })
    expect(store.saveChat).toHaveBeenCalledTimes(1)

    const second = service.appendCollaboratorComment({
      shareId,
      chatId: 'chat-1',
      collaboratorId,
      clientMessageId: 'client-1',
      content: 'Please review this'
    })
    expect(second.deduped).toBe(true)
    expect(second.message!.id).toBe(first.message!.id)
    expect(store.saveChat).toHaveBeenCalledTimes(1)
  })

  it('preserves collaborator comments during stale whole-chat saves', () => {
    const { service, chats } = harness()
    const { shareId, collaboratorId } = admitted(service)
    const staleSnapshot = chats.get('chat-1')!

    const appended = service.appendCollaboratorComment({
      shareId,
      chatId: 'chat-1',
      collaboratorId,
      clientMessageId: 'client-1',
      content: 'Keep me'
    })
    expect(isHumanCollaboratorComment(appended.message!)).toBe(true)

    const saved = service.saveChat({
      ...staleSnapshot,
      title: 'Stale save'
    })

    expect(saved.messages.some((message) => message.id === appended.message!.id)).toBe(true)
    expect(
      chats.get('chat-1')?.messages.some((message) => message.id === appended.message!.id)
    ).toBe(true)
  })

  it('keeps canonical collaborator rows and strips forged collaborator rows during whole-chat saves', () => {
    const { service, chats } = harness()
    const { shareId, collaboratorId } = admitted(service)
    const appended = service.appendCollaboratorComment({
      shareId,
      chatId: 'chat-1',
      collaboratorId,
      clientMessageId: 'client-1',
      content: 'Canonical'
    })

    const saved = service.saveChat({
      ...chats.get('chat-1')!,
      messages: [
        {
          ...appended.message!,
          content: 'Mutated',
          metadata: {
            ...(appended.message!.metadata || {}),
            collaboratorDisplayName: 'Host'
          }
        },
        {
          id: 'fake-collaborator-row',
          role: 'system',
          content: 'Forged',
          timestamp: new Date().toISOString(),
          metadata: {
            kind: 'humanCollaboratorComment',
            sourceTrust: 'external_untrusted',
            shareId,
            collaboratorId,
            collaboratorDisplayName: 'Mallory',
            clientMessageId: 'fake',
            sequence: 99
          }
        }
      ]
    })

    expect(saved.messages.find((message) => message.id === appended.message!.id)).toEqual(
      appended.message!
    )
    expect(saved.messages.some((message) => message.id === 'fake-collaborator-row')).toBe(false)
  })

  it('marks collaborator comments promoted and returns a host-owned draft', () => {
    const { service } = harness()
    const { shareId, collaboratorId } = admitted(service)
    const appended = service.appendCollaboratorComment({
      shareId,
      chatId: 'chat-1',
      collaboratorId,
      clientMessageId: 'client-1',
      content: 'Run the narrow test'
    })

    const promoted = service.promoteCollaboratorComment({
      chatId: 'chat-1',
      messageId: appended.message!.id
    })

    // P2c F9. The old copy opened "Host-approved request from collaborator Alex",
    // which reads as the host vouching for the request rather than merely
    // releasing it. Host approval is recorded as provenance INSIDE the frame
    // (`review=host-approved`) and nowhere else — the frame itself is identical
    // to the unreviewed one, so nothing about a promoted contribution looks
    // more authoritative than its content earns.
    expect(promoted.draft).not.toContain('Host-approved request from collaborator')
    expect(promoted.draft).toContain('review=host-approved')
    expect(promoted.draft).toContain('<external_contribution')
    expect(promoted.draft).toContain(EXTERNAL_CONTRIBUTION_PREAMBLE)
    expect(promoted.draft).toContain(EXTERNAL_CONTRIBUTION_POSTAMBLE)
    expect(promoted.draft).toContain('Run the narrow test')
    expect(
      promoted.chat.messages.find((message) => message.id === appended.message!.id)?.metadata
    ).toMatchObject({
      promotedBy: 'host'
    })
  })

  it('revokes active shares when the chat is deleted', () => {
    const { service, store, collaboration } = harness()
    const { shareId } = admitted(service)
    expect(collaboration.getShare(shareId)?.enabled).toBe(true)

    service.deleteChat('chat-1')

    expect(store.deleteChat).toHaveBeenCalledWith('chat-1')
    expect(collaboration.getShare(shareId)?.enabled).toBe(false)
    expect(collaboration.listShares('chat-1').some((share) => share.enabled)).toBe(false)
  })
})

/*
 * Phase 2 (P2b) — structured request-host-action contributions + auto-draft.
 */
describe('ChatService collaborator action requests (P2b)', () => {
  it('rejects an action request under plain comments rules', () => {
    const { service } = harness()
    const { shareId, collaboratorId } = admitted(service)
    expect(() =>
      service.appendCollaboratorComment({
        shareId,
        chatId: 'chat-1',
        collaboratorId,
        clientMessageId: 'c-1',
        content: 'please run the tests',
        intent: 'requestHostAction'
      })
    ).toThrow(/does not accept host-action requests/)
  })

  it('stamps contributionKind for action requests under requestHostAction rules — no draft, no send', () => {
    const { service } = harness()
    const { shareId, collaboratorId } = admitted(service)
    service.updateHumanCollaborationShareRules({ shareId, preset: 'requestHostAction' })

    const result = service.appendCollaboratorComment({
      shareId,
      chatId: 'chat-1',
      collaboratorId,
      clientMessageId: 'c-1',
      content: 'please run the tests',
      intent: 'requestHostAction'
    })
    expect(result.message!.metadata?.contributionKind).toBe('requestHostAction')
    expect(result.message!.metadata?.kind).toBe('humanCollaboratorComment')
    expect(result.message!.metadata?.sourceTrust).toBe('external_untrusted')
    // requestHostAction preset is host-click, not auto-draft: nothing pre-fills.
    expect(result.autoDraft).toBeUndefined()
    expect(result.message!.metadata?.promotedAt).toBeUndefined()
  })

  it('autoDraft rules return a wrapped provenance draft, stamped promotedBy auto — never host', () => {
    const { service } = harness()
    const { shareId, collaboratorId } = admitted(service)
    service.updateHumanCollaborationShareRules({ shareId, preset: 'autoDraft' })

    const result = service.appendCollaboratorComment({
      shareId,
      chatId: 'chat-1',
      collaboratorId,
      clientMessageId: 'c-2',
      content: 'please add a regression test',
      intent: 'requestHostAction'
    })
    // P2c F9: the draft now carries the SAME untrusted frame the composition
    // choke point emits, not a prose summary of one. This is the path that
    // frame cannot reach later — once the host sends the draft it is an
    // ordinary host `user` message with no `sourceTrust` to re-detect — so the
    // frame has to be here or it never exists for this text.
    expect(result.autoDraft).toContain('<external_contribution')
    expect(result.autoDraft).toContain('</external_contribution>')
    expect(result.autoDraft).toContain(EXTERNAL_CONTRIBUTION_PREAMBLE)
    expect(result.autoDraft).toContain(EXTERNAL_CONTRIBUTION_POSTAMBLE)
    expect(result.autoDraft).toContain('Alex')
    // An auto-draft was NOT read by the host before insertion, so it must never
    // claim review it did not get.
    expect(result.autoDraft).toContain('review=unreviewed')
    expect(result.autoDraft).not.toContain('review=host-approved')
    // Provenance: share id, message id, timestamp.
    expect(result.autoDraft).toContain(shareId)
    expect(result.autoDraft).toContain(result.message!.id)
    expect(result.message!.metadata?.promotedBy).toBe('auto')
    expect(result.message!.metadata?.promotedDraft).toBe(result.autoDraft)
  })

  it('a plain comment under autoDraft rules never auto-drafts', () => {
    const { service } = harness()
    const { shareId, collaboratorId } = admitted(service)
    service.updateHumanCollaborationShareRules({ shareId, preset: 'autoDraft' })
    const result = service.appendCollaboratorComment({
      shareId,
      chatId: 'chat-1',
      collaboratorId,
      clientMessageId: 'c-3',
      content: 'just a note'
    })
    expect(result.autoDraft).toBeUndefined()
    expect(result.message!.metadata?.contributionKind).toBeUndefined()
  })
})

/*
 * Host review (`share.requiresHostApproval`): a contribution is ENQUEUED for the
 * host instead of appended, and reaches the transcript only on approval.
 *
 * The flag defaults OFF and every one of these tests has to turn it on, which is
 * the point — a build carrying the queue must not change one existing share.
 */
describe('ChatService host-reviewed contributions', () => {
  /** Admit a collaborator and put the share into host review. */
  function reviewed(service: ChatService, collaboration: HumanCollaborationStore) {
    const { shareId, collaboratorId } = admitted(service)
    const updated = collaboration.setRequiresHostApproval({ shareId, requiresHostApproval: true })
    expect(updated?.requiresHostApproval).toBe(true)
    return { shareId, collaboratorId }
  }

  it('never touches the queue while host review is off, even with a queue wired in', () => {
    const { service, store, collaboration, queue, chats } = harness({ withQueue: true })
    const { shareId, collaboratorId } = admitted(service)
    // The regression that matters most: the flag defaults off precisely so that
    // shipping the queue changes nothing for a share nobody opted in.
    expect(collaboration.getShare(shareId)?.requiresHostApproval).toBeUndefined()
    const enqueue = vi.spyOn(queue, 'enqueue')

    const result = service.appendCollaboratorComment({
      shareId,
      chatId: 'chat-1',
      collaboratorId,
      clientMessageId: 'client-1',
      content: 'Straight to the transcript'
    })

    expect(enqueue).not.toHaveBeenCalled()
    expect(queue.listQueued('chat-1')).toEqual([])
    expect(result.queued).toBeUndefined()
    expect(result.queueEntryId).toBeUndefined()
    expect(result.message?.content).toBe('Straight to the transcript')
    expect(chats.get('chat-1')?.messages).toHaveLength(1)
    expect(store.saveChat).toHaveBeenCalledTimes(1)
  })

  it('queues the contribution and leaves the transcript untouched when host review is on', () => {
    const { service, store, collaboration, queue, chats, auditEvents } = harness({
      withQueue: true
    })
    const { shareId, collaboratorId } = reviewed(service, collaboration)
    const before = chats.get('chat-1')!.messages.length

    const result = service.appendCollaboratorComment({
      shareId,
      chatId: 'chat-1',
      collaboratorId,
      clientMessageId: 'client-1',
      content: 'Awaiting review'
    })

    expect(result.queued).toBe(true)
    expect(result.deduped).toBe(false)
    expect(result.queueEntryId).toBeTruthy()
    // Absent, not merely falsy: a caller that reads `result.message.id` must
    // fail loudly rather than dereference a placeholder row.
    expect('message' in result).toBe(false)
    expect(result.message).toBeUndefined()
    // Separately from the return shape: nothing moved in the transcript, in the
    // returned chat, or through the persistence path.
    expect(chats.get('chat-1')?.messages).toHaveLength(before)
    expect(result.chat.messages).toHaveLength(before)
    expect(store.saveChat).not.toHaveBeenCalled()
    expect(queue.listQueued('chat-1')).toHaveLength(1)
    expect(auditKinds(auditEvents)).toContain('contribution.received')
  })

  it('answers the THIRD dedupe state: a retry of a queued contribution never enqueues twice', () => {
    const { service, store, collaboration, queue, chats, auditEvents } = harness({
      withQueue: true
    })
    const { shareId, collaboratorId } = reviewed(service, collaboration)
    const send = () =>
      service.appendCollaboratorComment({
        shareId,
        chatId: 'chat-1',
        collaboratorId,
        clientMessageId: 'retry-1',
        content: 'Sent twice by a flaky socket'
      })

    const first = send()
    // The share store binds clientMessageId -> messageId at enqueue, so the
    // pre-existing branch DOES fire on the retry — and then asks only "is that
    // messageId in chat.messages?", which for a queued contribution is no. With
    // no queue lookup the retry falls straight through into a second enqueue.
    const second = send()

    expect(queue.listQueued('chat-1')).toHaveLength(1)
    expect(second.deduped).toBe(true)
    expect(second.queued).toBe(true)
    expect(second.queueEntryId).toBe(first.queueEntryId)
    expect(second.message).toBeUndefined()
    expect(auditKinds(auditEvents).filter((kind) => kind === 'contribution.deduped')).toHaveLength(
      1
    )
    // The queue's own duplicate refusal would surface to the collaborator as a
    // denial, so a retry must not produce a rejection row either.
    expect(auditKinds(auditEvents)).not.toContain('contribution.rejected')
    expect(chats.get('chat-1')?.messages).toHaveLength(0)
    expect(store.saveChat).not.toHaveBeenCalled()
  })

  it('allocates the sequence and the idempotency binding exactly once, at enqueue', () => {
    const { service, collaboration, queue } = harness({ withQueue: true })
    const { shareId, collaboratorId } = reviewed(service, collaboration)
    const send = (clientMessageId: string) =>
      service.appendCollaboratorComment({
        shareId,
        chatId: 'chat-1',
        collaboratorId,
        clientMessageId,
        content: `body for ${clientMessageId}`
      })
    expect(collaboration.getShare(shareId)?.nextSequence).toBe(1)

    const a = send('seq-a')
    expect(collaboration.getShare(shareId)?.nextSequence).toBe(2)
    const b = send('seq-b')
    expect(collaboration.getShare(shareId)?.nextSequence).toBe(3)
    expect(queue.get(a.queueEntryId!)?.sequence).toBe(1)
    expect(queue.get(b.queueEntryId!)?.sequence).toBe(2)

    // The retry allocates NOTHING: no sequence, no second entry, no rebinding.
    const retry = send('seq-a')
    expect(retry.queueEntryId).toBe(a.queueEntryId)
    expect(collaboration.getShare(shareId)?.nextSequence).toBe(3)
    expect(queue.listQueued('chat-1')).toHaveLength(2)
    // And the binding points at the id the entry already carries, which is what
    // lets the ordinary transcript dedupe take over the moment it materialises.
    const idempotency = collaboration.getShare(shareId)?.idempotency || {}
    expect(idempotency[`${collaboratorId}:seq-a`]).toBe(queue.get(a.queueEntryId!)?.messageId)
    expect(idempotency[`${collaboratorId}:seq-b`]).toBe(queue.get(b.queueEntryId!)?.messageId)
  })

  it('freezes the queued identity from the session and round-trips an action request', () => {
    const { service, collaboration, queue } = harness({ withQueue: true })
    const { shareId, collaboratorId } = reviewed(service, collaboration)
    service.updateHumanCollaborationShareRules({ shareId, preset: 'requestHostAction' })
    // The preset write must not have cleared the flag — that is exactly why the
    // field lives on the share and not inside the derived contributionRules.
    expect(collaboration.getShare(shareId)?.requiresHostApproval).toBe(true)

    const request = service.appendCollaboratorComment({
      shareId,
      chatId: 'chat-1',
      collaboratorId,
      clientMessageId: 'act-1',
      content: 'please run the tests',
      intent: 'requestHostAction'
    })
    const entry = queue.get(request.queueEntryId!)

    expect(entry).toMatchObject({
      chatId: 'chat-1',
      shareId,
      collaboratorId,
      // From the admitted SESSION, never from anything the caller passed: the
      // append API has no displayName parameter at all.
      displayName: 'Alex',
      clientMessageId: 'act-1',
      state: 'queued',
      body: 'please run the tests',
      intent: 'requestHostAction'
    })
    // The pre-minted row id travels with the entry, so approve has a target.
    expect(entry?.messageId).toBeTruthy()
    expect(entry?.messageId).toBe(
      (collaboration.getShare(shareId)?.idempotency || {})[`${collaboratorId}:act-1`]
    )

    // A plain comment must not acquire the intent by construction.
    const comment = service.appendCollaboratorComment({
      shareId,
      chatId: 'chat-1',
      collaboratorId,
      clientMessageId: 'act-2',
      content: 'just a note'
    })
    expect(queue.get(comment.queueEntryId!)?.intent).toBeUndefined()
  })

  it('surfaces an enqueue refusal as a denial, with an audit row and nothing appended', () => {
    const { service, store, collaboration, queue, chats, auditEvents } = harness({
      withQueue: true
    })
    const { shareId, collaboratorId } = reviewed(service, collaboration)
    for (let index = 0; index < MAX_QUEUED_PER_COLLABORATOR; index += 1) {
      service.appendCollaboratorComment({
        shareId,
        chatId: 'chat-1',
        collaboratorId,
        clientMessageId: `fill-${index}`,
        content: `filling the quota ${index}`
      })
    }
    expect(queue.listQueued('chat-1')).toHaveLength(MAX_QUEUED_PER_COLLABORATOR)

    let thrown: unknown
    try {
      service.appendCollaboratorComment({
        shareId,
        chatId: 'chat-1',
        collaboratorId,
        clientMessageId: 'one-too-many',
        content: 'one too many'
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(HumanCollaborationDenialError)
    expect((thrown as HumanCollaborationDenialError).code).toBe('quota_exceeded')
    const rejected = auditEvents.filter((event) => event.kind === 'contribution.rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.code).toBe('quota_exceeded')
    // A refusal that quietly appended instead would be the worst outcome here:
    // unreviewed text in the transcript, sent by the path that exists to stop it.
    expect(queue.listQueued('chat-1')).toHaveLength(MAX_QUEUED_PER_COLLABORATOR)
    expect(chats.get('chat-1')?.messages).toHaveLength(0)
    expect(store.saveChat).not.toHaveBeenCalled()
  })

  it('fails closed when a share asks for host review and no queue is wired', () => {
    // No `withQueue`: the deliberate direction is to throw rather than append
    // text the host asked to see first.
    const { service, store, collaboration, chats, auditEvents } = harness()
    const { shareId, collaboratorId } = reviewed(service, collaboration)

    expect(() =>
      service.appendCollaboratorComment({
        shareId,
        chatId: 'chat-1',
        collaboratorId,
        clientMessageId: 'client-1',
        content: 'must not land unreviewed'
      })
    ).toThrow(/review queue is unavailable/)

    expect(chats.get('chat-1')?.messages).toHaveLength(0)
    expect(store.saveChat).not.toHaveBeenCalled()
    expect(auditKinds(auditEvents)).not.toContain('contribution.received')
  })

  it('reports the entry STATE on a retry, never "still awaiting review" about a denial', () => {
    const { service, collaboration, queue, chats } = harness({ withQueue: true })
    const { shareId, collaboratorId } = reviewed(service, collaboration)
    const send = () =>
      service.appendCollaboratorComment({
        shareId,
        chatId: 'chat-1',
        collaboratorId,
        clientMessageId: 'c-deny',
        content: 'the host said no'
      })

    const first = send()
    expect(queue.deny(first.queueEntryId!, 'not this one')?.state).toBe('denied')
    const retry = send()

    // The lookup matches ANY state, so `queued` has to come from the entry, not
    // from its existence. This is the one that would silently mislead the
    // collaborator UI into showing a pending spinner over a refusal.
    expect(retry.deduped).toBe(true)
    expect(retry.queued).toBe(false)
    expect(retry.queueEntryId).toBe(first.queueEntryId)
    expect(retry.message).toBeUndefined()
    // Still exactly one entry, and the denial was not overwritten.
    expect(queue.listForCollaborator(collaboratorId)).toHaveLength(1)
    expect(queue.get(first.queueEntryId!)?.state).toBe('denied')
    expect(chats.get('chat-1')?.messages).toHaveLength(0)
  })

  it('reports the entry STATE for a lapse and for an approve not yet materialised', () => {
    const { service, collaboration, queue } = harness({ withQueue: true })
    const { shareId, collaboratorId } = reviewed(service, collaboration)
    const send = (clientMessageId: string) =>
      service.appendCollaboratorComment({
        shareId,
        chatId: 'chat-1',
        collaboratorId,
        clientMessageId,
        content: `body for ${clientMessageId}`
      })

    const lapsing = send('c-lapse')
    expect(queue.lapseAll({ collaboratorId }, 'revoked')).toHaveLength(1)
    const afterLapse = send('c-lapse')
    expect(afterLapse.deduped).toBe(true)
    expect(afterLapse.queued).toBe(false)
    expect(afterLapse.queueEntryId).toBe(lapsing.queueEntryId)

    // Approved but NOT yet written to the transcript: the row does not exist, so
    // the transcript dedupe cannot answer, and the entry is no longer queued.
    const approving = send('c-approve')
    expect(queue.approve(approving.queueEntryId!)?.materialised).toBe(false)
    const afterApprove = send('c-approve')
    expect(afterApprove.deduped).toBe(true)
    expect(afterApprove.queued).toBe(false)
    expect(afterApprove.queueEntryId).toBe(approving.queueEntryId)
    expect(afterApprove.message).toBeUndefined()
  })

  it('dedupes through the QUEUE when the share binding was evicted but the entry survives', () => {
    const { service, collaboration, queue } = harness({ withQueue: true })
    const { shareId, collaboratorId } = reviewed(service, collaboration)
    const send = (clientMessageId: string) =>
      service.appendCollaboratorComment({
        shareId,
        chatId: 'chat-1',
        collaboratorId,
        clientMessageId,
        content: `body for ${clientMessageId}`
      })

    const stillQueued = send('evict-a')
    const denied = send('evict-b')
    queue.deny(denied.queueEntryId!, 'no')

    // The share's idempotency map is capped and evicts OLDEST-first, while a
    // queued entry has no matching bound — so the binding can disappear while
    // its entry is still pending. Flood it with host review OFF (the flag is
    // irrelevant to `recordAppend`, and appending is the cheap way to bind).
    collaboration.setRequiresHostApproval({ shareId, requiresHostApproval: false })
    const bindings = () => collaboration.getShare(shareId)?.idempotency || {}
    let flood = 0
    while (
      (bindings()[`${collaboratorId}:evict-a`] !== undefined ||
        bindings()[`${collaboratorId}:evict-b`] !== undefined) &&
      flood < 2000
    ) {
      send(`flood-${flood}`)
      flood += 1
    }
    expect(bindings()[`${collaboratorId}:evict-a`]).toBeUndefined()
    expect(bindings()[`${collaboratorId}:evict-b`]).toBeUndefined()
    collaboration.setRequiresHostApproval({ shareId, requiresHostApproval: true })

    // Both retries now miss the share-side dedupe entirely and reach `enqueue`,
    // which answers `duplicate` WITH the existing entry. That must come back as
    // a dedupe carrying the real state — not as "could not be queued".
    const retryQueued = send('evict-a')
    expect(retryQueued.deduped).toBe(true)
    expect(retryQueued.queued).toBe(true)
    expect(retryQueued.queueEntryId).toBe(stillQueued.queueEntryId)

    const retryDenied = send('evict-b')
    expect(retryDenied.deduped).toBe(true)
    expect(retryDenied.queued).toBe(false)
    expect(retryDenied.queueEntryId).toBe(denied.queueEntryId)

    // Exactly the two original entries — no second copy of either.
    expect(queue.listForCollaborator(collaboratorId)).toHaveLength(2)
    expect(queue.listQueued('chat-1')).toHaveLength(1)
  })

  it('refuses a missing queue BEFORE allocating: no sequence moves and no binding is made', () => {
    const { service, store, collaboration, chats } = harness()
    const { shareId, collaboratorId } = reviewed(service, collaboration)
    const before = collaboration.getShare(shareId)!
    expect(before.nextSequence).toBe(1)

    let thrown: unknown
    try {
      service.appendCollaboratorComment({
        shareId,
        chatId: 'chat-1',
        collaboratorId,
        clientMessageId: 'no-queue',
        content: 'must not land unreviewed'
      })
    } catch (error) {
      thrown = error
    }

    // Typed, so a code-mapping caller sees a reason rather than an internal error.
    expect(thrown).toBeInstanceOf(HumanCollaborationDenialError)
    expect((thrown as HumanCollaborationDenialError).code).toBe('rule_denied')
    // The property that matters: refusing AFTER `recordAppend` would burn a
    // sequence number on every retry and bind the idempotency key to a
    // messageId that can never exist, so `nextSequence` climbs forever.
    const after = collaboration.getShare(shareId)!
    expect(after.nextSequence).toBe(before.nextSequence)
    expect(after.idempotency[`${collaboratorId}:no-queue`]).toBeUndefined()
    expect(Object.keys(after.idempotency)).toHaveLength(0)
    expect(chats.get('chat-1')?.messages).toHaveLength(0)
    expect(store.saveChat).not.toHaveBeenCalled()
  })

  it('refuses a full queue BEFORE allocating: no sequence moves and no binding is made', () => {
    const { service, collaboration, queue } = harness({ withQueue: true })
    const { shareId, collaboratorId } = reviewed(service, collaboration)
    for (let index = 0; index < MAX_QUEUED_PER_COLLABORATOR; index += 1) {
      service.appendCollaboratorComment({
        shareId,
        chatId: 'chat-1',
        collaboratorId,
        clientMessageId: `fill-${index}`,
        content: `filling the quota ${index}`
      })
    }
    const before = collaboration.getShare(shareId)!
    expect(before.nextSequence).toBe(MAX_QUEUED_PER_COLLABORATOR + 1)

    expect(() =>
      service.appendCollaboratorComment({
        shareId,
        chatId: 'chat-1',
        collaboratorId,
        clientMessageId: 'over-quota',
        content: 'one too many'
      })
    ).toThrow(HumanCollaborationDenialError)

    const after = collaboration.getShare(shareId)!
    expect(after.nextSequence).toBe(before.nextSequence)
    expect(after.idempotency[`${collaboratorId}:over-quota`]).toBeUndefined()
    expect(Object.keys(after.idempotency)).toHaveLength(MAX_QUEUED_PER_COLLABORATOR)
    expect(queue.listQueued('chat-1')).toHaveLength(MAX_QUEUED_PER_COLLABORATOR)
  })

  it('refuses a retry whose entry has aged out but whose TOMBSTONE survives, never appends it', () => {
    const { service, store, collaboration, queue, queueClock, chats, auditEvents } = harness({
      withQueue: true
    })
    const { shareId, collaboratorId } = reviewed(service, collaboration)
    const send = () =>
      service.appendCollaboratorComment({
        shareId,
        chatId: 'chat-1',
        collaboratorId,
        clientMessageId: 'long-gone',
        content: 'sent, resolved, and retried a week later'
      })

    const first = send()
    queue.deny(first.queueEntryId!, 'no')
    // Age the queue past its resolved-entry retention. Compaction evicts the
    // record and RETIRES its dedupe binding into a tombstone, which is the only
    // thing left that knows this clientMessageId was ever dealt with.
    queueClock.now = QUEUE_NOW + RESOLVED_RETENTION_MS + 1
    queue.sweep()
    expect(queue.listForCollaborator(collaboratorId)).toHaveLength(0)
    expect(queue.findByClientMessageId('chat-1', collaboratorId, 'long-gone')).toBeNull()

    // This is the last-resort refusal: no entry to dedupe against, so the only
    // alternatives are refuse or re-post. Appending here would double-post a
    // message the host already resolved — the unrecoverable direction.
    let thrown: unknown
    try {
      send()
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(HumanCollaborationDenialError)
    expect((thrown as HumanCollaborationDenialError).code).toBe('rule_denied')
    const rejected = auditEvents.filter((event) => event.kind === 'contribution.rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.detail).toContain('duplicate')
    expect(chats.get('chat-1')?.messages).toHaveLength(0)
    expect(store.saveChat).not.toHaveBeenCalled()
    expect(queue.listForCollaborator(collaboratorId)).toHaveLength(0)
  })
})

/*
 * Destructive chat paths must take the live channel down, not just flip the
 * record. `revokeShare` alone bites on the collaborator's NEXT inbound frame,
 * and a collaborator who is merely watching sends nothing — so their sealed
 * socket survives the chat, the next projection build throws 'Chat not found.'
 * and they sit on a frozen transcript with no signal. Closing every invite's
 * room is what actually ends it.
 */

/** Same idiom as `harness()`, plus a room-closing spy, a shared call log for
 *  ordering, a workspace-aware `getChatList` (the clear scope reads it) and
 *  switches for dropping the two optional deps. */
function roomHarness(
  options: {
    chats?: ChatRecord[]
    withCollaborationStore?: boolean
    withCloseCollaborationRoom?: boolean
  } = {}
) {
  const seed = options.chats ?? [chat()]
  const chats = new Map<string, ChatRecord>(seed.map((record) => [record.appChatId, record]))
  // Every close and every revoke, in the order the service performed them.
  const calls: string[] = []
  const store: ChatServiceStore = {
    getChats: vi.fn(() => Array.from(chats.values())),
    getChatList: vi.fn((workspaceId?: string): ChatListItem[] =>
      Array.from(chats.values())
        .filter((record) => !workspaceId || record.workspaceId === workspaceId)
        .map((record) => ({
          ...record,
          summaryOnly: true as const,
          messageCount: record.messages.length,
          runCount: record.runs.length
        }))
    ),
    getPinnedMessages: vi.fn(() => []),
    getChat: vi.fn((chatId) => chats.get(chatId) || null),
    createChat: vi.fn(),
    createGlobalChat: vi.fn(),
    createEnsembleChat: vi.fn(),
    createSubThread: vi.fn(),
    createSideChat: vi.fn(),
    setChatKind: vi.fn(),
    getChildChats: vi.fn(() => []),
    getSideChats: vi.fn(() => []),
    saveChat: vi.fn((next: ChatRecord) => {
      chats.set(next.appChatId, next)
      return next
    }),
    deleteChat: vi.fn(),
    clearChats: vi.fn()
  }
  const collaboration = new HumanCollaborationStore()
  const revokeShare = collaboration.revokeShare.bind(collaboration)
  vi.spyOn(collaboration, 'revokeShare').mockImplementation((shareId, now) => {
    calls.push(`revoke:${shareId}`)
    return revokeShare(shareId, now)
  })
  // Rooms whose close attempt blows up, standing in for a transport in a bad
  // state. Populated by the test after the roomIds exist. The call is logged
  // BEFORE the throw so the log still records that the attempt was made.
  const throwingRooms = new Set<string>()
  const closeCollaborationRoom = vi.fn((roomId: string) => {
    calls.push(`close:${roomId}`)
    if (throwingRooms.has(roomId)) throw new Error(`Relay transport is down: ${roomId}`)
  })
  const deps: ChatServiceDeps = {
    appStore: store,
    ...(options.withCollaborationStore === false ? {} : { humanCollaborationStore: collaboration }),
    findRegisteredWorkspace: vi.fn(),
    canonicalPath: vi.fn((value) => value),
    prepareForkMessages: vi.fn(({ copiedMessages }) => copiedMessages),
    sanitizeChatForSave: vi.fn((value) => value),
    appendDurableRunEventForRoute: vi.fn(),
    ...(options.withCloseCollaborationRoom === false ? {} : { closeCollaborationRoom })
  }
  return {
    service: new ChatService(deps),
    store,
    collaboration,
    chats,
    calls,
    closeCollaborationRoom,
    throwingRooms
  }
}

/** One share (one invite ⇒ one room) on `chatId`. */
function shared(service: ChatService, chatId = 'chat-1') {
  const created = service.createHumanCollaborationShare({ chatId, mode: 'comments' })
  return { shareId: created.share.shareId, roomId: created.roomId }
}

describe('ChatService closes collaboration rooms on destructive chat paths', () => {
  it('deleteChat closes the shared chat room and revokes the share', () => {
    const { service, store, collaboration, closeCollaborationRoom } = roomHarness()
    const { shareId, roomId } = shared(service)
    expect(collaboration.getShare(shareId)?.enabled).toBe(true)

    service.deleteChat('chat-1')

    expect(closeCollaborationRoom).toHaveBeenCalledTimes(1)
    expect(closeCollaborationRoom).toHaveBeenCalledWith(roomId)
    expect(collaboration.getShare(shareId)?.enabled).toBe(false)
    expect(store.deleteChat).toHaveBeenCalledWith('chat-1')
  })

  it('deleteChat closes EVERY invite room on the share, not just the first', () => {
    const { service, collaboration, closeCollaborationRoom } = roomHarness()
    // A second invite on an already-shared chat reuses the enabled share and
    // appends a fresh roomId — two live doors behind one share record.
    const first = shared(service)
    const second = shared(service)
    expect(second.shareId).toBe(first.shareId)
    expect(second.roomId).not.toBe(first.roomId)
    expect(collaboration.getShare(first.shareId)?.invites).toHaveLength(2)

    service.deleteChat('chat-1')

    expect(closeCollaborationRoom).toHaveBeenCalledWith(first.roomId)
    expect(closeCollaborationRoom).toHaveBeenCalledWith(second.roomId)
    expect(closeCollaborationRoom).toHaveBeenCalledTimes(2)
  })

  it('prepareClearChats with no workspace ends every share in the store', async () => {
    const { service, collaboration, closeCollaborationRoom } = roomHarness({
      chats: [
        chat({ appChatId: 'chat-1', workspaceId: 'workspace-1' }),
        chat({ appChatId: 'chat-2', workspaceId: 'workspace-2' })
      ]
    })
    const one = shared(service, 'chat-1')
    const two = shared(service, 'chat-2')

    await service.prepareClearChats()

    expect(closeCollaborationRoom).toHaveBeenCalledWith(one.roomId)
    expect(closeCollaborationRoom).toHaveBeenCalledWith(two.roomId)
    expect(collaboration.getShare(one.shareId)?.enabled).toBe(false)
    expect(collaboration.getShare(two.shareId)?.enabled).toBe(false)
  })

  it('prepareClearChats(workspaceId) ends only that workspace and leaves the other alone', async () => {
    const { service, collaboration, closeCollaborationRoom } = roomHarness({
      chats: [
        chat({ appChatId: 'chat-1', workspaceId: 'workspace-1' }),
        chat({ appChatId: 'chat-2', workspaceId: 'workspace-2' })
      ]
    })
    const inScope = shared(service, 'chat-1')
    const untouched = shared(service, 'chat-2')

    await service.prepareClearChats('workspace-1')

    expect(closeCollaborationRoom).toHaveBeenCalledWith(inScope.roomId)
    expect(collaboration.getShare(inScope.shareId)?.enabled).toBe(false)
    // Leakage the other way is just as bad: another workspace's collaborator
    // must keep both their room and their share.
    expect(closeCollaborationRoom).not.toHaveBeenCalledWith(untouched.roomId)
    expect(closeCollaborationRoom).toHaveBeenCalledTimes(1)
    expect(collaboration.getShare(untouched.shareId)?.enabled).toBe(true)
  })

  it('closes the room BEFORE revoking the share', () => {
    const { service, calls } = roomHarness()
    const { shareId, roomId } = shared(service)

    service.deleteChat('chat-1')

    // Revoke-then-close would work today, but the intended order is to drop the
    // socket first so no frame can be served against a half-torn-down share.
    expect(calls).toEqual([`close:${roomId}`, `revoke:${shareId}`])
  })

  it('a throwing room closer never blocks the deletion, and never skips the next room', () => {
    const { service, store, collaboration, closeCollaborationRoom, throwingRooms } = roomHarness()
    const first = shared(service)
    const second = shared(service)
    // Only the FIRST door is jammed. A try/catch wrapped around the whole loop
    // instead of each call would swallow this and silently abandon the second.
    throwingRooms.add(first.roomId)

    expect(() => service.deleteChat('chat-1')).not.toThrow()

    expect(closeCollaborationRoom).toHaveBeenCalledWith(first.roomId)
    expect(closeCollaborationRoom).toHaveBeenCalledWith(second.roomId)
    expect(closeCollaborationRoom).toHaveBeenCalledTimes(2)
    // A leaked socket is the acceptable failure; an undeleted chat with a
    // half-torn share is not.
    expect(collaboration.getShare(first.shareId)?.enabled).toBe(false)
    expect(store.deleteChat).toHaveBeenCalledWith('chat-1')
  })

  it('a workspace-scoped clear also ends orphan shares whose chat exists nowhere', async () => {
    const { service, collaboration, closeCollaborationRoom, chats } = roomHarness({
      chats: [
        chat({ appChatId: 'chat-1', workspaceId: 'workspace-1' }),
        chat({ appChatId: 'chat-2', workspaceId: 'workspace-2' }),
        chat({ appChatId: 'chat-orphan', workspaceId: 'workspace-2' })
      ]
    })
    const doomed = shared(service, 'chat-1')
    const surviving = shared(service, 'chat-2')
    const orphan = shared(service, 'chat-orphan')
    // The chat is gone; only the share record remembers it. Its last known
    // workspace is the SURVIVING one, so the only thing that can end it here is
    // orphanhood — not membership of the doomed workspace.
    chats.delete('chat-orphan')

    await service.prepareClearChats('workspace-1')

    expect(closeCollaborationRoom).toHaveBeenCalledWith(doomed.roomId)
    expect(collaboration.getShare(doomed.shareId)?.enabled).toBe(false)
    // Nothing else will ever come for the orphan's channel.
    expect(closeCollaborationRoom).toHaveBeenCalledWith(orphan.roomId)
    expect(collaboration.getShare(orphan.shareId)?.enabled).toBe(false)
    // The other half: a live chat in another workspace keeps its door.
    expect(closeCollaborationRoom).not.toHaveBeenCalledWith(surviving.roomId)
    expect(closeCollaborationRoom).toHaveBeenCalledTimes(2)
    expect(collaboration.getShare(surviving.shareId)?.enabled).toBe(true)
  })

  it('deleteChat still works with no collaboration store and no room closer', () => {
    const withoutStore = roomHarness({ withCollaborationStore: false })
    expect(() => withoutStore.service.deleteChat('chat-1')).not.toThrow()
    expect(withoutStore.store.deleteChat).toHaveBeenCalledWith('chat-1')
    expect(withoutStore.closeCollaborationRoom).not.toHaveBeenCalled()

    // Store present, closer absent: the share must still be revoked.
    const withoutCloser = roomHarness({ withCloseCollaborationRoom: false })
    const { shareId } = shared(withoutCloser.service)
    expect(() => withoutCloser.service.deleteChat('chat-1')).not.toThrow()
    expect(withoutCloser.collaboration.getShare(shareId)?.enabled).toBe(false)
    expect(withoutCloser.store.deleteChat).toHaveBeenCalledWith('chat-1')
  })
})

/*
 * The host-review flag itself. Lives beside the behaviour it gates because the
 * setter is the ONLY way the flag is ever turned on, and because the field has
 * to survive the store's allowlist normaliser — which runs on every read AND
 * every write, and silently erases anything it does not know about.
 */
const tempDirs: string[] = []

function tempStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tw-collab-share-'))
  tempDirs.push(dir)
  return join(dir, 'human-collaboration.json')
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

/** A hand-written share record, the shape a corrupted or edited file holds. */
function handWrittenShare(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    shareId: 'share-hand',
    chatId: 'chat-1',
    mode: 'comments',
    enabled: true,
    createdAt: 1000,
    updatedAt: 1000,
    nextSequence: 1,
    participants: [],
    invites: [],
    idempotency: {},
    ...overrides
  }
}

describe('HumanCollaborationStore.setRequiresHostApproval', () => {
  it('flips host review on and off, no-ops when unchanged, and survives a preset write', () => {
    const store = new HumanCollaborationStore()
    const created = store.createShare({ chatId: 'chat-1', mode: 'comments', now: 1000 })
    const shareId = created.share.shareId
    expect(created.share.requiresHostApproval).toBeUndefined()

    // Already off: a no-op that still returns the share, and must not stamp it.
    const noop = store.setRequiresHostApproval({ shareId, requiresHostApproval: false, now: 2000 })
    expect(noop?.shareId).toBe(shareId)
    expect(noop?.requiresHostApproval).toBeUndefined()
    expect(noop?.updatedAt).toBe(1000)

    const on = store.setRequiresHostApproval({ shareId, requiresHostApproval: true, now: 3000 })
    expect(on?.requiresHostApproval).toBe(true)
    expect(on?.updatedAt).toBe(3000)

    // Already on: no-op again, and `updatedAt` stays where the real change left it.
    const again = store.setRequiresHostApproval({ shareId, requiresHostApproval: true, now: 4000 })
    expect(again?.requiresHostApproval).toBe(true)
    expect(again?.updatedAt).toBe(3000)

    // The stated reason the flag is a share field rather than a contribution
    // rule: rules are re-derived per preset, and this has to outlive that.
    store.updateShareRules({ shareId, preset: 'requestHostAction', now: 4500 })
    expect(store.getShare(shareId)?.requiresHostApproval).toBe(true)

    const off = store.setRequiresHostApproval({ shareId, requiresHostApproval: false, now: 5000 })
    expect(off?.updatedAt).toBe(5000)
    // Deleted, not written as `false` — absent is the documented "off".
    expect(off && 'requiresHostApproval' in off).toBe(false)
  })

  it('returns null for an unknown share and for a revoked one', () => {
    const store = new HumanCollaborationStore()
    expect(
      store.setRequiresHostApproval({ shareId: 'nope', requiresHostApproval: true })
    ).toBeNull()

    const created = store.createShare({ chatId: 'chat-1', mode: 'comments', now: 1000 })
    store.revokeShare(created.share.shareId, 2000)
    expect(
      store.setRequiresHostApproval({
        shareId: created.share.shareId,
        requiresHostApproval: true,
        now: 3000
      })
    ).toBeNull()
    expect(store.getShare(created.share.shareId)?.requiresHostApproval).toBeUndefined()
  })

  it('survives a persist and reload through the allowlist normaliser', () => {
    const path = tempStorePath()
    const store = new HumanCollaborationStore(path)
    const created = store.createShare({ chatId: 'chat-1', mode: 'comments', now: 1000 })
    const shareId = created.share.shareId
    store.setRequiresHostApproval({ shareId, requiresHostApproval: true, now: 2000 })

    // The normaliser rebuilds the record on WRITE too, so a field missing from
    // its allowlist never even reaches the file.
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { shares: Record<string, unknown>[] }
    expect(onDisk.shares[0]?.requiresHostApproval).toBe(true)

    const reloaded = new HumanCollaborationStore(path)
    expect(reloaded.getShare(shareId)?.requiresHostApproval).toBe(true)

    // And off round-trips as absent, not as a persisted `false`.
    reloaded.setRequiresHostApproval({ shareId, requiresHostApproval: false, now: 3000 })
    const reopened = JSON.parse(readFileSync(path, 'utf8')) as { shares: Record<string, unknown>[] }
    expect('requiresHostApproval' in (reopened.shares[0] || {})).toBe(false)
    expect(
      new HumanCollaborationStore(path).getShare(shareId)?.requiresHostApproval
    ).toBeUndefined()
  })

  it('refuses a truthy-but-not-true value from a hand-written snapshot', () => {
    const path = tempStorePath()
    writeFileSync(
      path,
      JSON.stringify({
        shares: [
          handWrittenShare({ shareId: 'share-one', requiresHostApproval: 1 }),
          handWrittenShare({ shareId: 'share-yes', requiresHostApproval: 'yes' }),
          handWrittenShare({ shareId: 'share-true', requiresHostApproval: true })
        ]
      })
    )

    const store = new HumanCollaborationStore(path)
    expect(store.getShare('share-one')?.requiresHostApproval).toBeUndefined()
    expect(store.getShare('share-yes')?.requiresHostApproval).toBeUndefined()
    // The discriminator: the strict comparison still admits a genuine `true`.
    expect(store.getShare('share-true')?.requiresHostApproval).toBe(true)
  })
})

describe('withdrawing trust settles what is already queued', () => {
  // `reviewed` lives inside another describe; this block needs the same setup.
  const reviewedShare = (service: ChatService, collaboration: HumanCollaborationStore) => {
    const ids = admitted(service)
    expect(
      collaboration.setRequiresHostApproval({
        shareId: ids.shareId,
        requiresHostApproval: true
      })?.requiresHostApproval
    ).toBe(true)
    return ids
  }

  it('lapses a share’s queued contributions BEFORE the revoke lands', () => {
    // Left behind, a queued contribution stays APPROVABLE after trust was
    // withdrawn — the host would be releasing a message from someone they had
    // just removed. Lapsing before the revoke is also the last moment the
    // person is still connected and can be told.
    const { service, collaboration, queue } = harness({ withQueue: true })
    const { shareId, collaboratorId } = reviewedShare(service, collaboration)
    service.appendCollaboratorComment({
      shareId,
      chatId: 'chat-1',
      collaboratorId,
      clientMessageId: 'client-1',
      content: 'still pending when the plug is pulled'
    })
    expect(queue.listQueued('chat-1')).toHaveLength(1)

    service.revokeHumanCollaborationShare(shareId)

    expect(queue.listQueued('chat-1')).toEqual([])
    const entry = queue.listForCollaborator(collaboratorId)[0]
    expect(entry.state).toBe('lapsed')
    expect(entry.lapseReason).toBe('shareEnded')
    // The body goes with it — nothing to approve means nothing to retain.
    expect(entry.body).toBeUndefined()
  })

  it('lapses only the removed participant’s contributions, not the whole share', () => {
    const { service, collaboration, queue } = harness({ withQueue: true })
    const { shareId, collaboratorId } = reviewedShare(service, collaboration)
    service.appendCollaboratorComment({
      shareId,
      chatId: 'chat-1',
      collaboratorId,
      clientMessageId: 'client-1',
      content: 'from the collaborator being removed'
    })

    service.revokeHumanCollaborationParticipant(shareId, collaboratorId)

    const entry = queue.listForCollaborator(collaboratorId)[0]
    expect(entry.state).toBe('lapsed')
    expect(entry.lapseReason).toBe('revoked')
  })

  it('lapses an APPROVED but undelivered contribution when its author is revoked', () => {
    // Approval is a release, not a delivery, and revoking inside that gap used
    // to STRAND the entry: `lapseAll` skipped it for not being 'queued', and
    // from there nothing could reach it — the seat that would deliver it stops
    // resolving, deny/sweep/listQueued all skip it, and `isReapable` exempts it
    // from every eviction path. It sat in the queue file indefinitely, holding
    // the plaintext body of someone whose access had just been withdrawn — the
    // exact thing lapsing exists to prevent.
    const { service, collaboration, queue } = harness({ withQueue: true })
    const { shareId, collaboratorId } = reviewedShare(service, collaboration)
    service.appendCollaboratorComment({
      shareId,
      chatId: 'chat-1',
      collaboratorId,
      clientMessageId: 'client-1',
      content: 'approved, then the plug is pulled'
    })
    const queued = queue.listQueued('chat-1')[0]
    expect(service.approveExternalContribution(queued.entryId)?.state).toBe('approved')
    // The gap this test is about: released for the next seat turn, not yet
    // written to the transcript.
    expect(queue.listAwaitingMaterialisation()).toHaveLength(1)

    service.revokeHumanCollaborationParticipant(shareId, collaboratorId)

    const entry = queue.listForCollaborator(collaboratorId)[0]
    expect(entry.state).toBe('lapsed')
    expect(entry.lapseReason).toBe('revoked')
    // The two consequences that made this more than untidy: the withdrawn
    // person's words are off the disk, and the message can never now arrive.
    expect(entry.body).toBeUndefined()
    expect(queue.listAwaitingMaterialisation()).toEqual([])
  })

  it('does not wipe the queue when the service has no queue configured', () => {
    // lapseAll refuses a predicate-free filter, but the optional-chaining guard
    // is what keeps a review-less ChatService from throwing here at all.
    const { service, collaboration } = harness()
    const { shareId } = admitted(service)
    collaboration.setRequiresHostApproval({ shareId, requiresHostApproval: true })
    expect(() => service.revokeHumanCollaborationShare(shareId)).not.toThrow()
  })
})

describe('an external join converts the thread to a panel', () => {
  const solo = (overrides: Partial<ChatRecord> = {}): ChatRecord =>
    chat({ chatKind: 'single', provider: 'claude', ...overrides })

  it('converts an idle solo chat on join', () => {
    const { service, chats, store } = harness()
    chats.set('chat-1', solo())
    const { shareId } = admitted(service)

    service.convertChatForExternalJoin({
      chatId: 'chat-1',
      shareId,
      collaboratorId: 'collab-1'
    })

    expect(store.setChatKind).toHaveBeenCalledWith(
      'chat-1',
      'ensemble',
      expect.objectContaining({ seedParticipant: expect.objectContaining({ provider: 'claude' }) })
    )
  })

  it('is a no-op on a chat that is already a panel', () => {
    // Idempotency is keyed on CHAT STATE, never the handshake: a reconnect
    // fires on every tab reload, and a deferred first join arrives next AS a
    // reconnect and must still convert.
    const { service, chats, store } = harness()
    chats.set('chat-1', solo({ chatKind: 'ensemble' }))
    const { shareId } = admitted(service)

    const result = service.convertChatForExternalJoin({
      chatId: 'chat-1',
      shareId,
      collaboratorId: 'collab-1'
    })

    expect(result.outcome).toBe('noop')
    expect(store.setChatKind).not.toHaveBeenCalled()
  })

  it('DEFERS instead of failing when a run is streaming', () => {
    // AppStore.setChatKind throws mid-turn. That refusal is right for a host
    // toggling the panel and wrong for a person arriving, so the join wins and
    // the conversion waits.
    const { service, chats, store } = harness()
    chats.set(
      'chat-1',
      solo({ runs: [{ runId: 'r1', provider: 'claude', status: 'running' }] as never })
    )
    const { shareId } = admitted(service)

    const result = service.convertChatForExternalJoin({
      chatId: 'chat-1',
      shareId,
      collaboratorId: 'collab-1'
    })

    expect(result.outcome).toBe('queued')
    expect(store.setChatKind).not.toHaveBeenCalled()
    expect(
      chats.get('chat-1')?.providerMetadata?.pendingExternalJoinConversion
    ).toBeTruthy()
  })

  it('applies the deferred conversion at the next boundary, and clears the marker', () => {
    const { service, chats, store } = harness()
    chats.set(
      'chat-1',
      solo({ runs: [{ runId: 'r1', provider: 'claude', status: 'running' }] as never })
    )
    const { shareId } = admitted(service)
    service.convertChatForExternalJoin({ chatId: 'chat-1', shareId, collaboratorId: 'collab-1' })

    // The run has ended by the time the boundary fires.
    chats.set('chat-1', { ...chats.get('chat-1')!, runs: [] })
    expect(service.applyPendingExternalJoinConversion('chat-1')).toBe(true)

    expect(store.setChatKind).toHaveBeenCalled()
    expect(chats.get('chat-1')?.providerMetadata?.pendingExternalJoinConversion).toBeUndefined()
  })

  it('does NOT apply a deferred conversion once the external has already left', () => {
    // The marker is written while the chat is busy and drained at the next
    // terminal run — of ANY run, surviving a restart — so the gap between the
    // two can be long. Nothing clears the marker when the person leaves inside
    // it: `reconcileChatKindForExternalDeparture` bails because the kind is
    // still 'single'. Without a liveness re-check the host's solo thread
    // silently became a panel they never asked for, minutes after the only
    // collaborator was removed, and kept `externalJoinConverted` forever.
    const { service, chats, store } = harness()
    chats.set(
      'chat-1',
      solo({ runs: [{ runId: 'r1', provider: 'claude', status: 'running' }] as never })
    )
    const { shareId, collaboratorId } = admitted(service)
    service.convertChatForExternalJoin({ chatId: 'chat-1', shareId, collaboratorId })

    // Removed while the run was still streaming, then the run ends.
    service.revokeHumanCollaborationParticipant(shareId, collaboratorId)
    chats.set('chat-1', { ...chats.get('chat-1')!, runs: [] })

    expect(service.applyPendingExternalJoinConversion('chat-1')).toBe(false)
    expect(store.setChatKind).not.toHaveBeenCalled()
    // The marker still clears unconditionally — a stale plan must not retry on
    // every subsequent turn forever.
    expect(chats.get('chat-1')?.providerMetadata?.pendingExternalJoinConversion).toBeUndefined()
  })

  it('never throws, whatever the chat is', () => {
    // The contract the join path depends on. A retired provider, a rejected
    // seed, a concurrent mutation — none of them are the joiner's problem.
    const { service, chats } = harness()
    chats.set('chat-1', solo({ provider: 'gemini' }))
    expect(() =>
      service.convertChatForExternalJoin({
        chatId: 'chat-1',
        shareId: 'share-1',
        collaboratorId: 'collab-1'
      })
    ).not.toThrow()
  })
})

describe('the last external leaving hands the thread back', () => {
  it('reverts a thread this feature converted', () => {
    const { service, chats, store, collaboration } = harness()
    chats.set('chat-1', chat({ chatKind: 'single', provider: 'claude' }))
    const { shareId, collaboratorId } = admitted(service)
    // Stand in for the conversion having happened.
    chats.set('chat-1', {
      ...chats.get('chat-1')!,
      chatKind: 'ensemble',
      providerMetadata: { externalJoinConverted: true }
    })
    collaboration.revokeParticipant({ shareId, collaboratorId })

    expect(service.reconcileChatKindForExternalDeparture('chat-1')).toBe(true)
    expect(store.setChatKind).toHaveBeenCalledWith('chat-1', 'single', expect.anything())
  })

  it('never dismantles a panel the host built themselves', () => {
    // Sharing a real Ensemble and then unsharing it must not silently collapse
    // the host's roster onto one provider. No mark, no revert.
    //
    // The external must be GONE here, not merely present — otherwise the
    // participant-count check short-circuits first and this passes without ever
    // reaching the ownership rule it exists to pin. (It did, until a mutation
    // run showed removing the rule broke nothing.)
    const { service, chats, store, collaboration } = harness()
    chats.set('chat-1', chat({ chatKind: 'ensemble', provider: 'claude' }))
    const { shareId, collaboratorId } = admitted(service)
    collaboration.revokeParticipant({ shareId, collaboratorId })
    vi.mocked(store.setChatKind).mockClear()

    expect(service.reconcileChatKindForExternalDeparture('chat-1')).toBe(false)
    expect(store.setChatKind).not.toHaveBeenCalled()
  })

  it('does not revert while another external is still admitted', () => {
    const { service, chats, store } = harness()
    chats.set('chat-1', {
      ...chat({ chatKind: 'ensemble', provider: 'claude' }),
      providerMetadata: { externalJoinConverted: true }
    })
    admitted(service)

    expect(service.reconcileChatKindForExternalDeparture('chat-1')).toBe(false)
    expect(store.setChatKind).not.toHaveBeenCalled()
  })
})

describe('muting holds an approved contribution instead of stranding it', () => {
  function approvedForMutedSeat() {
    const h = harness({ withQueue: true })
    const { shareId, collaboratorId } = (() => {
      const ids = admitted(h.service)
      h.collaboration.setRequiresHostApproval({ shareId: ids.shareId, requiresHostApproval: true })
      return ids
    })()
    h.service.appendCollaboratorComment({
      shareId,
      chatId: 'chat-1',
      collaboratorId,
      clientMessageId: 'client-1',
      content: 'held while the seat is muted'
    })
    const entry = h.queue.listQueued('chat-1')[0]
    h.service.approveExternalContribution(entry.entryId)
    return { ...h, shareId, collaboratorId }
  }

  it('brings an approved-but-muted contribution BACK to the host stack', () => {
    // Before this it vanished: approval removed it from the queued list, and the
    // delivery rule refuses a muted seat forever. Neither delivered nor denied,
    // and invisible to everyone.
    const { service, collaboration, shareId, collaboratorId } = approvedForMutedSeat()
    expect(service.listPendingExternalContributions('chat-1')).toEqual([])

    collaboration.updateParticipantSeat({ shareId, collaboratorId, seatDisabled: true })

    const pending = service.listPendingExternalContributions('chat-1')
    expect(pending).toHaveLength(1)
    expect(pending[0].heldByMute).toBe(true)
  })

  it('drops the held flag again the moment the seat is unmuted', () => {
    // Derived at read time, never stored — a persisted flag would go stale here.
    const { service, collaboration, shareId, collaboratorId } = approvedForMutedSeat()
    collaboration.updateParticipantSeat({ shareId, collaboratorId, seatDisabled: true })
    expect(service.listPendingExternalContributions('chat-1')).toHaveLength(1)

    collaboration.updateParticipantSeat({ shareId, collaboratorId, seatDisabled: false })
    expect(service.listPendingExternalContributions('chat-1')).toEqual([])
  })

  it('does not resurrect a contribution that was already delivered', () => {
    const { service, collaboration, queue, shareId, collaboratorId } = approvedForMutedSeat()
    const entry = queue.listAwaitingMaterialisation()[0]
    queue.markMaterialised(entry.entryId)

    collaboration.updateParticipantSeat({ shareId, collaboratorId, seatDisabled: true })
    expect(service.listPendingExternalContributions('chat-1')).toEqual([])
  })
})
