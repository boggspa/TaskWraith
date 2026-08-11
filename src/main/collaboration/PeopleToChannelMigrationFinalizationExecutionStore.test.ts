import { createHash } from 'crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import type { HumanCollaborationSafeStorage } from './HumanCollaborationIdentityStore'
import {
  PEOPLE_TO_CHANNEL_EXECUTION_STORE_VERSION,
  type PeopleToChannelMigrationExecution
} from './PeopleToChannelMigrationExecutionStore'
import { materializePeopleToChannelMigrationHistory } from './PeopleToChannelMigrationHistory'
import { materializePeopleToChannels } from './PeopleToChannelMigrationMaterializer'
import { createPeopleToChannelMigrationPlan } from './PeopleToChannelMigrationPlan'
import {
  PEOPLE_TO_CHANNEL_FINALIZATION_EXECUTION_VERSION,
  PeopleToChannelMigrationFinalizationExecutionStore,
  PeopleToChannelMigrationFinalizationExecutionStoreError,
  createPeopleToChannelMigrationFinalizationExecution,
  type PeopleToChannelMigrationFinalizationExecution
} from './PeopleToChannelMigrationFinalizationExecutionStore'

const directories: string[] = []

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'taskwraith-channel-finalization-execution-'))
  directories.push(path)
  return path
}

afterEach(() => {
  for (const path of directories.splice(0)) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      // Best effort test cleanup.
    }
  }
})

function safeStorage(available = true): HumanCollaborationSafeStorage {
  const key = 0x6d
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(Buffer.from(plain, 'utf8').map((byte) => byte ^ key)),
    decryptString: (encrypted) =>
      Buffer.from(Buffer.from(encrypted).map((byte) => byte ^ key)).toString('utf8')
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)])
  )
}

function planDigest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)), 'utf8')
    .digest('hex')
}

function delta(hostDisplayName = 'Private Host Person'): PeopleToChannelMigrationExecution {
  const source = {
    hostIdentityPublicKey: Buffer.alloc(32, 7).toString('base64'),
    people: { shares: [] },
    channels: { schemaVersion: 4 as const, channels: [], members: [], invites: [] },
    chats: [
      {
        chatId: 'chat_private',
        title: 'Private migration title',
        scope: 'global' as const,
        legacyContributions: []
      }
    ]
  }
  const plan = createPeopleToChannelMigrationPlan(source)
  const base = materializePeopleToChannels({
    plan,
    source,
    hostDisplayName,
    migrationAt: 2_000
  })
  const history = materializePeopleToChannelMigrationHistory({
    plan,
    base,
    donorChats: [
      {
        appChatId: 'chat_private',
        title: 'Private migration title',
        scope: 'global',
        chatKind: 'single',
        messages: []
      }
    ],
    existingLogs: [],
    legacyProjectionHistory: 'import-then-reset'
  })
  return {
    schemaVersion: PEOPLE_TO_CHANNEL_EXECUTION_STORE_VERSION,
    planDigest: planDigest(plan),
    hostDisplayName,
    plan,
    base,
    history
  }
}

function execution(
  hostDisplayName = 'Private Host Person'
): PeopleToChannelMigrationFinalizationExecution {
  return createPeopleToChannelMigrationFinalizationExecution({
    schemaVersion: PEOPLE_TO_CHANNEL_FINALIZATION_EXECUTION_VERSION,
    initialPlanId: 'a'.repeat(64),
    initialPlanDigest: 'b'.repeat(64),
    channelStateDigest: 'c'.repeat(64),
    cutoverStateDigest: 'd'.repeat(64),
    delta: delta(hostDisplayName)
  })
}

describe('PeopleToChannelMigrationFinalizationExecutionStore', () => {
  it('encrypts the terminal delta and permits replacement only before the recovery fence', () => {
    const userDataPath = directory()
    let durableWrites = 0
    const store = new PeopleToChannelMigrationFinalizationExecutionStore({
      userDataPath,
      safeStorage: safeStorage(),
      afterDurableWrite: () => {
        durableWrites += 1
      }
    })
    const first = execution()
    const replacement = execution('Different Private Host')

    expect(store.prepareBeforeRecoveryFence(first)).toMatchObject({
      replaced: true,
      finalizationDigest: first.finalizationDigest,
      payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    expect(store.prepareBeforeRecoveryFence(first)).toMatchObject({ replaced: false })
    expect(store.prepareBeforeRecoveryFence(replacement)).toMatchObject({
      replaced: true,
      finalizationDigest: replacement.finalizationDigest
    })
    expect(store.load()).toEqual(replacement)
    expect(durableWrites).toBe(2)
    expect(statSync(store.path).mode & 0o777).toBe(0o600)
    expect(statSync(join(userDataPath, 'channels', 'people-to-channel-v1')).mode & 0o777).toBe(
      0o700
    )

    expect(
      store.loadForRecoveryFence({
        initialPlanId: replacement.initialPlanId,
        initialPlanDigest: replacement.initialPlanDigest,
        finalizationDigest: replacement.finalizationDigest
      })
    ).toEqual(replacement)
    expect(() =>
      store.loadForRecoveryFence({
        initialPlanId: first.initialPlanId,
        initialPlanDigest: first.initialPlanDigest,
        finalizationDigest: first.finalizationDigest
      })
    ).toThrow(/does not match the recovery fence/)

    const atRest = readFileSync(store.path, 'utf8')
    for (const secret of [
      'Private migration title',
      'Different Private Host',
      replacement.delta.base.mutations[0].channel.channelId
    ]) {
      expect(atRest).not.toContain(secret)
    }
  })

  it('keeps a post-publish crash restartable through the exact recovery fence', () => {
    const userDataPath = directory()
    const expected = execution()
    const crash = new Error('injected crash after finalization execution durable')
    const crashing = new PeopleToChannelMigrationFinalizationExecutionStore({
      userDataPath,
      safeStorage: safeStorage(),
      afterDurableWrite: () => {
        throw crash
      }
    })

    expect(() => crashing.prepareBeforeRecoveryFence(expected)).toThrow(crash)

    const resumed = new PeopleToChannelMigrationFinalizationExecutionStore({
      userDataPath,
      safeStorage: safeStorage()
    })
    expect(
      resumed.loadForRecoveryFence({
        initialPlanId: expected.initialPlanId,
        initialPlanDigest: expected.initialPlanDigest,
        finalizationDigest: expected.finalizationDigest
      })
    ).toEqual(expected)
  })

  it('fails closed before persistence when encryption is unavailable', () => {
    const store = new PeopleToChannelMigrationFinalizationExecutionStore({
      userDataPath: directory(),
      safeStorage: safeStorage(false)
    })

    expect(() => store.prepareBeforeRecoveryFence(execution())).toThrow(
      PeopleToChannelMigrationFinalizationExecutionStoreError
    )
    expect(() => store.prepareBeforeRecoveryFence(execution())).toThrow(/encryption is unavailable/)
    expect(existsSync(store.path)).toBe(false)
  })

  it('rejects tampered, hard-linked, and permissive terminal checkpoint files', () => {
    const store = new PeopleToChannelMigrationFinalizationExecutionStore({
      userDataPath: directory(),
      safeStorage: safeStorage()
    })
    store.prepareBeforeRecoveryFence(execution())

    const original = readFileSync(store.path, 'utf8')
    const parsed = JSON.parse(original) as { payloadDigest: string }
    parsed.payloadDigest = 'f'.repeat(64)
    writeFileSync(store.path, JSON.stringify(parsed), 'utf8')
    expect(() => store.load()).toThrow(/payload digest does not match/)

    writeFileSync(store.path, original, { mode: 0o600 })
    const alias = `${store.path}.alias`
    linkSync(store.path, alias)
    expect(() => store.load()).toThrow(/path is unsafe/)
    unlinkSync(alias)

    chmodSync(store.path, 0o644)
    expect(() => store.load()).toThrow(/path is unsafe/)
    expect(statSync(store.path).mode & 0o777).toBe(0o644)
  })
})
