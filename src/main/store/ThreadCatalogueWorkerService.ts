import type { ThreadCatalogueReadContext } from '../../shared/threadCatalogueTypes'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { isSafeChatId } from '../ChatPath'
import {
  ThreadCatalogue,
  type ThreadCatalogueProjection,
  type ThreadCatalogueWriter
} from './ThreadCatalogue'
import {
  ThreadCatalogueDatabase,
  openThreadCatalogueDatabase,
  type ThreadIndexedGeneration,
  type ThreadIndexedObjectKind
} from './ThreadCatalogueDatabase'
import { ThreadCatalogueDecoderClient } from './ThreadCatalogueDecoderClient'
import { selectNextCatalogueJob } from './ThreadCatalogueJobSelection'
import {
  captureThreadCatalogueWitness,
  flushThreadCatalogueSources,
  type ThreadCatalogueReaderOptions
} from './ThreadCatalogueDiskReader'
import type { ThreadDecodeMode } from './ThreadCatalogueWorkerProtocol'
import type { ThreadCatalogueQuery, ThreadCatalogueOpenResult } from './ThreadCatalogueClient'
import {
  preparedThreadDirectory,
  type PreparedThreadMutation,
  type ThreadCatalogueMutation
} from './ThreadCatalogueMutation'

export interface IndexedThread extends ThreadIndexedGeneration {
  projection: ThreadCatalogueProjection
  snapshot: boolean
}

export interface ThreadCatalogueWorkerServiceOptions {
  reader: ThreadCatalogueReaderOptions
  decoderPath: string
  writer: ThreadCatalogueWriter
  writerId: string
  writerLifecycle: (
    writer: ThreadCatalogueWriter,
    writerId: string
  ) => 'active' | 'retired' | 'unknown'
  onChanged?: (entry: IndexedThread) => void
  onRemoved?: (chatId: string) => void
  onProgress?: (progress: { total: number; indexed: number; failed: number }) => void
  assertSourceAuthority?: () => void
}

interface ImportJob {
  chatId: string
  mode: ThreadDecodeMode
  resolve: (value: IndexedThread | null) => void
  reject: (error: unknown) => void
  promise: Promise<IndexedThread | null>
  priority?: boolean
  projectionOptions?: string
  readContext?: ThreadCatalogueReadContext
}

interface PreparationJob {
  chatId: string
  mode: 'prepare'
  sourceWitness: string
  mutation: ThreadCatalogueMutation
  resolve: (value: PreparedThreadMutation | null) => void
  reject: (error: unknown) => void
  promise: Promise<PreparedThreadMutation | null>
}
type CatalogueJob = ImportJob | PreparationJob

/** Storage-process actor. Decoding is in a separate isolate; no request falls back to main. */
export class ThreadCatalogueWorkerService {
  readonly catalogue: ThreadCatalogue
  readonly database: ThreadCatalogueDatabase
  private decoder: ThreadCatalogueDecoderClient
  private readonly queue: CatalogueJob[] = []
  private readonly jobs = new Map<string, CatalogueJob>()
  private readonly prepared = new Map<string, PreparedThreadMutation>()
  private readonly viewContexts = new Map<string, string>()
  private readonly failed = new Set<string>()
  private readonly refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly known = new Set<string>()
  private readonly indexed = new Set<string>()
  private readonly changedWhileImporting = new Set<string>()
  private nextRequestId = 1
  private running: Promise<void> | null = null
  private closed = false
  private pausedForErasure = false
  /** Fast-lane picks since the last queue-head pick; see the job selector. */
  private consecutiveFastPicks = 0
  private inventoryWitness = ''
  private readonly watchers = new Map<string, fs.FSWatcher>()
  private inventoryTimer: ReturnType<typeof setTimeout> | null = null
  private inventoryRunning: Promise<void> | null = null
  private inventoryStarted = false
  private readonly leases = new Map<string, { entry: IndexedThread; expires: number }>()
  private readonly incarnation = randomUUID()
  private changeSequence = 0
  private readonly changes: Array<{ sequence: number; chatId: string; removed: boolean }> = []

  private changed(chatId: string, removed: boolean): void {
    this.changes.push({ sequence: ++this.changeSequence, chatId, removed })
    if (this.changes.length > 2000) this.changes.shift()
  }

  constructor(private readonly options: ThreadCatalogueWorkerServiceOptions) {
    this.database = openThreadCatalogueDatabase(
      path.join(options.reader.profilePath, 'thread-catalogue-v1'),
      {
        isPublicationCurrent: (generation, publicationId) => {
          const row = this.catalogue?.read(generation.chatId)
          return (
            row?.status === 'ready' &&
            row.publicationId === publicationId &&
            row.indexReference.databaseId === generation.databaseId &&
            row.indexReference.generation === generation.generation
          )
        },
        isInventoryCurrent: (witness) =>
          witness === this.inventoryWitness && witness === this.captureInventoryWitness(),
        hasUnresolvedPublications: () => this.catalogue.repairChatIds().length > 0
      }
    )
    this.catalogue = new ThreadCatalogue({
      profilePath: options.reader.profilePath,
      writer: options.writer,
      writerId: options.writerId,
      canWrite: () => !this.closed,
      canPublishResolution: () => !this.closed,
      canErase: () => !this.closed,
      isSourceDurabilityProven: (id, epoch, debtId) =>
        this.database.sourceDurabilityProven(id, epoch, debtId),
      writerLifecycle: options.writerLifecycle,
      isSourceWitnessCurrent: (chatId, witness) =>
        captureThreadCatalogueWitness(options.reader, chatId).witness === witness,
      isIndexedGenerationCommitted: (chatId, reference, sourceWitness, epoch, heads) =>
        this.database.isCommitted({
          chatId,
          databaseId: reference.databaseId,
          generation: reference.generation,
          sourceWitness,
          epoch,
          heads
        })
    })
    this.decoder = new ThreadCatalogueDecoderClient(options.decoderPath)
  }

  private captureInventoryWitness(): string {
    try {
      const stat = fs.statSync(path.join(this.options.reader.profilePath, 'chats'), {
        bigint: true
      })
      return createHash('sha256')
        .update(`${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`)
        .digest('hex')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
      throw error
    }
  }

  /** Starts filename discovery and repair asynchronously; constructing the actor reads no chats. */
  start(): void {
    this.watchSources()
    this.scheduleInventory(0)
  }

  private watchSources(): void {
    const directories = [
      '',
      'chats',
      'chat-journal-v2',
      'chat-store-v2',
      'chat-composer-selections',
      'thread-catalogue-v1',
      'thread-catalogue-v1/desktop',
      'thread-catalogue-v1/host'
    ]
    for (const relative of directories) {
      const directory = path.join(this.options.reader.profilePath, relative)
      if (this.watchers.has(directory)) continue
      try {
        const watcher = fs.watch(directory, (event, file) => {
          if (this.closed) return
          if (!relative) {
            if (
              file &&
              [
                'chats',
                'chat-journal-v2',
                'chat-store-v2',
                'chat-composer-selections',
                'thread-catalogue-v1'
              ].includes(String(file))
            ) {
              this.watchSources()
              this.scheduleInventory()
            }
            return
          }
          if (relative === 'thread-catalogue-v1') {
            this.watchSources()
            return
          }
          const id = file ? /^([A-Za-z0-9_-]+)\./.exec(String(file))?.[1] : undefined
          if (id && isSafeChatId(id)) this.notifyChanged(id)
          if (!file || (relative === 'chats' && event === 'rename')) this.scheduleInventory()
        })
        watcher.on('error', () => {
          watcher.close()
          this.watchers.delete(directory)
          this.inventoryWitness = ''
          this.scheduleInventory()
        })
        this.watchers.set(directory, watcher)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }

  private scheduleInventory(delay = 100): void {
    if (this.inventoryTimer || this.closed) return
    this.inventoryTimer = setTimeout(() => {
      this.inventoryTimer = null
      void this.refreshInventory().catch(() => {
        this.inventoryWitness = ''
      })
    }, delay)
    this.inventoryTimer.unref?.()
  }

  async refreshInventory(): Promise<void> {
    if (this.inventoryRunning) return this.inventoryRunning
    this.inventoryRunning = this.discoverInventory().finally(() => {
      this.inventoryRunning = null
    })
    return this.inventoryRunning
  }

  private async discoverInventory(): Promise<void> {
    const before = this.captureInventoryWitness()
    let names: string[] = []
    try {
      names = await fs.promises.readdir(path.join(this.options.reader.profilePath, 'chats'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (this.closed) return
    if (before !== this.captureInventoryWitness()) {
      this.scheduleInventory()
      return
    }
    const ids = names
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5))
      .filter(isSafeChatId)
    const present = new Set(ids)
    const additions = ids.filter((id) => !this.known.has(id))
    for (const old of this.known)
      if (!present.has(old)) {
        this.database.removeChat(old)
        this.indexed.delete(old)
        this.failed.delete(old)
        this.options.onRemoved?.(old)
        this.changed(old, true)
      }
    this.known.clear()
    for (const id of ids) this.known.add(id)
    this.inventoryWitness = before
    this.database.setInventory(ids, before)
    const audit = this.inventoryStarted ? additions : ids
    this.inventoryStarted = true
    let checked = 0
    for (const id of audit) {
      if (this.closed) return
      if (this.database.current(id)) {
        await this.ensureIndexed(id, 'metadata')
        this.indexed.add(id)
      } else if (!this.failed.has(id)) {
        void this.ensureIndexed(id, 'metadata').catch((error) => this.importFailed(id, error))
      }
      if (++checked % 32 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    }
    this.reportProgress()
  }

  private importFailed(chatId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : ''
    if (/outstanding work|changed during|changed before|being erased/.test(message)) {
      this.notifyChanged(chatId)
    } else {
      this.failed.add(chatId)
    }
    this.reportProgress()
  }

  notifyChanged(chatId: string): void {
    if (!isSafeChatId(chatId) || this.closed) return
    this.failed.delete(chatId)
    if (this.jobs.has(chatId)) this.changedWhileImporting.add(chatId)
    const previous = this.refreshTimers.get(chatId)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      this.refreshTimers.delete(chatId)
      if (this.closed) return
      void this.ensureIndexed(chatId, 'metadata').catch((error) => this.importFailed(chatId, error))
    }, 100)
    timer.unref?.()
    this.refreshTimers.set(chatId, timer)
  }

  ensureIndexed(
    chatId: string,
    mode: ThreadDecodeMode,
    priority = false,
    projectionOptions?: string,
    readContext?: ThreadCatalogueReadContext
  ): Promise<IndexedThread | null> {
    if (this.closed) return Promise.reject(new Error('History index is shutting down'))
    if (!isSafeChatId(chatId)) return Promise.reject(new Error('Invalid history chat id'))
    if (this.catalogue.read(chatId).status === 'erasing')
      return Promise.reject(new Error('History is being erased'))
    const current = this.database.current(chatId)
    const viewKey = JSON.stringify([
      mode,
      readContext?.runtimeInstanceId ?? this.options.reader.runtimeInstanceId,
      readContext?.defaultProvider ?? this.options.reader.defaultProvider
    ])
    if (
      mode !== 'remote' &&
      current &&
      (mode === 'metadata' ||
        (mode === 'runs' && this.database.hasKind(current, 'run-summary')) ||
        (mode === 'record' &&
          this.viewContexts.get(current.generation) === viewKey &&
          this.database.hasKind(current, 'record')) ||
        (mode === 'pages' &&
          this.viewContexts.get(current.generation) === viewKey &&
          ['message', 'run', 'shell'].every((kind) =>
            this.database.hasKind(current, kind as ThreadIndexedObjectKind)
          )))
    ) {
      const row = this.catalogue.read(chatId)
      if (row.status === 'ready') this.catalogue.acknowledgeResolution(chatId, row.publicationId)
      return Promise.resolve({ ...current, snapshot: false })
    }
    const existing = this.jobs.get(chatId)
    if (existing) {
      if (existing.mode !== 'prepare' && priority) existing.priority = true
      if (existing.mode === 'prepare')
        return existing.promise.then(() =>
          this.ensureIndexed(chatId, mode, priority, projectionOptions, readContext)
        )
      return (existing.mode === mode &&
        (!['remote', 'control'].includes(existing.mode) ||
          existing.projectionOptions === projectionOptions) &&
        JSON.stringify(existing.readContext) === JSON.stringify(readContext)) ||
        mode === 'metadata'
        ? existing.promise
        : existing.promise.then(() =>
            this.ensureIndexed(chatId, mode, priority, projectionOptions, readContext)
          )
    }
    let resolve!: ImportJob['resolve']
    let reject!: ImportJob['reject']
    const promise = new Promise<IndexedThread | null>((done, failed) => {
      resolve = done
      reject = failed
    })
    const job: ImportJob = {
      chatId,
      mode,
      resolve,
      reject,
      promise,
      priority,
      projectionOptions,
      readContext
    }
    this.jobs.set(chatId, job)
    this.queue.push(job)
    this.pump()
    return promise
  }

  private pump(): void {
    if (this.running || this.closed || this.pausedForErasure || !this.queue.length) return
    const selection = selectNextCatalogueJob(this.queue, this.consecutiveFastPicks)
    this.consecutiveFastPicks = selection.consecutiveFastPicks
    const job = this.queue.splice(selection.index, 1)[0]
    const finish = (): void => {
      this.jobs.delete(job.chatId)
      this.running = null
      if (this.changedWhileImporting.delete(job.chatId)) this.notifyChanged(job.chatId)
      this.reportProgress()
      this.pump()
    }
    if (job.mode === 'prepare') {
      this.running = this.prepareMutation(job).then(
        (value) => {
          finish()
          job.resolve(value)
        },
        (error) => {
          finish()
          job.reject(error)
        }
      )
      return
    }
    this.running = this.importChat(job).then(
      (value) => {
        finish()
        job.resolve(value)
      },
      (error) => {
        finish()
        job.reject(error)
      }
    )
  }

  private async enqueuePreparation(
    input: Extract<ThreadCatalogueQuery, { method: 'prepare' }>
  ): Promise<PreparedThreadMutation | null> {
    if (!isSafeChatId(input.chatId) || this.closed || this.pausedForErasure)
      throw new Error('History mutation is unavailable')
    const previous = this.jobs.get(input.chatId)
    if (previous) {
      await previous.promise
      return this.enqueuePreparation(input)
    }
    let resolve!: PreparationJob['resolve']
    let reject!: PreparationJob['reject']
    const promise = new Promise<PreparedThreadMutation | null>((yes, no) => {
      resolve = yes
      reject = no
    })
    const job: PreparationJob = { ...input, mode: 'prepare', resolve, reject, promise }
    this.jobs.set(input.chatId, job)
    this.queue.unshift(job)
    this.pump()
    return promise
  }

  private async prepareMutation(job: PreparationJob): Promise<PreparedThreadMutation | null> {
    if (this.prepared.size >= 32) throw new Error('Too many pending history mutations')
    const epoch = this.catalogue.epoch(job.chatId)
    const heads = this.catalogue.sourceHeads(job.chatId)
    if (this.catalogue.read(job.chatId).status !== 'ready')
      throw new Error('History mutation requires current metadata')
    if (!this.options.assertSourceAuthority)
      throw new Error('History source authority is unavailable')
    const durableWitness = await flushThreadCatalogueSources(
      this.options.reader,
      job.chatId,
      this.options.assertSourceAuthority
    )
    if (
      durableWitness !== job.sourceWitness ||
      JSON.stringify(epoch) !== JSON.stringify(this.catalogue.epoch(job.chatId)) ||
      JSON.stringify(heads) !== JSON.stringify(this.catalogue.sourceHeads(job.chatId))
    )
      throw new Error('History changed during mutation durability barrier')
    const result = await this.decoder.run(
      {
        type: 'prepare',
        requestId: this.nextRequestId++,
        chatId: job.chatId,
        sourceWitness: job.sourceWitness,
        epoch,
        heads,
        mutation: job.mutation,
        options: this.options.reader
      },
      () => {
        throw new Error('Unexpected mutation import frame')
      }
    )
    if (result.type !== 'prepared') throw new Error('History mutation preparation did not complete')
    if (result.prepared) {
      this.prepared.set(result.prepared.preparedId, result.prepared)
      if (
        this.closed ||
        JSON.stringify(epoch) !== JSON.stringify(this.catalogue.epoch(job.chatId))
      ) {
        this.discardPrepared(result.prepared.preparedId)
        throw new Error('History was erased during mutation preparation')
      }
    }
    return result.prepared
  }

  private discardPrepared(id: string): void {
    const prepared = this.prepared.get(id)
    if (!prepared) return
    this.prepared.delete(id)
    for (const file of [prepared.record, prepared.checkpoint])
      fs.rmSync(
        path.join(
          preparedThreadDirectory(this.options.reader.profilePath, prepared.chatId),
          file.name
        ),
        { force: true }
      )
  }

  private async importChat(job: ImportJob): Promise<IndexedThread | null> {
    const epoch = this.catalogue.epoch(job.chatId)
    const heads = this.catalogue.sourceHeads(job.chatId)
    let generation: ThreadIndexedGeneration | null = null
    let projection: ThreadCatalogueProjection | null = null
    try {
      const debts = this.catalogue
        .sourceDurabilityDebts(job.chatId)
        .filter((id) => !this.database.sourceDurabilityProven(job.chatId, epoch, id))
      if (debts.length) {
        const assertAuthority = this.options.assertSourceAuthority
        if (!assertAuthority) throw new Error('Source durability repair authority is unavailable')
        const witness = await flushThreadCatalogueSources(
          this.options.reader,
          job.chatId,
          assertAuthority
        )
        if (
          this.closed ||
          JSON.stringify(epoch) !== JSON.stringify(this.catalogue.epoch(job.chatId)) ||
          JSON.stringify(heads) !== JSON.stringify(this.catalogue.sourceHeads(job.chatId)) ||
          witness !== captureThreadCatalogueWitness(this.options.reader, job.chatId).witness
        )
          throw new Error('History changed during durability repair')
        assertAuthority()
        this.database.recordSourceDurabilityProofs(job.chatId, epoch, debts)
      }
      if (job.mode === 'metadata' && this.catalogue.publicationPending(job.chatId))
        throw new Error('History writer has outstanding work')
      const result = await this.decoder.run(
        {
          type: 'decode',
          requestId: this.nextRequestId++,
          chatId: job.chatId,
          mode: job.mode,
          projectionOptions: job.projectionOptions,
          readContext: job.readContext,
          options: this.options.reader
        },
        (message) => {
          if (this.closed) throw new Error('History index is shutting down')
          if (message.type === 'begin') {
            if (generation) throw new Error('History decoder repeated its begin frame')
            projection = message.projection
            generation = this.database.beginGeneration({
              chatId: job.chatId,
              sourceWitness: message.source.witness,
              epoch,
              heads
            })
          } else {
            if (!generation) throw new Error('History decoder omitted its begin frame')
            if (message.type === 'frames')
              this.database.writeObjectFrames(generation, message.frames)
            else if (message.type === 'activity')
              this.database.writeMessageActivity(generation, message.rows)
            else this.database.writeRunLocators(generation, message.runs)
          }
        }
      )
      if (result.type === 'missing') {
        if (
          this.closed ||
          JSON.stringify(epoch) !== JSON.stringify(this.catalogue.epoch(job.chatId)) ||
          JSON.stringify(heads) !== JSON.stringify(this.catalogue.sourceHeads(job.chatId)) ||
          captureThreadCatalogueWitness(this.options.reader, job.chatId).legacyExists
        )
          throw new Error('History changed during indexing')
        this.database.removeChat(job.chatId)
        this.options.onRemoved?.(job.chatId)
        this.changed(job.chatId, true)
        return null
      }
      if (result.type !== 'complete') throw new Error('Unexpected history import result')
      if (!generation || !projection) throw new Error('History decoder omitted its projection')
      const committed = generation as ThreadIndexedGeneration
      const metadata = projection as ThreadCatalogueProjection
      if (
        this.closed ||
        JSON.stringify(epoch) !== JSON.stringify(this.catalogue.epoch(job.chatId)) ||
        this.catalogue.read(job.chatId).status === 'erasing'
      )
        throw new Error('History changed during indexing')
      for (const [kind, count] of Object.entries(result.coverage)) {
        this.database.sealKind(
          committed,
          kind as ThreadIndexedObjectKind | 'run-locator' | 'message-activity',
          count
        )
      }
      this.database.commitGeneration(committed, metadata)
      if (job.mode === 'pages' || job.mode === 'record') {
        this.viewContexts.set(
          committed.generation,
          JSON.stringify([
            job.mode,
            job.readContext?.runtimeInstanceId ?? this.options.reader.runtimeInstanceId,
            job.readContext?.defaultProvider ?? this.options.reader.defaultProvider
          ])
        )
        if (this.viewContexts.size > 512)
          this.viewContexts.delete(this.viewContexts.keys().next().value!)
      }
      const published = this.catalogue.publishResolution({
        chatId: job.chatId,
        epoch,
        heads,
        sourceWitness: committed.sourceWitness,
        projection: metadata,
        indexReference: { databaseId: committed.databaseId, generation: committed.generation }
      })
      const row = this.catalogue.read(job.chatId)
      const active =
        published &&
        row.status === 'ready' &&
        this.database.activateGeneration(committed, row.publicationId)
      if (active && row.status === 'ready') {
        this.catalogue.acknowledgeResolution(job.chatId, row.publicationId)
        const entry = { ...committed, projection: metadata, snapshot: false }
        if (metadata.sourceComplete === false) this.failed.add(job.chatId)
        else this.failed.delete(job.chatId)
        this.indexed.add(job.chatId)
        this.options.onChanged?.(entry)
        this.changed(job.chatId, false)
        this.prune(job.chatId)
        return entry
      }
      if (job.mode === 'metadata') throw new Error('History changed during indexing')
      if (
        this.closed ||
        JSON.stringify(epoch) !== JSON.stringify(this.catalogue.epoch(job.chatId)) ||
        this.catalogue.read(job.chatId).status === 'erasing'
      )
        throw new Error('History was erased during indexing')
      // A requested transcript is a consistent read snapshot. It does not
      // publish recovery state when a source writer advanced during import.
      return { ...committed, projection: metadata, snapshot: true }
    } catch (error) {
      if (generation) {
        this.database.abandonGeneration(generation)
      }
      throw error
    }
  }

  private reportProgress(): void {
    this.options.onProgress?.({
      total: this.known.size,
      indexed: this.indexed.size,
      failed: this.failed.size
    })
  }

  private prune(chatId: string): void {
    const affected = new Set([chatId])
    for (const [id, lease] of this.leases) {
      if (lease.expires >= Date.now()) continue
      this.leases.delete(id)
      affected.add(lease.entry.chatId)
      if (lease.entry.snapshot) {
        this.database.abandonGeneration(lease.entry)
        this.viewContexts.delete(lease.entry.generation)
      }
    }
    for (const id of affected) {
      const pins = [...this.leases.values()]
        .filter((lease) => lease.entry.chatId === id)
        .map((lease) => lease.entry.generation)
      this.database.pruneSuperseded(id, [...new Set(pins)])
    }
  }

  private readLease(id: string, operational = false): IndexedThread {
    const lease = this.leases.get(id)
    if (!lease || lease.expires < Date.now()) throw new Error('History page lease expired')
    const entry = lease.entry
    if (
      JSON.stringify(entry.epoch) !== JSON.stringify(this.catalogue.epoch(entry.chatId)) ||
      this.catalogue.read(entry.chatId).status === 'erasing'
    )
      throw new Error('History page was erased')
    if (
      operational &&
      (entry.projection.sourceComplete === false ||
        this.database.current(entry.chatId)?.generation !== entry.generation)
    )
      throw new Error('History recovery state changed')
    lease.expires = Date.now() + 120_000
    return entry
  }

  /**
   * `priority` is the envelope's lane, not the query's. Absent means
   * foreground, which is what every caller but the recovery drain sends.
   */
  async query(
    query: ThreadCatalogueQuery,
    priority: 'foreground' | 'background' = 'foreground'
  ): Promise<unknown> {
    if (this.closed) throw new Error('History worker is shutting down')
    switch (query.method) {
      case 'introspection':
        return this.database.introspectionPage(query.window, query.after)
      case 'message-activity':
        return this.database.messageActivityPage(query.request, query.after)
      case 'repair-source': {
        if (
          !this.options.assertSourceAuthority ||
          this.catalogue.read(query.chatId).status === 'erasing'
        )
          throw new Error('Source repair authority is unavailable')
        return flushThreadCatalogueSources(this.options.reader, query.chatId, () => {
          this.options.assertSourceAuthority!()
          if (this.catalogue.read(query.chatId).status === 'erasing')
            throw new Error('History is being erased')
        })
      }
      case 'host-runs':
        return this.database.hostRunPage(query.offset)
      case 'page-runs':
        return this.database.pageRunOrdinals(
          this.readLease(query.leaseId),
          query.start,
          query.end,
          query.maximum
        )
      case 'ordinal':
        return this.database.findOrdinal(this.readLease(query.leaseId), query.kind, query.recordId)
      case 'begin-recovery':
      case 'end-recovery':
      case 'adopt-prepared':
        throw new Error('Recovery adoption belongs to the source parent')
      case 'prepare':
        return this.enqueuePreparation(query)
      case 'prepared':
        return this.prepared.get(query.preparedId) ?? null
      case 'discard-prepared':
        this.discardPrepared(query.preparedId)
        return true
      case 'changes': {
        const after = query.position
        const reset = Boolean(
          after &&
          (after.incarnation !== this.incarnation ||
            after.sequence < (this.changes[0]?.sequence ?? this.changeSequence) - 1)
        )
        const changes =
          after && !reset
            ? this.changes.filter((change) => change.sequence > after.sequence).slice(0, 100)
            : []
        return {
          reset,
          progress: {
            total: this.known.size,
            indexed: this.indexed.size,
            failed: this.failed.size
          },
          changes,
          position: {
            incarnation: this.incarnation,
            sequence: changes.at(-1)?.sequence ?? this.changeSequence
          }
        }
      }
      case 'list':
        return this.database.list(query)
      case 'summary':
        return this.database.current(query.chatId)
      case 'known-run':
        return this.database.findKnownRun(query.runId)
      case 'run':
        return this.database.findRun(query.runId)
      case 'changed':
        this.notifyChanged(query.chatId)
        return true
      case 'open': {
        // `pump` already runs two lanes — a 'metadata' job without `priority`
        // is the slow one — and this `true` was handing every caller the fast
        // lane regardless. That is the whole defect: the post-paint recovery
        // drain opens every thread in the corpus at mode 'metadata', so it sat
        // FIFO with a user's chat open and a send waited behind repair. Let the
        // envelope decide instead; absent still means fast.
        const entry = await this.ensureIndexed(
          query.chatId,
          query.mode,
          priority !== 'background',
          query.projectionOptions,
          query.readContext
        )
        if (!entry) return null
        this.prune(query.chatId)
        if (
          this.leases.size >= 512 ||
          [...this.leases.values()].filter((lease) => lease.entry.chatId === query.chatId).length >=
            16
        )
          throw new Error('History page lease capacity reached')
        const leaseId = randomUUID()
        this.leases.set(leaseId, { entry, expires: Date.now() + 120_000 })
        return { leaseId, entry } satisfies ThreadCatalogueOpenResult
      }
      case 'objects':
        return this.database.readObjects(
          this.readLease(query.leaseId, query.kind === 'recovery'),
          query.kind,
          query
        )
      case 'chunk':
        return this.database.readChunk(
          this.readLease(query.leaseId, query.reference.kind === 'recovery'),
          query.reference,
          query.offset,
          query.maximum
        )
      case 'release': {
        const lease = this.leases.get(query.leaseId)
        this.leases.delete(query.leaseId)
        if (lease) {
          if (lease.entry.snapshot) {
            this.database.abandonGeneration(lease.entry)
            this.viewContexts.delete(lease.entry.generation)
          }
          this.prune(lease.entry.chatId)
        }
        return true
      }
      case 'erase': {
        const generation = this.catalogue.beginErasure(query.chatId)
        this.pausedForErasure = true
        // Closing the decoder drains its last acknowledged batch and discards
        // unpublished work before derived bytes are removed.
        await this.decoder.dispose()
        await this.running
        for (const [id, prepared] of this.prepared)
          if (!query.chatId || prepared.chatId === query.chatId) this.discardPrepared(id)
        for (const job of this.queue.splice(0)) {
          this.jobs.delete(job.chatId)
          job.reject(new Error('History indexing interrupted by erasure'))
        }
        for (const [id, lease] of this.leases)
          if (!query.chatId || lease.entry.chatId === query.chatId) this.leases.delete(id)
        const ids = query.chatId ? [query.chatId] : [...this.known]
        if (!query.chatId) this.database.removeAll()
        for (const id of ids) {
          this.database.removeChat(id)
          fs.rmSync(path.join(this.catalogue.directory, 'prepared', id), {
            recursive: true,
            force: true
          })
          this.indexed.delete(id)
          this.known.delete(id)
          this.options.onRemoved?.(id)
          this.changed(id, true)
          for (const lane of ['desktop', 'host', 'resolved']) {
            fs.rmSync(path.join(this.catalogue.directory, lane, `${id}.json`), { force: true })
          }
          for (const lane of ['desktop', 'host'])
            fs.rmSync(path.join(this.catalogue.directory, 'pending', lane, id), {
              recursive: true,
              force: true
            })
        }
        if (!query.chatId) {
          for (const lane of ['desktop', 'host', 'resolved', 'pending', 'prepared'])
            fs.rmSync(path.join(this.catalogue.directory, lane), { recursive: true, force: true })
          this.known.clear()
        }
        this.catalogue.syncErasedCacheDirectories()
        return generation
      }
      case 'finish-erasure': {
        const finished = this.catalogue.finishErasure(query.generation, query.chatId)
        if (finished) {
          this.decoder = new ThreadCatalogueDecoderClient(this.options.decoderPath)
          this.pausedForErasure = false
          this.failed.clear()
          this.inventoryStarted = false
          this.scheduleInventory(0)
        }
        return finished
      }
      case 'owner':
        throw new Error('Writer ownership is supplied by the parent authority')
    }
  }

  async dispose(): Promise<void> {
    this.closed = true
    if (this.inventoryTimer) clearTimeout(this.inventoryTimer)
    for (const timer of this.refreshTimers.values()) clearTimeout(timer)
    this.refreshTimers.clear()
    for (const watcher of this.watchers.values()) watcher.close()
    for (const job of this.queue.splice(0)) {
      this.jobs.delete(job.chatId)
      job.reject(new Error('History index shut down'))
    }
    await this.decoder.dispose()
    await this.running
    for (const id of this.prepared.keys()) this.discardPrepared(id)
    await this.inventoryRunning
    this.database.close()
  }
}
