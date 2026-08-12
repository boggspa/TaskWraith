import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import type { HumanCollaborationShare } from './HumanCollaborationStore'
import { CHANNEL_SCHEMA_VERSION, ChannelStore } from './ChannelStore'
import {
  PEOPLE_TO_CHANNEL_CUTOVER_MANIFEST_VERSION,
  PEOPLE_TO_CHANNEL_SOAK_POSTURE,
  PeopleToChannelMigrationCutoverCoordinator,
  isPeopleToChannelMigrationCutoverCoordinatorError,
  loadPeopleToChannelCutoverManifest,
  peopleToChannelCutoverManifestPath,
  type PeopleToChannelCutoverCoordinatorStage
} from './PeopleToChannelMigrationCutoverCoordinator'
import {
  materializePeopleToChannels,
  type PeopleToChannelMigrationMaterialization
} from './PeopleToChannelMigrationMaterializer'
import {
  createPeopleToChannelMigrationPlan,
  type PeopleToChannelMigrationPlan,
  type PeopleToChannelMigrationPlanInput
} from './PeopleToChannelMigrationPlan'
import { PeopleToChannelMigrationRecoveryStore } from './PeopleToChannelMigrationRecoveryStore'
import { RECORDED_PEOPLE_TO_CHANNEL_CUTOVER_DECISIONS } from './PeopleToChannelMigrationRecordedDecisions'
import { PeopleToChannelMigrationSource } from './PeopleToChannelMigrationSource'

const HOST_KEY = Buffer.alloc(32, 31).toString('base64')
const MIGRATION_AT = 500
const CHANNEL_STATE_DIGEST = 'a'.repeat(64)
const temporaryPaths: string[] = []

type CrashStage = PeopleToChannelCutoverCoordinatorStage | 'intent:cutover_applied'

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'taskwraith-channels-p4-cutover-'))
  temporaryPaths.push(path)
  return path
}

afterEach(() => {
  while (temporaryPaths.length) rmSync(temporaryPaths.pop()!, { recursive: true, force: true })
})

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function share(shareId: string, chatId: string): HumanCollaborationShare {
  return {
    shareId,
    chatId,
    mode: 'comments',
    enabled: true,
    createdAt: 100,
    updatedAt: 200,
    nextSequence: 1,
    participants: [],
    invites: [],
    idempotency: {}
  }
}

interface Fixture {
  userDataPath: string
  sourcePath: string
  channelsPath: string
  plan: PeopleToChannelMigrationPlan
  base: PeopleToChannelMigrationMaterialization
}

function fixture(args: { channelsApplied?: boolean; empty?: boolean } = {}): Fixture {
  const channelsApplied = args.channelsApplied ?? true
  const userDataPath = temporaryDirectory()
  const sourcePath = join(userDataPath, 'human-collaboration.json')
  const channelsPath = join(userDataPath, 'channels', 'channels.json')
  const channels = new ChannelStore(channelsPath)
  const existing = channels.createChannel({
    chatId: 'chat_existing',
    title: 'Existing General',
    owner: {
      displayName: 'Host',
      identityPublicKey: HOST_KEY
    },
    now: 50,
    reference: { kind: 'chat', id: 'chat_existing' }
  })
  const shares = args.empty
    ? []
    : [share('share_people', 'chat_people'), share('share_both', 'chat_both')]
  writeFileSync(sourcePath, JSON.stringify({ shares }, null, 2), { mode: 0o600 })
  const source = new PeopleToChannelMigrationSource(sourcePath).read()
  const planInput: PeopleToChannelMigrationPlanInput = {
    hostIdentityPublicKey: HOST_KEY,
    people: source.snapshot,
    channels: {
      schemaVersion: CHANNEL_SCHEMA_VERSION,
      channels: channels.listChannels(),
      members: channels
        .listChannels()
        .flatMap((channel) => channels.listMembers(channel.channelId)),
      invites: channels.listChannels().flatMap((channel) => channels.listInvites(channel.channelId))
    },
    chats: args.empty
      ? []
      : [
          { chatId: 'chat_both', title: 'Shared General', scope: 'global' },
          { chatId: 'chat_existing', title: 'Existing General', scope: 'global' },
          { chatId: 'chat_general', title: 'New General', scope: 'global' },
          { chatId: 'chat_people', title: 'Workspace share', scope: 'workspace' }
        ]
  }
  const plan = createPeopleToChannelMigrationPlan(planInput)
  const base = materializePeopleToChannels({
    plan,
    source: planInput,
    hostDisplayName: 'Host',
    migrationAt: MIGRATION_AT
  })
  const recovery = new PeopleToChannelMigrationRecoveryStore({
    userDataPath,
    now: () => 1_000
  })
  recovery.prepare({
    plan,
    source,
    decisions: RECORDED_PEOPLE_TO_CHANNEL_CUTOVER_DECISIONS
  })
  if (channelsApplied) {
    channels.applyMigrationBatch(base.mutations)
    recovery.markChannelsApplied({
      planId: plan.planId,
      channelStateDigest: CHANNEL_STATE_DIGEST,
      now: 1_100
    })
  }
  expect(existing.channel.chatId).toBe('chat_existing')
  return { userDataPath, sourcePath, channelsPath, plan, base }
}

function runtime(
  built: Fixture,
  args: { crashAt?: CrashStage; events?: string[] } = {}
): {
  coordinator: PeopleToChannelMigrationCutoverCoordinator
  channels: ChannelStore
  recovery: PeopleToChannelMigrationRecoveryStore
  events: string[]
} {
  const events = args.events ?? []
  const crash = (stage: CrashStage): void => {
    events.push(stage)
    if (args.crashAt === stage) throw new Error(`injected crash at ${stage}`)
  }
  const recovery = new PeopleToChannelMigrationRecoveryStore({
    userDataPath: built.userDataPath,
    now: () => 1_500,
    afterDurableWrite: (stage) => {
      if (stage === 'intent:cutover_applied') crash(stage)
    }
  })
  const channels = new ChannelStore(built.channelsPath)
  const coordinator = new PeopleToChannelMigrationCutoverCoordinator({
    userDataPath: built.userDataPath,
    recovery,
    channels,
    now: () => 1_500,
    afterStage: crash
  })
  return { coordinator, channels, recovery, events }
}

function expectRecoveryBlocked(action: () => unknown): void {
  let error: unknown
  try {
    action()
  } catch (caught) {
    error = caught
  }
  expect(isPeopleToChannelMigrationCutoverCoordinatorError(error)).toBe(true)
}

describe('PeopleToChannelMigrationCutoverCoordinator', () => {
  it('pins every General and active-People route while keeping People writable for soak', () => {
    const built = fixture()
    const sourceBefore = readFileSync(built.sourcePath)
    const active = runtime(built)
    const result = active.coordinator.apply({ plan: built.plan })

    const generalChannelId = built.base.mutations.find(
      (mutation) => mutation.channel.chatId === 'chat_general'
    )!.channel.channelId
    const existingGeneralChannelId = built.plan.generalChats.find(
      (entry) => entry.source.chatId === 'chat_existing'
    )!.target!.channelId
    expect(result).toMatchObject({
      schemaVersion: PEOPLE_TO_CHANNEL_CUTOVER_MANIFEST_VERSION,
      phase: 'cutover_applied',
      planId: built.plan.planId,
      cutoverStateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      manifestWrittenThisRun: true,
      recoveryAdvancedThisRun: true,
      recovery: { phase: 'cutover_applied' },
      routes: [
        { chatId: 'chat_both', channelId: 'share_both', origin: 'general-and-people' },
        {
          chatId: 'chat_existing',
          channelId: existingGeneralChannelId,
          origin: 'general'
        },
        { chatId: 'chat_general', channelId: generalChannelId, origin: 'general' },
        { chatId: 'chat_people', channelId: 'share_people', origin: 'people' }
      ]
    })

    const manifest = loadPeopleToChannelCutoverManifest(built.userDataPath)
    expect(manifest).toMatchObject({
      status: 'soak',
      channelStateDigest: CHANNEL_STATE_DIGEST,
      preparedAt: 1_000,
      decisions: RECORDED_PEOPLE_TO_CHANNEL_CUTOVER_DECISIONS,
      peoplePosture: PEOPLE_TO_CHANNEL_SOAK_POSTURE
    })
    expect(readFileSync(built.sourcePath)).toEqual(sourceBefore)
    if (process.platform !== 'win32') {
      expect(lstatSync(peopleToChannelCutoverManifestPath(built.userDataPath)).mode & 0o777).toBe(
        0o600
      )
    }
    const persisted = readFileSync(peopleToChannelCutoverManifestPath(built.userDataPath), 'utf8')
    expect(persisted).not.toContain(HOST_KEY)
    expect(persisted).not.toContain('Host')
  })

  it('recovers byte-identically when interrupted after the manifest becomes durable', () => {
    const built = fixture()
    const first = runtime(built, { crashAt: 'manifest_durable' })
    expect(() => first.coordinator.apply({ plan: built.plan })).toThrow(
      'injected crash at manifest_durable'
    )
    expect(first.recovery.load()?.phase).toBe('channels_applied')
    const manifestPath = peopleToChannelCutoverManifestPath(built.userDataPath)
    const bytesAfterCrash = readFileSync(manifestPath)

    const resumed = runtime(built)
    const result = resumed.coordinator.apply({ plan: built.plan })
    expect(result).toMatchObject({
      manifestWrittenThisRun: false,
      recoveryAdvancedThisRun: true,
      recovery: { phase: 'cutover_applied' }
    })
    expect(readFileSync(manifestPath)).toEqual(bytesAfterCrash)
  })

  it('recovers read-only when interrupted after the recovery intent becomes durable', () => {
    const built = fixture()
    const first = runtime(built, { crashAt: 'intent:cutover_applied' })
    expect(() => first.coordinator.apply({ plan: built.plan })).toThrow(
      'injected crash at intent:cutover_applied'
    )
    expect(first.recovery.load()?.phase).toBe('cutover_applied')
    const manifestPath = peopleToChannelCutoverManifestPath(built.userDataPath)
    const bytesAfterCrash = readFileSync(manifestPath)

    const resumed = runtime(built)
    const result = resumed.coordinator.apply({ plan: built.plan })
    expect(result).toMatchObject({
      manifestWrittenThisRun: false,
      recoveryAdvancedThisRun: false,
      recovery: { phase: 'cutover_applied' }
    })
    expect(readFileSync(manifestPath)).toEqual(bytesAfterCrash)
    expect(resumed.events).toEqual([])
  })

  it('keeps route evidence valid while normal Channel state evolves during soak', () => {
    const built = fixture()
    const active = runtime(built)
    active.coordinator.apply({ plan: built.plan })
    active.channels.recordCommittedMessage('share_people', 1, 1_600)

    const resumed = runtime(built)
    const result = resumed.coordinator.apply({ plan: built.plan })
    expect(result).toMatchObject({
      recoveryAdvancedThisRun: false,
      routes: expect.arrayContaining([
        { chatId: 'chat_people', channelId: 'share_people', origin: 'people' }
      ])
    })
    expect(resumed.channels.getChannel('share_people')?.messageCount).toBe(1)
  })

  it('persists an explicit empty soak manifest when there is nothing to route', () => {
    const built = fixture({ empty: true })
    const result = runtime(built).coordinator.apply({ plan: built.plan })
    expect(result.routes).toEqual([])
    expect(loadPeopleToChannelCutoverManifest(built.userDataPath)?.routes).toEqual([])
  })

  it('blocks before Channels are durably applied', () => {
    const built = fixture({ channelsApplied: false })
    expectRecoveryBlocked(() => runtime(built).coordinator.apply({ plan: built.plan }))
    expect(loadPeopleToChannelCutoverManifest(built.userDataPath)).toBeNull()
  })

  it('blocks a stale plan before writing cutover evidence', () => {
    const stalePlan = fixture()
    const tamperedPlan = clone(stalePlan.plan)
    tamperedPlan.summary.generalChats += 1
    expectRecoveryBlocked(() => runtime(stalePlan).coordinator.apply({ plan: tamperedPlan }))
    expect(loadPeopleToChannelCutoverManifest(stalePlan.userDataPath)).toBeNull()
  })

  it('blocks a missing or closed Channel route without writing a manifest', () => {
    const built = fixture()
    const active = runtime(built)
    active.channels.closeChannel({ channelId: 'share_people', now: 1_300 })
    expectRecoveryBlocked(() => active.coordinator.apply({ plan: built.plan }))
    expect(loadPeopleToChannelCutoverManifest(built.userDataPath)).toBeNull()
  })

  it('fails closed on conflicting, corrupt, or multiply-linked immutable evidence', () => {
    const conflicting = fixture()
    const conflictPath = peopleToChannelCutoverManifestPath(conflicting.userDataPath)
    writeFileSync(conflictPath, '{}\n', { mode: 0o600 })
    expectRecoveryBlocked(() => runtime(conflicting).coordinator.apply({ plan: conflicting.plan }))

    const corrupt = fixture()
    runtime(corrupt).coordinator.apply({ plan: corrupt.plan })
    const corruptPath = peopleToChannelCutoverManifestPath(corrupt.userDataPath)
    writeFileSync(corruptPath, '{"bad":true}\n')
    chmodSync(corruptPath, 0o600)
    expectRecoveryBlocked(() => runtime(corrupt).coordinator.apply({ plan: corrupt.plan }))

    const linked = fixture()
    runtime(linked).coordinator.apply({ plan: linked.plan })
    const linkedPath = peopleToChannelCutoverManifestPath(linked.userDataPath)
    linkSync(linkedPath, `${linkedPath}.second-link`)
    expectRecoveryBlocked(() => loadPeopleToChannelCutoverManifest(linked.userDataPath))
  })
})
