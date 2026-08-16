import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHANNEL_AGENT_PROTOCOL_VERSION,
  hashChannelAgentContent,
  signChannelAgentPost
} from '../../shared/collaboration/ChannelAgentProtocol'
import { exportRawEd25519PublicKey, generateIdentityKeyPair } from '../../shared/e2ee/keys'
import {
  ChannelMessageLog,
  type AgentChannelMessage,
  type ChannelAppendResult,
  type ChannelMessage
} from './ChannelMessageLog'
import { ChannelHumanPolicyError, type ChannelHumanPolicyStore } from './ChannelHumanPolicyStore'
import { ChannelRuntime, type ChannelRuntimeTransport } from './ChannelRuntime'
import { ChannelStore } from './ChannelStore'

const temporaryDirectories: string[] = []

afterEach(() => {
  while (temporaryDirectories.length) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'taskwraith-channel-runtime-fault-'))
  temporaryDirectories.push(path)
  return path
}

function signedAgentFixture(channelId: string): {
  signedPost: ReturnType<typeof signChannelAgentPost>
  result: ChannelAppendResult
} {
  const keys = generateIdentityKeyPair()
  const publicKeyB64 = exportRawEd25519PublicKey(keys.publicKey).toString('base64')
  const content = 'Signed runtime delivery.'
  const signedPost = signChannelAgentPost(keys.privateKey, {
    schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
    channelId,
    agentMemberId: 'agent-runtime-proof',
    agentSeatId: 'pooled-agent-runtime-proof',
    agentPublicKeyB64: publicKeyB64,
    keyGeneration: 1,
    delegationId: 'delegation-runtime-proof',
    dispatchGrantId: 'grant-runtime-proof',
    triggerMessageId: 'trigger-runtime-proof',
    runId: 'run-runtime-proof',
    runAuthorityHash: 'a'.repeat(64),
    clientMessageId: 'agent-post-runtime-proof',
    kind: 'agent.text',
    content,
    contentHash: hashChannelAgentContent(content),
    createdAt: 1_000
  })
  const record: AgentChannelMessage = {
    channelId,
    sequence: 1,
    messageId: 'message-runtime-proof',
    authorMemberId: signedPost.post.agentMemberId,
    clientMessageId: signedPost.post.clientMessageId,
    kind: 'agent.text',
    content,
    acceptedAt: 1_001,
    contentHash: signedPost.post.contentHash,
    agentProof: { signedPost } as never
  }
  return { signedPost, result: { record, deduplicated: false } }
}

class RecordingTransport implements ChannelRuntimeTransport {
  readonly sent: Array<{ roomId: string; payload: string }> = []
  readonly closed: string[] = []

  send(roomId: string, payload: string): boolean {
    this.sent.push({ roomId, payload })
    return true
  }

  close(roomId: string): void {
    this.closed.push(roomId)
  }
}

describe('ChannelRuntime durability boundary', () => {
  it('maps migrated-human policy decisions to fail-closed Channel errors', () => {
    const root = directory()
    const evaluate = vi.fn<ChannelHumanPolicyStore['evaluate']>()
    const store = new ChannelStore(join(root, 'channels.json'))
    const runtime = new ChannelRuntime({
      identityKeyPair: generateIdentityKeyPair(),
      store,
      log: new ChannelMessageLog(join(root, 'logs'), store),
      humanPolicy: { evaluate }
    })
    const enforce = (
      runtime as unknown as {
        enforceHumanAppendPolicy: (
          session: { channelId: string; memberId: string },
          content: string
        ) => 'append' | 'host_review'
      }
    ).enforceHumanAppendPolicy.bind(runtime)
    const session = { channelId: 'channel-policy', memberId: 'member-policy' }

    evaluate.mockReturnValueOnce({ outcome: 'append', policy: null })
    expect(enforce(session, '🧪')).toBe('append')
    expect(evaluate).toHaveBeenLastCalledWith({
      channelId: 'channel-policy',
      memberId: 'member-policy',
      intent: 'comment',
      contentBytes: 4
    })

    evaluate.mockReturnValueOnce({
      outcome: 'deny',
      code: 'quota_exceeded',
      message: 'too large',
      policy: null
    })
    expect(() => enforce(session, 'x')).toThrowError(
      expect.objectContaining({ code: 'quota_exceeded', message: 'too large' })
    )

    evaluate.mockReturnValueOnce({
      outcome: 'deny',
      code: 'read_only',
      message: 'read only',
      policy: null
    })
    expect(() => enforce(session, 'x')).toThrowError(
      expect.objectContaining({ code: 'policy_denied', message: 'read only' })
    )

    evaluate.mockReturnValueOnce({ outcome: 'host_review', policy: {} as never })
    expect(enforce(session, 'x')).toBe('host_review')

    evaluate.mockImplementationOnce(() => {
      throw new ChannelHumanPolicyError('corrupt')
    })
    expect(() => enforce(session, 'x')).toThrowError(
      expect.objectContaining({ code: 'recovery_blocked' })
    )
    runtime.dispose()
  })

  it('recovers a crash after fsync but before fan-out and deduplicates the retry', async () => {
    const root = directory()
    const storePath = join(root, 'channels.json')
    const logPath = join(root, 'logs')
    const identity = generateIdentityKeyPair()
    const store = new ChannelStore(storePath)
    const log = new ChannelMessageLog(logPath, store)
    let faultArmed = true
    const runtime = new ChannelRuntime({
      identityKeyPair: identity,
      store,
      log,
      afterDurableCommit: () => {
        if (!faultArmed) return
        faultArmed = false
        throw new Error('injected crash after durable commit')
      }
    })
    const transport = new RecordingTransport()
    runtime.attachTransport(transport)
    const created = runtime.createChannel({
      chatId: 'chat',
      title: 'Channel',
      ownerDisplayName: 'Host'
    })
    const input = {
      clientMessageId: 'crash-window',
      content: 'survives restart'
    }

    await expect(runtime.appendHost(created.channel.channelId, input)).rejects.toThrow(
      'injected crash after durable commit'
    )
    expect(log.highWaterSequence(created.channel.channelId)).toBe(1)
    expect(log.getMessage(created.channel.channelId, 1)).toMatchObject({
      sequence: 1,
      content: 'survives restart'
    })
    expect(transport.sent).toEqual([])
    runtime.dispose()

    const restartedStore = new ChannelStore(storePath)
    const restartedLog = new ChannelMessageLog(logPath, restartedStore)
    const restarted = new ChannelRuntime({
      identityKeyPair: identity,
      store: restartedStore,
      log: restartedLog
    })
    const restartedTransport = new RecordingTransport()
    restarted.attachTransport(restartedTransport)
    const retry = await restarted.appendHost(created.channel.channelId, input)
    expect(retry).toMatchObject({ deduplicated: true, record: { sequence: 1 } })
    expect(restartedLog.highWaterSequence(created.channel.channelId)).toBe(1)
    expect(restartedTransport.sent).toEqual([])

    const next = await restarted.appendHost(created.channel.channelId, {
      clientMessageId: 'after-restart',
      content: 'next'
    })
    expect(next).toMatchObject({ deduplicated: false, record: { sequence: 2 } })
    expect(restartedLog.highWaterSequence(created.channel.channelId)).toBe(2)
    restarted.dispose()
  })

  it('rejects an agent-shaped host append before it consumes a sequence', async () => {
    const root = directory()
    const store = new ChannelStore(join(root, 'channels.json'))
    const log = new ChannelMessageLog(join(root, 'logs'), store)
    const runtime = new ChannelRuntime({
      identityKeyPair: generateIdentityKeyPair(),
      store,
      log
    })
    const created = runtime.createChannel({
      chatId: 'chat',
      title: 'Channel',
      ownerDisplayName: 'Host'
    })

    await expect(
      runtime.appendHost(created.channel.channelId, {
        clientMessageId: 'agent',
        content: 'dispatch',
        kind: 'agent.text'
      } as never)
    ).rejects.toMatchObject({ code: 'human_only' })
    expect(log.highWaterSequence(created.channel.channelId)).toBe(0)
    runtime.dispose()
  })

  it('fans out a signed agent post only after durable append and audit', async () => {
    const root = directory()
    const store = new ChannelStore(join(root, 'channels.json'))
    const trace: string[] = []
    const fixtureRef: { current: ReturnType<typeof signedAgentFixture> | null } = {
      current: null
    }
    const appendSignedAgentPost = vi.fn(() => {
      trace.push('log.append')
      return fixtureRef.current!.result
    })
    const afterDurableCommit = vi.fn()
    const audit = vi.fn(() => trace.push('audit.append'))
    const runtime = new ChannelRuntime({
      identityKeyPair: generateIdentityKeyPair(),
      store,
      log: { appendSignedAgentPost } as unknown as ChannelMessageLog,
      audit: { append: audit },
      afterDurableCommit
    })
    const created = runtime.createChannel({
      chatId: 'chat-agent-runtime',
      title: 'Agent runtime proof',
      ownerDisplayName: 'Host'
    })
    const fixture = signedAgentFixture(created.channel.channelId)
    fixtureRef.current = fixture
    trace.length = 0
    audit.mockClear()
    const fanOut = vi
      .spyOn(runtime as unknown as { fanOut(record: ChannelMessage): void }, 'fanOut')
      .mockImplementation(() => {
        trace.push('runtime.fanOut')
      })

    await expect(
      runtime.appendSignedAgentPost({ signedPost: fixture.signedPost, now: 1_001 })
    ).resolves.toEqual(fixture.result)
    expect(trace).toEqual(['log.append', 'audit.append', 'runtime.fanOut'])
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'message.accepted',
        channelId: created.channel.channelId,
        memberId: 'agent-runtime-proof',
        contentHash: fixture.result.record.contentHash
      })
    )
    expect(afterDurableCommit).not.toHaveBeenCalled()

    trace.length = 0
    appendSignedAgentPost.mockImplementation(() => {
      trace.push('log.append')
      return { ...fixture.result, deduplicated: true }
    })
    await runtime.appendSignedAgentPost({ signedPost: fixture.signedPost, now: 1_002 })
    expect(trace).toEqual(['log.append', 'audit.append'])
    expect(fanOut).toHaveBeenCalledOnce()

    trace.length = 0
    appendSignedAgentPost.mockImplementation(() => {
      trace.push('log.append')
      throw new Error('injected durable append failure')
    })
    await expect(
      runtime.appendSignedAgentPost({ signedPost: fixture.signedPost, now: 1_003 })
    ).rejects.toThrow('injected durable append failure')
    expect(trace).toEqual(['log.append'])
    expect(fanOut).toHaveBeenCalledOnce()
    expect(afterDurableCommit).not.toHaveBeenCalled()
    runtime.dispose()
  })

  it('fences new work immediately, drains the durable queue, then closes every room', async () => {
    const root = directory()
    const store = new ChannelStore(join(root, 'channels.json'))
    const log = new ChannelMessageLog(join(root, 'logs'), store)
    let now = 1_000
    let releaseDurableCommit!: () => void
    let durableCommitReached!: () => void
    const durableCommit = new Promise<void>((resolve) => {
      durableCommitReached = resolve
    })
    const durableCommitGate = new Promise<void>((resolve) => {
      releaseDurableCommit = resolve
    })
    const runtime = new ChannelRuntime({
      identityKeyPair: generateIdentityKeyPair(),
      store,
      log,
      now: () => now,
      afterDurableCommit: async () => {
        durableCommitReached()
        await durableCommitGate
      }
    })
    const transport = new RecordingTransport()
    runtime.attachTransport(transport)
    const created = runtime.createChannel({
      chatId: 'chat-quiesce',
      title: 'Quiesce proof',
      ownerDisplayName: 'Host'
    })
    const invite = runtime.createInvite({
      channelId: created.channel.channelId,
      now,
      ttlMs: 1_000
    })
    const accepted = runtime.appendHost(created.channel.channelId, {
      clientMessageId: 'before-quiesce',
      content: 'durable before erasure'
    })
    await durableCommit
    now = 3_000

    const quiescing = runtime.quiesceChannel(created.channel.channelId)
    expect(runtime.listRoomBindings()).toEqual([])
    expect(() => runtime.createInvite({ channelId: created.channel.channelId })).toThrowError(
      expect.objectContaining({ code: 'channel_closed' })
    )
    expect(() =>
      runtime.appendHost(created.channel.channelId, {
        clientMessageId: 'after-quiesce',
        content: 'must fail'
      })
    ).toThrowError(expect.objectContaining({ code: 'channel_closed' }))
    expect(transport.closed).toEqual([])

    releaseDurableCommit()
    await expect(accepted).resolves.toMatchObject({ record: { sequence: 1 } })
    await expect(quiescing).resolves.toBeUndefined()
    expect(transport.closed).toEqual([invite.invite.roomId])
    expect(log.highWaterSequence(created.channel.channelId)).toBe(1)
    runtime.dispose()
  })
})

describe('ChannelRuntime memberPresence', () => {
  function harness(now: () => number) {
    const root = directory()
    const store = new ChannelStore(join(root, 'channels.json'))
    const log = new ChannelMessageLog(join(root, 'logs'), store)
    const runtime = new ChannelRuntime({
      identityKeyPair: generateIdentityKeyPair(),
      store,
      log,
      now
    })
    return { root, store, log, runtime }
  }

  function presenceInternals(runtime: ChannelRuntime): {
    observeMemberPresence(channelId: string, memberId: string, now?: number): void
    noteMemberTransportClose(channelId: string, memberId: string, now?: number): void
    expireMemberPresence(channelId: string, memberId: string, now?: number): void
    handleSessionTransportFailure(session: {
      channelId: string
      memberId: string
      sessionId: string
      live: boolean
    }): void
    handleSessionTrustFailure(session: {
      channelId: string
      memberId: string
      sessionId: string
    }): void
  } {
    return runtime as unknown as {
      observeMemberPresence(channelId: string, memberId: string, now?: number): void
      noteMemberTransportClose(channelId: string, memberId: string, now?: number): void
      expireMemberPresence(channelId: string, memberId: string, now?: number): void
      handleSessionTransportFailure(session: {
        channelId: string
        memberId: string
        sessionId: string
        live: boolean
      }): void
      handleSessionTrustFailure(session: {
        channelId: string
        memberId: string
        sessionId: string
      }): void
    }
  }

  it('blocks an unknown channel by default — never optimistically ready', () => {
    const now = () => 1_000
    const { runtime } = harness(now)
    expect(runtime.channelAuthorityState('never-seen-channel')).toBe('recovery_blocked')
    expect(runtime.memberPresence('never-seen-channel', 'member-a')).toBe('recovery_blocked')
    runtime.setChannelAuthorityState('never-seen-channel', 'ready')
    expect(runtime.channelAuthorityState('never-seen-channel')).toBe('ready')
    expect(runtime.memberPresence('never-seen-channel', 'member-a')).toBe('unknown')
    runtime.dispose()
  })

  it('blocks presence on a recovery_blocked channel even when a member was live', () => {
    let now = 1_000
    const { runtime } = harness(() => now)
    const created = runtime.createChannel({
      chatId: 'chat-channel-blocked',
      title: 'Channel blocked',
      ownerDisplayName: 'Host'
    })
    presenceInternals(runtime).observeMemberPresence(created.channel.channelId, 'member-a', now)
    expect(runtime.memberPresence(created.channel.channelId, 'member-a')).toBe('live')
    runtime.setChannelAuthorityState(created.channel.channelId, 'recovery_blocked')
    expect(runtime.memberPresence(created.channel.channelId, 'member-a')).toBe('recovery_blocked')
    runtime.setChannelAuthorityState(created.channel.channelId, 'ready')
    expect(runtime.memberPresence(created.channel.channelId, 'member-a')).toBe('live')
    runtime.dispose()
  })

  it('restarts blocked until the service certifies the channel, then unknown', () => {
    let now = 1_000
    const { store, log, runtime } = harness(() => now)
    const created = runtime.createChannel({
      chatId: 'chat-restart',
      title: 'Restart',
      ownerDisplayName: 'Host'
    })
    presenceInternals(runtime).observeMemberPresence(created.channel.channelId, 'member-a', now)
    expect(runtime.memberPresence(created.channel.channelId, 'member-a')).toBe('live')
    runtime.dispose()

    const restarted = new ChannelRuntime({
      identityKeyPair: generateIdentityKeyPair(),
      store,
      log,
      now: () => now
    })
    // Presence and recovery state are both in-memory: a restarted runtime has
    // neither, so the channel is blocked until startup recovery certifies it.
    expect(restarted.memberPresence(created.channel.channelId, 'member-a')).toBe('recovery_blocked')
    restarted.setChannelAuthorityState(created.channel.channelId, 'ready')
    expect(restarted.memberPresence(created.channel.channelId, 'member-a')).toBe('unknown')
    restarted.dispose()
  })

  it('keeps a disconnected member present through the grace window, then expires', () => {
    let now = 1_000
    const { runtime } = harness(() => now)
    const created = runtime.createChannel({
      chatId: 'chat-grace',
      title: 'Grace',
      ownerDisplayName: 'Host'
    })
    const internals = presenceInternals(runtime)
    internals.observeMemberPresence(created.channel.channelId, 'member-a', now)
    expect(runtime.memberPresence(created.channel.channelId, 'member-a')).toBe('live')
    internals.noteMemberTransportClose(created.channel.channelId, 'member-a', now)
    expect(runtime.memberPresence(created.channel.channelId, 'member-a')).toBe('grace')
    now += 89_999
    expect(runtime.memberPresence(created.channel.channelId, 'member-a')).toBe('grace')
    now += 1
    expect(runtime.memberPresence(created.channel.channelId, 'member-a')).toBe('expired')
    runtime.dispose()
  })

  it('closes the grace window on reconnect', () => {
    let now = 1_000
    const { runtime } = harness(() => now)
    const created = runtime.createChannel({
      chatId: 'chat-reconnect',
      title: 'Reconnect',
      ownerDisplayName: 'Host'
    })
    const internals = presenceInternals(runtime)
    internals.observeMemberPresence(created.channel.channelId, 'member-a', now)
    internals.noteMemberTransportClose(created.channel.channelId, 'member-a', now)
    expect(runtime.memberPresence(created.channel.channelId, 'member-a')).toBe('grace')
    internals.observeMemberPresence(created.channel.channelId, 'member-a', now + 10_000)
    expect(runtime.memberPresence(created.channel.channelId, 'member-a')).toBe('live')
    runtime.dispose()
  })

  it('expires immediately on revoke and a validated new admission returns live', () => {
    let now = 1_000
    const { runtime } = harness(() => now)
    const created = runtime.createChannel({
      chatId: 'chat-revoke',
      title: 'Revoke',
      ownerDisplayName: 'Host'
    })
    const internals = presenceInternals(runtime)
    internals.observeMemberPresence(created.channel.channelId, 'member-a', now)
    internals.expireMemberPresence(created.channel.channelId, 'member-a', now)
    expect(runtime.memberPresence(created.channel.channelId, 'member-a')).toBe('expired')
    // A revoked member cannot reach observeMemberPresence in production:
    // ChannelStore.validateMemberSession throws before confirmHandshake. A
    // re-admitted member on a new invite does reach it, and must be live.
    internals.observeMemberPresence(created.channel.channelId, 'member-a', now + 1_000)
    expect(runtime.memberPresence(created.channel.channelId, 'member-a')).toBe('live')
    runtime.dispose()
  })

  it('refuses presence while the channel is quiescing', async () => {
    let now = 1_000
    const { runtime } = harness(() => now)
    const created = runtime.createChannel({
      chatId: 'chat-quiesce-presence',
      title: 'Quiesce',
      ownerDisplayName: 'Host'
    })
    presenceInternals(runtime).observeMemberPresence(created.channel.channelId, 'member-a', now)
    expect(runtime.memberPresence(created.channel.channelId, 'member-a')).toBe('live')
    const quiescing = runtime.quiesceChannel(created.channel.channelId)
    expect(runtime.memberPresence(created.channel.channelId, 'member-a')).toBe('recovery_blocked')
    await expect(quiescing).resolves.toBeUndefined()
    expect(runtime.memberPresence(created.channel.channelId, 'member-a')).toBe('recovery_blocked')
    runtime.dispose()
  })

  it('refuses presence after dispose', () => {
    let now = 1_000
    const { runtime } = harness(() => now)
    const created = runtime.createChannel({
      chatId: 'chat-dispose',
      title: 'Dispose',
      ownerDisplayName: 'Host'
    })
    presenceInternals(runtime).observeMemberPresence(created.channel.channelId, 'member-a', now)
    runtime.dispose()
    expect(runtime.memberPresence(created.channel.channelId, 'member-a')).toBe('recovery_blocked')
  })

  it('returns to live on a valid new-session reconnect after grace has elapsed', () => {
    let now = 1_000
    const { runtime } = harness(() => now)
    const created = runtime.createChannel({
      chatId: 'chat-reconnect-after-expiry',
      title: 'Reconnect after expiry',
      ownerDisplayName: 'Host'
    })
    const internals = presenceInternals(runtime)
    internals.observeMemberPresence(created.channel.channelId, 'member-a', now)
    internals.noteMemberTransportClose(created.channel.channelId, 'member-a', now)
    now += 90_000
    expect(runtime.memberPresence(created.channel.channelId, 'member-a')).toBe('expired')
    internals.observeMemberPresence(created.channel.channelId, 'member-a', now)
    expect(runtime.memberPresence(created.channel.channelId, 'member-a')).toBe('live')
    runtime.dispose()
  })

  it('classifies a transient session loss as grace, not expiry', () => {
    let now = 1_000
    const { runtime } = harness(() => now)
    const created = runtime.createChannel({
      chatId: 'chat-transport-failure',
      title: 'Transport failure',
      ownerDisplayName: 'Host'
    })
    const internals = presenceInternals(runtime)
    internals.observeMemberPresence(created.channel.channelId, 'member-a', now)
    internals.handleSessionTransportFailure({
      channelId: created.channel.channelId,
      memberId: 'member-a',
      sessionId: 'session-1',
      live: true
    })
    expect(runtime.memberPresence(created.channel.channelId, 'member-a')).toBe('grace')
    runtime.dispose()
  })

  it('classifies a trust-bearing session failure as immediate expiry', () => {
    let now = 1_000
    const { runtime } = harness(() => now)
    const created = runtime.createChannel({
      chatId: 'chat-trust-failure',
      title: 'Trust failure',
      ownerDisplayName: 'Host'
    })
    const internals = presenceInternals(runtime)
    internals.observeMemberPresence(created.channel.channelId, 'member-a', now)
    internals.handleSessionTrustFailure({
      channelId: created.channel.channelId,
      memberId: 'member-a',
      sessionId: 'session-1'
    })
    expect(runtime.memberPresence(created.channel.channelId, 'member-a')).toBe('expired')
    runtime.dispose()
  })
})
