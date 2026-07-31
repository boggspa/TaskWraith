import { describe, expect, it, vi } from 'vitest'
import type { ChatRecord } from '../store/types'
import { generateIdentityKeyPair } from '../../shared/e2ee/keys'
import type {
  TransportSocketFactory,
  TransportSocketHandlers
} from '../remote/RemoteTransportClient'
import { HumanCollaborationStore } from './HumanCollaborationStore'
import { HumanCollaborationRuntime } from './HumanCollaborationRuntime'
import {
  buildHumanSharePage,
  buildHumanShareProjection,
  type HumanShareProjection
} from './HumanShareProjection'
import { makeHumanCollaboratorComment } from './HumanCollaboratorMessages'
import { HumanCollaborationHostTransport } from './HumanCollaborationHostTransport'
import { HumanCollaborationCollaboratorClient } from './HumanCollaborationCollaboratorClient'

/**
 * An in-memory stand-in for the dumb 2-seat relay: connects a `mac` and an
 * `iphone` socket by sessionId and forwards every frame verbatim to the peer.
 * Delivery is deferred (queueMicrotask) to mimic the async network.
 */
function makeInMemoryRelay(): TransportSocketFactory {
  const rooms = new Map<string, { mac?: TransportSocketHandlers; iphone?: TransportSocketHandlers }>()
  return (url, headers, handlers) => {
    const sessionId = url.split('/v1/session/')[1] || ''
    const role = (headers['x-taskwraith-role'] as 'mac' | 'iphone') || 'mac'
    const peerRole = role === 'mac' ? 'iphone' : 'mac'
    const room = rooms.get(sessionId) || {}
    room[role] = handlers
    rooms.set(sessionId, room)
    queueMicrotask(() => handlers.onOpen())
    return {
      send: (data: string) => {
        const peer = rooms.get(sessionId)?.[peerRole]
        if (peer) queueMicrotask(() => peer.onMessage(data))
      },
      close: () => {
        const r = rooms.get(sessionId)
        if (r) r[role] = undefined
        queueMicrotask(() => handlers.onClose(1000))
      }
    }
  }
}

function makeChat(): ChatRecord {
  return {
    appChatId: 'chat-1',
    scope: 'global',
    provider: 'codex',
    title: 'Collab chat',
    workspaceId: 'ws-1',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [
      { id: 'h-1', role: 'user', content: 'Host opening message', timestamp: '2026-06-25T00:00:00.000Z' },
      { id: 'a-1', role: 'assistant', content: 'Assistant reply', timestamp: '2026-06-25T00:00:01.000Z' }
    ],
    runs: []
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('human collaboration transport (loopback)', () => {
  it('admits a remote collaborator and round-trips projection + comment over the relay', async () => {
    const relay = makeInMemoryRelay()
    const chat = makeChat()
    const store = new HumanCollaborationStore()
    const created = store.createShare({ chatId: 'chat-1', mode: 'comments', now: 1000, inviteTtlMs: 60_000 })

    // ── Host side: transport + runtime wired together ──────────────────────
    const hostTransport = new HumanCollaborationHostTransport({ socketFactory: relay })
    const runtime = new HumanCollaborationRuntime<HumanShareProjection, { ok: true }>({
      identityKeyPair: generateIdentityKeyPair(),
      store,
      buildProjection: (req) => buildHumanShareProjection(chat, req.share),
      appendComment: (input) => {
        // Minimal stand-in for ChatService.appendCollaboratorComment: assign a
        // sequence + append the comment to the chat so the next projection shows it.
        const sequence = store.recordAppend({
          shareId: input.shareId,
          chatId: input.chatId,
          collaboratorId: input.collaboratorId,
          clientMessageId: input.clientMessageId,
          messageId: `m-${input.clientMessageId}`
        })
        chat.messages.push(
          makeHumanCollaboratorComment({
            id: `m-${input.clientMessageId}`,
            content: input.content,
            timestamp: '2026-06-25T00:00:05.000Z',
            shareId: input.shareId,
            collaboratorId: input.collaboratorId,
            collaboratorDisplayName: input.displayName,
            clientMessageId: input.clientMessageId,
            sequence
          })
        )
        return { ok: true }
      },
      publishEncryptedProjection: (sessionId, frame) => hostTransport.deliver(sessionId, frame),
      now: () => 1000
    })
    hostTransport.attachRuntime(runtime)

    const relayUrl = 'ws://127.0.0.1:0'
    const roomId = 'room-abc'
    hostTransport.openRoom(relayUrl, roomId)

    // ── Collaborator side ──────────────────────────────────────────────────
    const projections: HumanShareProjection[] = []
    let sasCode = ''
    const client = new HumanCollaborationCollaboratorClient({
      socketFactory: relay,
      now: () => 1000,
      onSasCode: (code) => {
        sasCode = code
      },
      onProjection: (p) => projections.push(p as HumanShareProjection)
    })
    client.connect(relayUrl, roomId)

    const admitted = await client.admit({
      shareId: created.share.shareId,
      chatId: 'chat-1',
      inviteToken: created.inviteToken,
      displayName: 'Alex',
      shareMode: 'comments'
    })

    expect(admitted.sessionId).toBeTruthy()
    expect(admitted.collaboratorId).toBeTruthy()
    // The SAS is computed locally for the out-of-band human compare.
    expect(sasCode).toMatch(/^\d{6}$/)

    // Subscribe → host pushes the least-privilege projection.
    client.subscribe()
    await waitFor(() => projections.length >= 1)
    const first = projections[projections.length - 1]
    expect(first.chatId).toBe('chat-1')
    expect(first.rows.some((row) => row.role === 'host' && row.preview.includes('Host opening'))).toBe(true)
    expect(first.rows.some((row) => row.role === 'assistant')).toBe(true)

    // Append a comment → host records it → next projection carries it.
    const before = projections.length
    client.appendComment('A question from the collaborator', 'cm-1')
    await waitFor(() => projections.length > before)
    const latest = projections[projections.length - 1]
    expect(
      latest.rows.some(
        (row) => row.role === 'collaborator' && row.preview.includes('A question from the collaborator')
      )
    ).toBe(true)
    // The host transcript actually gained the comment.
    expect(chat.messages.some((m) => m.content === 'A question from the collaborator')).toBe(true)

    client.dispose()
    hostTransport.dispose()
  })

  it('two-phase admit holds at the SAS until confirmAdmission is called', async () => {
    const relay = makeInMemoryRelay()
    const chat = makeChat()
    const store = new HumanCollaborationStore()
    const created = store.createShare({ chatId: 'chat-1', mode: 'comments', now: 1000, inviteTtlMs: 60_000 })

    const hostTransport = new HumanCollaborationHostTransport({ socketFactory: relay })
    const runtime = new HumanCollaborationRuntime<HumanShareProjection, { ok: true }>({
      identityKeyPair: generateIdentityKeyPair(),
      store,
      buildProjection: (req) => buildHumanShareProjection(chat, req.share),
      appendComment: vi.fn().mockReturnValue({ ok: true }),
      publishEncryptedProjection: (sessionId, frame) => hostTransport.deliver(sessionId, frame),
      now: () => 1000
    })
    hostTransport.attachRuntime(runtime)
    hostTransport.openRoom('ws://127.0.0.1:0', 'room-gate')

    let sas = ''
    const client = new HumanCollaborationCollaboratorClient({
      socketFactory: relay,
      now: () => 1000,
      onSasCode: (code) => {
        sas = code
      }
    })
    client.connect('ws://127.0.0.1:0', 'room-gate')

    const begun = await client.beginAdmission({
      shareId: created.share.shareId,
      chatId: 'chat-1',
      inviteToken: created.inviteToken,
      displayName: 'Alex',
      shareMode: 'comments'
    })
    // SAS surfaced, but the session is NOT yet established (no confirm sent).
    expect(begun.confirmCode).toMatch(/^\d{6}$/)
    expect(sas).toBe(begun.confirmCode)
    expect(client.isEstablished).toBe(false)

    // Human compared the codes and accepted → confirm establishes the session.
    const confirmed = await client.confirmAdmission()
    expect(confirmed.sessionId).toBeTruthy()
    expect(client.isEstablished).toBe(true)

    client.dispose()
    hostTransport.dispose()
  })

  it('host transport reconnects a dropped room with backoff and stops on closeRoom', () => {
    vi.useFakeTimers()
    try {
      let opens = 0
      let last: TransportSocketHandlers | null = null
      const factory: TransportSocketFactory = (_url, _headers, handlers) => {
        opens += 1
        last = handlers
        return { send: () => {}, close: () => {} }
      }
      const transport = new HumanCollaborationHostTransport({ socketFactory: factory })
      transport.openRoom('ws://127.0.0.1:0', 'room-r')
      expect(opens).toBe(1)

      // Unexpected drop → reconnect after the base delay (1000ms).
      last!.onClose(1006)
      vi.advanceTimersByTime(1000)
      expect(opens).toBe(2)

      // Second drop → backoff doubles (2000ms).
      last!.onClose(1006)
      vi.advanceTimersByTime(1000)
      expect(opens).toBe(2)
      vi.advanceTimersByTime(1000)
      expect(opens).toBe(3)

      // closeRoom (revoke) stops reconnect — a later drop does nothing.
      transport.closeRoom('room-r')
      last!.onClose(1006)
      vi.advanceTimersByTime(60_000)
      expect(opens).toBe(3)
      transport.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rebinds an open room when the relay URL changes', () => {
    vi.useFakeTimers()
    try {
      const openedUrls: string[] = []
      let closeCount = 0
      let firstHandlers: TransportSocketHandlers | null = null
      let latestHandlers: TransportSocketHandlers | null = null
      const factory: TransportSocketFactory = (url, _headers, handlers) => {
        openedUrls.push(url)
        if (!firstHandlers) firstHandlers = handlers
        latestHandlers = handlers
        return {
          send: () => {},
          close: () => {
            closeCount += 1
          }
        }
      }
      const transport = new HumanCollaborationHostTransport({ socketFactory: factory })
      transport.openRoom('ws://old-relay', 'room-r')
      expect(openedUrls).toEqual(['ws://old-relay/v1/session/room-r'])

      transport.openRoom('ws://new-relay', 'room-r')
      expect(openedUrls).toEqual([
        'ws://old-relay/v1/session/room-r',
        'ws://new-relay/v1/session/room-r'
      ])

      // The stale socket's close callback must not clear or reconnect over the
      // replacement socket.
      firstHandlers!.onClose(1006)
      vi.advanceTimersByTime(60_000)
      expect(openedUrls).toHaveLength(2)

      latestHandlers!.onClose(1006)
      vi.advanceTimersByTime(1000)
      expect(openedUrls[2]).toBe('ws://new-relay/v1/session/room-r')
      expect(closeCount).toBeGreaterThan(0)
      transport.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a collaborator presenting a bad invite token', async () => {
    const relay = makeInMemoryRelay()
    const chat = makeChat()
    const store = new HumanCollaborationStore()
    store.createShare({ chatId: 'chat-1', mode: 'comments', now: 1000, inviteTtlMs: 60_000 })

    const hostTransport = new HumanCollaborationHostTransport({ socketFactory: relay })
    const runtime = new HumanCollaborationRuntime<HumanShareProjection, { ok: true }>({
      identityKeyPair: generateIdentityKeyPair(),
      store,
      buildProjection: (req) => buildHumanShareProjection(chat, req.share),
      appendComment: vi.fn().mockReturnValue({ ok: true }),
      publishEncryptedProjection: (sessionId, frame) => hostTransport.deliver(sessionId, frame),
      now: () => 1000
    })
    hostTransport.attachRuntime(runtime)
    hostTransport.openRoom('ws://127.0.0.1:0', 'room-xyz')

    const share = store.getShareForChat('chat-1')
    const client = new HumanCollaborationCollaboratorClient({ socketFactory: relay, now: () => 1000 })
    client.connect('ws://127.0.0.1:0', 'room-xyz')

    await expect(
      client.admit({
        shareId: share!.shareId,
        chatId: 'chat-1',
        inviteToken: 'tskey-not-a-real-invite',
        displayName: 'Mallory',
        shareMode: 'comments'
      })
    ).rejects.toThrow(/invite/i)

    client.dispose()
    hostTransport.dispose()
  })

  it('Slice 5: reconnects with a pinned identity — no invite token, fresh keys, revocation holds', async () => {
    const relay = makeInMemoryRelay()
    const chat = makeChat()
    const store = new HumanCollaborationStore()
    const created = store.createShare({ chatId: 'chat-1', mode: 'comments', now: 1000, inviteTtlMs: 60_000 })

    const hostIdentity = generateIdentityKeyPair()
    const hostTransport = new HumanCollaborationHostTransport({ socketFactory: relay })
    const runtime = new HumanCollaborationRuntime<HumanShareProjection, { ok: true }>({
      identityKeyPair: hostIdentity,
      store,
      buildProjection: (req) => buildHumanShareProjection(chat, req.share),
      appendComment: (input) => {
        store.recordAppend({
          shareId: input.shareId,
          chatId: input.chatId,
          collaboratorId: input.collaboratorId,
          clientMessageId: input.clientMessageId,
          messageId: `m-${input.clientMessageId}`
        })
        return { ok: true }
      },
      publishEncryptedProjection: (sessionId, frame) => hostTransport.deliver(sessionId, frame),
      now: () => 1000
    })
    hostTransport.attachRuntime(runtime)

    const relayUrl = 'ws://127.0.0.1:0'
    const roomId = 'room-reconnect'
    hostTransport.openRoom(relayUrl, roomId)

    // Original join with a PERSISTED (injected) identity.
    const pinnedIdentity = generateIdentityKeyPair()
    const first = new HumanCollaborationCollaboratorClient({
      socketFactory: relay,
      identity: pinnedIdentity,
      now: () => 1000
    })
    first.connect(relayUrl, roomId)
    const admitted = await first.admit({
      shareId: created.share.shareId,
      chatId: 'chat-1',
      inviteToken: created.inviteToken,
      displayName: 'Alex',
      shareMode: 'comments'
    })
    const hostKeyB64 = admitted.hostIdentityPubKeyB64
    // Simulate a drop (crash / lost network): dispose without graceful leave.
    first.dispose()
    await waitFor(() => !first.isConnected)

    // Reconnect with the SAME identity — no invite token, pinned host key.
    const second = new HumanCollaborationCollaboratorClient({
      socketFactory: relay,
      identity: pinnedIdentity,
      now: () => 1000
    })
    second.connect(relayUrl, roomId)
    await second.whenConnected()
    const reconnected = await second.reconnect({
      shareId: created.share.shareId,
      chatId: 'chat-1',
      collaboratorId: admitted.collaboratorId,
      displayName: 'Alex',
      shareMode: 'comments',
      expectedHostIdentityPubKeyB64: hostKeyB64
    })
    expect(reconnected.collaboratorId).toBe(admitted.collaboratorId)
    // Fresh session, not a resumed one.
    expect(reconnected.sessionId).not.toBe(admitted.sessionId)
    // The runtime reports the reconnect mode distinctly (host-visible state).
    expect(runtime.sessionSummaries().some((s) => s.mode === 'reconnect')).toBe(true)

    // A WRONG host pin is refused outright.
    const wrongPin = new HumanCollaborationCollaboratorClient({
      socketFactory: relay,
      identity: pinnedIdentity,
      now: () => 1000
    })
    wrongPin.connect(relayUrl, roomId)
    await wrongPin.whenConnected()
    await expect(
      wrongPin.reconnect({
        shareId: created.share.shareId,
        chatId: 'chat-1',
        collaboratorId: admitted.collaboratorId,
        displayName: 'Alex',
        shareMode: 'comments',
        expectedHostIdentityPubKeyB64: 'not-the-real-host-key'
      })
    ).rejects.toThrow(/Host identity changed/)
    wrongPin.dispose()

    // Revocation holds: a revoked participant cannot reconnect.
    store.revokeParticipant({ shareId: created.share.shareId, collaboratorId: admitted.collaboratorId })
    const afterRevoke = new HumanCollaborationCollaboratorClient({
      socketFactory: relay,
      identity: pinnedIdentity,
      now: () => 1000
    })
    afterRevoke.connect(relayUrl, roomId)
    await afterRevoke.whenConnected()
    await expect(
      afterRevoke.reconnect({
        shareId: created.share.shareId,
        chatId: 'chat-1',
        collaboratorId: admitted.collaboratorId,
        displayName: 'Alex',
        shareMode: 'comments',
        expectedHostIdentityPubKeyB64: hostKeyB64
      })
    ).rejects.toThrow(/not active/)
    afterRevoke.dispose()
    second.dispose()
    hostTransport.dispose()
  })
})

describe('loadOlder over a real relay', () => {
  it('a page actually REACHES the collaborator, stamped with their session', async () => {
    // The point of driving this end to end rather than unit-testing the merge:
    // a cache-discard test passes just as green when the cache was never
    // populated at all, because the page silently never arrived. So prove the
    // page arrives first — host seals, transport delivers, relay forwards,
    // client decrypts — and only then is discarding it meaningful.
    const relay = makeInMemoryRelay()
    const chat = makeChat()
    // Twenty rows of history behind a live window of two.
    chat.messages = [
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `old-${i}`,
        role: 'user' as const,
        content: `Older message ${i}`,
        timestamp: `2026-06-25T00:00:${String(i).padStart(2, '0')}.000Z`
      })),
      ...chat.messages
    ]
    const store = new HumanCollaborationStore()
    const created = store.createShare({
      chatId: 'chat-1',
      mode: 'comments',
      now: 1000,
      inviteTtlMs: 60_000
    })

    const hostTransport = new HumanCollaborationHostTransport({ socketFactory: relay })
    const runtime = new HumanCollaborationRuntime<HumanShareProjection, { ok: true }>({
      identityKeyPair: generateIdentityKeyPair(),
      store,
      // A live window of two, so there is genuinely history behind it.
      buildProjection: ({ share }) => buildHumanShareProjection(chat, share, { maxRows: 2 }),
      buildPage: ({ share, beforeRowId }) =>
        buildHumanSharePage(chat, share, {
          ...(beforeRowId ? { beforeRowId } : {})
        }),
      appendComment: () => ({ ok: true }),
      publishEncryptedProjection: (sessionId, frame) => hostTransport.deliver(sessionId, frame),
      now: () => 1000
    })
    hostTransport.attachRuntime(runtime)
    const relayUrl = 'ws://127.0.0.1:0'
    const roomId = 'room-page'
    hostTransport.openRoom(relayUrl, roomId)

    const projections: HumanShareProjection[] = []
    const pages: Array<{ sessionId: string; rows: unknown[]; hasMore: boolean; oldestRowId?: string }> = []
    const client = new HumanCollaborationCollaboratorClient({
      socketFactory: relay,
      now: () => 1000,
      onProjection: (p) => projections.push(p as HumanShareProjection),
      onOlderPage: (page) => pages.push(page)
    })
    client.connect(relayUrl, roomId)
    const admitted = await client.admit({
      shareId: created.share.shareId,
      chatId: 'chat-1',
      inviteToken: created.inviteToken,
      displayName: 'Alex',
      shareMode: 'comments'
    })
    client.subscribe()
    await waitFor(() => projections.length >= 1)
    const live = projections[projections.length - 1]
    expect(live.rows).toHaveLength(2)

    // Page back from the oldest row the collaborator currently holds.
    client.loadOlder(live.rows[0].id)
    await waitFor(() => pages.length >= 1)

    const page = pages[0]
    // It arrived, it has real rows, and they are OLDER than the live window.
    expect(page.rows.length).toBeGreaterThan(0)
    const ids = (page.rows as Array<{ id: string }>).map((row) => row.id)
    expect(ids).not.toContain(live.rows[0].id)
    expect(ids.every((id) => id.startsWith('old-'))).toBe(true)
    // Stamped with THIS collaborator's session — the whole basis for a cache
    // that cannot outlive a re-handshake.
    expect(page.sessionId).toBe(admitted.sessionId)
    expect(page.oldestRowId).toBe(ids[0])

    client.dispose()
    hostTransport.dispose()
  })
})
