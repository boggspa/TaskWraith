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
import { materializePeopleToChannelMigrationHistory } from './PeopleToChannelMigrationHistory'
import { materializePeopleToChannels } from './PeopleToChannelMigrationMaterializer'
import { createPeopleToChannelMigrationPlan } from './PeopleToChannelMigrationPlan'
import {
  PEOPLE_TO_CHANNEL_EXECUTION_STORE_VERSION,
  PeopleToChannelMigrationExecutionStore,
  PeopleToChannelMigrationExecutionStoreError,
  type PeopleToChannelMigrationExecution
} from './PeopleToChannelMigrationExecutionStore'

const directories: string[] = []

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'taskwraith-channel-execution-'))
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
  const key = 0x5a
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

function execution(): PeopleToChannelMigrationExecution {
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
    hostDisplayName: 'Private Host Person',
    migrationAt: 1_000
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
    hostDisplayName: 'Private Host Person',
    plan,
    base,
    history
  }
}

describe('PeopleToChannelMigrationExecutionStore', () => {
  it('persists one private encrypted execution and reloads it byte-for-byte', () => {
    const userDataPath = directory()
    let durableWrites = 0
    const store = new PeopleToChannelMigrationExecutionStore({
      userDataPath,
      safeStorage: safeStorage(),
      afterDurableWrite: () => {
        durableWrites += 1
      }
    })
    const expected = execution()

    expect(store.persist(expected)).toMatchObject({
      created: true,
      payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    expect(store.load()).toEqual(expected)
    expect(store.persist(expected)).toMatchObject({ created: false })
    expect(durableWrites).toBe(1)
    if (process.platform !== 'win32') {
      expect(statSync(store.path).mode & 0o777).toBe(0o600)
      expect(statSync(join(userDataPath, 'channels', 'people-to-channel-v1')).mode & 0o777).toBe(
        0o700
      )
    }

    const atRest = readFileSync(store.path, 'utf8')
    for (const secret of [
      'Private migration title',
      'Private Host Person',
      expected.base.mutations[0].channel.channelId
    ]) {
      expect(atRest).not.toContain(secret)
    }
  })

  it('keeps a post-publish crash resumable and rejects a conflicting execution', () => {
    const userDataPath = directory()
    const crash = new Error('injected crash after execution durable')
    const crashing = new PeopleToChannelMigrationExecutionStore({
      userDataPath,
      safeStorage: safeStorage(),
      afterDurableWrite: () => {
        throw crash
      }
    })
    const expected = execution()
    expect(() => crashing.persist(expected)).toThrow(crash)

    const resumed = new PeopleToChannelMigrationExecutionStore({
      userDataPath,
      safeStorage: safeStorage()
    })
    expect(resumed.load()).toEqual(expected)
    expect(resumed.persist(expected)).toMatchObject({ created: false })
    expect(() =>
      resumed.persist({ ...expected, hostDisplayName: 'Different Host Person' })
    ).toThrow(/different People migration execution/)
  })

  it('fails closed before persistence when encryption is unavailable', () => {
    const store = new PeopleToChannelMigrationExecutionStore({
      userDataPath: directory(),
      safeStorage: safeStorage(false)
    })
    expect(() => store.persist(execution())).toThrow(PeopleToChannelMigrationExecutionStoreError)
    expect(() => store.persist(execution())).toThrow(/encryption is unavailable/)
    expect(existsSync(store.path)).toBe(false)
  })

  it('rejects tampered, hard-linked, and permissive checkpoint files', () => {
    const userDataPath = directory()
    const store = new PeopleToChannelMigrationExecutionStore({
      userDataPath,
      safeStorage: safeStorage()
    })
    store.persist(execution())

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

    if (process.platform !== 'win32') {
      chmodSync(store.path, 0o644)
      expect(() => store.load()).toThrow(/path is unsafe/)
      expect(statSync(store.path).mode & 0o777).toBe(0o644)
    }
  })
})
