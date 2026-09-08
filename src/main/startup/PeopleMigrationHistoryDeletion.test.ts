import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createPeopleMigrationHistoryDeletion,
  purgePeopleMigrationForGlobalDeletion
} from './PeopleMigrationHistoryDeletion'
import {
  acquirePeopleMigrationLease,
  assertNoPeopleMigrationDeletion,
  releasePeopleMigrationLease
} from './PeopleMigrationHelperLease'
import { HumanCollaborationStore } from '../collaboration/HumanCollaborationStore'
import { forwardingPeopleMigrationGate } from './ThreadCataloguePeopleMigration'

let profile: string
beforeEach(() => {
  profile = fs.mkdtempSync(join(tmpdir(), 'taskwraith-migration-erase-'))
})
afterEach(() => {
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('migration recovery deletion boundaries', () => {
  it('finishes initial scoped migration without joining its own startup barrier, but refuses a later degraded migration', async () => {
    const events: string[] = []
    const pending = { operationId: 'erase', kind: 'workspace' as const, chatIds: ['chat'] }
    const runMigration = vi.fn(async (scope) => {
      expect(scope).toEqual(pending)
      events.push('migration')
    })
    const options = {
      profilePath: profile,
      initialRecovery: () => true,
      ready: new Promise<void>(() => {}),
      service: () => undefined,
      pending: () => pending,
      runMigration,
      reload: () => {
        events.push('reload')
      },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => {
          throw new Error('crypto trap')
        },
        decryptString: () => {
          throw new Error('crypto trap')
        }
      }
    }
    await expect(createPeopleMigrationHistoryDeletion(options)(pending)).resolves.toMatchObject({
      kind: 'workspace',
      purgedChannelIds: []
    })
    expect(events[0]).toBe('migration')
    expect(events[1]).toBe('reload')
    runMigration.mockClear()
    await expect(
      createPeopleMigrationHistoryDeletion({
        ...options,
        ready: Promise.resolve(),
        initialRecovery: () => false
      })(pending)
    ).rejects.toThrow('authority is unavailable')
    expect(runMigration).not.toHaveBeenCalled()
  })

  it('removes global migration copies even when the live Channel service owns the purge', async () => {
    const root = join(profile, 'channels', 'people-to-channel-v1')
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(join(root, 'execution.json'), 'opaque')
    const pending = { operationId: 'erase', kind: 'global' as const, chatIds: [] }
    const purge = vi.fn(async () => {
      expect(fs.existsSync(root)).toBe(false)
      return { purgedChannelIds: ['old'] }
    })
    const runMigration = vi.fn()
    const erase = createPeopleMigrationHistoryDeletion({
      profilePath: profile,
      initialRecovery: () => false,
      ready: Promise.resolve(),
      pending: () => pending,
      service: () => ({
        status: () => ({ state: 'running' }),
        purgeForHistoryDeletionScope: purge
      }),
      runMigration,
      reload: vi.fn(),
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => {
          throw new Error('crypto trap')
        },
        decryptString: () => {
          throw new Error('crypto trap')
        }
      }
    })
    expect(await erase(pending)).toEqual({ purgedChannelIds: ['old'] })
    expect(runMigration).not.toHaveBeenCalled()
  })

  it('globally erases every recovery copy without decrypting it or removing the identity key', async () => {
    const root = join(profile, 'channels', 'people-to-channel-v1')
    fs.mkdirSync(join(root, 'backups'), { recursive: true })
    for (const file of [
      'execution.json',
      'finalization-execution.json',
      'intent.json',
      'admissions.json',
      'backups/source'
    ])
      fs.writeFileSync(join(root, file), 'opaque encrypted migration payload')
    const identity = join(profile, 'human-collaboration-identity.json')
    fs.writeFileSync(identity, 'identity retained')
    let pending = { operationId: 'erase', kind: 'workspace' }
    const erase = () =>
      purgePeopleMigrationForGlobalDeletion({
        profilePath: profile,
        operationId: 'erase',
        pending: () => pending
      })
    expect(erase).toThrow('exact pending global')
    expect(fs.existsSync(root)).toBe(true)
    pending = { operationId: 'erase', kind: 'global' }
    const lease = await acquirePeopleMigrationLease(profile)
    expect(erase).toThrow('still has an owner')
    releasePeopleMigrationLease(lease)
    erase()
    expect(fs.existsSync(root)).toBe(false)
    expect(fs.readFileSync(identity, 'utf8')).toBe('identity retained')
    expect(erase).not.toThrow()
  })

  it('admits only the immutable scoped deletion while ordinary migration still refuses any intent', () => {
    const scope = { operationId: 'erase', kind: 'workspace' as const, chatIds: ['b', 'a'] }
    const path = join(profile, 'history-deletion-intent.json')
    fs.writeFileSync(path, JSON.stringify({ ...scope, chatIds: ['a', 'b'], phase: 'prepared' }))
    expect(() => assertNoPeopleMigrationDeletion(profile)).toThrow('History deletion')
    expect(() => assertNoPeopleMigrationDeletion(profile, scope)).not.toThrow()
    for (const changed of [
      { ...scope, kind: 'global' },
      { ...scope, chatIds: ['a'] },
      { ...scope, operationId: 'other' }
    ]) {
      fs.writeFileSync(path, JSON.stringify(changed))
      expect(() => assertNoPeopleMigrationDeletion(profile, scope)).toThrow('History deletion')
    }
    fs.unlinkSync(path)
    expect(() => assertNoPeopleMigrationDeletion(profile, scope)).toThrow()
    expect(() => assertNoPeopleMigrationDeletion(profile)).not.toThrow()
  })

  it('retains the People erasure work after failed persistence, then retries the actual disk write', () => {
    const path = join(profile, 'people.json')
    const initial = new HumanCollaborationStore(path)
    initial.createShare({ chatId: 'erase', mode: 'comments', now: 1 })
    const gate = forwardingPeopleMigrationGate()
    const scope = { operationId: 'erase', kind: 'global' as const, chatIds: [] }
    const store = new HumanCollaborationStore(path, {
      legacyWriteGate: gate.gate,
      getHistoryDeletionScope: () => scope
    })
    fs.mkdirSync(path + '.tmp')
    expect(() => store.purgeForHistoryDeletionScope(scope)).toThrow()
    expect(store.listShares()).toHaveLength(1)
    expect(new HumanCollaborationStore(path).listShares()).toHaveLength(1)
    fs.rmdirSync(path + '.tmp')
    expect(store.purgeForHistoryDeletionScope(scope)).toBe(1)
    expect(new HumanCollaborationStore(path).listShares()).toHaveLength(0)
    expect(() => store.createShare({ chatId: 'new', mode: 'comments' })).toThrow('still loading')
  })
})
