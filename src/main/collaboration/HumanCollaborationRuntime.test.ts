import { describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'crypto'
import {
  b64,
  exportRawEd25519PublicKey,
  exportRawX25519PublicKey,
  generateEphemeralKeyPair,
  generateIdentityKeyPair,
  importRawX25519PublicKey,
  signEd25519
} from '../../shared/e2ee/keys'
import {
  computeHumanCollaborationTranscriptHash,
  deriveHumanCollaborationSessionKeys,
  humanCollaborationConfirmCode
} from '../../shared/collaboration/HumanCollaborationKeySchedule'
import {
  openHumanCollaborationFrame,
  sealHumanCollaborationMessage
} from '../../shared/collaboration/HumanCollaborationCipher'
import { hashInviteToken, HumanCollaborationStore } from './HumanCollaborationStore'
import {
  HUMAN_COLLABORATION_EVENTS,
  HUMAN_COLLABORATION_METHODS,
  HUMAN_COLLABORATION_PROTOCOL,
  type HumanCollaborationBeginHandshakeInput,
  type HumanCollaborationBeginHandshakeResult,
  type HumanCollaborationConfirmSasResult,
  type HumanCollaborationHandshakeContext
} from '../../shared/collaboration/HumanCollaborationProtocol'
import { HumanCollaborationRuntime, type HumanCollaborationAppendRequest, type HumanCollaborationProjectionRequest } from './HumanCollaborationRuntime'

function makeCollaborationIdentity() {
  const identity = generateIdentityKeyPair()
  const ephemeral = generateEphemeralKeyPair()
  const nonce = randomBytes(16)
  return {
    identity,
    identityPubKeyB64: b64.encode(exportRawEd25519PublicKey(identity.publicKey)),
    ephemeral,
    ephemeralPubKeyB64: b64.encode(exportRawX25519PublicKey(ephemeral.publicKey)),
    nonceB64: b64.encode(nonce)
  }
}

function makeTranscriptContext(
  args: {
    shareId: string
    chatId: string
    inviteId: string
    inviteToken: string
    inviteTokenHash?: string
    inviteExpiresAt: number
    shareMode: 'readOnly' | 'comments'
    mode?: 'admission' | 'reconnect'
    hostIdentityPubKeyB64: string
    hostEphemeralPubKeyB64: string
    hostNonceB64: string
    hostCollaborator: ReturnType<typeof makeCollaborationIdentity>
    existingCollaboratorId?: string
  }
): HumanCollaborationHandshakeContext {
  return {
    protocol: HUMAN_COLLABORATION_PROTOCOL,
    mode: args.mode || 'admission',
    shareId: args.shareId,
    chatId: args.chatId,
    inviteId: args.inviteId,
    inviteTokenHash: args.inviteTokenHash || hashInviteToken(args.inviteToken),
    inviteExpiresAt: args.inviteExpiresAt,
    shareMode: args.shareMode,
    collaboratorId: args.existingCollaboratorId,
    hostIdentityPubKeyB64: args.hostIdentityPubKeyB64,
    collaboratorIdentityPubKeyB64: args.hostCollaborator.identityPubKeyB64,
    hostEphemeralPubKeyB64: args.hostEphemeralPubKeyB64,
    collaboratorEphemeralPubKeyB64: args.hostCollaborator.ephemeralPubKeyB64,
    hostNonceB64: args.hostNonceB64,
    collaboratorNonceB64: args.hostCollaborator.nonceB64
  }
}

describe('HumanCollaborationRuntime', () => {
  it('creates a handshake pending state and consumes the invite only after host SAS confirmation', async () => {
    const store = new HumanCollaborationStore()
    const share = store.createShare({ chatId: 'chat-1', mode: 'comments', now: 1000, inviteTtlMs: 10000 })
    const collaborator = makeCollaborationIdentity()
    const host = generateIdentityKeyPair()
    const buildProjection = vi.fn()
    const appendComment = vi.fn()
    const runtime = new HumanCollaborationRuntime({
      identityKeyPair: host,
      store,
      buildProjection,
      appendComment,
      now: () => 1000
    })

    const result = await runtime.beginAdmission({
      shareId: share.share.shareId,
      chatId: 'chat-1',
      displayName: 'Alex',
      inviteToken: share.inviteToken,
      collaboratorIdentityPubKeyB64: collaborator.identityPubKeyB64,
      collaboratorEphemeralPubKeyB64: collaborator.ephemeralPubKeyB64,
      collaboratorNonceB64: collaborator.nonceB64
    })

    expect(result.protocol).toBe(HUMAN_COLLABORATION_PROTOCOL)
    expect(result.mode).toBe('admission')
    expect(result.confirmCode).toHaveLength(6)
    expect(result.confirmCode).not.toBe(share.inviteToken)
    expect(store.getShare(share.share.shareId)?.invites[0]?.consumedAt).toBeUndefined()

    const context = makeTranscriptContext({
      shareId: share.share.shareId,
      chatId: 'chat-1',
      inviteId: result.inviteId,
      inviteToken: share.inviteToken,
      inviteExpiresAt: result.expiresAt,
      shareMode: 'comments',
      hostIdentityPubKeyB64: result.hostIdentityPubKeyB64,
      hostEphemeralPubKeyB64: result.hostEphemeralPubKeyB64,
      hostNonceB64: result.hostNonceB64,
      hostCollaborator: collaborator
    })
    const contextHash = computeHumanCollaborationTranscriptHash(context)
    expect(humanCollaborationConfirmCode(context)).toBe(result.confirmCode)

    const confirmed = await runtime.confirmSas({
      handshakeId: result.handshakeId,
      confirmCode: result.confirmCode,
      collaboratorTranscriptSigB64: b64.encode(
        signEd25519(collaborator.identity.privateKey, contextHash)
      )
    })

    expect(confirmed.sessionId).toBeTruthy()
    expect(confirmed.displayName).toBe('Alex')
    expect(store.getShare(share.share.shareId)?.invites[0]?.consumedAt).toBeGreaterThan(0)
  })

  it('enforces revocation before projection and inbound append', async () => {
    const store = new HumanCollaborationStore()
    const share = store.createShare({ chatId: 'chat-1', mode: 'comments', now: 1000, inviteTtlMs: 10000 })
    const collaborator = makeCollaborationIdentity()
    const host = generateIdentityKeyPair()
    const buildProjection = vi.fn((input: HumanCollaborationProjectionRequest) => ({
      schemaVersion: 1,
      shareId: input.share.shareId
    }))
    const appendComment = vi.fn((input: HumanCollaborationAppendRequest) => ({
      messageId: `msg-${input.clientMessageId}`
    }))
    const runtime = new HumanCollaborationRuntime({
      identityKeyPair: host,
      store,
      buildProjection,
      appendComment,
      now: () => 1000
    })

    const begin = await runtime.beginAdmission({
      shareId: share.share.shareId,
      chatId: 'chat-1',
      displayName: 'Alex',
      inviteToken: share.inviteToken,
      collaboratorIdentityPubKeyB64: collaborator.identityPubKeyB64,
      collaboratorEphemeralPubKeyB64: collaborator.ephemeralPubKeyB64,
      collaboratorNonceB64: collaborator.nonceB64
    })
    const context = makeTranscriptContext({
      shareId: share.share.shareId,
      chatId: 'chat-1',
      inviteId: begin.inviteId,
      inviteToken: share.inviteToken,
      inviteExpiresAt: begin.expiresAt,
      shareMode: 'comments',
      hostIdentityPubKeyB64: begin.hostIdentityPubKeyB64,
      hostEphemeralPubKeyB64: begin.hostEphemeralPubKeyB64,
      hostNonceB64: begin.hostNonceB64,
      hostCollaborator: collaborator
    })
    const contextHash = computeHumanCollaborationTranscriptHash(context)
    const session = await runtime.confirmSas({
      handshakeId: begin.handshakeId,
      confirmCode: begin.confirmCode,
      collaboratorTranscriptSigB64: b64.encode(signEd25519(collaborator.identity.privateKey, contextHash))
    })

    const projection = await runtime.subscribeProjection({ sessionId: session.sessionId })
    expect(projection).toEqual({ schemaVersion: 1, shareId: share.share.shareId })
    expect(buildProjection).toHaveBeenCalledTimes(1)

    const append = await runtime.appendComment({
      sessionId: session.sessionId,
      clientMessageId: 'c1',
      content: 'Please review this snippet'
    })
    expect(append.messageId).toBe('msg-c1')
    expect(appendComment).toHaveBeenCalledOnce()

    store.revokeShare(share.share.shareId, 2000)
    await expect(runtime.subscribeProjection({ sessionId: session.sessionId })).rejects.toThrow(
      /no longer active|is no longer active|not active/
    )
    await expect(
      runtime.appendComment({
        sessionId: session.sessionId,
        clientMessageId: 'c2',
        content: 'Second'
      })
    ).rejects.toThrow(/no longer active|is no longer active|not active/)
  })

  it('allows reconnect only with the pinned collaborator identity', async () => {
    const store = new HumanCollaborationStore()
    const share = store.createShare({ chatId: 'chat-1', mode: 'comments', now: 1000, inviteTtlMs: 10000 })
    const collaborator = makeCollaborationIdentity()
    const host = generateIdentityKeyPair()
    let now = 1000
    const runtime = new HumanCollaborationRuntime({
      identityKeyPair: host,
      store,
      buildProjection: vi.fn().mockResolvedValue({ ok: true }),
      appendComment: vi.fn().mockResolvedValue({ ok: true }),
      now: () => now
    })

    const begin = await runtime.beginAdmission({
      shareId: share.share.shareId,
      chatId: 'chat-1',
      displayName: 'Alex',
      inviteToken: share.inviteToken,
      collaboratorIdentityPubKeyB64: collaborator.identityPubKeyB64,
      collaboratorEphemeralPubKeyB64: collaborator.ephemeralPubKeyB64,
      collaboratorNonceB64: collaborator.nonceB64
    })
    const admissionContext = makeTranscriptContext({
      shareId: share.share.shareId,
      chatId: 'chat-1',
      inviteId: begin.inviteId,
      inviteToken: share.inviteToken,
      inviteExpiresAt: begin.expiresAt,
      shareMode: 'comments',
      hostIdentityPubKeyB64: begin.hostIdentityPubKeyB64,
      hostEphemeralPubKeyB64: begin.hostEphemeralPubKeyB64,
      hostNonceB64: begin.hostNonceB64,
      hostCollaborator: collaborator
    })
    const admitted = await runtime.confirmSas({
      handshakeId: begin.handshakeId,
      confirmCode: begin.confirmCode,
      collaboratorTranscriptSigB64: b64.encode(
        signEd25519(collaborator.identity.privateKey, computeHumanCollaborationTranscriptHash(admissionContext))
      )
    })
    await runtime.disconnect({ sessionId: admitted.sessionId })

    const wrong = makeCollaborationIdentity()
    await expect(
      runtime.beginAdmission({
        shareId: share.share.shareId,
        chatId: 'chat-1',
        displayName: 'Mallory',
        collaboratorId: admitted.collaboratorId,
        collaboratorIdentityPubKeyB64: wrong.identityPubKeyB64,
        collaboratorEphemeralPubKeyB64: wrong.ephemeralPubKeyB64,
        collaboratorNonceB64: wrong.nonceB64
      })
    ).rejects.toThrow(/identity/)

    now = 2000
    const reconnectPeer = makeCollaborationIdentity()
    reconnectPeer.identity = collaborator.identity
    reconnectPeer.identityPubKeyB64 = collaborator.identityPubKeyB64
    const reconnect = await runtime.beginAdmission({
      shareId: share.share.shareId,
      chatId: 'chat-1',
      displayName: 'Alex',
      collaboratorId: admitted.collaboratorId,
      collaboratorIdentityPubKeyB64: reconnectPeer.identityPubKeyB64,
      collaboratorEphemeralPubKeyB64: reconnectPeer.ephemeralPubKeyB64,
      collaboratorNonceB64: reconnectPeer.nonceB64
    })
    expect(reconnect.mode).toBe('reconnect')
    const reconnectContext = makeTranscriptContext({
      mode: 'reconnect',
      shareId: share.share.shareId,
      chatId: 'chat-1',
      inviteId: reconnect.inviteId,
      inviteToken: '',
      inviteTokenHash: `pinned:${collaborator.identityPubKeyB64}`,
      inviteExpiresAt: reconnect.expiresAt,
      shareMode: 'comments',
      existingCollaboratorId: admitted.collaboratorId,
      hostIdentityPubKeyB64: reconnect.hostIdentityPubKeyB64,
      hostEphemeralPubKeyB64: reconnect.hostEphemeralPubKeyB64,
      hostNonceB64: reconnect.hostNonceB64,
      hostCollaborator: reconnectPeer
    })
    const reconnected = await runtime.confirmSas({
      handshakeId: reconnect.handshakeId,
      confirmCode: reconnect.confirmCode,
      collaboratorTranscriptSigB64: b64.encode(
        signEd25519(reconnectPeer.identity.privateKey, computeHumanCollaborationTranscriptHash(reconnectContext))
      )
    })
    expect(reconnected.collaboratorId).toBe(admitted.collaboratorId)
  })

  it('supports transport action routing to the collaboration namespace', async () => {
    const store = new HumanCollaborationStore()
    const share = store.createShare({ chatId: 'chat-1', mode: 'comments', now: 1000, inviteTtlMs: 10000 })
    const collaborator = makeCollaborationIdentity()
    const host = generateIdentityKeyPair()
    const runtime = new HumanCollaborationRuntime({
      identityKeyPair: host,
      store,
      buildProjection: vi.fn().mockResolvedValue({}),
      appendComment: vi.fn().mockResolvedValue({ ok: true }),
      now: () => 1000
    })

    const beginInput: HumanCollaborationBeginHandshakeInput = {
      shareId: share.share.shareId,
      chatId: 'chat-1',
      displayName: 'Alex',
      inviteToken: share.inviteToken,
      collaboratorIdentityPubKeyB64: collaborator.identityPubKeyB64,
      collaboratorEphemeralPubKeyB64: collaborator.ephemeralPubKeyB64,
      collaboratorNonceB64: collaborator.nonceB64
    }

    const beginResult = await runtime.routeAction<HumanCollaborationBeginHandshakeResult>(
      HUMAN_COLLABORATION_METHODS.beginHandshake,
      beginInput
    )

    const context = makeTranscriptContext({
      shareId: share.share.shareId,
      chatId: 'chat-1',
      inviteId: beginResult.inviteId,
      inviteToken: share.inviteToken,
      inviteExpiresAt: beginResult.expiresAt,
      shareMode: 'comments',
      hostIdentityPubKeyB64: beginResult.hostIdentityPubKeyB64,
      hostEphemeralPubKeyB64: beginResult.hostEphemeralPubKeyB64,
      hostNonceB64: beginResult.hostNonceB64,
      hostCollaborator: collaborator
    })
    const contextHash = computeHumanCollaborationTranscriptHash(context)
    const confirmed = await runtime.routeAction<HumanCollaborationConfirmSasResult>(
      HUMAN_COLLABORATION_METHODS.confirmSas,
      {
        handshakeId: beginResult.handshakeId,
        confirmCode: beginResult.confirmCode,
        collaboratorTranscriptSigB64: b64.encode(
          signEd25519(collaborator.identity.privateKey, contextHash)
        )
      }
    )
    const projection = await runtime.routeAction(HUMAN_COLLABORATION_METHODS.subscribeProjection, {
      sessionId: confirmed.sessionId
    })
    expect(projection).toEqual({})
    expect(await runtime.routeAction(HUMAN_COLLABORATION_METHODS.disconnect, { sessionId: confirmed.sessionId })).toBe(
      true
    )
    await expect(runtime.routeAction(HUMAN_COLLABORATION_METHODS.subscribeProjection, { sessionId: confirmed.sessionId })).rejects.toThrow(
      /session is not active/
    )
  })

  it('routes encrypted collaborator frames and seals projection updates for the peer', async () => {
    const store = new HumanCollaborationStore()
    const share = store.createShare({ chatId: 'chat-1', mode: 'comments', now: 1000, inviteTtlMs: 10000 })
    const collaborator = makeCollaborationIdentity()
    const host = generateIdentityKeyPair()
    const appendComment = vi.fn((input: HumanCollaborationAppendRequest) => ({
      messageId: `msg-${input.clientMessageId}`
    }))
    const runtime = new HumanCollaborationRuntime({
      identityKeyPair: host,
      store,
      buildProjection: vi.fn().mockResolvedValue({ rows: [] }),
      appendComment,
      now: () => 1000
    })

    const begin = await runtime.beginAdmission({
      shareId: share.share.shareId,
      chatId: 'chat-1',
      displayName: 'Alex',
      inviteToken: share.inviteToken,
      collaboratorIdentityPubKeyB64: collaborator.identityPubKeyB64,
      collaboratorEphemeralPubKeyB64: collaborator.ephemeralPubKeyB64,
      collaboratorNonceB64: collaborator.nonceB64
    })
    const context = makeTranscriptContext({
      shareId: share.share.shareId,
      chatId: 'chat-1',
      inviteId: begin.inviteId,
      inviteToken: share.inviteToken,
      inviteExpiresAt: begin.expiresAt,
      shareMode: 'comments',
      hostIdentityPubKeyB64: begin.hostIdentityPubKeyB64,
      hostEphemeralPubKeyB64: begin.hostEphemeralPubKeyB64,
      hostNonceB64: begin.hostNonceB64,
      hostCollaborator: collaborator
    })
    const session = await runtime.confirmSas({
      handshakeId: begin.handshakeId,
      confirmCode: begin.confirmCode,
      collaboratorTranscriptSigB64: b64.encode(
        signEd25519(collaborator.identity.privateKey, computeHumanCollaborationTranscriptHash(context))
      )
    })
    const collaboratorKeys = deriveHumanCollaborationSessionKeys({
      hostEphemeralPrivate: collaborator.ephemeral.privateKey,
      collaboratorEphemeralPublic: importRawX25519PublicKey(b64.decode(begin.hostEphemeralPubKeyB64)),
      hostNonce: b64.decode(begin.hostNonceB64),
      collaboratorNonce: b64.decode(collaborator.nonceB64)
    })

    const appendFrame = sealHumanCollaborationMessage({
      keys: collaboratorKeys,
      direction: 'collaboratorToHost',
      sessionId: session.sessionId,
      seq: 1,
      message: {
        msgId: 1,
        method: HUMAN_COLLABORATION_METHODS.appendComment,
        params: {
          clientMessageId: 'encrypted-1',
          content: 'Encrypted collaborator comment'
        }
      }
    })
    const appendResult = await runtime.routeEncryptedAction(appendFrame)
    expect(appendResult).toEqual({ messageId: 'msg-encrypted-1' })
    expect(appendComment).toHaveBeenCalledOnce()
    await expect(runtime.routeEncryptedAction(appendFrame)).rejects.toThrow(/replay/)

    const projectionFrame = runtime.sealProjectionUpdate(session.sessionId, { rows: ['allowed'] })
    const openedProjection = openHumanCollaborationFrame({
      keys: collaboratorKeys,
      expectedDirection: 'hostToCollaborator',
      frame: projectionFrame
    })
    expect(openedProjection).toMatchObject({
      method: HUMAN_COLLABORATION_EVENTS.projectionUpdate,
      params: { projection: { rows: ['allowed'] } }
    })

    const forbiddenFrame = sealHumanCollaborationMessage({
      keys: collaboratorKeys,
      direction: 'collaboratorToHost',
      sessionId: session.sessionId,
      seq: 2,
      message: {
        msgId: 2,
        method: 'startTurn' as typeof HUMAN_COLLABORATION_METHODS.disconnect,
        params: {}
      }
    })
    await expect(runtime.routeEncryptedAction(forbiddenFrame)).rejects.toThrow(/not allowed/)
  })

  it('rate-limits collaborator appends per share/collaborator', async () => {
    const store = new HumanCollaborationStore()
    const share = store.createShare({ chatId: 'chat-1', mode: 'comments', now: 1000, inviteTtlMs: 10000 })
    const collaborator = makeCollaborationIdentity()
    const host = generateIdentityKeyPair()
    let now = 1000
    const runtime = new HumanCollaborationRuntime({
      identityKeyPair: host,
      store,
      buildProjection: vi.fn().mockResolvedValue({ ok: true }),
      appendComment: vi.fn().mockResolvedValue({ ok: true }),
      now: () => now
    })
    const begin = await runtime.beginAdmission({
      shareId: share.share.shareId,
      chatId: 'chat-1',
      displayName: 'Alex',
      inviteToken: share.inviteToken,
      collaboratorIdentityPubKeyB64: collaborator.identityPubKeyB64,
      collaboratorEphemeralPubKeyB64: collaborator.ephemeralPubKeyB64,
      collaboratorNonceB64: collaborator.nonceB64
    })
    const context = makeTranscriptContext({
      shareId: share.share.shareId,
      chatId: 'chat-1',
      inviteId: begin.inviteId,
      inviteToken: share.inviteToken,
      inviteExpiresAt: begin.expiresAt,
      shareMode: 'comments',
      hostIdentityPubKeyB64: begin.hostIdentityPubKeyB64,
      hostEphemeralPubKeyB64: begin.hostEphemeralPubKeyB64,
      hostNonceB64: begin.hostNonceB64,
      hostCollaborator: collaborator
    })
    const admitted = await runtime.confirmSas({
      handshakeId: begin.handshakeId,
      confirmCode: begin.confirmCode,
      collaboratorTranscriptSigB64: b64.encode(
        signEd25519(collaborator.identity.privateKey, computeHumanCollaborationTranscriptHash(context))
      )
    })

    await expect(
      runtime.appendComment({ sessionId: admitted.sessionId, clientMessageId: 'c-1', content: 'hi' })
    ).resolves.toMatchObject({ ok: true })
    // A second append in the same tick (< min interval) is rejected.
    await expect(
      runtime.appendComment({ sessionId: admitted.sessionId, clientMessageId: 'c-2', content: 'spam' })
    ).rejects.toThrow(/rate limit/i)
    // After the min interval it is allowed again.
    now = 2000
    await expect(
      runtime.appendComment({ sessionId: admitted.sessionId, clientMessageId: 'c-3', content: 'ok now' })
    ).resolves.toMatchObject({ ok: true })
  })

  it('drops the pending handshake on a failed SAS confirmation', async () => {
    const store = new HumanCollaborationStore()
    const share = store.createShare({ chatId: 'chat-1', mode: 'comments', now: 1000, inviteTtlMs: 10000 })
    const collaborator = makeCollaborationIdentity()
    const host = generateIdentityKeyPair()
    const runtime = new HumanCollaborationRuntime({
      identityKeyPair: host,
      store,
      buildProjection: vi.fn().mockResolvedValue({ ok: true }),
      appendComment: vi.fn().mockResolvedValue({ ok: true }),
      now: () => 1000
    })
    const begin = await runtime.beginAdmission({
      shareId: share.share.shareId,
      chatId: 'chat-1',
      displayName: 'Alex',
      inviteToken: share.inviteToken,
      collaboratorIdentityPubKeyB64: collaborator.identityPubKeyB64,
      collaboratorEphemeralPubKeyB64: collaborator.ephemeralPubKeyB64,
      collaboratorNonceB64: collaborator.nonceB64
    })
    const context = makeTranscriptContext({
      shareId: share.share.shareId,
      chatId: 'chat-1',
      inviteId: begin.inviteId,
      inviteToken: share.inviteToken,
      inviteExpiresAt: begin.expiresAt,
      shareMode: 'comments',
      hostIdentityPubKeyB64: begin.hostIdentityPubKeyB64,
      hostEphemeralPubKeyB64: begin.hostEphemeralPubKeyB64,
      hostNonceB64: begin.hostNonceB64,
      hostCollaborator: collaborator
    })
    const goodSig = b64.encode(
      signEd25519(collaborator.identity.privateKey, computeHumanCollaborationTranscriptHash(context))
    )
    // Wrong code → rejected AND the pending handshake is dropped.
    await expect(
      runtime.confirmSas({
        handshakeId: begin.handshakeId,
        confirmCode: '000000',
        collaboratorTranscriptSigB64: goodSig
      })
    ).rejects.toThrow(/mismatch/i)
    // Retrying with the correct code now fails because the handshake is gone.
    await expect(
      runtime.confirmSas({
        handshakeId: begin.handshakeId,
        confirmCode: begin.confirmCode,
        collaboratorTranscriptSigB64: goodSig
      })
    ).rejects.toThrow(/not active/i)
  })

  it('bounds the number of pending handshakes per share', async () => {
    const store = new HumanCollaborationStore()
    const share = store.createShare({ chatId: 'chat-1', mode: 'comments', now: 1000, inviteTtlMs: 10000 })
    const host = generateIdentityKeyPair()
    const runtime = new HumanCollaborationRuntime({
      identityKeyPair: host,
      store,
      buildProjection: vi.fn().mockResolvedValue({ ok: true }),
      appendComment: vi.fn().mockResolvedValue({ ok: true }),
      now: () => 1000
    })
    const beginOnce = () => {
      const peer = makeCollaborationIdentity()
      return runtime.beginAdmission({
        shareId: share.share.shareId,
        chatId: 'chat-1',
        displayName: 'Alex',
        inviteToken: share.inviteToken,
        collaboratorIdentityPubKeyB64: peer.identityPubKeyB64,
        collaboratorEphemeralPubKeyB64: peer.ephemeralPubKeyB64,
        collaboratorNonceB64: peer.nonceB64
      })
    }
    for (let i = 0; i < 4; i++) {
      await expect(beginOnce()).resolves.toBeTruthy()
    }
    await expect(beginOnce()).rejects.toThrow(/too many pending/i)
  })

  it('P2a: exposes per-session summaries and audits admission + disconnect', async () => {
    const store = new HumanCollaborationStore()
    const share = store.createShare({ chatId: 'chat-1', mode: 'comments', now: 1000, inviteTtlMs: 10000 })
    const collaborator = makeCollaborationIdentity()
    const host = generateIdentityKeyPair()
    const audit = { append: vi.fn() }
    const runtime = new HumanCollaborationRuntime({
      identityKeyPair: host,
      store,
      buildProjection: vi.fn(),
      appendComment: vi.fn(),
      audit,
      now: () => 1000
    })

    expect(runtime.sessionSummaries()).toEqual([])

    const begin = await runtime.beginAdmission({
      shareId: share.share.shareId,
      chatId: 'chat-1',
      displayName: 'Alex',
      inviteToken: share.inviteToken,
      collaboratorIdentityPubKeyB64: collaborator.identityPubKeyB64,
      collaboratorEphemeralPubKeyB64: collaborator.ephemeralPubKeyB64,
      collaboratorNonceB64: collaborator.nonceB64
    })
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'admission.began', chatId: 'chat-1' })
    )

    const context = makeTranscriptContext({
      shareId: share.share.shareId,
      chatId: 'chat-1',
      inviteId: begin.inviteId,
      inviteToken: share.inviteToken,
      inviteExpiresAt: begin.expiresAt,
      shareMode: 'comments',
      hostIdentityPubKeyB64: begin.hostIdentityPubKeyB64,
      hostEphemeralPubKeyB64: begin.hostEphemeralPubKeyB64,
      hostNonceB64: begin.hostNonceB64,
      hostCollaborator: collaborator
    })
    const confirmed = await runtime.confirmSas({
      handshakeId: begin.handshakeId,
      confirmCode: begin.confirmCode,
      collaboratorTranscriptSigB64: b64.encode(
        signEd25519(collaborator.identity.privateKey, computeHumanCollaborationTranscriptHash(context))
      )
    })
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'admission.sas_confirmed', collaboratorId: confirmed.collaboratorId })
    )

    const summaries = runtime.sessionSummaries()
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      chatId: 'chat-1',
      shareId: share.share.shareId,
      collaboratorId: confirmed.collaboratorId,
      displayName: 'Alex',
      mode: 'admission'
    })
    // No key material or sequence state leaks through the summary.
    expect(Object.keys(summaries[0]).sort()).toEqual(
      ['chatId', 'collaboratorId', 'displayName', 'establishedAt', 'mode', 'shareId'].sort()
    )

    await runtime.disconnect({ sessionId: confirmed.sessionId })
    expect(runtime.sessionSummaries()).toEqual([])
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'session.disconnected', collaboratorId: confirmed.collaboratorId })
    )
  })

  it('P2b: sanitizes contribution intent — junk degrades to a plain comment, rules gate action requests', async () => {
    const store = new HumanCollaborationStore()
    const share = store.createShare({ chatId: 'chat-1', mode: 'comments', now: 1000, inviteTtlMs: 10000 })
    const collaborator = makeCollaborationIdentity()
    const host = generateIdentityKeyPair()
    const appendComment = vi.fn((input: HumanCollaborationAppendRequest & { intent?: string }) => ({
      messageId: input.clientMessageId,
      intentSeen: input.intent
    }))
    let clock = 1000
    const runtime = new HumanCollaborationRuntime({
      identityKeyPair: host,
      store,
      buildProjection: vi.fn(),
      appendComment,
      now: () => clock
    })

    const begin = await runtime.beginAdmission({
      shareId: share.share.shareId,
      chatId: 'chat-1',
      displayName: 'Alex',
      inviteToken: share.inviteToken,
      collaboratorIdentityPubKeyB64: collaborator.identityPubKeyB64,
      collaboratorEphemeralPubKeyB64: collaborator.ephemeralPubKeyB64,
      collaboratorNonceB64: collaborator.nonceB64
    })
    const context = makeTranscriptContext({
      shareId: share.share.shareId,
      chatId: 'chat-1',
      inviteId: begin.inviteId,
      inviteToken: share.inviteToken,
      inviteExpiresAt: begin.expiresAt,
      shareMode: 'comments',
      hostIdentityPubKeyB64: begin.hostIdentityPubKeyB64,
      hostEphemeralPubKeyB64: begin.hostEphemeralPubKeyB64,
      hostNonceB64: begin.hostNonceB64,
      hostCollaborator: collaborator
    })
    const confirmed = await runtime.confirmSas({
      handshakeId: begin.handshakeId,
      confirmCode: begin.confirmCode,
      collaboratorTranscriptSigB64: b64.encode(
        signEd25519(collaborator.identity.privateKey, computeHumanCollaborationTranscriptHash(context))
      )
    })

    // Hostile/junk intent value degrades to a plain comment (no throw, no leak).
    await runtime.appendComment({
      sessionId: confirmed.sessionId,
      clientMessageId: 'j-1',
      content: 'hello',
      intent: 'directDispatch' as never
    })
    expect(appendComment).toHaveBeenLastCalledWith(
      expect.objectContaining({ clientMessageId: 'j-1', intent: undefined })
    )

    // A REAL action request is rule-gated: the comments preset rejects it
    // (advance the clock past the rate-limit window so the RULES gate decides).
    clock += 60_000
    await expect(
      runtime.appendComment({
        sessionId: confirmed.sessionId,
        clientMessageId: 'j-2',
        content: 'please act',
        intent: 'requestHostAction'
      })
    ).rejects.toThrow(/does not accept host-action requests/)
  })
})

