import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

import {
  exportRawEd25519PublicKey,
  generateIdentityKeyPair,
  type KeyPair
} from '../src/shared/e2ee/keys'
import { ChannelExternalSeatAuthority } from '../src/main/collaboration/ChannelExternalSeatAuthority'
import type { ChannelAgentIdentitySafeStorage } from '../src/main/collaboration/ChannelAgentIdentityStore'
import {
  createChannelProductionService,
  type ChannelProductionService
} from '../src/main/collaboration/ChannelProductionService'
import { ExternalContributionQueueStore } from '../src/main/collaboration/ExternalContributionQueueStore'
import {
  HumanCollaborationIdentityStore,
  type HumanCollaborationSafeStorage
} from '../src/main/collaboration/HumanCollaborationIdentityStore'
import { HumanCollaborationStore } from '../src/main/collaboration/HumanCollaborationStore'
import { contributionRulesForPreset } from '../src/main/collaboration/HumanContributionRules'
import { HUMAN_COLLABORATOR_COMMENT_KIND } from '../src/main/collaboration/HumanCollaboratorMessages'
import {
  PeopleToChannelMigrationFinalizationProductionRunner,
  type PeopleToChannelMigrationFinalizationProductionRunnerDurablePublish,
  type PeopleToChannelMigrationFinalizationProductionRunnerStage
} from '../src/main/collaboration/PeopleToChannelMigrationFinalizationProductionRunner'
import {
  degradePeopleToChannelMigrationStartup,
  startPeopleToChannelMigrationBootstrap
} from '../src/main/collaboration/PeopleToChannelMigrationStartup'
import {
  PeopleToChannelMigrationProductionRunner,
  type PeopleToChannelMigrationProductionRunnerStage
} from '../src/main/collaboration/PeopleToChannelMigrationProductionRunner'
import type { TransportSocketFactory } from '../src/main/remote/RemoteTransportClient'
import { EnsembleOrchestrator } from '../src/main/services/EnsembleOrchestrator'
import type { ChatRecord } from '../src/main/store/types'

const CHAT_ID = 'chat-channels-p6-proof'
const SHARE_ID = 'share-channels-p6-proof'
const COLLABORATOR_ID = 'collaborator-channels-p6-proof'
const MESSAGE_ID = 'channels-p6-external-row'
const CLIENT_MESSAGE_ID = 'channels-p6-contribution'
const NOW_BASE = 1_800_000_000_000

type CrashBoundary = 'migration_execution_publish' | 'finalization_execution_publish'
type ProfileKind = 'membered' | 'empty'
type InterruptedStartStage =
  | PeopleToChannelMigrationProductionRunnerStage
  | PeopleToChannelMigrationFinalizationProductionRunnerStage

const ADDITIVE_START_STAGES = [
  'execution_durable',
  'recovery_prepared',
  'channels_applied',
  'cutover_applied'
] as const satisfies readonly PeopleToChannelMigrationProductionRunnerStage[]

const FINALIZATION_START_STAGES = [
  'write_gate_quiesced',
  'finalization_execution_durable',
  'recovery_fenced',
  'logs_durable',
  'policies_durable',
  'admission:terminal_escrow_durable',
  'admission:terminal_metadata_durable',
  'admission:superseded_invitations_retired',
  'admissions_durable',
  'legacy_retired',
  'receipt_durable'
] as const satisfies readonly PeopleToChannelMigrationFinalizationProductionRunnerStage[]

const INTERRUPTED_START_STAGES = new Set<string>([
  ...ADDITIVE_START_STAGES,
  ...FINALIZATION_START_STAGES
])

interface ExternalSeat {
  shareId: string
  collaboratorId: string
  displayName: string
  seatOrder?: number
  present: boolean
  enabled: boolean
}

function assertMission(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Channels P6 proof worker failed: ${message}`)
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

function syncDirectory(path: string): void {
  try {
    const descriptor = openSync(path, 'r')
    try {
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  } catch {
    // File fsync plus atomic rename is the portable floor used by production.
  }
}

function writeDurableJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  let descriptor: number | null = null
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
    renameSync(temporary, path)
    chmodSync(path, 0o600)
    syncDirectory(dirname(path))
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor)
      } catch {
        // Preserve the original failure.
      }
    }
    try {
      if (existsSync(temporary)) unlinkSync(temporary)
    } catch {
      // Preserve the original failure.
    }
    throw error
  }
}

function peopleSource(memberIdentity: KeyPair): unknown {
  const memberKey = exportRawEd25519PublicKey(memberIdentity.publicKey).toString('base64')
  const pendingMemberKey = exportRawEd25519PublicKey(generateIdentityKeyPair().publicKey).toString(
    'base64'
  )
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
            displayName: 'P6 proof collaborator',
            publicKeyId: memberKey,
            status: 'active',
            joinedAt: 150,
            seatOrder: 2,
            colorIndex: 5
          },
          {
            collaboratorId: 'pending-collaborator-channels-p6-proof',
            displayName: 'Pending P6 proof collaborator',
            publicKeyId: pendingMemberKey,
            status: 'pending',
            seatOrder: 3,
            colorIndex: 2,
            seatDisabled: true
          }
        ],
        invites: [
          {
            inviteId: 'consumed-p6-proof-invite',
            tokenHash: 'consumed-p6-proof-token-hash',
            createdAt: 120,
            expiresAt: NOW_BASE + 60_000,
            consumedAt: 150,
            collaboratorId: COLLABORATOR_ID,
            roomId: 'p6-proof-room'
          },
          {
            inviteId: 'open-p6-proof-invite',
            tokenHash: 'open-p6-proof-token-hash',
            createdAt: 200,
            expiresAt: NOW_BASE + 60_000,
            roomId: 'p6-proof-open-room'
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

function emptyPeopleSource(): unknown {
  return { shares: [] }
}

function missionChat(workspacePath: string): ChatRecord {
  return {
    appChatId: CHAT_ID,
    title: 'Channels P6 crash recovery proof',
    workspaceId: 'workspace-channels-p6-proof',
    workspacePath,
    scope: 'workspace',
    chatKind: 'ensemble',
    createdAt: NOW_BASE,
    updatedAt: NOW_BASE,
    archived: false,
    messages: [],
    runs: [],
    ensemble: { enabled: true, participants: [] }
  } as ChatRecord
}

function loadChat(path: string): ChatRecord {
  return JSON.parse(readFileSync(path, 'utf8')) as ChatRecord
}

function loadHostIdentity(userDataPath: string): KeyPair {
  return new HumanCollaborationIdentityStore(
    join(userDataPath, 'human-collaboration-identity.json'),
    safeStorage
  ).load()
}

function inventoryChats() {
  return [
    {
      appChatId: CHAT_ID,
      title: 'Channels P6 crash recovery proof',
      scope: 'global' as const,
      chatKind: 'single' as const,
      messages: [
        {
          id: 'legacy-p6-proof-message',
          role: 'system' as const,
          content: 'migrate this exact disposable P6 profile',
          timestamp: new Date(200).toISOString(),
          metadata: {
            kind: HUMAN_COLLABORATOR_COMMENT_KIND,
            sourceTrust: 'external_untrusted' as const,
            shareId: SHARE_ID,
            collaboratorId: COLLABORATOR_ID,
            collaboratorDisplayName: 'P6 proof collaborator',
            clientMessageId: 'legacy-p6-proof-client-message',
            sequence: 1
          }
        }
      ]
    }
  ]
}

function finalizationRunner(args: {
  userDataPath: string
  hostIdentity: KeyPair
  now: () => number
  storage?: HumanCollaborationSafeStorage
  beforeDurablePublish?: (
    event: PeopleToChannelMigrationFinalizationProductionRunnerDurablePublish
  ) => void
  afterStage?: (stage: PeopleToChannelMigrationFinalizationProductionRunnerStage) => void
}): PeopleToChannelMigrationFinalizationProductionRunner {
  return new PeopleToChannelMigrationFinalizationProductionRunner({
    userDataPath: args.userDataPath,
    safeStorage: args.storage ?? safeStorage,
    loadIdentity: () => args.hostIdentity,
    hostDisplayName: 'P6 proof host',
    listChats: inventoryChats,
    listWorkflowChatIds: () => [],
    now: args.now,
    beforeDurablePublish: args.beforeDurablePublish,
    afterStage: args.afterStage
  })
}

function additiveRunner(args: {
  userDataPath: string
  hostIdentity: KeyPair
  now: () => number
  afterStage: (stage: PeopleToChannelMigrationProductionRunnerStage) => void
}): PeopleToChannelMigrationProductionRunner {
  return new PeopleToChannelMigrationProductionRunner({
    userDataPath: args.userDataPath,
    safeStorage,
    loadIdentity: () => args.hostIdentity,
    hostDisplayName: 'P6 proof host',
    listChats: inventoryChats,
    listWorkflowChatIds: () => [],
    now: args.now,
    afterStage: args.afterStage
  })
}

function launch(args: {
  userDataPath: string
  hostIdentity: KeyPair
  now: () => number
  beforeDurablePublish?: (
    event: PeopleToChannelMigrationFinalizationProductionRunnerDurablePublish
  ) => void
}): {
  service: ChannelProductionService
  stop: () => Promise<void>
  terminalPlanId: string
  migrationPhase: string
} {
  let service: ChannelProductionService | null = null
  const started = startPeopleToChannelMigrationBootstrap({
    runner: finalizationRunner(args),
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
    terminalPlanId: started.terminalPlanId,
    migrationPhase: started.migration.phase
  }
}

function resolveChannelExternalSeats(service: ChannelProductionService) {
  return new ChannelExternalSeatAuthority({
    channelStore: service.externalSeatChannelStore(),
    humanPolicyStore: service.externalSeatHumanPolicyStore(),
    runtime: service.externalSeatRuntimeAuthority(),
    legacy: { mode: 'channel_only' }
  }).resolve(CHAT_ID)
}

function externalSeats(service: ChannelProductionService): readonly ExternalSeat[] {
  const resolution = resolveChannelExternalSeats(service)
  assertMission(resolution.state === 'ready', 'Channel seat authority was not ready')
  return resolution.seats.map((seat) => ({
    shareId: '',
    collaboratorId: seat.seatId,
    displayName: seat.displayName,
    ...(seat.seatOrder === undefined ? {} : { seatOrder: seat.seatOrder }),
    present: seat.present,
    enabled: seat.enabled
  }))
}

function deliver(args: {
  chatPath: string
  queue: ExternalContributionQueueStore
  seats: readonly ExternalSeat[]
  now: () => number
}): ChatRecord {
  let chat = loadChat(args.chatPath)
  const orchestrator = new EnsembleOrchestrator({
    getChat: () => chat,
    saveChat: (next: ChatRecord) => {
      writeDurableJson(args.chatPath, next)
      chat = next
    },
    getSettings: () => ({}),
    dispatch: async () => ({ dispatched: true, appRunId: 'unused' }),
    cancelRun: async () => true,
    createRunId: () => 'unused',
    now: args.now,
    nowIso: () => new Date(args.now()).toISOString(),
    resolveExternalSeats: () => args.seats,
    externalContributionQueue: args.queue
  } as never)
  const delivery = orchestrator as unknown as {
    deliverExternalSeatTurns(runtime: { chatId: string }, beforeOrder: number | undefined): void
  }
  delivery.deliverExternalSeatTurns({ chatId: CHAT_ID }, undefined)
  return chat
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function writeWindowInterlock(args: {
  boundary: CrashBoundary
  workRoot: string
}): (event: PeopleToChannelMigrationFinalizationProductionRunnerDurablePublish) => void {
  const targetBoundary =
    args.boundary === 'migration_execution_publish'
      ? 'migration_execution'
      : 'finalization_execution'
  let reached = false

  return (event): void => {
    if (reached || event.boundary !== targetBoundary) return
    reached = true
    const temporary = resolve(event.temporaryPath)
    const destination = resolve(event.destinationPath)
    const receipt = {
      status: 'write_window',
      boundary: args.boundary,
      operation: event.operation,
      temporaryPath: relative(args.workRoot, temporary),
      destinationPath: relative(args.workRoot, destination),
      temporaryFileBytes: statSync(temporary).size,
      destinationExistsBeforePublish: existsSync(destination)
    }
    writeSync(1, Buffer.from(`${JSON.stringify(receipt)}\n`, 'utf8'))
    // The parent now sends SIGKILL. This is a rendezvous inside the real
    // production write, after its temporary file fsync and before publication;
    // no exception or simulated write failure is involved.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  }
}

function interruptedStartInterlock(
  target: InterruptedStartStage
): (stage: InterruptedStartStage) => void {
  let reached = false
  return (stage): void => {
    if (reached || stage !== target) return
    reached = true
    writeSync(
      1,
      Buffer.from(
        `${JSON.stringify({ status: 'startup_gate', stage: target, pid: process.pid })}\n`,
        'utf8'
      )
    )
    // Each matrix interruption is a real process death. The callback is only a
    // deterministic rendezvous after the production runner reports its stage;
    // it neither throws nor changes the durable state being tested.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  }
}

async function seed(args: {
  workRoot: string
  userDataPath: string
  workspacePath: string
  queuePath: string
  chatPath: string
  now: () => number
  profileKind: ProfileKind
}): Promise<void> {
  assertMission(!existsSync(join(args.userDataPath, 'human-collaboration.json')), 'profile reused')
  mkdirSync(args.userDataPath, { recursive: true })
  mkdirSync(args.workspacePath, { recursive: true })
  loadHostIdentity(args.userDataPath)
  writeDurableJson(
    join(args.userDataPath, 'human-collaboration.json'),
    args.profileKind === 'membered' ? peopleSource(generateIdentityKeyPair()) : emptyPeopleSource()
  )
  writeDurableJson(args.chatPath, missionChat(args.workspacePath))

  let awaitingMaterialisation = 0
  if (args.profileKind === 'membered') {
    const queue = new ExternalContributionQueueStore(args.queuePath, undefined, args.now)
    const enqueued = queue.enqueue({
      chatId: CHAT_ID,
      shareId: SHARE_ID,
      collaboratorId: COLLABORATOR_ID,
      displayName: 'P6 proof collaborator',
      clientMessageId: CLIENT_MESSAGE_ID,
      sequence: 1,
      body: 'survive two real process deaths and deliver once',
      messageId: MESSAGE_ID,
      now: args.now()
    })
    assertMission(enqueued.ok && enqueued.entry, 'contribution did not enqueue')
    const approved = queue.approve(enqueued.entry.entryId, enqueued.entry.messageId, args.now())
    assertMission(approved?.materialised === false, 'contribution did not await materialisation')
    awaitingMaterialisation = 1
  }
  emit({
    status: 'seeded',
    profileKind: args.profileKind,
    disposable: true,
    awaitingMaterialisation
  })
}

async function crash(args: {
  boundary: CrashBoundary
  workRoot: string
  userDataPath: string
  now: () => number
}): Promise<void> {
  const active = launch({
    userDataPath: args.userDataPath,
    hostIdentity: loadHostIdentity(args.userDataPath),
    now: args.now,
    beforeDurablePublish: writeWindowInterlock(args)
  })
  await active.stop()
  assertMission(false, `write window ${args.boundary} was not reached`)
}

async function interruptStart(args: {
  stage: InterruptedStartStage
  userDataPath: string
  now: () => number
}): Promise<void> {
  const hostIdentity = loadHostIdentity(args.userDataPath)
  if ((ADDITIVE_START_STAGES as readonly string[]).includes(args.stage)) {
    additiveRunner({
      userDataPath: args.userDataPath,
      hostIdentity,
      now: args.now,
      afterStage: interruptedStartInterlock(args.stage) as (
        stage: PeopleToChannelMigrationProductionRunnerStage
      ) => void
    }).runToSoak()
  } else {
    finalizationRunner({
      userDataPath: args.userDataPath,
      hostIdentity,
      now: args.now,
      afterStage: interruptedStartInterlock(args.stage) as (
        stage: PeopleToChannelMigrationFinalizationProductionRunnerStage
      ) => void
    }).runToCompletion()
  }
  assertMission(false, `interrupted-start stage ${args.stage} was not reached`)
}

async function observeMatrix(args: {
  profileKind: ProfileKind
  userDataPath: string
  now: () => number
}): Promise<void> {
  const active = launch({
    userDataPath: args.userDataPath,
    hostIdentity: loadHostIdentity(args.userDataPath),
    now: args.now
  })
  const channels = active.service.listChannels()
  const channel = channels.find((candidate) => candidate.chatId === CHAT_ID)
  assertMission(channel, 'matrix recovery produced no Channel for its chat')
  const resolution = resolveChannelExternalSeats(active.service)
  const externalSeatIds =
    resolution.state === 'ready' ? resolution.seats.map((seat) => seat.seatId) : null
  const memberCount = active.service
    .externalSeatChannelStore()
    .listMembers(channel.channelId).length
  const expectedSeatIds = args.profileKind === 'membered' ? [COLLABORATOR_ID] : []
  const expectedMemberCount = args.profileKind === 'membered' ? 2 : 1
  const assertions = {
    migrationCommitted: active.migrationPhase === 'committed',
    recoveryHealthy: active.service.status().recoveryBlockedChannelCount === 0,
    exactlyOneChannel: channels.length === 1,
    membershipExact: memberCount === expectedMemberCount,
    externalSeatStateExact: JSON.stringify(externalSeatIds) === JSON.stringify(expectedSeatIds)
  }
  assertMission(Object.values(assertions).every(Boolean), 'matrix observation was inconsistent')
  await active.stop()
  emit({
    status: 'observed',
    profileKind: args.profileKind,
    terminalPlanId: active.terminalPlanId,
    channelCount: channels.length,
    memberCount,
    externalSeatIds,
    assertions
  })
}

async function observeBlockedStartup(args: {
  userDataPath: string
  now: () => number
}): Promise<void> {
  const unavailableStorage: HumanCollaborationSafeStorage = {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('unavailable storage must not encrypt')
    },
    decryptString: () => {
      throw new Error('unavailable storage must not decrypt')
    }
  }
  let bootstrapConstructed = false
  try {
    startPeopleToChannelMigrationBootstrap({
      runner: finalizationRunner({
        userDataPath: args.userDataPath,
        hostIdentity: loadHostIdentity(args.userDataPath),
        storage: unavailableStorage,
        now: args.now
      }),
      createBootstrap: () => {
        bootstrapConstructed = true
        throw new Error('blocked startup constructed Channels')
      }
    })
    assertMission(false, 'unavailable storage did not block startup')
  } catch (error) {
    assertMission(!bootstrapConstructed, 'blocked startup constructed Channel authority')
    const degraded = degradePeopleToChannelMigrationStartup(error)
    assertMission(degraded.legacyWriteGate.isQuiesced(), 'degraded People gate was writable')
    emit({
      status: 'blocked',
      bootstrapConstructed,
      externalSeatIds: null,
      legacyWritesQuiesced: true
    })
  }
}

async function recover(args: {
  userDataPath: string
  queuePath: string
  chatPath: string
  now: () => number
}): Promise<void> {
  const active = launch({
    userDataPath: args.userDataPath,
    hostIdentity: loadHostIdentity(args.userDataPath),
    now: args.now
  })
  const seats = externalSeats(active.service)
  const queue = new ExternalContributionQueueStore(args.queuePath, undefined, args.now)
  assertMission(queue.listAwaitingMaterialisation().length === 1, 'two crashes lost the queue')
  let chat = deliver({ chatPath: args.chatPath, queue, seats, now: args.now })
  chat = deliver({ chatPath: args.chatPath, queue, seats, now: args.now })
  const people = new HumanCollaborationStore(join(args.userDataPath, 'human-collaboration.json'))
  const assertions = {
    migrationCommitted: active.migrationPhase === 'committed',
    channelRecoveryHealthy: active.service.status().recoveryBlockedChannelCount === 0,
    realMembershipRecovered:
      seats.filter((seat) => seat.collaboratorId === COLLABORATOR_ID).length === 1,
    ordinaryPeopleShareRetired: people.listShares().length === 0,
    queueSurvivedBothProcessDeaths: true,
    contributionDeliveredExactlyOnce:
      chat.messages.filter((message) => message.id === MESSAGE_ID).length === 1,
    queueMaterialised: queue.listAwaitingMaterialisation().length === 0
  }
  assertMission(Object.values(assertions).every(Boolean), 'recovered assertions did not converge')
  await active.stop()
  emit({
    status: 'recovered',
    terminalPlanId: active.terminalPlanId,
    assertionCount: Object.keys(assertions).length,
    assertions
  })
}

async function verify(args: {
  userDataPath: string
  queuePath: string
  chatPath: string
  now: () => number
}): Promise<void> {
  const active = launch({
    userDataPath: args.userDataPath,
    hostIdentity: loadHostIdentity(args.userDataPath),
    now: args.now
  })
  const queue = new ExternalContributionQueueStore(args.queuePath, undefined, args.now)
  const seats = externalSeats(active.service)
  const chat = deliver({ chatPath: args.chatPath, queue, seats, now: args.now })
  const assertions = {
    committedFastPath: active.migrationPhase === 'committed',
    membershipStable: seats.filter((seat) => seat.collaboratorId === COLLABORATOR_ID).length === 1,
    deliveredRowStillExactlyOnce:
      chat.messages.filter((message) => message.id === MESSAGE_ID).length === 1,
    queueSettlementSurvivedRelaunch: queue.listAwaitingMaterialisation().length === 0
  }
  assertMission(Object.values(assertions).every(Boolean), 'verification relaunch diverged')
  await active.stop()
  emit({
    status: 'verified',
    terminalPlanId: active.terminalPlanId,
    assertionCount: Object.keys(assertions).length,
    assertions
  })
}

async function main(): Promise<void> {
  const suppliedRoot = process.env.CHANNELS_P6_PROOF_ROOT
  assertMission(suppliedRoot, 'runner did not supply a disposable work root')
  const workRoot = resolve(suppliedRoot)
  const userDataPath = join(workRoot, 'user-data')
  const workspacePath = join(workRoot, 'workspace')
  const queuePath = join(userDataPath, 'external-contribution-queue.json')
  const chatPath = join(userDataPath, 'channels-p6-mission-chat.json')
  const launchIndex = Number(process.env.CHANNELS_P6_LAUNCH_INDEX ?? 0)
  assertMission(Number.isSafeInteger(launchIndex) && launchIndex >= 0, 'launch index is invalid')
  const profileKind = (process.env.CHANNELS_P6_PROFILE_KIND ?? 'membered') as ProfileKind
  assertMission(profileKind === 'membered' || profileKind === 'empty', 'profile kind is invalid')
  let clock = NOW_BASE + launchIndex * 10_000
  const now = () => ++clock
  const command = process.argv[2]

  if (command === 'seed') {
    await seed({ workRoot, userDataPath, workspacePath, queuePath, chatPath, now, profileKind })
    return
  }
  if (command === 'crash') {
    const boundary = process.env.CHANNELS_P6_WRITE_BOUNDARY as CrashBoundary | undefined
    assertMission(
      boundary === 'migration_execution_publish' || boundary === 'finalization_execution_publish',
      'crash boundary is invalid'
    )
    await crash({ boundary, workRoot, userDataPath, now })
    return
  }
  if (command === 'interrupt') {
    const stage = process.env.CHANNELS_P6_START_STAGE
    assertMission(
      stage && INTERRUPTED_START_STAGES.has(stage),
      'interrupted-start stage is invalid'
    )
    await interruptStart({ stage: stage as InterruptedStartStage, userDataPath, now })
    return
  }
  if (command === 'matrix-observe') {
    await observeMatrix({ profileKind, userDataPath, now })
    return
  }
  if (command === 'blocked-observe') {
    await observeBlockedStartup({ userDataPath, now })
    return
  }
  if (command === 'recover') {
    await recover({ userDataPath, queuePath, chatPath, now })
    return
  }
  if (command === 'verify') {
    await verify({ userDataPath, queuePath, chatPath, now })
    return
  }
  assertMission(false, `unknown command ${String(command)}`)
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.stack || error.message : String(error)
  process.stderr.write(`${detail}\n`)
  process.exitCode = 1
})
