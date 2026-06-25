import { describe, expect, it, vi } from 'vitest'
import type { ChatRecord } from '../store/types'
import { generateIdentityKeyPair } from '../../shared/e2ee/keys'
import type {
  TransportSocketFactory,
  TransportSocketHandlers
} from '../remote/RemoteTransportClient'
import { HumanCollaborationStore } from './HumanCollaborationStore'
import { HumanCollaborationRuntime } from './HumanCollaborationRuntime'
import { buildHumanShareProjection, type HumanShareProjection } from './HumanShareProjection'
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
})
