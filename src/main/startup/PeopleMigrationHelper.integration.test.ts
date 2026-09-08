import { PeopleToChannelMigrationFinalizationProductionRunner } from '../collaboration/PeopleToChannelMigrationFinalizationProductionRunner'
import { purgeColdChannelHistoryDeletion } from '../collaboration/ChannelHistoryDeletionStore'
import { ChannelHumanPolicyStore } from '../collaboration/ChannelHumanPolicyStore'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { exportRawEd25519PublicKey, generateIdentityKeyPair } from '../../shared/e2ee/keys'
import type { ChatRecord } from '../store/types'
import {
  HumanCollaborationIdentityStore,
  type HumanCollaborationSafeStorage
} from '../collaboration/HumanCollaborationIdentityStore'
import { contributionRulesForPreset } from '../collaboration/HumanContributionRules'
import {
  HumanCollaborationStore,
  type PeopleHistoryDeletionScope
} from '../collaboration/HumanCollaborationStore'
import { ChannelMessageLog } from '../collaboration/ChannelMessageLog'
import { ChannelStore } from '../collaboration/ChannelStore'
import { channelProductionDataPaths } from '../collaboration/ChannelProductionService'
import { PeopleToChannelMigrationProductionRunner } from '../collaboration/PeopleToChannelMigrationProductionRunner'
import { PeopleToChannelMigrationRecoveryStore } from '../collaboration/PeopleToChannelMigrationRecoveryStore'
import { withPeopleDonorMutationGate } from '../../host-shared/thread-catalogue/PeopleDonorMutationGate'
import { createPeopleMigrationMutationGuard } from './PeopleMigrationMutationGuard'
import { forwardingPeopleMigrationGate } from './ThreadCataloguePeopleMigration'
import { runPeopleMigrationHelper } from './PeopleMigrationHelperCore'

const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})
const xor = (bytes: Buffer): Buffer => Buffer.from(bytes.map((byte) => byte ^ 0x96))
// This tests the existing native-crypto interface and payload shape, not an OS keychain.
const crypto: HumanCollaborationSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => xor(Buffer.from(value)),
  decryptString: (value) => xor(value).toString('utf8')
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture(count = 1) {
  const profilePath = mkdtempSync(join(tmpdir(), 'people-migration-helper-review-'))
  directories.push(profilePath)
  const identity = new HumanCollaborationIdentityStore(
    join(profilePath, 'human-collaboration-identity.json'),
    crypto
  ).load()
  const participantKey = exportRawEd25519PublicKey(generateIdentityKeyPair().publicKey).toString(
    'base64'
  )
  const source = {
    shares: [
      {
        shareId: 'share_one',
        chatId: 'chat_one',
        mode: 'comments',
        enabled: true,
        createdAt: 100,
        updatedAt: 300,
        nextSequence: count + 1,
        participants: [
          {
            collaboratorId: 'person',
            displayName: 'Person',
            publicKeyId: participantKey,
            status: 'active',
            joinedAt: 150,
            seatOrder: 2,
            colorIndex: 5
          }
        ],
        invites: [
          {
            inviteId: 'consumed',
            tokenHash: 'old_token_hash',
            createdAt: 120,
            expiresAt: 20000,
            consumedAt: 150,
            collaboratorId: 'person',
            roomId: 'room'
          }
        ],
        idempotency: {},
        contributionRules: contributionRulesForPreset('requestHostAction'),
        requiresHostApproval: true,
        fullHistory: true
      }
    ]
  }
  writeFileSync(join(profilePath, 'human-collaboration.json'), JSON.stringify(source), {
    mode: 0o600
  })
  const chat: ChatRecord = {
    appChatId: 'chat_one',
    title: 'Original title',
    provider: 'mistral',
    scope: 'global',
    chatKind: 'single',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    persistenceRevision: 3,
    runs: [],
    messages: Array.from({ length: count }, (_, index) => ({
      id: `legacy_${index}`,
      role: 'system' as const,
      content: 'x'.repeat(5000),
      timestamp: new Date(200).toISOString(),
      metadata: {
        kind: 'humanCollaboratorComment',
        sourceTrust: 'external_untrusted',
        shareId: 'share_one',
        collaboratorId: 'person',
        collaboratorDisplayName: 'Person',
        clientMessageId: `client_${index}`,
        sequence: index + 1
      }
    }))
  }
  mkdirSync(join(profilePath, 'chats'))
  writeFileSync(join(profilePath, 'chats', 'chat_one.json'), JSON.stringify(chat), { mode: 0o600 })
  return { profilePath, identity, chat }
}

describe('People migration helper inventory boundary', () => {
  it('waits for active migration on title, topology and task existence changes while allowing other updates', async () => {
    const f = fixture()
    const done = deferred()
    const active = withPeopleDonorMutationGate(f.profilePath, () => done.promise)
    const guard = createPeopleMigrationMutationGuard(f.profilePath, (id) =>
      id === f.chat.appChatId ? f.chat : null
    )
    try {
      expect(guard.beforeSaveChat({ ...f.chat, title: 'Renamed' })).toBeInstanceOf(Promise)
      expect(
        guard.beforeSaveChat({ ...f.chat, parentChatId: 'parent', parentChatRelation: 'subThread' })
      ).toBeInstanceOf(Promise)
      expect(
        guard.beforeSaveChat({ ...f.chat, appChatId: 'new_chat', messages: [] })
      ).toBeInstanceOf(Promise)
      expect(guard.beforeSaveChat({ ...f.chat, pinned: true })).toBeUndefined()
      expect(
        guard.beforeSaveChat({
          ...f.chat,
          runs: [{ runId: 'new_run', status: 'running', startedAt: new Date(300).toISOString() }]
        })
      ).toBeUndefined()
      expect(
        guard.beforeSaveChat({
          ...f.chat,
          messages: [
            ...f.chat.messages,
            {
              id: 'stream',
              role: 'assistant',
              content: 'Ordinary stream',
              timestamp: new Date(400).toISOString()
            }
          ]
        })
      ).toBeUndefined()
    } finally {
      done.resolve()
      await active
    }
    expect(guard.beforeSaveChat({ ...f.chat, title: 'Renamed after handoff' })).toBeUndefined()
  })

  it.each(['rename', 'new-chat'] as const)(
    'documents inherited orphan-checkpoint rejection after later %s source drift',
    (change) => {
      const f = fixture()
      let chats = [f.chat]
      const runner = (crash: boolean) =>
        new PeopleToChannelMigrationProductionRunner({
          userDataPath: f.profilePath,
          safeStorage: crypto,
          loadIdentity: () => f.identity,
          hostDisplayName: 'Test Host',
          listChats: () => chats,
          now: () => 1000,
          afterStage: (stage) => {
            if (crash && stage === 'execution_durable')
              throw new Error('injected execution-before-intent crash')
          }
        })
      expect(() => runner(true).runToSoak()).toThrow('injected execution-before-intent crash')
      const recovery = new PeopleToChannelMigrationRecoveryStore({ userDataPath: f.profilePath })
      expect(recovery.load()).toBeNull()
      chats =
        change === 'rename'
          ? [{ ...f.chat, title: 'Later rename' }]
          : [f.chat, { ...f.chat, appChatId: 'new_chat', title: 'Later new chat', messages: [] }]
      expect(() => runner(false).runToSoak()).toThrow(/source changed after the orphan execution/)
      // The helper guard restores serialization while running; it should not
      // weaken this inherited immutable-checkpoint comparison after failure.
      expect(recovery.load()).toBeNull()
      expect(
        new ChannelStore(channelProductionDataPaths(f.profilePath).metadata).listChannels()
      ).toEqual([])
    }
  )

  it.each([64, 500])(
    'migrates %i valid 5KiB donors through the helper and returns no transcript bodies',
    (count) => {
      const f = fixture(count)
      const request = {
        type: 'initialize' as const,
        nonce: 'fixture',
        parentPid: process.pid,
        profilePath: f.profilePath,
        appName: 'Test Host',
        runtimeInstanceId: 'test-runtime',
        segmented: false,
        defaultProvider: 'mistral'
      }
      const rawBytes = Buffer.byteLength(JSON.stringify(f.chat))
      expect(rawBytes).toBeGreaterThan(count === 64 ? 256 * 1024 : 2 * 1024 * 1024)
      const result = runPeopleMigrationHelper(request, crypto, () => {})
      expect(result.finalization.phase).toBe('committed')
      const paths = channelProductionDataPaths(f.profilePath)
      const channels = new ChannelStore(paths.metadata)
      const channel = channels.listChannels().find((item) => item.chatId === f.chat.appChatId)!
      const log = new ChannelMessageLog(paths.logs, channels)
      expect(log.highWaterSequence(channel.channelId)).toBe(count)
      expect(JSON.stringify(result)).not.toContain('x'.repeat(100))
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(128 * 1024)
      expect(
        JSON.parse(readFileSync(join(f.profilePath, 'human-collaboration.json'), 'utf8')).shares
      ).toEqual([])
      // Existing encrypted execution recovery uses the same helper route.
      expect(runPeopleMigrationHelper(request, crypto, () => {}).terminalPlanId).toBe(
        result.terminalPlanId
      )
      expect(log.highWaterSequence(channel.channelId)).toBe(count)
    },
    15000
  )

  it.each(['none', 'wrong-kind', 'wrong-ids'] as const)(
    'refuses an unprepared or mismatched People erasure scope: %s',
    (caseName) => {
      const f = fixture()
      const forwarder = forwardingPeopleMigrationGate()
      const pending =
        caseName === 'none'
          ? null
          : {
              operationId: 'operation',
              kind: caseName === 'wrong-kind' ? ('chat' as const) : ('workspace' as const),
              chatIds: caseName === 'wrong-ids' ? ['other_chat'] : ['chat_one']
            }
      const store = new HumanCollaborationStore(join(f.profilePath, 'human-collaboration.json'), {
        legacyWriteGate: forwarder.gate,
        getHistoryDeletionScope: () => pending
      })
      expect(() =>
        store.purgeForHistoryDeletionScope({ kind: 'workspace', chatIds: ['chat_one'] })
      ).toThrow('durable prepared scope')
      expect(store.listShares()).toHaveLength(1)
      expect(() => store.purgeAllShares()).toThrow('Collaboration history is still loading')
    }
  )

  it.each(['truncate', 'workspace', 'global'] as const)(
    'performs only the explicitly prepared People erasure while ordinary writes remain closed: %s',
    (kind) => {
      const f = fixture()
      const file = join(f.profilePath, 'human-collaboration.json')
      const source = JSON.parse(readFileSync(file, 'utf8'))
      source.shares.push({
        ...source.shares[0],
        shareId: 'share_two',
        chatId: 'chat_two',
        invites: source.shares[0].invites.map((invite: Record<string, unknown>) => ({
          ...invite,
          inviteId: 'consumed_two',
          roomId: 'room_two'
        }))
      })
      writeFileSync(file, JSON.stringify(source), { mode: 0o600 })
      const scope: PeopleHistoryDeletionScope = { kind, chatIds: ['chat_one'] }
      const forwarder = forwardingPeopleMigrationGate()
      const store = new HumanCollaborationStore(file, {
        legacyWriteGate: forwarder.gate,
        getHistoryDeletionScope: () => ({ operationId: 'operation', ...scope })
      })
      expect(() => store.purgeAllShares()).toThrow('Collaboration history is still loading')
      expect(store.purgeForHistoryDeletionScope(scope)).toBe(
        kind === 'truncate' ? 0 : kind === 'global' ? 2 : 1
      )
      const remaining =
        kind === 'truncate' ? ['chat_one', 'chat_two'] : kind === 'global' ? [] : ['chat_two']
      expect(store.listShares().map((share) => share.chatId)).toEqual(remaining)
      expect(
        JSON.parse(readFileSync(file, 'utf8')).shares.map(
          (share: { chatId: string }) => share.chatId
        )
      ).toEqual(remaining)
      expect(store.purgeForHistoryDeletionScope(scope)).toBe(0)
      expect(() => forwarder.gate.assertOrdinaryWriteAllowed('share_two')).toThrow(
        'Collaboration history is still loading'
      )
    }
  )
  it('finishes prepared scoped migration before cold purge and cannot replay the erased target on committed restart', () => {
    const f = fixture()
    const sourceFile = join(f.profilePath, 'human-collaboration.json')
    const source = JSON.parse(readFileSync(sourceFile, 'utf8'))
    source.shares.push({
      ...source.shares[0],
      shareId: 'share_two',
      chatId: 'chat_two',
      invites: source.shares[0].invites.map((invite: Record<string, unknown>) => ({
        ...invite,
        inviteId: 'consumed_two',
        roomId: 'room_two'
      }))
    })
    writeFileSync(sourceFile, JSON.stringify(source), { mode: 0o600 })
    const other: ChatRecord = {
      ...f.chat,
      appChatId: 'chat_two',
      title: 'Unrelated retained task',
      messages: [
        {
          ...f.chat.messages[0],
          id: 'other_donor',
          content: 'y'.repeat(5000),
          metadata: {
            ...f.chat.messages[0].metadata,
            shareId: 'share_two',
            clientMessageId: 'other_client'
          }
        }
      ]
    }
    writeFileSync(join(f.profilePath, 'chats', 'chat_two.json'), JSON.stringify(other), {
      mode: 0o600
    })
    const chats = [f.chat, other]
    const additive = new PeopleToChannelMigrationProductionRunner({
      userDataPath: f.profilePath,
      safeStorage: crypto,
      loadIdentity: () => f.identity,
      hostDisplayName: 'Test Host',
      listChats: () => chats,
      now: () => 1000,
      afterStage: (stage) => {
        if (stage === 'recovery_prepared') throw new Error('prepared crash')
      }
    })
    expect(() => additive.runToSoak()).toThrow('prepared crash')
    const recovery = new PeopleToChannelMigrationRecoveryStore({ userDataPath: f.profilePath })
    expect(recovery.load()?.phase).toBe('prepared')

    const intentFile = join(f.profilePath, 'history-deletion-intent.json')
    const prepared = {
      operationId: 'scoped-operation',
      kind: 'chat' as const,
      chatIds: ['chat_one']
    }
    writeFileSync(intentFile, JSON.stringify(prepared), { mode: 0o600 })
    const assertScope = () => expect(JSON.parse(readFileSync(intentFile, 'utf8'))).toEqual(prepared)
    // This is the exact runner the deletion-owned Electron helper invokes.
    // Helper IPC/PID admission is covered separately; preserve its bound scope
    // at every available durable-publication/phase callback here.
    const completed = new PeopleToChannelMigrationFinalizationProductionRunner({
      userDataPath: f.profilePath,
      safeStorage: crypto,
      loadIdentity: () => f.identity,
      hostDisplayName: 'Test Host',
      listChats: () => chats,
      now: () => 2000,
      beforeDurablePublish: assertScope,
      afterStage: assertScope
    }).runToCompletion()
    expect(completed.finalization.phase).toBe('committed')
    const paths = channelProductionDataPaths(f.profilePath)
    const before = new ChannelStore(paths.metadata)
    const erased = before.listChannels().find((channel) => channel.chatId === 'chat_one')!
    const retained = before.listChannels().find((channel) => channel.chatId === 'chat_two')!
    expect(erased).toBeDefined()
    expect(retained).toBeDefined()
    const retainedMembers = before.listMembers(retained.channelId)
    const retainedInvites = before.listInvites(retained.channelId)
    const retainedPolicies = new ChannelHumanPolicyStore(paths.humanPolicies)
      .list()
      .filter((policy) => policy.channelId === retained.channelId)
    const retainedDigest = new ChannelMessageLog(paths.logs, before).digest(retained.channelId)

    assertScope()
    expect(
      purgeColdChannelHistoryDeletion({ paths, scope: prepared, safeStorage: crypto })
        .purgedChannelIds
    ).toEqual([erased.channelId])
    const people = new HumanCollaborationStore(sourceFile, {
      getHistoryDeletionScope: () => prepared
    })
    people.purgeForHistoryDeletionScope(prepared)
    rmSync(join(f.profilePath, 'chats', 'chat_one.json'))
    const erasedLog = join(paths.logs, `${erased.channelId}.jsonl`)
    expect(existsSync(erasedLog)).toBe(false)
    rmSync(intentFile)

    const restarted = runPeopleMigrationHelper(
      {
        type: 'initialize',
        nonce: 'fixture',
        parentPid: process.pid,
        profilePath: f.profilePath,
        appName: 'Test Host',
        runtimeInstanceId: 'restart-runtime',
        segmented: false,
        defaultProvider: 'mistral'
      },
      crypto,
      () => {}
    )
    expect(restarted.terminalPlanId).toBe(completed.terminalPlanId)
    const after = new ChannelStore(paths.metadata)
    expect(after.listChannels()).toEqual([retained])
    expect(after.listMembers(retained.channelId)).toEqual(retainedMembers)
    expect(after.listInvites(retained.channelId)).toEqual(retainedInvites)
    expect(
      new ChannelHumanPolicyStore(paths.humanPolicies)
        .list()
        .filter((policy) => policy.channelId === retained.channelId)
    ).toEqual(retainedPolicies)
    expect(new ChannelMessageLog(paths.logs, after).digest(retained.channelId)).toBe(retainedDigest)
    expect(existsSync(erasedLog)).toBe(false)
    expect(recovery.load()?.phase).toBe('committed')
  })
})
