import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  exportRawEd25519PublicKey,
  generateIdentityKeyPair,
  type KeyPair
} from '../src/shared/e2ee/keys'
import type { ChatRecord } from '../src/main/store/types'
import type { TransportSocketFactory } from '../src/main/remote/RemoteTransportClient'
import { ChannelExternalSeatAuthority } from '../src/main/collaboration/ChannelExternalSeatAuthority'
import type { ChannelAgentIdentitySafeStorage } from '../src/main/collaboration/ChannelAgentIdentityStore'
import {
  channelProductionDataPaths,
  createChannelProductionService,
  type ChannelProductionService
} from '../src/main/collaboration/ChannelProductionService'
import { ExternalContributionQueueStore } from '../src/main/collaboration/ExternalContributionQueueStore'
import type { HumanCollaborationSafeStorage } from '../src/main/collaboration/HumanCollaborationIdentityStore'
import { contributionRulesForPreset } from '../src/main/collaboration/HumanContributionRules'
import { HUMAN_COLLABORATOR_COMMENT_KIND } from '../src/main/collaboration/HumanCollaboratorMessages'
import { HumanCollaborationStore } from '../src/main/collaboration/HumanCollaborationStore'
import { PeopleToChannelMigrationFinalizationProductionRunner } from '../src/main/collaboration/PeopleToChannelMigrationFinalizationProductionRunner'
import { startPeopleToChannelMigrationBootstrap } from '../src/main/collaboration/PeopleToChannelMigrationStartup'
import { EnsembleOrchestrator } from '../src/main/services/EnsembleOrchestrator'

const CHAT_ID = 'chat-channels-p5-live-proof'
const SHARE_ID = 'share-channels-p5-live-proof'
const COLLABORATOR_ID = 'collaborator-channels-p5-live-proof'
const NOW_BASE = 1_800_000_000_000

function assertMission(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Channels P5 live mission failed: ${message}`)
}

function xor(value: Buffer): Buffer {
  return Buffer.from(value.map((byte) => byte ^ 0x5a))
}

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => xor(Buffer.from(plain, 'utf8')),
  decryptString: (encrypted: Buffer) => xor(encrypted).toString('utf8'),
  getSelectedStorageBackend: () => 'kwallet6' as const
} satisfies ChannelAgentIdentitySafeStorage & HumanCollaborationSafeStorage

const socketFactory: TransportSocketFactory = (_url, _headers, handlers) => {
  queueMicrotask(() => handlers.onOpen())
  return {
    send: () => undefined,
    close: () => undefined
  }
}

function peopleSource(memberIdentity: KeyPair): unknown {
  const memberKey = exportRawEd25519PublicKey(memberIdentity.publicKey).toString('base64')
  return {
    shares: [
      {
        shareId: SHARE_ID,
        chatId: CHAT_ID,
        mode: 'comments',
        enabled: true,
        createdAt: 100,
        updatedAt: 300,
        nextSequence: 2,
        participants: [
          {
            collaboratorId: COLLABORATOR_ID,
            displayName: 'Migration proof collaborator',
            publicKeyId: memberKey,
            status: 'active',
            joinedAt: 150,
            seatOrder: 2,
            colorIndex: 5
          }
        ],
        invites: [
          {
            inviteId: 'consumed-proof-invite',
            tokenHash: 'consumed-proof-token-hash',
            createdAt: 120,
            expiresAt: NOW_BASE + 60_000,
            consumedAt: 150,
            collaboratorId: COLLABORATOR_ID,
            roomId: 'proof-room'
          }
        ],
        idempotency: {},
        contributionRules: contributionRulesForPreset('requestHostAction'),
        requiresHostApproval: true,
        fullHistory: true
      }
    ]
  }
}

function missionChat(workspacePath: string): ChatRecord {
  return {
    appChatId: CHAT_ID,
    title: 'Channels P5 live migration proof',
    workspaceId: 'workspace-channels-p5-live-proof',
    workspacePath,
    scope: 'workspace',
    createdAt: NOW_BASE,
    updatedAt: NOW_BASE,
    archived: false,
    messages: [],
    runs: [],
    ensemble: { enabled: true, participants: [] }
  } as ChatRecord
}

function runner(args: {
  userDataPath: string
  hostIdentity: KeyPair
  now: () => number
}): PeopleToChannelMigrationFinalizationProductionRunner {
  return new PeopleToChannelMigrationFinalizationProductionRunner({
    userDataPath: args.userDataPath,
    safeStorage,
    loadIdentity: () => args.hostIdentity,
    hostDisplayName: 'Migration proof host',
    listChats: () => [
      {
        appChatId: CHAT_ID,
        title: 'Channels P5 live migration proof',
        scope: 'workspace',
        chatKind: 'single',
        messages: [
          {
            id: 'legacy-proof-message',
            role: 'system',
            content: 'migrate this exact disposable profile',
            timestamp: new Date(200).toISOString(),
            metadata: {
              kind: HUMAN_COLLABORATOR_COMMENT_KIND,
              sourceTrust: 'external_untrusted',
              shareId: SHARE_ID,
              collaboratorId: COLLABORATOR_ID,
              collaboratorDisplayName: 'Migration proof collaborator',
              clientMessageId: 'legacy-proof-client-message',
              sequence: 1
            }
          }
        ]
      }
    ],
    listWorkflowChatIds: () => [],
    now: args.now
  })
}

function launch(args: { userDataPath: string; hostIdentity: KeyPair; now: () => number }): {
  service: ChannelProductionService
  stop: () => Promise<void>
  terminalPlanId: string
} {
  let service: ChannelProductionService | null = null
  const started = startPeopleToChannelMigrationBootstrap({
    runner: runner(args),
    createBootstrap: ({ migratedAdmissionAuthority }) => {
      service = createChannelProductionService({
        userDataPath: args.userDataPath,
        loadIdentity: () => args.hostIdentity,
        safeStorage,
        relay: {
          hostRelayUrl: () => 'ws://relay.invalid',
          inviteRelayUrls: () => ['ws://relay.invalid']
        },
        socketFactory,
        migratedAdmissionAuthority,
        now: args.now
      })
      return {
        service,
        start: () => service!.start(),
        stop: () => service!.stop()
      }
    }
  })
  assertMission(service, 'startup did not construct the Channel service')
  return {
    service,
    stop: () => started.bootstrap.stop(),
    terminalPlanId: started.terminalPlanId
  }
}

interface ExternalSeat {
  shareId: string
  collaboratorId: string
  displayName: string
  seatOrder?: number
  present: boolean
  enabled: boolean
}

function seatAuthority(
  service: ChannelProductionService,
  people: HumanCollaborationStore,
  mode: 'transitional' | 'channel_only'
): ChannelExternalSeatAuthority {
  return new ChannelExternalSeatAuthority({
    channelStore: service.externalSeatChannelStore(),
    humanPolicyStore: service.externalSeatHumanPolicyStore(),
    runtime: service.externalSeatRuntimeAuthority(),
    legacy:
      mode === 'transitional'
        ? {
            mode,
            shareStore: people,
            resolvePresence: () => 'unknown'
          }
        : { mode }
  })
}

function externalSeatResolver(
  service: ChannelProductionService,
  people: HumanCollaborationStore
): () => readonly ExternalSeat[] {
  return () => {
    const resolution = seatAuthority(service, people, 'transitional').resolve(CHAT_ID)
    if (resolution.state !== 'ready') return []
    return resolution.seats.map((seat) => ({
      shareId: '',
      collaboratorId: seat.seatId,
      displayName: seat.displayName,
      ...(seat.seatOrder === undefined ? {} : { seatOrder: seat.seatOrder }),
      present: seat.present,
      enabled: seat.enabled
    }))
  }
}

function deliver(args: {
  chat: ChatRecord
  queue: ExternalContributionQueueStore
  resolveExternalSeats: () => readonly ExternalSeat[]
  now: () => number
}): ChatRecord {
  let chat = args.chat
  const orchestrator = new EnsembleOrchestrator({
    getChat: () => chat,
    saveChat: (next: ChatRecord) => {
      chat = next
    },
    getSettings: () => ({}),
    dispatch: async () => ({ dispatched: true, appRunId: 'unused' }),
    cancelRun: async () => true,
    createRunId: () => 'unused',
    now: args.now,
    nowIso: () => new Date(args.now()).toISOString(),
    resolveExternalSeats: args.resolveExternalSeats,
    externalContributionQueue: args.queue
  } as never)
  const delivery = orchestrator as unknown as {
    deliverExternalSeatTurns(runtime: { chatId: string }, beforeOrder: number | undefined): void
  }
  delivery.deliverExternalSeatTurns({ chatId: CHAT_ID }, undefined)
  return chat
}

async function main(): Promise<void> {
  const suppliedRoot = process.env.CHANNELS_P5_LIVE_PROOF_ROOT
  assertMission(suppliedRoot, 'runner did not supply a disposable work root')
  const workRoot = resolve(suppliedRoot)
  const userDataPath = join(workRoot, 'user-data')
  const workspacePath = join(workRoot, 'workspace')
  mkdirSync(userDataPath, { recursive: true })
  mkdirSync(workspacePath, { recursive: true })

  const hostIdentity = generateIdentityKeyPair()
  const memberIdentity = generateIdentityKeyPair()
  let clock = NOW_BASE
  const now = () => ++clock
  const sourcePath = join(userDataPath, 'human-collaboration.json')
  writeFileSync(sourcePath, JSON.stringify(peopleSource(memberIdentity)), { mode: 0o600 })

  let relaunchCount = 0
  const initial = launch({ userDataPath, hostIdentity, now })
  relaunchCount += 1
  const channel = initial.service.listChannels()[0]
  assertMission(channel, 'migration produced no Channel')
  assertMission(
    initial.service.status().recoveryBlockedChannelCount === 0,
    'initial launch blocked'
  )
  const migratedPeople = new HumanCollaborationStore(sourcePath)
  const initialResolution = seatAuthority(initial.service, migratedPeople, 'transitional').resolve(
    CHAT_ID
  )
  const channelOnlyResolution = seatAuthority(
    initial.service,
    migratedPeople,
    'channel_only'
  ).resolve(CHAT_ID)
  assertMission(initialResolution.state === 'ready', 'initial seat authority was not ready')
  assertMission(
    initialResolution.seats.filter((seat) => seat.seatId === COLLABORATOR_ID).length === 1,
    'migrated Channel collaborator did not project exactly once'
  )
  assertMission(
    migratedPeople.getShareForChat(CHAT_ID) === null,
    'transitional authority could still read the inherited People share after migration'
  )
  assertMission(
    JSON.stringify(channelOnlyResolution) === JSON.stringify(initialResolution),
    'Channel-only authority changed the resolved upgrade-profile seats'
  )
  assertMission(
    migratedPeople.listShares().length === 0,
    'ordinary People share survived terminal migration'
  )
  await initial.stop()

  const queuePath = join(userDataPath, 'external-contribution-queue.json')
  let queue = new ExternalContributionQueueStore(queuePath, undefined, now)
  const enqueued = queue.enqueue({
    chatId: CHAT_ID,
    shareId: SHARE_ID,
    collaboratorId: COLLABORATOR_ID,
    displayName: 'Migration proof collaborator',
    clientMessageId: 'p5-live-proof-contribution',
    sequence: 1,
    body: 'deliver only after healthy recovery',
    messageId: 'p5-live-proof-external-row',
    now: now()
  })
  assertMission(enqueued.ok && enqueued.entry, 'contribution did not enqueue')
  const approved = queue.approve(enqueued.entry.entryId, enqueued.entry.messageId, now())
  assertMission(approved && approved.materialised === false, 'contribution did not await delivery')

  const paths = channelProductionDataPaths(userDataPath)
  const logPath = join(paths.logs, `${channel.channelId}.jsonl`)
  const originalLog = readFileSync(logPath, 'utf8')
  const lines = originalLog.trimEnd().split('\n')
  const tampered = JSON.parse(lines[0]) as { content?: string }
  tampered.content = 'tampered migrated history'
  lines[0] = JSON.stringify(tampered)
  writeFileSync(logPath, `${lines.join('\n')}\n`, 'utf8')

  const blocked = launch({ userDataPath, hostIdentity, now })
  relaunchCount += 1
  assertMission(
    blocked.service.status().recoveryBlockedChannelCount === 1,
    'corrupt Channel did not fail closed'
  )
  queue = new ExternalContributionQueueStore(queuePath, undefined, now)
  let chat = missionChat(workspacePath)
  chat = deliver({
    chat,
    queue,
    resolveExternalSeats: externalSeatResolver(
      blocked.service,
      new HumanCollaborationStore(sourcePath)
    ),
    now
  })
  assertMission(chat.messages.length === 0, 'blocked authority delivered an Ensemble row')
  assertMission(
    queue
      .listAwaitingMaterialisation()
      .map((entry) => entry.entryId)
      .includes(approved.entryId),
    'blocked delivery dropped the queued contribution'
  )
  await blocked.stop()

  writeFileSync(logPath, originalLog, 'utf8')
  const healthy = launch({ userDataPath, hostIdentity, now })
  relaunchCount += 1
  assertMission(
    healthy.service.status().recoveryBlockedChannelCount === 0,
    'repaired Channel did not recover on relaunch'
  )
  queue = new ExternalContributionQueueStore(queuePath, undefined, now)
  assertMission(
    queue
      .listAwaitingMaterialisation()
      .map((entry) => entry.entryId)
      .includes(approved.entryId),
    'queued contribution did not survive to the healthy relaunch'
  )
  chat = deliver({
    chat,
    queue,
    resolveExternalSeats: externalSeatResolver(
      healthy.service,
      new HumanCollaborationStore(sourcePath)
    ),
    now
  })
  assertMission(
    chat.messages.filter((message) => message.id === 'p5-live-proof-external-row').length === 1,
    'healthy relaunch did not deliver exactly one Ensemble row'
  )
  assertMission(queue.listAwaitingMaterialisation().length === 0, 'delivery was not materialised')
  await healthy.stop()

  const verified = launch({ userDataPath, hostIdentity, now })
  relaunchCount += 1
  queue = new ExternalContributionQueueStore(queuePath, undefined, now)
  assertMission(
    verified.service.status().recoveryBlockedChannelCount === 0 &&
      queue.listAwaitingMaterialisation().length === 0,
    'final relaunch did not preserve healthy recovery and queue settlement'
  )
  await verified.stop()

  const assertions = {
    workerCreatedDisposableProfile: true,
    migrationCommitted: true,
    ordinaryPeopleShareRetired: true,
    inheritedPeopleShareUnreadableAfterMigration: true,
    channelOnlyMatchesTransitionalAfterUpgrade: true,
    initialChannelReady: true,
    migratedChannelSeatProjected: true,
    durableContributionApproved: true,
    corruptChannelRecoveryBlocked: true,
    blockedEnsembleDeliveryDeferred: true,
    queuedEntrySurvivedBlockedRelaunch: true,
    repairedChannelReadyOnHealthyRelaunch: true,
    queuedEntryDeliveredExactlyOnce: true,
    queueSettlementSurvivedFinalRelaunch: true
  }
  process.stdout.write(
    `${JSON.stringify({
      status: 'passed',
      profileKind: 'disposable',
      terminalPlanId: initial.terminalPlanId,
      relaunchCount,
      assertionCount: Object.keys(assertions).length,
      assertions
    })}\n`
  )
}

main().catch((error) => {
  process.stderr.write(`${String(error.stack || error.message || error)}\n`)
  process.exitCode = 1
})
