import * as fs from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ThreadAuthorityFiles,
  type ThreadAuthorityFs,
  type ThreadWriterLiveness
} from '../host-shared/thread-log/ThreadAuthorityFile'
import type { ThreadOwnershipReservation } from '../host-shared/thread-log/ThreadOwnership'
import { HostThreadOwnerRegistry } from './HostThreadOwnerRegistry'
import { threadPublicationAuthorityWitness } from './HostThreadPublicationGuard'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((profile) => fs.rm(profile, { recursive: true, force: true }))
  )
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture() {
  const profile = mkdtempSync(join(tmpdir(), 'orphan-custody-'))
  directories.push(profile)
  const state = {
    liveness: 'dead' as ThreadWriterLiveness,
    authority: true,
    erasing: false,
    generation: 'generation-1',
    full: 3 as number | null,
    log: 3 as number | null,
    failSync: false,
    onSync: null as null | (() => Promise<void>),
    syncs: 0
  }
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
      if (state.onSync) await state.onSync()
      if (state.failSync) {
        state.failSync = false
        throw new Error('directory sync failed')
      }
      if (process.platform === 'win32') return
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
    threadId: 'chat',
    writer: { writerId: 'dead-writer', pid: 12345 },
    epoch: { host: 'old-host', grant: 1 },
    grantedAtRevision: 1,
    grantedAt: 123
  }
  await files.write(mark)
  const options = {
    incarnation: 'current-host',
    enabled: true,
    files,
    fullCopyRevision: () => state.full,
    logRevision: async () => state.log,
    hostRunActive: () => false,
    desktopPresence: () => 'attached' as const,
    otherDesktopUnattached: () => false,
    publicationWitness: (id: string) => threadPublicationAuthorityWitness(profile, id),
    liveness: () => state.liveness,
    erasing: () => state.erasing,
    erasureGeneration: () => state.generation,
    assertProfileAuthority: () => {
      if (!state.authority) throw new Error('lease lost')
    }
  }
  const registry = new HostThreadOwnerRegistry(options)
  const reserve = async () => {
    const handle = await registry.reserveOwnership('chat')
    if (!handle) throw new Error('expected reservation')
    return handle
  }
  return { files, mark, options, registry, state, reserve }
}

describe('opaque orphan custody over real authority files', () => {
  it('excludes claims, Host writes and publications until explicit release, including after retirement', async () => {
    const h = await fixture()
    const reservation = await h.reserve()
    expect(await h.registry.reserveOwnership('chat')).toBeNull()
    expect(
      await h.registry.claim({
        action: 'claim',
        threadId: 'chat',
        writerId: 'new-writer',
        claimId: 1,
        baseRevision: 3,
        headRevision: 3
      })
    ).toMatchObject({ granted: false })
    expect(await h.registry.requestHostWrite('chat', 0)).toMatchObject({ kind: 'busy' })
    let published = false
    expect(
      await h.registry.publishFullCopy('chat', { owner: null, isCurrent: () => true }, () => {
        published = true
        return 1
      })
    ).toMatchObject({ kind: 'refused' })
    expect(published).toBe(false)
    expect(await h.registry.retireOrphanAuthority('chat', reservation)).toEqual({ kind: 'retired' })
    expect(await h.registry.requestHostWrite('chat', 0)).toMatchObject({ kind: 'busy' })
    expect(h.registry.releaseOwnership(reservation)).toBe(true)
    expect(() => reservation.revalidate()).toThrow(/not_minted/)
    expect(await h.registry.requestHostWrite('chat', 0)).toEqual({ kind: 'write' })
  })

  it('does not accept a copied or cross-registry handle with identical fields', async () => {
    const h = await fixture()
    const handle = await h.reserve()
    const copied = { ...handle } as ThreadOwnershipReservation
    expect(await h.registry.retireOrphanAuthority('chat', copied)).toEqual({
      kind: 'busy',
      reason: 'damaged'
    })
    expect(h.registry.releaseOwnership(copied)).toBe(false)
    const other = new HostThreadOwnerRegistry(h.options)
    expect(await other.retireOrphanAuthority('chat', handle)).toEqual({
      kind: 'busy',
      reason: 'damaged'
    })
    expect((await h.files.read('chat')).kind).toBe('held')
  })

  it('keeps exact custody for failed-sync retry and does not accept bare absence', async () => {
    const h = await fixture()
    const handle = await h.reserve()
    h.state.failSync = true
    expect(await h.registry.retireOrphanAuthority('chat', handle)).toEqual({
      kind: 'uncertain',
      reason: 'sync_failed'
    })
    expect((await h.files.read('chat')).kind).toBe('none')
    expect(h.registry.releaseOwnership(handle)).toBe(false)
    const before = h.state.syncs
    expect(await h.registry.retireOrphanAuthority('chat', { ...handle })).toMatchObject({
      kind: 'busy'
    })
    expect(h.state.syncs).toBe(before)
    expect(await h.registry.retireOrphanAuthority('chat', handle)).toEqual({ kind: 'retired' })
    expect(h.state.syncs).toBeGreaterThan(before)
    expect(h.registry.releaseOwnership(handle)).toBe(true)
  })

  it.each(['writer', 'profile', 'generation', 'erasing'] as const)(
    'pays a failed sync with a directory sync alone and still reports a %s change',
    async (change) => {
      const h = await fixture()
      const handle = await h.reserve()
      h.state.failSync = true
      expect(await h.registry.retireOrphanAuthority('chat', handle)).toMatchObject({
        reason: 'sync_failed'
      })
      // A revalidation after the unlink binds everything but the witness, so
      // the owed custody is still usable rather than locked behind mark_moved.
      expect(() => handle.revalidate()).not.toThrow()
      if (change === 'writer') h.state.liveness = 'alive'
      if (change === 'profile') h.state.authority = false
      if (change === 'generation') h.state.generation = 'generation-2'
      if (change === 'erasing') h.state.erasing = true
      h.state.failSync = false
      const before = h.state.syncs
      expect(await h.registry.retireOrphanAuthority('chat', handle)).toMatchObject({ kind: 'busy' })
      // The sync names nothing, so it needs no validation: the debt is paid
      // and custody becomes releasable even though the change is reported.
      expect(h.state.syncs).toBeGreaterThan(before)
      expect(h.registry.releaseOwnership(handle)).toBe(true)
    }
  )

  it('joins directory sync with custody and revalidates a writer that revives while it waits', async () => {
    const h = await fixture()
    const handle = await h.reserve()
    const entered = deferred(),
      finish = deferred()
    h.state.onSync = async () => {
      entered.resolve()
      await finish.promise
    }
    const retirement = h.registry.retireOrphanAuthority('chat', handle)
    await entered.promise
    expect(h.registry.releaseOwnership(handle)).toBe(false)
    h.state.liveness = 'alive'
    finish.resolve()
    expect(await retirement).toEqual({ kind: 'busy', reason: 'live_writer' })
    expect(() => handle.revalidate()).toThrow(/writer_alive/)
  })

  it('distinguishes a replacement mark from absence after sync', async () => {
    const h = await fixture()
    const handle = await h.reserve()
    h.state.onSync = async () => {
      h.state.onSync = null
      await h.files.write({ ...h.mark, epoch: { host: 'replacement', grant: 2 } })
    }
    expect(await h.registry.retireOrphanAuthority('chat', handle)).toEqual({
      kind: 'uncertain',
      reason: 'witness_changed'
    })
    expect(await h.files.read('chat')).toMatchObject({
      kind: 'held',
      record: { epoch: { host: 'replacement' } }
    })
    // A retry reports what stands and never reaches the replacement mark.
    expect(await h.registry.retireOrphanAuthority('chat', handle)).toEqual({
      kind: 'uncertain',
      reason: 'witness_changed'
    })
    expect(await h.files.read('chat')).toMatchObject({
      kind: 'held',
      record: { epoch: { host: 'replacement' } }
    })
    expect(h.registry.releaseOwnership(handle)).toBe(true)
  })

  it('pays a sync debt without unlinking a mark written after the failed sync', async () => {
    const h = await fixture()
    const handle = await h.reserve()
    h.state.failSync = true
    expect(await h.registry.retireOrphanAuthority('chat', handle)).toEqual({
      kind: 'uncertain',
      reason: 'sync_failed'
    })
    await h.files.write({ ...h.mark, epoch: { host: 'replacement', grant: 3 } })
    h.state.failSync = false
    expect(await h.registry.retireOrphanAuthority('chat', handle)).toEqual({
      kind: 'uncertain',
      reason: 'witness_changed'
    })
    expect(await h.files.read('chat')).toMatchObject({
      kind: 'held',
      record: { epoch: { host: 'replacement', grant: 3 } }
    })
    expect(h.registry.releaseOwnership(handle)).toBe(true)
  })

  it('answers ownership only for the exact handle it minted and still holds', async () => {
    const h = await fixture()
    const handle = await h.reserve()
    expect(h.registry.ownsReservation(handle)).toBe(true)
    expect(h.registry.ownsReservation({ ...handle })).toBe(false)
    expect(h.registry.releaseOwnership(handle)).toBe(true)
    expect(h.registry.ownsReservation(handle)).toBe(false)
  })

  it('does not retire when the full copy is missing or still behind the log', async () => {
    const h = await fixture()
    const handle = await h.reserve()
    h.state.full = null
    expect(await h.registry.retireOrphanAuthority('chat', handle)).toMatchObject({ kind: 'busy' })
    h.state.full = 2
    expect(await h.registry.retireOrphanAuthority('chat', handle)).toMatchObject({ kind: 'busy' })
    expect((await h.files.read('chat')).kind).toBe('held')
  })

  it('does not let unrelated attached desktop presence excuse unresolved writer liveness', async () => {
    const h = await fixture()
    h.state.liveness = 'unresolved'
    expect(await h.registry.reserveOwnership('chat')).toBeNull()
  })
})
