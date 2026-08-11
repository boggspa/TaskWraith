import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { contributionRulesForPreset } from './HumanContributionRules'
import { CHANNEL_SCHEMA_VERSION } from './ChannelStore'
import { createPeopleToChannelMigrationPlan } from './PeopleToChannelMigrationPlan'
import {
  PeopleToChannelMigrationRecoveryError,
  PeopleToChannelMigrationRecoveryStore,
  type PeopleToChannelMigrationRecoveryWriteStage
} from './PeopleToChannelMigrationRecoveryStore'
import { RECORDED_PEOPLE_TO_CHANNEL_CUTOVER_DECISIONS } from './PeopleToChannelMigrationRecordedDecisions'
import { PeopleToChannelMigrationSource } from './PeopleToChannelMigrationSource'

const HOST_KEY = Buffer.alloc(32, 7).toString('base64')
const MEMBER_KEY = Buffer.alloc(32, 8).toString('base64')
const CHANNEL_DIGEST = 'a'.repeat(64)
const CUTOVER_DIGEST = 'b'.repeat(64)
const FINALIZATION_DIGEST = 'c'.repeat(64)
const DECISIONS = RECORDED_PEOPLE_TO_CHANNEL_CUTOVER_DECISIONS

function donor(): Record<string, unknown> {
  return {
    shares: [
      {
        shareId: 'share_one',
        chatId: 'chat_one',
        mode: 'comments',
        enabled: true,
        createdAt: 100,
        updatedAt: 200,
        nextSequence: 1,
        participants: [
          {
            collaboratorId: 'collaborator_one',
            displayName: 'Private Migration Person',
            publicKeyId: MEMBER_KEY,
            status: 'active',
            joinedAt: 120
          }
        ],
        invites: [
          {
            inviteId: 'invite_one',
            tokenHash: 'private-legacy-token-hash',
            createdAt: 110,
            expiresAt: 500,
            consumedAt: 120,
            collaboratorId: 'collaborator_one',
            roomId: 'private-relay-room'
          }
        ],
        idempotency: {},
        contributionRules: contributionRulesForPreset('comments')
      }
    ]
  }
}

function withFixture(
  run: (fixture: {
    userDataPath: string
    sourcePath: string
    source: ReturnType<PeopleToChannelMigrationSource['read']>
    plan: ReturnType<typeof createPeopleToChannelMigrationPlan>
  }) => void
): void {
  const userDataPath = mkdtempSync(join(tmpdir(), 'taskwraith-people-channel-recovery-'))
  const sourcePath = join(userDataPath, 'human-collaboration.json')
  try {
    writeFileSync(sourcePath, JSON.stringify(donor(), null, 2), { mode: 0o600 })
    const source = new PeopleToChannelMigrationSource(sourcePath).read()
    const plan = createPeopleToChannelMigrationPlan({
      hostIdentityPublicKey: HOST_KEY,
      people: source.snapshot,
      channels: {
        schemaVersion: CHANNEL_SCHEMA_VERSION,
        channels: [],
        members: [],
        invites: []
      },
      chats: [{ chatId: 'chat_one', title: 'Private Migration Chat' }]
    })
    run({ userDataPath, sourcePath, source, plan })
  } finally {
    rmSync(userDataPath, { recursive: true, force: true })
  }
}

function privateMode(path: string): number {
  return statSync(path).mode & 0o777
}

describe('PeopleToChannelMigrationRecoveryStore', () => {
  it('prepares an exact private backup and content-free durable intent', () => {
    withFixture(({ userDataPath, source, plan }) => {
      const store = new PeopleToChannelMigrationRecoveryStore({
        userDataPath,
        now: () => 1_000
      })
      const prepared = store.prepare({ plan, source, decisions: DECISIONS })

      expect(prepared).toMatchObject({
        planId: plan.planId,
        sourceDigest: plan.sourceDigest,
        decisions: DECISIONS,
        phase: 'prepared',
        preparedAt: 1_000,
        updatedAt: 1_000,
        source: {
          exists: true,
          bytes: source.bytes,
          fileSha256: source.fileSha256
        }
      })
      const backupPath = join(store.paths.backups, prepared.source.backupFile!)
      expect(readFileSync(backupPath)).toEqual(readFileSync(source.path))
      expect(privateMode(store.paths.root)).toBe(0o700)
      expect(privateMode(store.paths.intent)).toBe(0o600)
      expect(privateMode(backupPath)).toBe(0o600)

      const intent = readFileSync(store.paths.intent, 'utf8')
      expect(intent).not.toContain('Private Migration Person')
      expect(intent).not.toContain('Private Migration Chat')
      expect(intent).not.toContain('private-legacy-token-hash')
      expect(intent).not.toContain('private-relay-room')
      expect(prepared.decisions).toEqual({
        generalChatScope: 'all-general-chats',
        legacyProjectionHistory: 'import-then-reset',
        peopleRetirementTiming: 'after-p4-acceptance'
      })
      expect(store.load()).toEqual(prepared)

      const intentBefore = readFileSync(store.paths.intent)
      expect(store.prepare({ plan, source, decisions: DECISIONS })).toEqual(prepared)
      expect(readFileSync(store.paths.intent)).toEqual(intentBefore)
    })
  })

  it('requires explicit supported decisions and an executable plan before writing', () => {
    withFixture(({ userDataPath, source, plan }) => {
      const store = new PeopleToChannelMigrationRecoveryStore({ userDataPath })
      expect(() =>
        store.prepare({
          plan,
          source,
          decisions: {
            ...DECISIONS,
            peopleRetirementTiming: undefined
          } as unknown as typeof DECISIONS
        })
      ).toThrow(PeopleToChannelMigrationRecoveryError)

      const blockedPlan = createPeopleToChannelMigrationPlan({
        hostIdentityPublicKey: '',
        people: source.snapshot,
        channels: {
          schemaVersion: CHANNEL_SCHEMA_VERSION,
          channels: [],
          members: [],
          invites: []
        },
        chats: [{ chatId: 'chat_one', title: 'Blocked plan' }]
      })
      expect(() => store.prepare({ plan: blockedPlan, source, decisions: DECISIONS })).toThrow(
        /not executable/
      )
      expect(existsSync(store.paths.intent)).toBe(false)
    })
  })

  it('blocks a donor mutation after inventory and a competing durable plan', () => {
    withFixture(({ userDataPath, sourcePath, source, plan }) => {
      const store = new PeopleToChannelMigrationRecoveryStore({ userDataPath, now: () => 1_000 })
      writeFileSync(sourcePath, `${readFileSync(sourcePath, 'utf8')}\n`)
      expect(() => store.prepare({ plan, source, decisions: DECISIONS })).toThrow(
        /changed after inventory/
      )

      writeFileSync(sourcePath, JSON.stringify(donor(), null, 2))
      const refreshed = new PeopleToChannelMigrationSource(sourcePath).read()
      store.prepare({ plan, source: refreshed, decisions: DECISIONS })
      expect(() =>
        store.prepare({
          plan,
          source: refreshed,
          decisions: { ...DECISIONS, peopleRetirementTiming: 'keep-adjacent' }
        })
      ).toThrow(/different People migration/)
    })
  })

  it('enforces ordered digest-bound transitions and emits an immutable receipt', () => {
    withFixture(({ userDataPath, source, plan }) => {
      let now = 1_000
      const store = new PeopleToChannelMigrationRecoveryStore({
        userDataPath,
        now: () => ++now
      })
      store.prepare({ plan, source, decisions: DECISIONS })
      expect(() =>
        store.markCutoverApplied({ planId: plan.planId, cutoverStateDigest: CUTOVER_DIGEST })
      ).toThrow(/out of order/)

      const channels = store.markChannelsApplied({
        planId: plan.planId,
        channelStateDigest: CHANNEL_DIGEST
      })
      expect(channels.phase).toBe('channels_applied')
      expect(
        store.markChannelsApplied({
          planId: plan.planId,
          channelStateDigest: CHANNEL_DIGEST
        })
      ).toEqual(channels)
      expect(() =>
        store.markChannelsApplied({
          planId: plan.planId,
          channelStateDigest: 'c'.repeat(64)
        })
      ).toThrow(/conflicts/)

      const cutover = store.markCutoverApplied({
        planId: plan.planId,
        cutoverStateDigest: CUTOVER_DIGEST
      })
      expect(cutover.phase).toBe('cutover_applied')
      const committed = store.finalize({ planId: plan.planId })
      expect(committed).toMatchObject({
        phase: 'committed',
        channelStateDigest: CHANNEL_DIGEST,
        cutoverStateDigest: CUTOVER_DIGEST
      })
      expect(committed.receiptSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(store.finalize({ planId: plan.planId })).toEqual(committed)

      const receiptPath = join(store.paths.receipts, `${plan.planId}.json`)
      const receipt = readFileSync(receiptPath, 'utf8')
      expect(privateMode(receiptPath)).toBe(0o600)
      expect(receipt).toContain('"status": "committed"')
      expect(receipt).not.toContain('Private Migration Person')
      expect(receipt).not.toContain('Private Migration Chat')
      expect(receipt).not.toContain('private-legacy-token-hash')
    })
  })

  it('resumes after durable-write interruption at every finalization boundary', () => {
    withFixture(({ userDataPath, source, plan }) => {
      let crashAt: PeopleToChannelMigrationRecoveryWriteStage | null = 'backup'
      const crash = new Error('simulated process death')
      const crashingStore = () =>
        new PeopleToChannelMigrationRecoveryStore({
          userDataPath,
          now: () => 1_000,
          afterDurableWrite: (stage) => {
            if (stage === crashAt) throw crash
          }
        })

      expect(() => crashingStore().prepare({ plan, source, decisions: DECISIONS })).toThrow(crash)
      expect(existsSync(crashingStore().paths.intent)).toBe(false)
      crashAt = null
      crashingStore().prepare({ plan, source, decisions: DECISIONS })

      crashAt = 'intent:channels_applied'
      expect(() =>
        crashingStore().markChannelsApplied({
          planId: plan.planId,
          channelStateDigest: CHANNEL_DIGEST
        })
      ).toThrow(crash)
      expect(crashingStore().load()?.phase).toBe('channels_applied')
      crashAt = null
      crashingStore().markCutoverApplied({
        planId: plan.planId,
        cutoverStateDigest: CUTOVER_DIGEST
      })

      crashAt = 'intent:finalizing'
      expect(() => crashingStore().finalize({ planId: plan.planId })).toThrow(crash)
      expect(crashingStore().load()?.phase).toBe('finalizing')

      crashAt = 'receipt'
      expect(() => crashingStore().finalize({ planId: plan.planId })).toThrow(crash)
      expect(crashingStore().load()?.phase).toBe('finalizing')

      crashAt = null
      expect(crashingStore().finalize({ planId: plan.planId }).phase).toBe('committed')
      expect(crashingStore().load()?.phase).toBe('committed')
    })
  })

  it('fences a planned terminal delta before retirement and commits only matching evidence', () => {
    withFixture(({ userDataPath, source, plan }) => {
      const store = new PeopleToChannelMigrationRecoveryStore({ userDataPath, now: () => 1_000 })
      store.prepare({ plan, source, decisions: DECISIONS })
      store.markChannelsApplied({ planId: plan.planId, channelStateDigest: CHANNEL_DIGEST })
      store.markCutoverApplied({ planId: plan.planId, cutoverStateDigest: CUTOVER_DIGEST })

      const begun = store.beginFinalization({
        planId: plan.planId,
        finalizationDigest: FINALIZATION_DIGEST
      })
      expect(begun).toMatchObject({
        phase: 'finalizing',
        finalizationDigest: FINALIZATION_DIGEST
      })
      expect(store.load()).toEqual(begun)
      expect(
        store.beginFinalization({
          planId: plan.planId,
          finalizationDigest: FINALIZATION_DIGEST
        })
      ).toEqual(begun)
      expect(() =>
        store.beginFinalization({ planId: plan.planId, finalizationDigest: 'd'.repeat(64) })
      ).toThrow(/finalization evidence conflicts/)

      const committed = store.completeFinalization({ planId: plan.planId })
      expect(committed).toMatchObject({
        phase: 'committed',
        finalizationDigest: FINALIZATION_DIGEST
      })
      const receipt = readFileSync(join(store.paths.receipts, `${plan.planId}.json`), 'utf8')
      expect(receipt).toContain(`"finalizationDigest": "${FINALIZATION_DIGEST}"`)
      expect(
        store.beginFinalization({
          planId: plan.planId,
          finalizationDigest: FINALIZATION_DIGEST
        })
      ).toEqual(committed)
      expect(() => store.beginFinalization({ planId: plan.planId })).toThrow(
        /finalization evidence conflicts/
      )
    })
  })

  it('fails closed without rewriting corrupt intent, backup, or receipt evidence', () => {
    withFixture(({ userDataPath, source, plan }) => {
      const store = new PeopleToChannelMigrationRecoveryStore({ userDataPath, now: () => 1_000 })
      const prepared = store.prepare({ plan, source, decisions: DECISIONS })
      const backupPath = join(store.paths.backups, prepared.source.backupFile!)
      writeFileSync(backupPath, 'corrupt backup bytes')
      const corruptBackup = readFileSync(backupPath)
      expect(() => store.load()).toThrow(/backup is missing or corrupt/)
      expect(readFileSync(backupPath)).toEqual(corruptBackup)
    })

    withFixture(({ userDataPath, source, plan }) => {
      const store = new PeopleToChannelMigrationRecoveryStore({ userDataPath, now: () => 1_000 })
      store.prepare({ plan, source, decisions: DECISIONS })
      writeFileSync(store.paths.intent, '{not-json')
      const corruptIntent = readFileSync(store.paths.intent)
      expect(() => store.load()).toThrow(/intent is corrupt/)
      expect(readFileSync(store.paths.intent)).toEqual(corruptIntent)
    })

    withFixture(({ userDataPath, source, plan }) => {
      const store = new PeopleToChannelMigrationRecoveryStore({ userDataPath, now: () => 1_000 })
      store.prepare({ plan, source, decisions: DECISIONS })
      store.markChannelsApplied({ planId: plan.planId, channelStateDigest: CHANNEL_DIGEST })
      store.markCutoverApplied({ planId: plan.planId, cutoverStateDigest: CUTOVER_DIGEST })
      store.finalize({ planId: plan.planId })
      const receiptPath = join(store.paths.receipts, `${plan.planId}.json`)
      writeFileSync(receiptPath, '{not-json')
      const corruptReceipt = readFileSync(receiptPath)
      expect(() => store.load()).toThrow(/receipt is missing or corrupt/)
      expect(readFileSync(receiptPath)).toEqual(corruptReceipt)
    })
  })
})
