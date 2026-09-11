import { currentEnsembleRuntimeInstanceId } from '../EnsembleRuntimeIdentity'
import { AppStore } from '../store'
import { threadCatalogueWriteGate } from '../store/ThreadCatalogueWriteGate'
import type {
  ThreadCatalogueProjection,
  ThreadCatalogueRecoveryHold
} from '../store/ThreadCatalogue'
import type { ThreadCatalogueOpenResult } from '../store/ThreadCatalogueClient'
import type { ThreadIndexedObject, ThreadIndexedObjectKind } from '../store/ThreadCatalogueDatabase'
import type {
  PreparedThreadMutation,
  ThreadCatalogueMutation
} from '../store/ThreadCatalogueMutation'
import type { TerminalChatRunSessionLike } from '../ChatRunReconciler'
import type { installStartupThreadCatalogue } from './installThreadCatalogue'

type Catalogue = ReturnType<typeof installStartupThreadCatalogue>

export async function readCatalogueObjects(
  catalogue: Catalogue,
  leaseId: string,
  kind: ThreadIndexedObjectKind
): Promise<unknown[]> {
  const values: unknown[] = []
  let after = -1
  let totalBytes = 0
  for (;;) {
    const page = await catalogue.mirror.port.query<ThreadIndexedObject[] | null>({
      method: 'objects',
      leaseId,
      kind,
      ...(after >= 0 ? { after } : {}),
      direction: 'newer',
      maxObjects: 64,
      maxBytes: 256 * 1024
    })
    if (!page) throw new Error('History query requires repair')
    if (!page.length) return values
    if (values.length + page.length > 4096)
      throw new Error('Operational history exceeds the recovery batch limit; source retained')
    for (const item of page) {
      totalBytes += item.kind === 'inline' ? item.byteLength : item.reference.byteLength
      if (totalBytes > 2 * 1024 * 1024)
        throw new Error('Operational recovery capacity exceeded; source retained')
      after = item.ordinal
      if (item.kind === 'inline') values.push(item.value)
      else {
        if (item.reference.byteLength > 256 * 1024)
          throw new Error(
            'Operational history object exceeds the main-process recovery limit; source retained'
          )
        const chunks: Buffer[] = []
        let offset = 0
        while (offset < item.reference.byteLength) {
          const bytes = await catalogue.mirror.port.query<Uint8Array | null>({
            method: 'chunk',
            leaseId,
            reference: item.reference,
            offset
          })
          if (!bytes?.byteLength) throw new Error('History object is incomplete')
          chunks.push(Buffer.from(bytes))
          offset += bytes.byteLength
        }
        values.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      }
    }
  }
}

export interface CatalogueRecoveryDependencies {
  catalogue: Catalogue
  isRunLive(runId: string): boolean
  isChatLive(chatId: string): boolean
  getRunSession(runId: string): TerminalChatRunSessionLike | undefined
  isErasing(projection: ThreadCatalogueProjection): boolean
  onRecovered?(prepared: PreparedThreadMutation): void | Promise<void>
  onOperationalRecords?(
    projection: ThreadCatalogueProjection,
    records: readonly Record<string, unknown>[]
  ): Promise<void> | void
  onError?(error: unknown, chatId: string): void
}

/** Every late migration row receives recovery; a cold empty catalogue is never a completed sweep. */
export class ThreadCatalogueRecovery {
  private readonly operational = new Map<
    string,
    { revision: number; sourceWitness: string; records: readonly Record<string, unknown>[] }
  >()
  private readonly queued = new Set<string>()
  private readonly active = new Set<string>()
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly cleanup = new Map<
    string,
    { token: string; finish(): void; timer?: ReturnType<typeof setTimeout> }
  >()
  private paused = false
  private mutations = 0
  private stopped = false
  private pumping = false
  private unsubscribe: (() => void) | null = null
  constructor(private readonly deps: CatalogueRecoveryDependencies) {}

  start(): void {
    if (this.unsubscribe || this.stopped) return
    this.unsubscribe = this.deps.catalogue.mirror.subscribe((row, id) => {
      if (row) this.enqueue(id)
      else this.operational.delete(id)
    })
    for (const row of this.deps.catalogue.mirror.projections()) this.enqueue(row.summary.chatId)
  }
  enqueueAll(): void {
    for (const row of this.deps.catalogue.mirror.projections()) this.enqueue(row.summary.chatId)
  }

  get joinsReady(): boolean {
    return (
      this.deps.catalogue.mirror.complete &&
      this.deps.catalogue.mirror
        .projections()
        .every(
          (row) =>
            row.sourceComplete !== false &&
            (row.recovery.joinPolicies === 0 ||
              this.operational.get(row.summary.chatId)?.revision === row.revision)
        )
    )
  }

  joinWorkers(parentChatId: string, groupId: string): unknown[] {
    return [...this.operational.entries()]
      .filter(([id, cached]) => {
        const row = this.deps.catalogue.mirror.get(id)
        return (
          row &&
          row.sourceComplete !== false &&
          row.recovery.joinPolicies > 0 &&
          row.revision === cached.revision
        )
      })
      .flatMap(([, { records }]) =>
        records.flatMap((record) =>
          record.kind === 'join' &&
          record.parentChatId === parentChatId &&
          record.groupId === groupId &&
          Array.isArray(record.workers)
            ? record.workers
            : []
        )
      )
  }

  enqueue(chatId: string): void {
    if (this.stopped || this.paused) return
    const row = this.deps.catalogue.mirror.get(chatId)
    if (!row || row.sourceComplete === false || this.deps.isErasing(row)) {
      this.operational.delete(chatId)
      return
    }
    if (this.operational.get(chatId)?.revision !== row.revision || row.recovery.joinPolicies === 0)
      this.operational.delete(chatId)
    const r = row.recovery
    if (
      !(
        r.unsettledRuns ||
        r.ensembleWakeups ||
        r.soloWakeups ||
        r.workerEvents ||
        r.joinPolicies ||
        r.nextBlackboardExpiryAt !== null
      )
    )
      return
    this.queued.add(chatId)
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopped || this.paused) return
    this.pumping = true
    try {
      while (this.queued.size && !this.stopped && !this.paused) {
        const id = this.queued.values().next().value!
        this.queued.delete(id)
        this.active.add(id)
        try {
          await this.recover(id)
        } catch (error) {
          this.deps.onError?.(error, id)
          if (!this.retries.has(id)) {
            const timer = setTimeout(() => {
              this.retries.delete(id)
              this.enqueue(id)
            }, 2000)
            timer.unref?.()
            this.retries.set(id, timer)
          }
        } finally {
          this.active.delete(id)
        }
      }
    } finally {
      this.pumping = false
    }
  }

  private session(runId: string): TerminalChatRunSessionLike | undefined {
    const s = this.deps.getRunSession(runId)
    return s
      ? {
          runId: s.runId,
          appChatId: s.appChatId,
          provider: s.provider,
          status: s.status,
          updatedAt: s.updatedAt
        }
      : undefined
  }

  private async recover(chatId: string): Promise<void> {
    const opened = await this.deps.catalogue.mirror.port.query<ThreadCatalogueOpenResult | null>({
      method: 'open',
      chatId,
      mode: 'metadata'
    })
    if (!opened) return
    let records: Record<string, unknown>[]
    try {
      if (opened.entry.projection.sourceComplete === false) return
      records = (await readCatalogueObjects(
        this.deps.catalogue,
        opened.leaseId,
        'recovery'
      )) as Record<string, unknown>[]
    } finally {
      await this.deps.catalogue.mirror.port.query({ method: 'release', leaseId: opened.leaseId })
    }
    if (this.stopped || this.deps.isErasing(opened.entry.projection)) return
    this.operational.set(chatId, {
      revision: opened.entry.projection.revision,
      sourceWitness: opened.entry.sourceWitness,
      records: records.filter((record) => record.kind === 'join')
    })
    const runs = records
      .filter(
        (record) =>
          record.kind === 'run' &&
          typeof record.runId === 'string' &&
          !this.deps.isRunLive(record.runId)
      )
      .slice(0, 1000)
      .map((record) => ({
        runId: String(record.runId),
        session: this.session(String(record.runId))
      }))
    if (runs.length)
      await this.mutate(
        chatId,
        { kind: 'settle-runs', nowIso: new Date().toISOString(), minAgeMs: 0, runs },
        () =>
          runs.every(
            (run) =>
              !this.deps.isRunLive(run.runId) &&
              JSON.stringify(this.session(run.runId)) === JSON.stringify(run.session)
          )
      )
    await this.deps.onOperationalRecords?.(opened.entry.projection, records)
  }

  async quiesce(): Promise<void> {
    this.paused = true
    const deadline = Date.now() + 30_000
    while (this.pumping || this.mutations || this.cleanup.size) {
      if (Date.now() > deadline) throw new Error('History recovery has not quiesced')
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
  }
  resume(): void {
    this.paused = false
    this.enqueueAll()
  }

  async mutate(
    chatId: string,
    mutation: ThreadCatalogueMutation,
    valid: () => boolean = () => true
  ): Promise<ThreadCatalogueProjection | null> {
    if (this.paused || this.stopped) return null
    this.mutations += 1
    try {
      return await this.performMutation(chatId, mutation, valid)
    } finally {
      this.mutations -= 1
    }
  }

  private async performMutation(
    chatId: string,
    mutation: ThreadCatalogueMutation,
    valid: () => boolean = () => true
  ): Promise<ThreadCatalogueProjection | null> {
    if (mutation.kind === 'repair-title') await AppStore.pendingPeopleMigrationInventory()
    if (
      this.stopped ||
      this.paused ||
      !AppStore.catalogueRecoveryAllowed(chatId) ||
      !valid() ||
      this.deps.isChatLive(chatId)
    )
      return null
    await AppStore.quiesceForCatalogueMutation(chatId)
    const release = threadCatalogueWriteGate.hold(chatId)
    if (!release) throw new Error('Chat has active admission; recovery is deferred')
    if (AppStore.hasPendingCatalogueWrites(chatId)) {
      release()
      throw new Error('Chat writer changed during recovery admission')
    }
    const clearGuard = this.deps.catalogue.setMutationGuard(
      chatId,
      () => !this.stopped && !this.paused && valid() && !this.deps.isChatLive(chatId)
    )
    let hold: ThreadCatalogueRecoveryHold | undefined
    let prepared: PreparedThreadMutation | null = null
    try {
      if (this.paused || !valid()) return null
      hold = await this.deps.catalogue.maintain<ThreadCatalogueRecoveryHold>({
        method: 'begin-recovery',
        chatId,
        desktopWriterId: currentEnsembleRuntimeInstanceId()
      })
      const current = await this.deps.catalogue.mirror.port.query<ThreadCatalogueOpenResult | null>(
        { method: 'open', chatId, mode: 'metadata' }
      )
      if (!current) return null
      await this.deps.catalogue.mirror.port.query({ method: 'release', leaseId: current.leaseId })
      if (
        current.entry.projection.sourceComplete === false ||
        this.deps.isErasing(current.entry.projection) ||
        !valid()
      )
        return null
      prepared = await this.deps.catalogue.maintain<PreparedThreadMutation | null>({
        method: 'prepare',
        chatId,
        sourceWitness: current.entry.sourceWitness,
        recoveryToken: hold.token,
        mutation
      })
      if (!prepared || this.stopped || this.paused || !valid()) return null
      const projection = await this.deps.catalogue.maintain<ThreadCatalogueProjection>({
        method: 'adopt-prepared',
        chatId,
        preparedId: prepared.preparedId,
        recoveryToken: hold.token
      })
      AppStore.acceptCatalogueMutation(projection)
      await this.deps.onRecovered?.(prepared)
      return projection
    } finally {
      // Idempotent: the failure path below settles locally straight away and
      // the parked retry still holds a reference for `dispose()`.
      let finished = false
      const finish = (): void => {
        if (finished) return
        finished = true
        if (prepared)
          void this.deps.catalogue
            .maintain({ method: 'discard-prepared', preparedId: prepared.preparedId })
            .catch(() => undefined)
        clearGuard()
        release()
      }
      if (hold) {
        const token = hold.token
        await this.deps.catalogue
          .maintain({
            method: 'end-recovery',
            chatId,
            recoveryToken: token
          })
          .catch((error) => {
            // Settle the PROCESS-LOCAL gate now, and keep chasing the remote
            // cancel in the background.
            //
            // This used to wait for the cancel to be acknowledged, so that an
            // `adopt-prepared` which timed out locally but is still running on
            // the Host could not interleave with a local writer. The cost of
            // that belt was unbounded: `ThreadCatalogueWriteGate.admit` waits on
            // a held chat with no timeout and no rejection, and an unreachable
            // Host — or one whose writer authority moved — rejects every retry,
            // so "until it is acknowledged" becomes "until this process exits".
            // Every composer-selection persist, `saveRendererChat` and
            // `mutateTranscript` for that one thread hangs behind it, with
            // nothing anywhere to say why. 66fcf2813 fixed exactly this for
            // teardown and left the live path holding.
            //
            // Nothing is actually unguarded by releasing here: this recovery
            // has finished every local step, so the gate is no longer excluding
            // anything of its own, and a late Host-side commit is excluded by
            // the braces rather than the belt — `adopt` re-asserts its hold and
            // `adoptPreparedThreadRecord` CAS-checks the prepared mutation's
            // epoch, which an intervening local write has already moved.
            finish()
            this.cleanup.set(chatId, { token, finish })
            this.retryCleanup(chatId)
            throw error
          })
      }
      finish()
    }
  }

  private retryCleanup(chatId: string): void {
    const cleanup = this.cleanup.get(chatId)
    if (!cleanup || cleanup.timer) return
    cleanup.timer = setTimeout(() => {
      cleanup.timer = undefined
      void this.deps.catalogue
        .maintain({ method: 'end-recovery', chatId, recoveryToken: cleanup.token })
        .then(
          () => {
            if (this.cleanup.get(chatId) !== cleanup) return
            this.cleanup.delete(chatId)
            cleanup.finish()
            this.enqueue(chatId)
          },
          () => this.retryCleanup(chatId)
        )
    }, 2000)
    cleanup.timer.unref?.()
  }

  dispose(): void {
    this.stopped = true
    this.unsubscribe?.()
    this.queued.clear()
    for (const timer of this.retries.values()) clearTimeout(timer)
    this.retries.clear()
    // A deferred cleanup still owns this chat's write-gate hold: its `finish`
    // is the only thing that calls the `release()` taken in
    // `runMutation`. Dropping the reference without calling it strands the
    // hold, and `ThreadCatalogueWriteGate.admit` waits on a held chat with no
    // timeout and no rejection -- so every later command on that thread, plus
    // `saveRendererChat`, `mutateTranscript` and `awaitChatRecordPersisted`,
    // blocks for the lifetime of the process. That is indistinguishable from
    // the app freezing on one thread.
    //
    // These timers also live on the cleanup entry rather than in `retries`,
    // so they survived dispose and kept retrying an `end-recovery` against a
    // catalogue that is going away. Cancel them and settle locally: the
    // durable hold is separately bounded by its own TTL, and leaving the
    // PROCESS-LOCAL gate shut buys nothing once recovery has stopped.
    for (const entry of this.cleanup.values()) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.finish()
    }
    this.cleanup.clear()
  }
}
