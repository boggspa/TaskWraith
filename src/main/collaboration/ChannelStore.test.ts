import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ChannelError,
  ChannelStore,
  MAX_CHANNEL_MEMBERS,
  type TaskWraithReference
} from './ChannelStore'
import { ChannelMessageLog } from './ChannelMessageLog'

const temporaryPaths: string[] = []

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'taskwraith-channels-p1-'))
  temporaryPaths.push(path)
  return path
}

afterEach(() => {
  while (temporaryPaths.length) rmSync(temporaryPaths.pop()!, { recursive: true, force: true })
})

function channelFixture() {
  const directory = temporaryDirectory()
  const storePath = join(directory, 'channels.json')
  const store = new ChannelStore(storePath)
  const created = store.createChannel({
    chatId: 'general-chat',
    owner: { displayName: 'Host', identityPublicKey: 'ed25519:host' },
    title: 'Launch room',
    reference: { kind: 'chat', id: 'general-chat' },
    now: 1_000
  })
  const log = new ChannelMessageLog(join(directory, 'logs'), store)
  return { directory, storePath, store, log, ...created }
}

function expectCode(action: () => unknown, code: ChannelError['code']) {
  expect(action).toThrowError(ChannelError)
  try {
    action()
  } catch (error) {
    expect(error).toMatchObject({ code })
  }
}

describe('ChannelStore', () => {
  it('persists human-only metadata and its immutable display envelope', () => {
    const { store, storePath, channel, owner } = channelFixture()
    const invited = store.admitMember({
      channelId: channel.channelId,
      displayName: 'Member B',
      identityPublicKey: 'ed25519:b',
      roomId: 'room-b',
      now: 2_000
    })

    const reloaded = new ChannelStore(storePath)
    expect(reloaded.getChannel(channel.channelId)).toMatchObject({
      chatId: 'general-chat',
      ownerMemberId: owner.memberId,
      membershipRevision: 2
    })
    expect(reloaded.getMember(channel.channelId, invited.memberId)).toMatchObject({
      kind: 'human',
      identityPublicKey: 'ed25519:b',
      roomId: 'room-b',
      status: 'active'
    })
    expect(reloaded.getDisplayEnvelope(channel.channelId)).toEqual({
      title: 'Launch room',
      status: 'active',
      memberCount: 2,
      messageCount: 0
    })
  })

  it('enforces the eight-person ceiling, pins identities, and scopes revocation', () => {
    const { store, channel } = channelFixture()
    const members = Array.from({ length: MAX_CHANNEL_MEMBERS - 1 }, (_, index) =>
      store.admitMember({
        channelId: channel.channelId,
        displayName: `Member ${index}`,
        identityPublicKey: `ed25519:${index}`,
        roomId: `room-${index}`,
        now: 2_000 + index
      })
    )
    expect(
      store.listMembers(channel.channelId).filter((member) => member.status === 'active')
    ).toHaveLength(MAX_CHANNEL_MEMBERS)

    expectCode(
      () =>
        store.admitMember({
          channelId: channel.channelId,
          displayName: 'Ninth',
          identityPublicKey: 'ed25519:ninth',
          roomId: 'room-ninth'
        }),
      'quota_exceeded'
    )
    expect(
      store.admitMember({
        channelId: channel.channelId,
        displayName: 'Different display name is ignored on reconnect',
        identityPublicKey: 'ed25519:0',
        roomId: 'other-room'
      })
    ).toEqual(members[0])

    store.revokeMember({ channelId: channel.channelId, memberId: members[0]!.memberId, now: 9_000 })
    expect(store.getMember(channel.channelId, members[1]!.memberId)?.status).toBe('active')
    expectCode(
      () =>
        store.admitMember({
          channelId: channel.channelId,
          displayName: 'Rejoin',
          identityPublicKey: 'ed25519:0',
          roomId: 'fresh-room'
        }),
      'revoked'
    )
  })

  it('binds a session to its pinned identity and room without an inbound author field', () => {
    const { store, channel, owner } = channelFixture()
    const member = store.admitMember({
      channelId: channel.channelId,
      displayName: 'Member B',
      identityPublicKey: 'ed25519:b',
      roomId: 'room-b'
    })

    expect(
      store.validateMemberSession({
        channelId: channel.channelId,
        memberId: member.memberId,
        identityPublicKey: 'ed25519:b',
        roomId: 'room-b'
      })
    ).toMatchObject({ memberId: member.memberId })
    expectCode(
      () =>
        store.validateMemberSession({
          channelId: channel.channelId,
          memberId: member.memberId,
          identityPublicKey: 'ed25519:wrong',
          roomId: 'room-b'
        }),
      'identity_mismatch'
    )
    expectCode(
      () =>
        store.validateMemberSession({
          channelId: channel.channelId,
          memberId: owner.memberId,
          identityPublicKey: 'ed25519:host',
          roomId: 'invented-room'
        }),
      'identity_mismatch'
    )
  })

  it('keeps the display envelope when its TaskWraith reference is unavailable', () => {
    const { store, channel } = channelFixture()
    const unavailable = store.resolveReference(channel.channelId, () => undefined)
    expect(unavailable).toMatchObject({
      state: 'referent unavailable',
      reference: { kind: 'chat', id: 'general-chat' },
      display: { title: 'Launch room', status: 'active', memberCount: 1, messageCount: 0 }
    })

    const available = store.resolveReference(channel.channelId, (reference) => ({
      reference: reference as TaskWraithReference,
      redacted: true
    }))
    expect(available).toMatchObject({ state: 'available', value: { redacted: true } })
  })
})

describe('ChannelMessageLog', () => {
  it('durably sequences host-owned human text and retains idempotency after restart', () => {
    const { directory, storePath, channel, owner, log } = channelFixture()
    const first = log.append({
      channelId: channel.channelId,
      principalMemberId: owner.memberId,
      identityPublicKey: 'ed25519:host',
      clientMessageId: 'first',
      content: 'hello'
    })
    expect(first).toMatchObject({ sequence: 1, authorMemberId: owner.memberId, kind: 'human.text' })

    const restartedStore = new ChannelStore(storePath)
    const restartedLog = new ChannelMessageLog(join(directory, 'logs'), restartedStore)
    expect(
      restartedLog.append({
        channelId: channel.channelId,
        principalMemberId: owner.memberId,
        identityPublicKey: 'ed25519:host',
        clientMessageId: 'first',
        content: 'hello'
      })
    ).toEqual(first)
    expectCode(
      () =>
        restartedLog.append({
          channelId: channel.channelId,
          principalMemberId: owner.memberId,
          identityPublicKey: 'ed25519:host',
          clientMessageId: 'first',
          content: 'changed'
        }),
      'idempotency_conflict'
    )
  })

  it('replays bounded, gapless records and rejects cursors ahead of durable history', () => {
    const { channel, owner, log } = channelFixture()
    for (const clientMessageId of ['one', 'two', 'three']) {
      log.append({
        channelId: channel.channelId,
        principalMemberId: owner.memberId,
        identityPublicKey: 'ed25519:host',
        clientMessageId,
        content: clientMessageId
      })
    }

    const firstBatch = log.replay({ channelId: channel.channelId, resumeAfter: 0, maxRecords: 2 })
    expect(firstBatch.highWaterSequence).toBe(3)
    expect(firstBatch.records.map((record) => record.sequence)).toEqual([1, 2])
    expect(log.replay({ channelId: channel.channelId, resumeAfter: 2 }).records).toHaveLength(1)
    expectCode(() => log.replay({ channelId: channel.channelId, resumeAfter: 4 }), 'invalid_cursor')
  })

  it('discards only a torn final log tail and preserves the complete committed prefix', () => {
    const { directory, channel, owner, log } = channelFixture()
    log.append({
      channelId: channel.channelId,
      principalMemberId: owner.memberId,
      identityPublicKey: 'ed25519:host',
      clientMessageId: 'first',
      content: 'first'
    })
    const path = join(directory, 'logs', `${channel.channelId}.jsonl`)
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"schemaVersion":`, 'utf8')

    const recovered = new ChannelMessageLog(
      join(directory, 'logs'),
      new ChannelStore(join(directory, 'channels.json'))
    )
    expect(recovered.highWaterSequence(channel.channelId)).toBe(1)
    expect(
      recovered.append({
        channelId: channel.channelId,
        principalMemberId: owner.memberId,
        identityPublicKey: 'ed25519:host',
        clientMessageId: 'second',
        content: 'second'
      })
    ).toMatchObject({ sequence: 2 })
  })

  it('structurally rejects agent-shaped messages before persistence', () => {
    const { channel, owner, log } = channelFixture()
    expectCode(
      () =>
        log.append({
          channelId: channel.channelId,
          principalMemberId: owner.memberId,
          identityPublicKey: 'ed25519:host',
          clientMessageId: 'agent-attempt',
          kind: 'agent.text' as never,
          content: 'start a provider'
        }),
      'human_only'
    )
    expect(log.highWaterSequence(channel.channelId)).toBe(0)
  })
})
