/**
 * The orphan fold's custody joins over real components: the Host owner
 * registry minting custody over real authority files, the recovery
 * controller checking that custody is minted and holding the thread, and the
 * orchestrator paying a failed directory sync. Only the catalogue's hold
 * storage and the worker client are in memory.
 */
import * as fs from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { HostThreadOwnerRegistry } from '../host-runtime/HostThreadOwnerRegistry'
import { threadPublicationAuthorityWitness } from '../host-runtime/HostThreadPublicationGuard'
import type { ThreadCatalogueRecoveryHold } from '../host-shared/thread-catalogue/ThreadCatalogue'
import { ThreadCatalogueRecoveryController } from '../host-shared/thread-catalogue/ThreadCatalogueRecoveryController'
import {
  ThreadAuthorityFiles,
  type ThreadAuthorityFs
} from '../host-shared/thread-log/ThreadAuthorityFile'
import { ThreadOrphanFoldRecovery } from './ThreadOrphanFoldRecovery'

const CHAT = 'chat'
const INCARNATION = 'current-host'
const TEMPORARY_PREFIX = 'orphan-fold-joins-'
const profiles: string[] = []
const disposers: Array<() => void> = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose()
  await Promise.all(
    profiles.splice(0).map((profile) => {
      if (!path.basename(profile).startsWith(TEMPORARY_PREFIX)) throw new Error('refusing')
      return fs.rm(profile, { recursive: true, force: true })
    })
  )
})

function catalogueHolds() {
  const holds = new Map<string, ThreadCatalogueRecoveryHold>()
  let recorded = 0
  return {
    holds,
    recorded: () => recorded,
    recoveryHolds: () => [...holds.values()],
    unreadableRecoveryHoldChatIds: () => [] as string[],
    releaseUnreadableRecoveryHold: () => false,
    holdRecovery: (hold: ThreadCatalogueRecoveryHold) => {
      if (holds.has(hold.chatId)) throw new Error('a hold is already recorded for this chat')
      recorded += 1
      holds.set(hold.chatId, hold)
    },
    recoveryHold: (chatId: string) => holds.get(chatId) ?? null,
    releaseRecoveryHold: (chatId: string, token: string) => {
      const held = holds.get(chatId)
      if (!held || held.token !== token) return false
      holds.delete(chatId)
      return true
    },
    currentRegisteredWriter: (kind: 'desktop' | 'host') =>
      kind === 'host' ? { writerId: INCARNATION } : null
  }
}

async function joins() {
  const profile = mkdtempSync(path.join(tmpdir(), TEMPORARY_PREFIX))
  profiles.push(profile)
  const state = { failSync: 0, syncs: 0, full: 3, log: 3 }
  const port: ThreadAuthorityFs = {
    mkdir: (directory) => fs.mkdir(directory, { recursive: true, mode: 0o700 }),
    create: async (file) => {
      const handle = await fs.open(file, 'w', 0o600)
      return {
        write: (text) => handle.writeFile(text),
        sync: () => handle.sync(),
        close: () => handle.close()
      }
    },
    rename: fs.rename,
    unlink: fs.unlink,
    readFile: async (file, limit) => (await fs.readFile(file, 'utf8')).slice(0, limit),
    readdir: (directory) => fs.readdir(directory),
    syncDirectory: async (directory) => {
      state.syncs += 1
      if (state.failSync > 0) {
        state.failSync -= 1
        throw new Error('directory sync failed')
      }
      const handle = await fs.open(directory, 'r')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
  }
  const files = new ThreadAuthorityFiles(profile, port)
  const mark = {
    threadId: CHAT,
    writer: { writerId: 'dead-writer', pid: 12345 },
    epoch: { host: 'old-host', grant: 1 },
    grantedAtRevision: 1,
    grantedAt: 123
  }
  await files.write(mark)
  const registry = new HostThreadOwnerRegistry({
    incarnation: INCARNATION,
    enabled: true,
    files,
    fullCopyRevision: () => state.full,
    logRevision: async () => state.log,
    hostRunActive: () => false,
    desktopPresence: () => 'attached' as const,
    otherDesktopUnattached: () => false,
    publicationWitness: (id: string) => threadPublicationAuthorityWitness(profile, id),
    liveness: () => 'dead',
    erasing: () => false,
    erasureGeneration: () => 'generation-1',
    assertProfileAuthority: () => undefined
  })
  const catalogue = catalogueHolds()
  const queries: string[] = []
  const client = {
    query: async <T>(query: { method: string }): Promise<T> => {
      queries.push(query.method)
      throw new Error(`no worker in this test: ${query.method}`)
    }
  }
  const controller = new ThreadCatalogueRecoveryController({
    client,
    publisher: {
      catalogue: catalogue as never,
      begin: () => ({}) as never,
      finishProjection: () => undefined,
      fail: () => undefined,
      canRecover: () => true
    },
    reader: {} as never,
    incarnation: INCARNATION,
    assertAuthority: () => undefined,
    hasLiveWork: () => false,
    ownsReservation: (reservation) => registry.ownsReservation(reservation)
  })
  const fold = new ThreadOrphanFoldRecovery({
    client,
    recovery: controller,
    owners: {
      reserveOrphanOwnership: (id) => registry.reserveOwnership(id),
      retireOrphanAuthority: (id, reservation) => registry.retireOrphanAuthority(id, reservation),
      releaseOrphanOwnership: (reservation) => registry.releaseOwnership(reservation)
    },
    // No log files: the mark is caught up, so the fold goes straight to retirement.
    logDirectory: path.join(profile, 'chat-journal-v2'),
    fullCopyRevision: () => state.full,
    profileAuthority: `host-incarnation:${INCARNATION}`
  })
  disposers.push(
    () => fold.dispose(),
    () => controller.dispose()
  )
  return { files, mark, registry, catalogue, controller, fold, state, queries }
}

describe('orphan fold custody joins over real components', () => {
  it('keeps custody across a failed directory sync, pays it without a hold, then frees the thread', async () => {
    const h = await joins()
    // remove(): the unlink's directory sync fails.
    h.state.failSync = 1
    expect(await h.fold.foldOrphan(CHAT)).toEqual({ kind: 'unresolved', reason: 'sync_failed' })
    expect((await h.files.read(CHAT)).kind).toBe('none')
    // The hold ended; custody did not: nothing else may take the thread yet.
    expect(h.catalogue.holds.size).toBe(0)
    expect(await h.registry.reserveOwnership(CHAT)).toBeNull()
    expect(await h.registry.requestHostWrite(CHAT, 0)).toMatchObject({ kind: 'busy' })

    const recorded = h.catalogue.recorded()
    const syncs = h.state.syncs
    expect(await h.fold.foldOrphan(CHAT)).toEqual({ kind: 'folded' })
    // Paid with a directory sync alone, under no new catalogue hold.
    expect(h.state.syncs).toBe(syncs + 1)
    expect(h.catalogue.recorded()).toBe(recorded)
    expect(await h.registry.requestHostWrite(CHAT, 0)).toEqual({ kind: 'write' })
    expect(h.queries).toEqual([])
  })

  it('pays a sync debt without unlinking a mark written after it, and still frees custody', async () => {
    const h = await joins()
    h.state.failSync = 1
    expect(await h.fold.foldOrphan(CHAT)).toEqual({ kind: 'unresolved', reason: 'sync_failed' })
    const replacement = { ...h.mark, epoch: { host: INCARNATION, grant: 7 } }
    await h.files.write(replacement)
    expect(await h.fold.foldOrphan(CHAT)).toEqual({
      kind: 'unresolved',
      reason: 'witness_changed'
    })
    expect(await h.files.read(CHAT)).toMatchObject({
      kind: 'held',
      record: { epoch: { host: INCARNATION, grant: 7 } }
    })
    // Released: a fresh reservation is a decision of its own again.
    expect(await h.registry.reserveOwnership(CHAT)).not.toBeNull()
  })

  it('refuses a copy of minted custody at the controller, and an ordinary pending Host hold', async () => {
    const h = await joins()
    const minted = await h.registry.reserveOwnership(CHAT)
    expect(minted).not.toBeNull()
    expect(h.controller.beginOrphanViaReservation(CHAT, { ...minted! })).toEqual({
      kind: 'busy',
      reason: 'damaged'
    })
    expect(h.registry.releaseOwnership(minted!)).toBe(true)

    const ordinary = h.controller.beginHost(CHAT)
    expect(await h.fold.foldOrphan(CHAT)).toEqual({ kind: 'deferred' })
    expect(h.catalogue.recoveryHold(CHAT)).toEqual(ordinary)
    expect((await h.files.read(CHAT)).kind).toBe('held')
    // The deferred attempt released its custody.
    expect(await h.registry.reserveOwnership(CHAT)).not.toBeNull()
  })
})
