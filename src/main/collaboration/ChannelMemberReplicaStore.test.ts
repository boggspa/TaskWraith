import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChannelMessage } from './ChannelMessageLog'
import {
  ChannelMemberReplicaError,
  ChannelMemberReplicaStore,
  channelMemberReplicaPaths
} from './ChannelMemberReplicaStore'

const directories: string[] = []
const hostIdentityPubKeyB64 = Buffer.alloc(32, 7).toString('base64')

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'taskwraith-channel-member-replica-'))
  directories.push(path)
  return path
}

function message(
  channelId: string,
  sequence: number,
  content = `message ${sequence}`
): ChannelMessage {
  return {
    channelId,
    sequence,
    messageId: `message-${sequence}`,
    authorMemberId: sequence % 2 === 0 ? 'member-b' : 'member-a',
    clientMessageId: `client-${sequence}`,
    kind: 'human.text',
    content,
    acceptedAt: 1_000 + sequence,
    contentHash: createHash('sha256').update(content, 'utf8').digest('hex')
  }
}

function activate(
  store: ChannelMemberReplicaStore,
  channelId = 'channel-a',
  overrides: Partial<Parameters<ChannelMemberReplicaStore['activate']>[0]> = {}
) {
  return store.activate({
    channelId,
    hostChatId: `host-chat-${channelId}`,
    memberId: `member-${channelId}`,
    displayName: 'Chris',
    title: `Channel ${channelId}`,
    relayUrls: ['wss://relay.example'],
    roomId: `room-${channelId}`,
    hostIdentityPubKeyB64,
    now: 1_000,
    ...overrides
  })
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('ChannelMemberReplicaStore', () => {
  it('keeps joined memberships outside the hosted-Channel authority tree', () => {
    const paths = channelMemberReplicaPaths('/tmp/taskwraith-user-data')

    expect(paths.root).toBe('/tmp/taskwraith-user-data/channel-memberships')
    expect(paths.identity).toBe('/tmp/taskwraith-user-data/channel-memberships/identity.json')
    expect(paths.memberships).toBe('/tmp/taskwraith-user-data/channel-memberships/memberships.json')
    expect(paths.records).toBe('/tmp/taskwraith-user-data/channel-memberships/records')
  })

  it('durably retains multiple memberships and contiguous deduplicated history', () => {
    const root = directory()
    const store = new ChannelMemberReplicaStore(root)
    activate(store, 'channel-a')
    store.appendRecords('channel-a', [message('channel-a', 1), message('channel-a', 2)])
    activate(store, 'channel-b')
    store.appendRecords('channel-b', [message('channel-b', 1, 'hello B')])
    store.setActive('channel-a')
    store.appendRecords('channel-a', [message('channel-a', 2)])
    const staleTemporary = `${store.dataPaths().memberships}.dead.tmp`
    writeFileSync(staleTemporary, 'stale')

    const restarted = new ChannelMemberReplicaStore(root)
    expect(existsSync(staleTemporary)).toBe(false)
    expect(restarted.readActive()).toMatchObject({
      session: { channelId: 'channel-a', status: 'active' },
      highWaterSequence: 2,
      records: [{ sequence: 1 }, { sequence: 2 }]
    })
    expect(restarted.listSessions().map((session) => session.channelId)).toEqual([
      'channel-a',
      'channel-b'
    ])
    expect(restarted.read('channel-b')).toMatchObject({
      highWaterSequence: 1,
      records: [{ content: 'hello B' }]
    })
  })

  it('pins a Channel id to the first verified host identity', () => {
    const store = new ChannelMemberReplicaStore(directory())
    activate(store)

    expect(() =>
      activate(store, 'channel-a', {
        hostIdentityPubKeyB64: Buffer.alloc(32, 9).toString('base64')
      })
    ).toThrow(/different host identity/i)
  })

  it('persists member revisions, revocation, and readable offline history', () => {
    const root = directory()
    const store = new ChannelMemberReplicaStore(root)
    activate(store)
    store.appendRecords('channel-a', [message('channel-a', 1)])
    store.updateMembers({
      channelId: 'channel-a',
      membershipRevision: 2,
      members: [
        {
          memberId: 'member-a',
          kind: 'human',
          displayName: 'Host',
          status: 'active',
          joinedAt: 900
        }
      ],
      now: 1_100
    })
    store.markRevoked('channel-a', 1_200)

    expect(new ChannelMemberReplicaStore(root).readActive()).toMatchObject({
      session: {
        status: 'revoked',
        membershipRevision: 2,
        members: [{ displayName: 'Host' }]
      },
      highWaterSequence: 1,
      records: [{ content: 'message 1' }]
    })
  })

  it('fails closed on gaps, conflicts, and same-revision membership changes', () => {
    const store = new ChannelMemberReplicaStore(directory())
    activate(store)
    store.appendRecords('channel-a', [message('channel-a', 1)])

    expect(() => store.appendRecords('channel-a', [message('channel-a', 3)])).toThrow(
      /not contiguous/i
    )
    expect(() =>
      store.appendRecords('channel-a', [message('channel-a', 1, 'conflicting content')])
    ).toThrow(/conflicts/i)

    const members = [
      {
        memberId: 'member-a',
        kind: 'human' as const,
        displayName: 'Host',
        status: 'active' as const,
        joinedAt: 900
      }
    ]
    store.updateMembers({ channelId: 'channel-a', membershipRevision: 2, members })
    expect(() =>
      store.updateMembers({
        channelId: 'channel-a',
        membershipRevision: 2,
        members: [{ ...members[0], displayName: 'Changed' }]
      })
    ).toThrow(/revision conflicts/i)
  })

  it('drops only an unsynced torn tail and replays it from the host later', () => {
    const root = directory()
    const store = new ChannelMemberReplicaStore(root)
    activate(store)
    store.appendRecords('channel-a', [message('channel-a', 1)])
    const recordsPath = join(root, 'channel-memberships', 'records', 'channel-a.jsonl')
    appendFileSync(recordsPath, '{"schemaVersion":1,"record":')

    const restarted = new ChannelMemberReplicaStore(root)
    expect(restarted.readActive()).toMatchObject({ highWaterSequence: 1 })
    expect(readFileSync(recordsPath, 'utf8')).toMatch(/\n$/)
    restarted.appendRecords('channel-a', [message('channel-a', 2)])
    expect(restarted.readActive()?.highWaterSequence).toBe(2)
  })

  it('blocks corrupted committed metadata or record bytes', () => {
    const root = directory()
    const store = new ChannelMemberReplicaStore(root)
    activate(store)
    store.appendRecords('channel-a', [message('channel-a', 1)])
    const paths = store.dataPaths()
    const metadata = JSON.parse(readFileSync(paths.memberships, 'utf8')) as {
      sessions: Array<{ displayName: string }>
    }
    metadata.sessions[0].displayName = 'Tampered'
    writeFileSync(paths.memberships, JSON.stringify(metadata))

    expect(() => new ChannelMemberReplicaStore(root).readActive()).toThrow(
      ChannelMemberReplicaError
    )

    const secondRoot = directory()
    const second = new ChannelMemberReplicaStore(secondRoot)
    activate(second)
    second.appendRecords('channel-a', [message('channel-a', 1)])
    const recordPath = join(second.dataPaths().records, 'channel-a.jsonl')
    const committed = readFileSync(recordPath, 'utf8').replace('message 1', 'tampered')
    mkdirSync(second.dataPaths().records, { recursive: true })
    writeFileSync(recordPath, committed)
    expect(() => new ChannelMemberReplicaStore(secondRoot).readActive()).toThrow(
      ChannelMemberReplicaError
    )
  })

  it('can reset only local records or forget one membership without touching identity', () => {
    const root = directory()
    const store = new ChannelMemberReplicaStore(root)
    activate(store, 'channel-a')
    store.appendRecords('channel-a', [message('channel-a', 1)])
    activate(store, 'channel-b')
    writeFileSync(store.dataPaths().identity, 'encrypted identity', { mode: 0o600 })

    expect(store.resetRecords('channel-a').highWaterSequence).toBe(0)
    store.forget('channel-b')
    expect(store.read('channel-b')).toBeNull()
    expect(store.readActive()?.session.channelId).toBe('channel-a')
    expect(readFileSync(store.dataPaths().identity, 'utf8')).toBe('encrypted identity')
  })

  it('can reset a corrupted local record log while retaining pinned membership metadata', () => {
    const root = directory()
    const store = new ChannelMemberReplicaStore(root)
    activate(store)
    store.appendRecords('channel-a', [message('channel-a', 1)])
    const recordPath = join(store.dataPaths().records, 'channel-a.jsonl')
    writeFileSync(recordPath, readFileSync(recordPath, 'utf8').replace('message 1', 'tampered'))

    const restarted = new ChannelMemberReplicaStore(root)
    expect(() => restarted.readActive()).toThrow(ChannelMemberReplicaError)
    expect(restarted.resetRecords('channel-a')).toMatchObject({
      session: { channelId: 'channel-a', hostIdentityPubKeyB64 },
      records: [],
      highWaterSequence: 0
    })
    expect(restarted.readActive()?.highWaterSequence).toBe(0)
  })

  it('can explicitly clear corrupted replicas without replacing the member identity', () => {
    const root = directory()
    const store = new ChannelMemberReplicaStore(root)
    activate(store)
    store.appendRecords('channel-a', [message('channel-a', 1)])
    writeFileSync(store.dataPaths().identity, 'encrypted identity', { mode: 0o600 })
    writeFileSync(store.dataPaths().memberships, '{corrupted')

    const restarted = new ChannelMemberReplicaStore(root)
    expect(() => restarted.readActive()).toThrow(ChannelMemberReplicaError)
    restarted.forgetAll()

    expect(restarted.readActive()).toBeNull()
    expect(readFileSync(store.dataPaths().identity, 'utf8')).toBe('encrypted identity')
    expect(readFileSync(store.dataPaths().memberships, 'utf8')).not.toContain('channel-a')
  })
})
