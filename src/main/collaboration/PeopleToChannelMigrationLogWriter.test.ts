import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ChannelMessageLog,
  type ChannelMessage,
  type ChannelMessageLogMigrationMutation
} from './ChannelMessageLog'
import { ChannelError, ChannelStore, type Channel, type ChannelMember } from './ChannelStore'
import {
  PEOPLE_TO_CHANNEL_HISTORY_MATERIALIZATION_VERSION,
  type PeopleToChannelMigrationHistoryMaterialization
} from './PeopleToChannelMigrationHistory'
import { PeopleToChannelMigrationLogWriter } from './PeopleToChannelMigrationLogWriter'

const temporaryPaths: string[] = []

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'taskwraith-channels-p4-log-'))
  temporaryPaths.push(path)
  return path
}

afterEach(() => {
  while (temporaryPaths.length) rmSync(temporaryPaths.pop()!, { recursive: true, force: true })
})

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => [key, canonicalize(entry)])
  )
}

function historyEnvelope(
  mutations: readonly ChannelMessageLogMigrationMutation[]
): PeopleToChannelMigrationHistoryMaterialization {
  const withoutDigest: Omit<PeopleToChannelMigrationHistoryMaterialization, 'executionDigest'> = {
    schemaVersion: PEOPLE_TO_CHANNEL_HISTORY_MATERIALIZATION_VERSION,
    planId: 'a'.repeat(64),
    sourceDigest: 'b'.repeat(64),
    baseMaterializationDigest: 'c'.repeat(64),
    migrationAt: 200,
    metadataMutations: mutations.map((mutation) => ({
      mode: 'create',
      beforeDigest: null,
      channel: clone(mutation.channel),
      members: mutation.members.map(clone),
      invites: []
    })),
    logMutations: mutations.map((mutation) => ({
      channelId: mutation.channel.channelId,
      beforeDigest: mutation.beforeDigest,
      desiredDigest: mutation.desiredDigest,
      messages: mutation.messages.map(clone),
      importedCount: mutation.importedCount
    })),
    importedContributionCount: mutations.reduce(
      (count, mutation) => count + mutation.importedCount,
      0
    )
  }
  return {
    ...withoutDigest,
    executionDigest: sha256(JSON.stringify(canonicalize(withoutDigest)))
  }
}

function resealHistory(
  history: PeopleToChannelMigrationHistoryMaterialization
): PeopleToChannelMigrationHistoryMaterialization {
  const { executionDigest: _executionDigest, ...withoutDigest } = history
  return {
    ...withoutDigest,
    executionDigest: sha256(JSON.stringify(canonicalize(withoutDigest)))
  }
}

function expectRecoveryBlocked(action: () => unknown): void {
  expect(action).toThrowError(ChannelError)
  try {
    action()
  } catch (error) {
    expect(error).toMatchObject({ code: 'recovery_blocked' })
  }
}

function migrationTarget(channelId: string): ChannelMessageLogMigrationMutation {
  const owner: ChannelMember = {
    memberId: `${channelId}_owner`,
    channelId,
    kind: 'human',
    displayName: 'Host',
    identityPublicKey: `${channelId}_host_key`,
    status: 'active',
    joinedAt: 100
  }
  const collaborator: ChannelMember = {
    memberId: `${channelId}_member`,
    channelId,
    kind: 'human',
    displayName: 'Person',
    identityPublicKey: `${channelId}_member_key`,
    status: 'active',
    roomId: `${channelId}_room`,
    joinedAt: 120
  }
  const content = `migrated history for ${channelId}`
  const message: ChannelMessage = {
    channelId,
    sequence: 1,
    messageId: `migration_${sha256(`${channelId}:message`).slice(0, 40)}`,
    authorMemberId: collaborator.memberId,
    clientMessageId: `migration_${sha256(`${channelId}:client`)}`,
    kind: 'human.text',
    content,
    acceptedAt: 150,
    contentHash: sha256(content)
  }
  const channel: Channel = {
    channelId,
    chatId: `${channelId}_chat`,
    ownerMemberId: owner.memberId,
    status: 'active',
    createdAt: 100,
    updatedAt: 200,
    membershipRevision: 2,
    messageCount: 1,
    reference: { kind: 'chat', id: `${channelId}_chat` },
    display: {
      title: 'Migrated Channel',
      status: 'active',
      memberCount: 2,
      messageCount: 1
    }
  }
  return {
    channel,
    members: [owner, collaborator],
    beforeDigest: sha256('[]'),
    desiredDigest: sha256(JSON.stringify([message])),
    messages: [message],
    importedCount: 1
  }
}

function mergeFixture() {
  const directory = temporaryDirectory()
  const logs = join(directory, 'logs')
  const store = new ChannelStore(join(directory, 'channels.json'))
  const { channel, owner } = store.createChannel({
    chatId: 'existing_chat',
    owner: { displayName: 'Host', identityPublicKey: 'host_key' },
    title: 'Existing Channel',
    now: 100
  })
  const collaborator = store.admitMember({
    channelId: channel.channelId,
    displayName: 'Person',
    identityPublicKey: 'person_key',
    roomId: 'person_room',
    now: 150
  })
  const log = new ChannelMessageLog(logs, store)
  log.append({
    channelId: channel.channelId,
    principalMemberId: owner.memberId,
    identityPublicKey: owner.identityPublicKey,
    clientMessageId: 'existing_client',
    content: 'existing prefix',
    now: 200
  })
  const prefix = log.replay({ channelId: channel.channelId, resumeAfter: 0 }).records
  const importedContent = 'historical People contribution'
  const imported: ChannelMessage = {
    channelId: channel.channelId,
    sequence: 2,
    messageId: `migration_${'a'.repeat(40)}`,
    authorMemberId: collaborator.memberId,
    clientMessageId: `migration_${'b'.repeat(64)}`,
    kind: 'human.text',
    content: importedContent,
    acceptedAt: 180,
    contentHash: sha256(importedContent)
  }
  const desired = [...prefix, imported]
  const currentChannel = store.getChannel(channel.channelId)!
  const mutation: ChannelMessageLogMigrationMutation = {
    channel: {
      ...currentChannel,
      updatedAt: 300,
      messageCount: desired.length,
      display: { ...currentChannel.display, messageCount: desired.length }
    },
    members: store.listMembers(channel.channelId),
    beforeDigest: sha256(JSON.stringify(prefix)),
    desiredDigest: sha256(JSON.stringify(desired)),
    messages: desired,
    importedCount: 1
  }
  return {
    directory,
    logs,
    store,
    log,
    channel,
    owner,
    mutation,
    path: join(logs, `${channel.channelId}.jsonl`)
  }
}

function rewriteStoredRecord(
  path: string,
  mutate: (record: Record<string, unknown>) => void
): void {
  const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  mutate(record)
  const { checksum: _checksum, ...withoutChecksum } = record
  record.checksum = sha256(JSON.stringify(withoutChecksum))
  writeFileSync(path, `${JSON.stringify(record)}\n`, 'utf8')
}

describe('People-to-Channel migration log writer', () => {
  it('writes a new Channel atomically, leaves metadata behind, and reruns without a write', () => {
    const directory = temporaryDirectory()
    const logs = join(directory, 'logs')
    const store = new ChannelStore(join(directory, 'channels.json'))
    const log = new ChannelMessageLog(logs, store)
    const writer = new PeopleToChannelMigrationLogWriter(log)
    const mutation = migrationTarget('channel_new')
    const history = historyEnvelope([mutation])

    expect(writer.apply(history)).toEqual({
      writtenChannelIds: ['channel_new'],
      alreadyAppliedChannelIds: []
    })
    expect(store.getChannel('channel_new')).toBeNull()
    const path = join(logs, 'channel_new.jsonl')
    const source = readFileSync(path, 'utf8')
    expect(source.endsWith('\n')).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(logs).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
    const stored = JSON.parse(source) as Record<string, unknown>
    const { checksum, ...withoutChecksum } = stored
    expect(checksum).toBe(sha256(JSON.stringify(withoutChecksum)))

    expect(writer.apply(history)).toEqual({
      writtenChannelIds: [],
      alreadyAppliedChannelIds: ['channel_new']
    })
    expect(readFileSync(path, 'utf8')).toBe(source)

    store.applyMigrationBatch([
      {
        mode: 'create',
        beforeDigest: null,
        channel: clone(mutation.channel),
        members: mutation.members.map(clone),
        invites: []
      }
    ])
    expect(log.replay({ channelId: 'channel_new', resumeAfter: 0 })).toEqual({
      records: mutation.messages,
      highWaterSequence: 1
    })
  })

  it('preserves every raw prefix byte while appending migrated records', () => {
    const fixture = mergeFixture()
    const before = readFileSync(fixture.path, 'utf8')

    expect(fixture.log.applyMigrationBatch([fixture.mutation])).toEqual({
      writtenChannelIds: [fixture.channel.channelId],
      alreadyAppliedChannelIds: []
    })
    const after = readFileSync(fixture.path, 'utf8')
    expect(after.startsWith(before)).toBe(true)
    expect(after.slice(0, before.length)).toBe(before)
    expect(after.trim().split('\n')).toHaveLength(2)
    expect(fixture.store.getChannel(fixture.channel.channelId)?.messageCount).toBe(1)
  })

  it('binds the writer to the exact history execution and metadata target', () => {
    const directory = temporaryDirectory()
    const writer = new PeopleToChannelMigrationLogWriter(
      new ChannelMessageLog(
        join(directory, 'logs'),
        new ChannelStore(join(directory, 'channels.json'))
      )
    )
    const history = historyEnvelope([migrationTarget('channel_bound')])
    const staleDigest = clone(history)
    staleDigest.executionDigest = 'd'.repeat(64)
    expectRecoveryBlocked(() => writer.apply(staleDigest))

    const mismatchedTarget = clone(history)
    mismatchedTarget.metadataMutations[0].channel.channelId = 'channel_other'
    expectRecoveryBlocked(() => writer.apply(resealHistory(mismatchedTarget)))
    expect(existsSync(join(directory, 'logs'))).toBe(false)
  })

  it('resumes a multi-Channel batch after one file is durable', () => {
    const directory = temporaryDirectory()
    const logs = join(directory, 'logs')
    const store = new ChannelStore(join(directory, 'channels.json'))
    const writer = new ChannelMessageLog(logs, store)
    const first = migrationTarget('channel_a')
    const second = migrationTarget('channel_b')
    mkdirSync(join(logs, 'channel_b.jsonl'), { recursive: true })

    expectRecoveryBlocked(() => writer.applyMigrationBatch([second, first]))
    expect(existsSync(join(logs, 'channel_a.jsonl'))).toBe(true)
    expect(statSync(join(logs, 'channel_b.jsonl')).isDirectory()).toBe(true)

    rmSync(join(logs, 'channel_b.jsonl'), { recursive: true })
    expect(writer.applyMigrationBatch([second, first])).toEqual({
      writtenChannelIds: ['channel_b'],
      alreadyAppliedChannelIds: ['channel_a']
    })
    expect(readdirSync(logs).sort()).toEqual(['channel_a.jsonl', 'channel_b.jsonl'])
  })

  it('blocks a concurrent prefix change and leaves every byte untouched', () => {
    const fixture = mergeFixture()
    fixture.log.append({
      channelId: fixture.channel.channelId,
      principalMemberId: fixture.owner.memberId,
      identityPublicKey: fixture.owner.identityPublicKey,
      clientMessageId: 'concurrent_client',
      content: 'concurrent Channel history',
      now: 250
    })
    const before = readFileSync(fixture.path, 'utf8')

    expectRecoveryBlocked(() => fixture.log.applyMigrationBatch([fixture.mutation]))
    expect(readFileSync(fixture.path, 'utf8')).toBe(before)
    expect(readdirSync(fixture.logs).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
  })

  it('rejects a tampered digest, unredacted content, and invalid historical membership', () => {
    const directory = temporaryDirectory()
    const writer = new ChannelMessageLog(
      join(directory, 'logs'),
      new ChannelStore(join(directory, 'channels.json'))
    )
    const digestTamper = migrationTarget('channel_digest')
    digestTamper.desiredDigest = 'f'.repeat(64)
    expectRecoveryBlocked(() => writer.applyMigrationBatch([digestTamper]))

    const unredacted = migrationTarget('channel_unredacted')
    const unredactedMessage = unredacted.messages[0]
    unredactedMessage.content = 'token=private-secret-value'
    unredactedMessage.contentHash = sha256(unredactedMessage.content)
    unredacted.desiredDigest = sha256(JSON.stringify(unredacted.messages))
    expectRecoveryBlocked(() => writer.applyMigrationBatch([unredacted]))

    const revoked = migrationTarget('channel_revoked')
    const author = revoked.members.find(
      (member) => member.memberId === revoked.messages[0].authorMemberId
    )!
    author.status = 'revoked'
    author.revokedAt = revoked.messages[0].acceptedAt
    expectRecoveryBlocked(() => writer.applyMigrationBatch([revoked]))
    expect(existsSync(join(directory, 'logs'))).toBe(false)
  })

  it('normal restart validation retains pre-revocation human history and blocks forged timing', () => {
    const fixture = mergeFixture()
    const member = fixture.store
      .listMembers(fixture.channel.channelId)
      .find((candidate) => candidate.memberId !== fixture.owner.memberId)!
    fixture.log.append({
      channelId: fixture.channel.channelId,
      principalMemberId: member.memberId,
      identityPublicKey: member.identityPublicKey,
      roomId: member.roomId,
      clientMessageId: 'member_history',
      content: 'valid before revocation',
      now: 350
    })
    fixture.store.revokeMember({
      channelId: fixture.channel.channelId,
      memberId: member.memberId,
      now: 400
    })
    const restarted = new ChannelMessageLog(
      fixture.logs,
      new ChannelStore(join(fixture.directory, 'channels.json'))
    )
    expect(restarted.highWaterSequence(fixture.channel.channelId)).toBe(2)

    const lines = readFileSync(fixture.path, 'utf8').trim().split('\n')
    const forged = JSON.parse(lines[1]) as Record<string, unknown>
    forged.acceptedAt = 400
    const { checksum: _checksum, ...withoutChecksum } = forged
    forged.checksum = sha256(JSON.stringify(withoutChecksum))
    writeFileSync(fixture.path, `${lines[0]}\n${JSON.stringify(forged)}\n`, 'utf8')
    const blocked = new ChannelMessageLog(
      fixture.logs,
      new ChannelStore(join(fixture.directory, 'channels.json'))
    )
    expectRecoveryBlocked(() => blocked.highWaterSequence(fixture.channel.channelId))
  })

  it('normal restart validation blocks unredacted human bytes even with fresh hashes', () => {
    const fixture = mergeFixture()
    rewriteStoredRecord(fixture.path, (record) => {
      record.content = 'token=private-secret-value'
      record.contentHash = sha256(record.content as string)
    })

    const restarted = new ChannelMessageLog(
      fixture.logs,
      new ChannelStore(join(fixture.directory, 'channels.json'))
    )
    expectRecoveryBlocked(() => restarted.highWaterSequence(fixture.channel.channelId))
  })
})
