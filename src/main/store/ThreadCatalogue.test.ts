import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ThreadCatalogue,
  THREAD_CATALOGUE_MAX_HEAD_BYTES,
  type ThreadCatalogueProjection,
  type ThreadCatalogueTicket,
  type ThreadCatalogueWriter
} from './ThreadCatalogue'

function projection(chatId = 'chat', revision = 1): ThreadCatalogueProjection {
  return {
    revision,
    summary: {
      chatId,
      title: 'History',
      provider: 'claude',
      chatKind: 'single',
      scope: 'global',
      createdAt: 1,
      updatedAt: 2,
      archived: false,
      messageCount: 10_000,
      runCount: 1_000
    },
    recovery: {
      unsettledRuns: 0,
      ensembleWakeups: 0,
      soloWakeups: 0,
      workerEvents: 0,
      joinPolicies: 0,
      nextBlackboardExpiryAt: null
    }
  }
}

describe('durable thread catalogue publication', () => {
  let profile: string
  let witness: string
  let writable: boolean
  let retired: Set<string>
  let provenDurability: Set<string>
  let beforeRename: ((file: string) => void) | undefined
  let afterRename: ((file: string) => void) | undefined
  let beforeSync: ((directory: string) => void) | undefined
  let openTemporary: ((file: string) => number) | undefined

  function catalogue(
    writer: ThreadCatalogueWriter = 'desktop',
    writerId = `${writer}-1`
  ): ThreadCatalogue {
    return new ThreadCatalogue({
      profilePath: profile,
      writer,
      writerId,
      canWrite: () => writable,
      writerLifecycle: (_lane, id) => (retired.has(id) ? 'retired' : 'active'),
      canPublishResolution: () => writer === 'desktop',
      canErase: () => writable && writer === 'desktop',
      canManageRecoveryHolds: () => writer === 'desktop',
      isSourceDurabilityProven: (_chatId, _epoch, id) => provenDurability.has(id),
      isIndexedGenerationCommitted: () => true,
      openTemporaryFile: (file) => openTemporary?.(file) ?? fs.openSync(file, 'wx', 0o600),
      beforeAtomicRename: (file) => beforeRename?.(file),
      afterAtomicRename: (file) => afterRename?.(file),
      beforeDirectorySync: (directory) => beforeSync?.(directory),
      isSourceWitnessCurrent: (_chatId, expected) => expected === witness
    })
  }

  function finish(store: ThreadCatalogue, ticket: ThreadCatalogueTicket, revision = 1): boolean {
    return store.finishPublication(
      ticket,
      {
        operationId: ticket.operationId,
        sequence: ticket.sequence,
        revision,
        sourceWitness: witness
      },
      projection(ticket.chatId, revision)
    )
  }

  function resolution(store: ThreadCatalogue, chatId = 'chat') {
    return {
      chatId,
      epoch: store.epoch(chatId),
      heads: store.sourceHeads(chatId),
      sourceWitness: witness,
      indexReference: { databaseId: 'database', generation: 'generation' },
      projection: projection(chatId)
    }
  }

  beforeEach(() => {
    profile = fs.mkdtempSync(join(tmpdir(), 'thread-catalogue-'))
    witness = 'legacy:1;journal:1;overlay:absent'
    writable = true
    retired = new Set()
    provenDurability = new Set()
    beforeRename = undefined
    afterRename = undefined
    beforeSync = undefined
    openTemporary = undefined
  })

  it('settles an aborted begin without stranding an active writer forever', () => {
    const store = catalogue()
    beforeRename = (file) => {
      if (file.endsWith(join('desktop', 'chat.json'))) throw new Error('head disk failure')
    }
    expect(() => store.beginPublication('chat')).toThrow('head disk failure')
    expect(store.repairChatIds()).toEqual(['chat'])
    beforeRename = undefined
    store.retryPublication('chat')
    expect(store.publishResolution(resolution(store))).toBe(true)
    const row = store.read('chat')
    expect(row.status).toBe('ready')
    if (row.status !== 'ready') throw new Error('not ready')
    expect(store.acknowledgeResolution('chat', row.publicationId)).toBe(true)
    expect(store.repairChatIds()).toEqual([])
  })

  it('cannot acknowledge away a newer publication and can recreate a retired debt directory', () => {
    const source = catalogue()
    const resolver = catalogue()
    finish(source, source.beginPublication('chat'))
    expect(resolver.publishResolution(resolution(resolver))).toBe(true)
    const old = resolver.read('chat')
    if (old.status !== 'ready') throw new Error('not ready')
    expect(resolver.acknowledgeResolution('chat', old.publicationId)).toBe(true)
    const newer = source.beginPublication('chat')
    expect(resolver.acknowledgeResolution('chat', old.publicationId)).toBe(false)
    expect(resolver.repairChatIds()).toEqual(['chat'])
    expect(finish(source, newer)).toBe(true)
  })

  it('does not let repeated acknowledgements retire a newly recreated pending namespace', () => {
    const source = catalogue()
    const resolver = catalogue()
    const first = source.beginPublication('chat')
    expect(finish(source, first)).toBe(true)
    expect(resolver.publishResolution(resolution(resolver))).toBe(true)
    const initial = resolver.read('chat')
    if (initial.status !== 'ready') throw new Error('not ready')
    expect(resolver.acknowledgeResolution('chat', initial.publicationId)).toBe(true)

    const pendingDirectory = join(source.directory, 'pending', 'desktop', 'chat')
    const pendingWriterDirectory = join(source.directory, 'pending', 'desktop')
    // Normalize both implementations to a first-use directory. The injected
    // acknowledgement then lands after mkdir and before the ticket temp open.
    fs.rmSync(pendingDirectory, { recursive: true, force: true })
    let acknowledgementInterleaved = false
    beforeSync = (directory) => {
      if (directory !== pendingWriterDirectory || acknowledgementInterleaved) return
      acknowledgementInterleaved = true
      expect(resolver.acknowledgeResolution('chat', initial.publicationId)).toBe(true)
    }

    let next = source.beginPublication('chat')
    beforeSync = undefined
    expect(acknowledgementInterleaved).toBe(true)
    for (let cycle = 0; cycle < 3; cycle += 1) {
      expect(finish(source, next)).toBe(true)
      expect(resolver.publishResolution(resolution(resolver))).toBe(true)
      const ready = resolver.read('chat')
      if (ready.status !== 'ready') throw new Error('not ready')
      expect(resolver.acknowledgeResolution('chat', ready.publicationId)).toBe(true)
      expect(resolver.repairChatIds()).toEqual([])
      if (cycle < 2) next = source.beginPublication('chat')
    }
    expect(fs.existsSync(pendingDirectory)).toBe(false)
  })

  it('bounds repeated pending namespace retirement to one retry', () => {
    const source = catalogue()
    const resolver = catalogue()
    expect(finish(source, source.beginPublication('chat'))).toBe(true)
    expect(resolver.publishResolution(resolution(resolver))).toBe(true)
    const ready = resolver.read('chat')
    if (ready.status !== 'ready') throw new Error('not ready')
    expect(resolver.acknowledgeResolution('chat', ready.publicationId)).toBe(true)

    const pendingWriterDirectory = join(source.directory, 'pending', 'desktop')
    let retirements = 0
    let acknowledging = false
    beforeSync = (directory) => {
      if (directory !== pendingWriterDirectory || acknowledging) return
      retirements += 1
      acknowledging = true
      try {
        expect(resolver.acknowledgeResolution('chat', ready.publicationId)).toBe(true)
      } finally {
        acknowledging = false
      }
    }
    expect(() => source.beginPublication('chat')).toThrow(/ENOENT/)
    beforeSync = undefined

    expect(retirements).toBe(2)
    expect(source.hasOutstandingPublication('chat')).toBe(false)
    expect(resolver.repairChatIds()).toEqual([])
  })

  it('does not recreate publication state after the erased epoch has advanced', () => {
    const source = catalogue()
    const resolver = catalogue()
    const eraser = catalogue()
    expect(finish(source, source.beginPublication('chat'))).toBe(true)
    expect(resolver.publishResolution(resolution(resolver))).toBe(true)
    const ready = resolver.read('chat')
    if (ready.status !== 'ready') throw new Error('not ready')
    expect(resolver.acknowledgeResolution('chat', ready.publicationId)).toBe(true)

    const pendingDirectory = join(source.directory, 'pending', 'desktop', 'chat')
    const pendingWriterDirectory = join(source.directory, 'pending', 'desktop')
    const sourceHead = join(source.directory, 'desktop', 'chat.json')
    const resolvedHead = join(source.directory, 'resolved', 'chat.json')
    let erased = false
    beforeSync = (directory) => {
      if (directory !== pendingWriterDirectory || erased) return
      erased = true
      expect(resolver.acknowledgeResolution('chat', ready.publicationId)).toBe(true)
      const generation = eraser.beginErasure('chat')
      fs.rmSync(pendingDirectory, { recursive: true, force: true })
      fs.rmSync(sourceHead, { force: true })
      fs.rmSync(resolvedHead, { force: true })
      expect(eraser.finishErasure(generation, 'chat')).toBe(true)
    }
    expect(() => source.beginPublication('chat')).toThrow(/ENOENT/)
    beforeSync = undefined

    expect(erased).toBe(true)
    expect(source.hasOutstandingPublication('chat')).toBe(false)
    expect(fs.existsSync(pendingDirectory)).toBe(false)
    expect(fs.existsSync(sourceHead)).toBe(false)
    expect(fs.existsSync(resolvedHead)).toBe(false)
  })

  it('does not recreate the pending namespace after recovery takes a hold', () => {
    const source = catalogue()
    const resolver = catalogue()
    expect(finish(source, source.beginPublication('chat'))).toBe(true)
    expect(resolver.publishResolution(resolution(resolver))).toBe(true)
    const ready = resolver.read('chat')
    if (ready.status !== 'ready') throw new Error('not ready')
    expect(resolver.acknowledgeResolution('chat', ready.publicationId)).toBe(true)

    const pendingDirectory = join(source.directory, 'pending', 'desktop', 'chat')
    const pendingWriterDirectory = join(source.directory, 'pending', 'desktop')
    let held = false
    beforeSync = (directory) => {
      if (directory !== pendingWriterDirectory || held) return
      held = true
      expect(resolver.acknowledgeResolution('chat', ready.publicationId)).toBe(true)
      resolver.holdRecovery({
        chatId: 'chat',
        token: 'recovery-token',
        desktopWriterId: 'desktop-1',
        hostIncarnation: 'host-incarnation'
      })
    }
    expect(() => source.beginPublication('chat')).toThrow(/ENOENT/)
    beforeSync = undefined

    expect(held).toBe(true)
    expect(source.hasOutstandingPublication('chat')).toBe(false)
    expect(fs.existsSync(pendingDirectory)).toBe(false)
    expect(resolver.repairChatIds()).toEqual([])
    expect(resolver.releaseRecoveryHold('chat', 'recovery-token')).toBe(true)
    expect(resolver.publishResolution(resolution(resolver))).toBe(true)
    const repaired = resolver.read('chat')
    if (repaired.status !== 'ready') throw new Error('not ready')
    expect(resolver.acknowledgeResolution('chat', repaired.publicationId)).toBe(true)
    expect(resolver.repairChatIds()).toEqual([])
  })

  it('finalizes an issued ticket when recovery takes a hold after the pending head', () => {
    const source = catalogue()
    const resolver = catalogue()
    const sourceHead = join(source.directory, 'desktop', 'chat.json')
    let held = false
    afterRename = (file) => {
      if (file !== sourceHead || held) return
      held = true
      resolver.holdRecovery({
        chatId: 'chat',
        token: 'recovery-token',
        desktopWriterId: 'desktop-1',
        hostIncarnation: 'host-incarnation'
      })
    }
    expect(() => source.beginPublication('chat')).toThrow('recovery is in progress')
    afterRename = undefined

    expect(held).toBe(true)
    expect(source.hasOutstandingPublication('chat')).toBe(false)
    expect(resolver.repairChatIds()).toEqual(['chat'])
    expect(resolver.releaseRecoveryHold('chat', 'recovery-token')).toBe(true)
    expect(resolver.publishResolution(resolution(resolver))).toBe(true)
    const repaired = resolver.read('chat')
    if (repaired.status !== 'ready') throw new Error('not ready')
    expect(resolver.acknowledgeResolution('chat', repaired.publicationId)).toBe(true)
    expect(resolver.repairChatIds()).toEqual([])
  })

  it('does not recreate the pending namespace after its writer retires', () => {
    const source = catalogue()
    const resolver = catalogue()
    expect(finish(source, source.beginPublication('chat'))).toBe(true)
    expect(resolver.publishResolution(resolution(resolver))).toBe(true)
    const ready = resolver.read('chat')
    if (ready.status !== 'ready') throw new Error('not ready')
    expect(resolver.acknowledgeResolution('chat', ready.publicationId)).toBe(true)

    const pendingDirectory = join(source.directory, 'pending', 'desktop', 'chat')
    const pendingWriterDirectory = join(source.directory, 'pending', 'desktop')
    let writerRetired = false
    beforeSync = (directory) => {
      if (directory !== pendingWriterDirectory || writerRetired) return
      expect(resolver.acknowledgeResolution('chat', ready.publicationId)).toBe(true)
      retired.add('desktop-1')
      writerRetired = true
    }
    expect(() => source.beginPublication('chat')).toThrow(/ENOENT/)
    beforeSync = undefined

    expect(writerRetired).toBe(true)
    expect(source.hasOutstandingPublication('chat')).toBe(false)
    expect(fs.existsSync(pendingDirectory)).toBe(false)
  })

  it('retries a temporary-open EINVAL when its exact parent disappeared', () => {
    const source = catalogue()
    const resolver = catalogue()
    expect(finish(source, source.beginPublication('chat'))).toBe(true)
    expect(resolver.publishResolution(resolution(resolver))).toBe(true)
    const ready = resolver.read('chat')
    if (ready.status !== 'ready') throw new Error('not ready')
    expect(resolver.acknowledgeResolution('chat', ready.publicationId)).toBe(true)

    const pendingDirectory = join(source.directory, 'pending', 'desktop', 'chat')
    let attempts = 0
    openTemporary = (file) => {
      if (dirname(file) !== pendingDirectory) return fs.openSync(file, 'wx', 0o600)
      attempts += 1
      if (attempts === 1) {
        fs.rmSync(pendingDirectory, { recursive: true, force: true })
        throw Object.assign(new Error('invalid open argument'), {
          code: 'EINVAL',
          errno: -22,
          syscall: 'open',
          path: file
        })
      }
      return fs.openSync(file, 'wx', 0o600)
    }
    const ticket = source.beginPublication('chat')
    openTemporary = undefined

    expect(attempts).toBe(2)
    expect(finish(source, ticket)).toBe(true)
    expect(resolver.publishResolution(resolution(resolver))).toBe(true)
    const repaired = resolver.read('chat')
    if (repaired.status !== 'ready') throw new Error('not ready')
    expect(resolver.acknowledgeResolution('chat', repaired.publicationId)).toBe(true)
    expect(resolver.repairChatIds()).toEqual([])
  })

  it('preserves a temporary-open EINVAL while its exact parent remains present', () => {
    const source = catalogue()
    const pendingDirectory = join(source.directory, 'pending', 'desktop', 'chat')
    let attempts = 0
    let injected: NodeJS.ErrnoException | undefined
    openTemporary = (file) => {
      if (dirname(file) !== pendingDirectory) return fs.openSync(file, 'wx', 0o600)
      attempts += 1
      injected = Object.assign(new Error('invalid open argument'), {
        code: 'EINVAL',
        errno: -22,
        syscall: 'open',
        path: file
      })
      throw injected
    }
    let observed: NodeJS.ErrnoException | undefined
    try {
      source.beginPublication('chat')
    } catch (error) {
      observed = error as NodeJS.ErrnoException
    }
    openTemporary = undefined
    expect(observed).toBe(injected)
    expect(observed).toMatchObject({
      message: 'invalid open argument',
      code: 'EINVAL',
      errno: -22,
      syscall: 'open'
    })
    expect(dirname(observed?.path ?? '')).toBe(pendingDirectory)
    expect(attempts).toBe(1)
    expect(fs.existsSync(pendingDirectory)).toBe(true)
  })

  it('surfaces the second EINVAL after one missing-parent retry', () => {
    const source = catalogue()
    const pendingDirectory = join(source.directory, 'pending', 'desktop', 'chat')
    let attempts = 0
    let injected: NodeJS.ErrnoException | undefined
    openTemporary = (file) => {
      if (dirname(file) !== pendingDirectory) return fs.openSync(file, 'wx', 0o600)
      attempts += 1
      fs.rmSync(pendingDirectory, { recursive: true, force: true })
      injected = Object.assign(new Error(`invalid open argument ${attempts}`), {
        code: 'EINVAL',
        errno: -22,
        syscall: 'open',
        path: file
      })
      throw injected
    }
    let observed: NodeJS.ErrnoException | undefined
    try {
      source.beginPublication('chat')
    } catch (error) {
      observed = error as NodeJS.ErrnoException
    }
    openTemporary = undefined

    expect(attempts).toBe(2)
    expect(observed).toBe(injected)
    expect(observed?.message).toBe('invalid open argument 2')
    expect(fs.existsSync(pendingDirectory)).toBe(false)
    expect(source.hasOutstandingPublication('chat')).toBe(false)
  })

  afterEach(() => fs.rmSync(profile, { recursive: true, force: true }))

  it('treats missing metadata as repair debt without creating files on a read', () => {
    const store = catalogue()
    expect(store.read('chat')).toEqual({ status: 'repair-pending' })
    expect(fs.readdirSync(profile)).toEqual([])
  })

  it('keeps a source append pending until its explicit durability receipt arrives', () => {
    const store = catalogue()
    store.registerWriter()
    const ticket = store.beginPublication('chat')
    const prepared = resolution(store)
    expect(store.publishResolution(prepared)).toBe(false)
    expect(store.read('chat')).toEqual({ status: 'repair-pending' })

    expect(finish(store, ticket)).toBe(true)
    expect(store.publishResolution(resolution(store))).toBe(true)
    expect(store.read('chat')).toMatchObject({ status: 'ready', projection: projection() })
  })

  it('does not let an older fsync callback acknowledge a later streaming append', () => {
    const store = catalogue()
    store.registerWriter()
    const first = store.beginPublication('chat')
    const second = store.beginPublication('chat')
    expect(second.operationId).toBe(first.operationId)
    expect(second.sequence).toBe(first.sequence + 1)
    expect(finish(store, first)).toBe(false)
    expect(store.failPublication(first)).toBe(false)
    expect(store.publishResolution(resolution(store))).toBe(false)
    expect(finish(store, second, 2)).toBe(true)

    const third = store.beginPublication('chat')
    expect(third.operationId).not.toBe(second.operationId)
    expect(finish(store, second, 2)).toBe(false)
  })

  it('rejects migration prepared before a Host-native write began', () => {
    const desktop = catalogue()
    const host = catalogue('host')
    desktop.registerWriter()
    host.registerWriter()
    const prepared = resolution(desktop)
    const ticket = host.beginPublication('chat')
    expect(finish(host, ticket)).toBe(true)
    expect(desktop.publishResolution(prepared)).toBe(false)
  })

  it('keeps the burst pending when the newer operation fails before an older operation settles', () => {
    const store = catalogue()
    const first = store.beginPublication('chat')
    const second = store.beginPublication('chat')
    expect(store.failPublication(second, { source: 'unchanged' })).toBe(true)
    expect(store.publishResolution(resolution(store))).toBe(false)
    expect(store.read('chat').status).toBe('repair-pending')
    expect(finish(store, first)).toBe(true)
    expect(store.publishResolution(resolution(store))).toBe(true)
  })

  it('settles an older durability acknowledgement without replacing a newer committed projection', () => {
    const store = catalogue()
    const first = store.beginPublication('chat')
    const second = store.beginPublication('chat')
    const oldWitness = witness
    witness = 'legacy:2;journal:2;overlay:absent'
    expect(finish(store, second, 2)).toBe(false)
    expect(store.publishResolution(resolution(store))).toBe(false)
    expect(
      store.finishPublication(
        first,
        {
          operationId: first.operationId,
          sequence: first.sequence,
          revision: 1,
          sourceWitness: oldWitness
        },
        projection()
      )
    ).toBe(true)
  })

  it('rejects completion from a retired writer even if ordinary write admission was not revoked', () => {
    const previous = catalogue()
    const ticket = previous.beginPublication('chat')
    retired.add('desktop-1')
    const next = catalogue('desktop', 'desktop-2')
    next.registerWriter()
    expect(finish(previous, ticket)).toBe(false)
    expect(() => previous.beginPublication('another')).toThrow('not active')
    expect(next.publishResolution(resolution(next))).toBe(false)
    for (const id of next.sourceDurabilityDebts('chat')) provenDurability.add(id)
    expect(next.publishResolution(resolution(next))).toBe(true)
  })

  it('does not grant resolved publication or erasure to a source-only Host instance', () => {
    const host = catalogue('host')
    expect(host.publishResolution(resolution(host))).toBe(false)
    expect(() => host.beginErasure()).toThrow('erasure authority')
  })

  it('copies only allowlisted metadata without serializing unknown history payloads', () => {
    const store = catalogue()
    const prepared = resolution(store)
    const poison = {
      toJSON: () => {
        throw new Error('History was serialized on main')
      }
    }
    Object.assign(prepared.projection, { messages: poison })
    Object.assign(prepared.projection.summary, { prompt: poison, ensemble: poison })
    expect(store.publishResolution(prepared)).toBe(true)
    expect(store.read('chat')).toMatchObject({ status: 'ready', projection: projection() })
  })

  it('does not confuse a chat named global with the global erasure fence', () => {
    const store = catalogue()
    store.beginErasure('global')
    expect(store.read('global').status).toBe('erasing')
    expect(store.read('unrelated').status).toBe('repair-pending')
  })

  it.each(['before', 'after'] as const)(
    'retries failed finalization %s rename without repeating source persistence',
    (when) => {
      const store = catalogue()
      const ticket = store.beginPublication('chat')
      const failOnce = () => {
        beforeRename = undefined
        afterRename = undefined
        throw Object.assign(new Error('temporary publication failure'), { code: 'EIO' })
      }
      if (when === 'before') beforeRename = failOnce
      else afterRename = failOnce
      expect(() => finish(store, ticket)).toThrow('temporary publication failure')
      expect(finish(store, ticket)).toBe(true)
      expect(store.publishResolution(resolution(store))).toBe(true)
    }
  )

  it('retries first-use ancestor durability even when the failed attempt already created the directory', () => {
    const store = catalogue()
    let profileSyncs = 0
    beforeSync = (directory) => {
      if (directory !== profile) return
      profileSyncs += 1
      if (profileSyncs === 1)
        throw Object.assign(new Error('directory sync failed'), { code: 'EIO' })
    }
    expect(() => store.beginPublication('chat')).toThrow('directory sync failed')
    const ticket = store.beginPublication('chat')
    expect(profileSyncs).toBeGreaterThanOrEqual(2)
    expect(finish(store, ticket)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')(
    'keeps a dangling epoch link fenced instead of treating it as absent',
    () => {
      const store = catalogue()
      fs.mkdirSync(join(store.controlDirectory, 'epochs'), { recursive: true })
      fs.symlinkSync(
        join(profile, 'missing-epoch'),
        join(store.controlDirectory, 'epochs', 'global.json')
      )
      expect(store.read('chat').status).toBe('erasing')
      expect(() => store.beginPublication('chat')).toThrow('history erasure')
    }
  )

  it('does not equate an unreadable source head with no outstanding source mutation', () => {
    const host = catalogue('host')
    host.beginPublication('chat')
    fs.writeFileSync(join(host.directory, 'host', 'chat.json'), '{corrupt')
    const parent = catalogue()
    expect(parent.sourceHeads('chat').host).toBe('unreadable')
    expect(parent.publishResolution(resolution(parent))).toBe(false)
    expect(parent.read('chat').status).toBe('repair-pending')
  })

  it('revalidates same-revision composer changes when metadata is consumed', () => {
    const store = catalogue()
    expect(store.publishResolution(resolution(store))).toBe(true)
    witness = 'legacy:1;journal:1;overlay:changed'
    expect(store.read('chat')).toEqual({ status: 'repair-pending', summary: projection().summary })
  })

  it('never lets a late worker recreate metadata across completed chat erasure', () => {
    const store = catalogue()
    const prepared = resolution(store)
    expect(store.publishResolution(prepared)).toBe(true)
    const generation = store.beginErasure('chat')
    expect(store.read('chat')).toEqual({ status: 'erasing' })
    expect(store.publishResolution(prepared)).toBe(false)
    expect(store.finishErasure(generation, 'chat')).toBe(true)
    expect(store.publishResolution(prepared)).toBe(false)
    expect(store.read('chat')).toEqual({ status: 'repair-pending' })
  })

  it('retains the global erasure generation across a new process', () => {
    const before = catalogue()
    const prepared = resolution(before)
    const generation = before.beginErasure()
    const restarted = catalogue('desktop', 'desktop-2')
    expect(restarted.finishErasure(generation)).toBe(true)
    expect(restarted.publishResolution(prepared)).toBe(false)
  })

  it('allows repair of an interrupted publication after its source owner is replaced', () => {
    const previous = catalogue()
    previous.registerWriter()
    previous.beginPublication('chat')
    const next = catalogue('desktop', 'desktop-2')
    expect(next.publishResolution(resolution(next))).toBe(false)
    retired.add('desktop-1')
    next.registerWriter()
    expect(next.publishResolution(resolution(next))).toBe(false)
    for (const id of next.sourceDurabilityDebts('chat')) provenDurability.add(id)
    expect(next.publishResolution(resolution(next))).toBe(true)
    expect(next.read('chat').status).toBe('ready')
  })

  it('retains failed-flush debt through aborted bursts and binds repair to exact interrupted operations', () => {
    const source = catalogue()
    source.failPublication(source.beginPublication('chat'))
    const debt = source.sourceDurabilityDebts('chat')
    expect(debt).toHaveLength(1)
    source.failPublication(source.beginPublication('chat'), { source: 'unchanged' })
    expect(source.sourceDurabilityDebts('chat')).toEqual(debt)
    expect(source.publishResolution(resolution(source))).toBe(false)
    for (const id of debt) provenDurability.add(id)
    expect(source.publishResolution(resolution(source))).toBe(true)
    source.beginPublication('chat')
    retired.add('desktop-1')
    const resolver = catalogue('desktop', 'desktop-2')
    expect(resolver.publishResolution(resolution(resolver))).toBe(false)
    for (const id of resolver.sourceDurabilityDebts('chat')) provenDurability.add(id)
    expect(resolver.publishResolution(resolution(resolver))).toBe(true)
  })

  it('keeps disjoint source slots intact while migration publishes its own resolution', () => {
    const desktop = catalogue()
    const host = catalogue('host')
    desktop.registerWriter()
    host.registerWriter()
    expect(finish(desktop, desktop.beginPublication('chat'))).toBe(true)
    expect(finish(host, host.beginPublication('chat'))).toBe(true)
    const files = ['desktop', 'host'].map((lane) => join(desktop.directory, lane, 'chat.json'))
    const before = files.map((file) => fs.readFileSync(file, 'utf8'))
    expect(desktop.publishResolution(resolution(desktop))).toBe(true)
    expect(files.map((file) => fs.readFileSync(file, 'utf8'))).toEqual(before)
  })

  it('does not interpret an old projection missing recovery fields as empty work', () => {
    const store = catalogue()
    const prepared = resolution(store)
    delete (prepared.projection.recovery as Partial<typeof prepared.projection.recovery>)
      .soloWakeups
    expect(store.publishResolution(prepared)).toBe(false)
    expect(store.read('chat')).toEqual({ status: 'repair-pending' })
  })

  it('refuses oversized metadata and leaves its durable repair marker', () => {
    const store = catalogue()
    const ticket = store.beginPublication('chat')
    const oversized = projection()
    oversized.summary.title = 'x'.repeat(THREAD_CATALOGUE_MAX_HEAD_BYTES)
    expect(
      store.finishPublication(
        ticket,
        {
          operationId: ticket.operationId,
          sequence: ticket.sequence,
          revision: 1,
          sourceWitness: witness
        },
        oversized
      )
    ).toBe(false)
    expect(store.read('chat').status).toBe('repair-pending')
  })

  it('cannot acquire write authority from a writer label while the gate is closed', () => {
    const store = catalogue()
    writable = false
    expect(() => store.registerWriter()).toThrow('read-only')
    expect(() => store.beginPublication('chat')).toThrow('read-only')
    expect(fs.readdirSync(profile)).toEqual([])
  })
})

describe('a recovery hold that no token can name', () => {
  let profile: string

  beforeEach(() => {
    profile = fs.mkdtempSync(join(tmpdir(), 'thread-catalogue-hold-'))
  })

  afterEach(() => {
    fs.rmSync(profile, { recursive: true, force: true })
  })

  function holdingCatalogue(): ThreadCatalogue {
    return new ThreadCatalogue({
      profilePath: profile,
      writer: 'desktop',
      writerId: 'desktop-1',
      canWrite: () => true,
      canManageRecoveryHolds: () => true,
      writerLifecycle: () => 'active',
      canPublishResolution: () => true,
      canErase: () => true,
      isSourceDurabilityProven: () => true,
      isIndexedGenerationCommitted: () => true,
      isSourceWitnessCurrent: () => true
    })
  }

  function holdFile(chatId: string): string {
    return join(profile, 'thread-history-control-v1', 'recovery-holds', `${chatId}.json`)
  }

  it('is invisible to every existing clearing path once its file is torn', () => {
    const store = holdingCatalogue()
    store.holdRecovery({
      chatId: 'chat-1',
      token: 'token-1',
      desktopWriterId: 'desktop-1',
      hostIncarnation: 'incarnation-1'
    })
    // A crash partway through writeJson leaves exactly this.
    fs.writeFileSync(holdFile('chat-1'), '{')

    expect(store.recoveryHold('chat-1')).toBe('unreadable')
    // Blocks every save for this chat...
    expect(() => store.assertRecoveryHoldAllows('chat-1', 'token-1')).toThrow(
      'Chat history recovery is in progress'
    )
    // ...while being unreleasable, unoverwritable, and invisible to the sweep.
    expect(store.releaseRecoveryHold('chat-1', 'token-1')).toBe(false)
    expect(store.recoveryHolds()).toEqual([])
    expect(fs.existsSync(holdFile('chat-1'))).toBe(true)
  })

  it('is discoverable and clearable through the unreadable-hold escape hatch', () => {
    const store = holdingCatalogue()
    store.holdRecovery({
      chatId: 'chat-1',
      token: 'token-1',
      desktopWriterId: 'desktop-1',
      hostIncarnation: 'incarnation-1'
    })
    fs.writeFileSync(holdFile('chat-1'), '{')

    expect(store.unreadableRecoveryHoldChatIds()).toEqual(['chat-1'])
    expect(store.releaseUnreadableRecoveryHold('chat-1')).toBe(true)
    expect(fs.existsSync(holdFile('chat-1'))).toBe(false)
    expect(() => store.assertRecoveryHoldAllows('chat-1', 'token-1')).not.toThrow()
  })

  it('never discards a hold that is merely held by someone else', () => {
    const store = holdingCatalogue()
    store.holdRecovery({
      chatId: 'chat-1',
      token: 'token-1',
      desktopWriterId: 'desktop-1',
      hostIncarnation: 'incarnation-1'
    })
    // Intact holds are not "unreadable" and must survive the sweep untouched.
    expect(store.unreadableRecoveryHoldChatIds()).toEqual([])
    expect(store.releaseUnreadableRecoveryHold('chat-1')).toBe(false)
    expect(fs.existsSync(holdFile('chat-1'))).toBe(true)
    expect(() => store.assertRecoveryHoldAllows('chat-1', 'other-token')).toThrow(
      'Chat history recovery is in progress'
    )
  })
})
