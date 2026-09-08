import { createHash, randomUUID } from 'node:crypto'
import {
  ThreadCatalogue,
  type ThreadCatalogueTicket,
  type ThreadCatalogueWriter
} from './ThreadCatalogue'
import { captureThreadCatalogueWitness } from './ThreadCatalogueWitness'
import type { ThreadCatalogueProjection } from './ThreadCatalogue'
import { threadCatalogueWriteGate } from './ThreadCatalogueWriteGate'

export type ThreadCataloguePublication = ThreadCatalogueTicket & { untracked?: true }

/** Runs beside the existing source writer; it never opens the query database. */
export class ThreadCatalogueSourcePublisher<
  TRecord extends { appChatId: string } = { appChatId: string }
> {
  readonly catalogue: ThreadCatalogue
  private readonly active = new Map<string, string>()
  private readonly unknown = new Set<string>()
  private readonly repairing = new Map<string, Promise<void>>()
  private repairReset = 0
  private readonly repairEpochs = new Map<string, number>()
  private stopped = false
  private registered = false
  private registrationRetryAt = 0
  private readonly completions = new Set<Promise<void>>()
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>()
  constructor(
    private readonly options: {
      repairSource?(chatId: string): Promise<string>
      project?(record: TRecord): ThreadCatalogueProjection
      profilePath: string
      writer: ThreadCatalogueWriter
      writerId: string
      canWrite(): boolean
      segmented: boolean
      canManageRecoveryHolds?: () => boolean
      onChanged?(chatId: string): void
      onError?(error: unknown): void
    }
  ) {
    this.catalogue = new ThreadCatalogue({
      ...options,
      writerLifecycle: (lane, id) =>
        lane === options.writer && id === options.writerId ? 'active' : 'unknown',
      canPublishResolution: () => false,
      canErase: () => false,
      canManageRecoveryHolds: options.canManageRecoveryHolds,
      isSourceWitnessCurrent: (id, witness) => this.witness(id) === witness,
      isIndexedGenerationCommitted: () => false
    })
    this.tryRegister()
  }

  private tryRegister(): boolean {
    if (this.registered) return true
    if (Date.now() < this.registrationRetryAt) return false
    try {
      this.catalogue.registerWriter()
      this.registered = true
      return true
    } catch (error) {
      this.registrationRetryAt = Date.now() + 2000
      this.options.onError?.(error)
      return false
    }
  }
  private key(ticket: ThreadCatalogueTicket): string {
    return `${ticket.operationId}:${ticket.sequence}`
  }
  private hasSourceWrites(chatId: string): boolean {
    return [...this.active.values()].includes(chatId)
  }
  hasPending(chatId: string): boolean {
    return this.hasSourceWrites(chatId) || this.repairing.has(chatId)
  }
  canRecover(chatId: string): boolean {
    return (
      !this.hasPending(chatId) &&
      !this.unknown.has(chatId) &&
      !this.catalogue.hasOutstandingPublication(chatId)
    )
  }
  private completed(ticket: ThreadCataloguePublication): void {
    this.active.delete(this.key(ticket))
    if (!ticket.untracked) this.catalogue.settleLocalSource(ticket)
    if (this.unknown.has(ticket.chatId) && !this.hasSourceWrites(ticket.chatId))
      this.repair(ticket.chatId)
  }
  private repair(chatId: string): void {
    if (this.stopped || !this.options.repairSource || this.repairing.has(chatId)) return
    const key = createHash('sha256').update(chatId).digest('hex')
    const reset = this.repairReset
    const epoch = this.repairEpochs.get(key) ?? 0
    const current = (): boolean =>
      !this.stopped && reset === this.repairReset && epoch === (this.repairEpochs.get(key) ?? 0)
    const flight = Promise.resolve()
      .then(() => this.options.repairSource!(chatId))
      .then((witness) => {
        if (!current()) return
        if (!this.hasSourceWrites(chatId) && this.witness(chatId) === witness) {
          this.catalogue.retryPublication(chatId)
          if (this.catalogue.hasOutstandingPublication(chatId))
            throw new Error('History metadata finalization is pending')
          if (!this.tryRegister()) throw new Error('History writer registration is pending')
          this.unknown.delete(chatId)
          this.options.onChanged?.(chatId)
        } else if (!this.hasSourceWrites(chatId))
          throw new Error('History changed during source repair')
      })
      .catch(() => {
        if (current() && !this.retries.has(chatId)) {
          const timer = setTimeout(() => {
            this.retries.delete(chatId)
            this.repair(chatId)
          }, 2000)
          timer.unref?.()
          this.retries.set(chatId, timer)
        }
      })
      .finally(() => {
        this.repairing.delete(chatId)
      })
    this.repairing.set(chatId, flight)
  }

  private witness(chatId: string): string {
    return captureThreadCatalogueWitness(
      {
        profilePath: this.options.profilePath,
        runtimeInstanceId: this.options.writerId,
        segmented: this.options.segmented
      },
      chatId
    ).witness
  }

  begin(chatId: string, recoveryToken?: string): ThreadCataloguePublication {
    if (this.stopped) throw new Error('History publisher is shut down')
    // These are actual source-operation holds, not optional index bookkeeping.
    if (this.options.writer === 'desktop' && !recoveryToken)
      threadCatalogueWriteGate.assertAvailable(chatId)
    this.catalogue.assertSourceMutationAllowed(chatId, recoveryToken)
    let ticket: ThreadCataloguePublication
    try {
      if (!this.tryRegister()) throw new Error('History metadata registration is unavailable')
      ticket = this.catalogue.beginPublication(chatId, recoveryToken)
    } catch (error) {
      // A hold installed during a cross-process attempt still wins. Only the
      // derived bookkeeping may degrade; the canonical writer checks its own authority.
      this.catalogue.assertSourceMutationAllowed(chatId, recoveryToken)
      this.unknown.add(chatId)
      this.options.onError?.(error)
      ticket = {
        chatId,
        writer: this.options.writer,
        writerId: this.options.writerId,
        operationId: randomUUID(),
        operationOrdinal: 0,
        sequence: 1,
        epoch: { global: 'untracked', chat: 'untracked' },
        untracked: true
      }
    }
    try {
      this.catalogue.assertSourceMutationAllowed(chatId, recoveryToken)
    } catch (error) {
      this.fail(ticket, 'unchanged')
      throw error
    }
    this.active.set(this.key(ticket), chatId)
    return ticket
  }

  finishProjection(
    ticket: ThreadCataloguePublication,
    projection: ThreadCatalogueProjection
  ): string | undefined {
    let sourceWitness: string | undefined
    try {
      sourceWitness = this.witness(ticket.chatId)
      if (
        !ticket.untracked &&
        !this.catalogue.finishPublication(
          ticket,
          {
            operationId: ticket.operationId,
            sequence: ticket.sequence,
            revision: projection.revision,
            sourceWitness
          },
          projection
        )
      )
        this.unknown.add(ticket.chatId)
    } catch (error) {
      this.unknown.add(ticket.chatId)
      this.options.onError?.(error)
    } finally {
      this.completed(ticket)
      this.options.onChanged?.(ticket.chatId)
    }
    return sourceWitness
  }

  finish(ticket: ThreadCataloguePublication, record: TRecord): void {
    try {
      const projection = this.options.project?.(record)
      if (
        !ticket.untracked &&
        !this.catalogue.finishPublication(
          ticket,
          {
            operationId: ticket.operationId,
            sequence: ticket.sequence,
            revision:
              projection?.revision ??
              Number((record as { persistenceRevision?: number }).persistenceRevision ?? 0),
            sourceWitness: this.witness(ticket.chatId)
          },
          projection
        )
      )
        this.unknown.add(ticket.chatId)
    } catch (error) {
      this.unknown.add(ticket.chatId)
      this.options.onError?.(error)
    } finally {
      this.completed(ticket)
      this.options.onChanged?.(ticket.chatId)
    }
  }

  finishAfter(
    ticket: ThreadCataloguePublication,
    record: TRecord,
    durability: Promise<void>
  ): void {
    // Capture the exact source vector before yielding; an older fsync completing
    // after a newer failed append must not borrow that append's source identity.
    let captured: { projection: ThreadCatalogueProjection; sourceWitness: string } | undefined
    let captureError: unknown
    try {
      captured = {
        projection: this.options.project!(record),
        sourceWitness: this.witness(ticket.chatId)
      }
    } catch (error) {
      captureError = error
    }
    const completion = durability
      .then(
        () => {
          if (!captured) {
            this.fail(ticket, 'unchanged')
            this.options.onError?.(captureError)
            return
          }
          const { projection, sourceWitness } = captured
          if (
            !ticket.untracked &&
            !this.catalogue.finishPublication(
              ticket,
              {
                operationId: ticket.operationId,
                sequence: ticket.sequence,
                revision: projection.revision,
                sourceWitness
              },
              projection
            )
          )
            this.unknown.add(ticket.chatId)
          this.options.onChanged?.(ticket.chatId)
        },
        (error) => {
          this.fail(ticket)
          throw error
        }
      )
      .catch((error) => {
        this.unknown.add(ticket.chatId)
        this.options.onError?.(error)
      })
      .finally(() => {
        this.completed(ticket)
        this.completions.delete(completion)
      })
    this.completions.add(completion)
  }

  fail(ticket: ThreadCataloguePublication, source: 'unchanged' | 'uncertain' = 'uncertain'): void {
    if (source === 'uncertain') this.unknown.add(ticket.chatId)
    try {
      if (!ticket.untracked) this.catalogue.failPublication(ticket, { source })
    } catch (error) {
      this.unknown.add(ticket.chatId)
      this.options.onError?.(error)
    } finally {
      this.completed(ticket)
      this.options.onChanged?.(ticket.chatId)
    }
  }

  async drain(chatIds?: readonly string[]): Promise<void> {
    const scope = chatIds ? new Set(chatIds) : null
    const deadline = Date.now() + 30_000
    for (;;) {
      const pending = [...new Set([...this.active.values(), ...this.repairing.keys()])].filter(
        (id) => !scope || scope.has(id)
      )
      if (!pending.length) break
      if (Date.now() >= deadline) throw new Error('History source writers have not drained')
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
    if (!scope) await Promise.all([...this.completions])
  }

  forgetErased(chatId?: string): void {
    const ids = chatId
      ? [chatId]
      : [
          ...new Set([
            ...this.unknown,
            ...this.retries.keys(),
            ...this.repairing.keys(),
            ...this.catalogue.outstandingChatIds()
          ])
        ]
    if (!chatId) {
      this.repairReset += 1
      this.repairEpochs.clear()
    }
    for (const id of ids) {
      if (this.hasSourceWrites(id)) throw new Error('Erased source writes have not drained')
      const key = createHash('sha256').update(id).digest('hex')
      if (chatId) this.repairEpochs.set(key, (this.repairEpochs.get(key) ?? 0) + 1)
      const timer = this.retries.get(id)
      if (timer) clearTimeout(timer)
      this.retries.delete(id)
      this.unknown.delete(id)
      this.catalogue.forgetErasedPublications(id)
    }
  }

  async dispose(): Promise<void> {
    await this.drain()
    this.stopped = true
    for (const timer of this.retries.values()) clearTimeout(timer)
    this.retries.clear()
  }

  async drainChat(chatId: string): Promise<void> {
    await this.drain([chatId])
  }

  async writeRecord<T extends TRecord | null>(chatId: string, write: () => Promise<T>): Promise<T> {
    return threadCatalogueWriteGate.admit(chatId, async () => {
      const ticket = this.begin(chatId)
      try {
        const record = await write()
        if (record) this.finish(ticket, record)
        else this.fail(ticket, 'unchanged')
        return record
      } catch (error) {
        this.fail(ticket)
        throw error
      }
    })
  }
}
