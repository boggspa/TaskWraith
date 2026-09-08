import type {
  ThreadCatalogueSummary,
  ThreadCatalogueProjection,
  ThreadCatalogueEpoch,
  ThreadCatalogueTicket,
  ThreadCatalogueDurabilityReceipt,
  ThreadCatalogueSourceHeads,
  ThreadCatalogueIndexReference
} from '../../shared/threadCatalogueTypes'
export type {
  ThreadCatalogueSummary,
  ThreadCatalogueRecovery,
  ThreadCatalogueProjection,
  ThreadCatalogueEpoch,
  ThreadCatalogueTicket,
  ThreadCatalogueDurabilityReceipt,
  ThreadCatalogueSourceHeads,
  ThreadCatalogueIndexReference
} from '../../shared/threadCatalogueTypes'
import { copyThreadCatalogueProjection } from './ThreadCatalogueProjection'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { isSafeChatId } from '../../shared/ChatPath'

export const THREAD_CATALOGUE_VERSION = 1
export const THREAD_CATALOGUE_MAX_HEAD_BYTES = 256 * 1024
export type ThreadCatalogueWriter = 'desktop' | 'host'

interface PublicationHead {
  version: typeof THREAD_CATALOGUE_VERSION
  ticket: ThreadCatalogueTicket
  phase: 'pending' | 'durable' | 'repair'
  receipt?: ThreadCatalogueDurabilityReceipt
  projection?: ThreadCatalogueProjection
  durabilityDebtId?: string
}

interface ResolvedHead {
  version: typeof THREAD_CATALOGUE_VERSION
  chatId: string
  epoch: ThreadCatalogueEpoch
  heads: ThreadCatalogueSourceHeads
  sourceWitness: string
  projection: ThreadCatalogueProjection
  publicationId: string
  indexReference: ThreadCatalogueIndexReference
  coveredWriters: Partial<
    Record<ThreadCatalogueWriter, { writerId: string; operationOrdinal: number }>
  >
}

interface EpochRecord {
  generation: string
  erasing: boolean
}

export type ThreadCatalogueRead =
  | {
      status: 'ready'
      projection: ThreadCatalogueProjection
      publicationId: string
      indexReference: ThreadCatalogueIndexReference
    }
  | { status: 'repair-pending'; summary?: ThreadCatalogueSummary }
  | { status: 'erasing' }

export interface ThreadCatalogueOptions {
  profilePath: string
  /** Writer labels are correlation evidence. canWrite supplies existing authority. */
  writer: ThreadCatalogueWriter
  writerId: string
  canWrite: () => boolean
  /** Existing profile/process authority decides retirement; a label never does. */
  writerLifecycle: (
    writer: ThreadCatalogueWriter,
    writerId: string
  ) => 'active' | 'retired' | 'unknown'
  /** Only the designated parent may publish the resolved slot. */
  canPublishResolution: () => boolean
  /** Separate admission from the existing history-erasure transaction. */
  canErase: () => boolean
  canManageRecoveryHolds?: () => boolean
  /** Durable acknowledgement of a resolver-authorized source flush, keyed by exact failure. */
  isSourceDurabilityProven?: (
    chatId: string,
    epoch: ThreadCatalogueEpoch,
    debtId: string
  ) => boolean
  /** Fault-injection seams for publication and first-use directory crash tests. */
  beforeAtomicRename?: (filePath: string) => void
  afterAtomicRename?: (filePath: string) => void
  beforeDirectorySync?: (directory: string) => void
  /** Checks the complete canonical source vector, including same-revision overlays. */
  isSourceWitnessCurrent: (chatId: string, witness: string) => boolean
  isIndexedGenerationCommitted: (
    chatId: string,
    reference: ThreadCatalogueIndexReference,
    sourceWitness: string,
    epoch: ThreadCatalogueEpoch,
    heads: ThreadCatalogueSourceHeads
  ) => boolean
}

export interface ThreadCatalogueRecoveryHold {
  chatId: string
  token: string
  desktopWriterId?: string
  hostWriterId?: string
  hostIncarnation: string
}

function epochMatches(a: ThreadCatalogueEpoch, b: ThreadCatalogueEpoch): boolean {
  return a.global === b.global && a.chat === b.chat
}

function headsMatch(a: ThreadCatalogueSourceHeads, b: ThreadCatalogueSourceHeads): boolean {
  return a.desktop === b.desktop && a.host === b.host
}

interface PendingBurst {
  ticket: ThreadCatalogueTicket
  unsettled: Set<number>
  candidate?: {
    ticket: ThreadCatalogueTicket
    receipt: ThreadCatalogueDurabilityReceipt
    projection: ThreadCatalogueProjection
  }
  finalizationPending?: boolean
  durabilityDebtId?: string
}

/**
 * Fixed, disjoint publication slots. Source writers never append/compact a
 * shared index, and migration never edits their slots. A missing/old/changed
 * publication remains repair debt; no method falls back to a ChatRecord read.
 */
export class ThreadCatalogue {
  readonly directory: string
  readonly controlDirectory: string
  private readonly profilePath: string
  private readonly outstanding = new Map<string, PendingBurst>()
  private readonly durableDirectories = new Set<string>()
  private nextOperationOrdinal = 0

  constructor(private readonly options: ThreadCatalogueOptions) {
    if (
      !path.isAbsolute(options.profilePath) ||
      !['desktop', 'host'].includes(options.writer) ||
      typeof options.writerId !== 'string' ||
      !options.writerId ||
      options.writerId.length > 256
    ) {
      throw new Error('Invalid thread catalogue writer configuration')
    }
    this.profilePath = path.resolve(options.profilePath)
    this.directory = path.join(this.profilePath, 'thread-catalogue-v1')
    this.controlDirectory = path.join(this.profilePath, 'thread-history-control-v1')
  }

  private assertWritable(): void {
    if (!this.options.canWrite()) throw new Error('Thread catalogue publication is read-only')
  }

  private assertChatId(chatId: string): void {
    if (!isSafeChatId(chatId)) throw new Error('Invalid thread catalogue chat id')
  }

  private witnessIsCurrent(chatId: string, witness: string): boolean {
    if (typeof witness !== 'string' || !witness || witness.length > 4096) return false
    try {
      return this.options.isSourceWitnessCurrent(chatId, witness) === true
    } catch {
      return false
    }
  }

  private indexIsCommitted(
    row: Pick<ResolvedHead, 'chatId' | 'indexReference' | 'sourceWitness' | 'epoch' | 'heads'>
  ): boolean {
    const ref = row.indexReference
    if (
      !ref ||
      typeof ref.databaseId !== 'string' ||
      ref.databaseId.length > 128 ||
      typeof ref.generation !== 'string' ||
      ref.generation.length > 128
    )
      return false
    try {
      return (
        this.options.isIndexedGenerationCommitted(
          row.chatId,
          ref,
          row.sourceWitness,
          row.epoch,
          row.heads
        ) === true
      )
    } catch {
      return false
    }
  }

  /** Read a fixed byte budget even if the file is replaced after it is opened. */
  private readJson<T>(filePath: string): T | null {
    let fd: number | undefined
    try {
      fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || stat.size > THREAD_CATALOGUE_MAX_HEAD_BYTES) return null
      const bytes = Buffer.alloc(stat.size + 1)
      const count = fs.readSync(fd, bytes, 0, bytes.length, 0)
      if (count !== stat.size) return null
      return JSON.parse(bytes.toString('utf8', 0, count)) as T
    } catch {
      return null
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd)
        } catch {
          /* An unreadable head stays repair debt. */
        }
      }
    }
  }

  private filePresence(filePath: string): 'present' | 'missing' | 'unreadable' {
    try {
      fs.lstatSync(filePath)
      return 'present'
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable'
    }
  }

  private writeJson(filePath: string, value: unknown): void {
    this.assertWritable()
    const text = JSON.stringify(value)
    if (Buffer.byteLength(text) > THREAD_CATALOGUE_MAX_HEAD_BYTES) {
      throw new Error('Thread catalogue publication exceeds its metadata budget')
    }
    const directory = path.dirname(filePath)
    this.ensureDurableDirectory(directory)
    const temporary = `${filePath}.tmp-${randomUUID()}`
    let fd: number | undefined
    try {
      fd = fs.openSync(temporary, 'wx', 0o600)
      fs.writeFileSync(fd, text)
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fd = undefined
      this.options.beforeAtomicRename?.(filePath)
      fs.renameSync(temporary, filePath)
      this.options.afterAtomicRename?.(filePath)
      this.syncDirectory(directory)
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
      fs.rmSync(temporary, { force: true })
    }
  }

  private syncDirectory(directory: string): void {
    let fd: number | undefined
    try {
      this.options.beforeDirectorySync?.(directory)
      fd = fs.openSync(directory, 'r')
      fs.fsyncSync(fd)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const unsupported =
        code === 'EINVAL' ||
        code === 'ENOTSUP' ||
        (process.platform === 'win32' && ['EISDIR', 'EPERM', 'EACCES'].includes(code ?? ''))
      if (!unsupported) throw error
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
  }

  private ensureDurableDirectory(directory: string): void {
    if (this.durableDirectories.has(directory) && fs.existsSync(directory)) return
    this.durableDirectories.delete(directory)
    const parent = path.dirname(directory)
    if (directory !== this.profilePath) this.ensureDurableDirectory(parent)
    if (!fs.existsSync(directory)) {
      // The existing profile owner creates the profile root before publishing.
      if (directory === this.profilePath) throw new Error('Thread catalogue profile is absent')
      try {
        fs.mkdirSync(directory, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    // Repeat this after a failed attempt even if mkdir already succeeded.
    this.syncDirectory(parent)
    this.durableDirectories.add(directory)
  }

  private slot(writer: ThreadCatalogueWriter | 'resolved', chatId: string): string {
    this.assertChatId(chatId)
    return path.join(this.directory, writer, `${chatId}.json`)
  }

  private repairDirectory(writer: ThreadCatalogueWriter, chatId: string): string {
    this.assertChatId(chatId)
    return path.join(this.directory, 'pending', writer, chatId)
  }

  private repairTickets(
    writer: ThreadCatalogueWriter,
    chatId: string
  ): Array<{ file: string; ticket: ThreadCatalogueTicket | null }> {
    const directory = this.repairDirectory(writer, chatId)
    let names: string[]
    try {
      names = fs.readdirSync(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      return [{ file: directory, ticket: null }]
    }
    return names
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const file = path.join(directory, name)
        const ticket = this.readJson<ThreadCatalogueTicket>(file)
        return {
          file,
          ticket:
            ticket?.writer === writer &&
            ticket.chatId === chatId &&
            typeof ticket.writerId === 'string' &&
            typeof ticket.operationId === 'string' &&
            Number.isSafeInteger(ticket.operationOrdinal)
              ? ticket
              : null
        }
      })
  }

  /** Enumerates outstanding work only, never historical catalogue heads. */
  repairChatIds(): string[] {
    const ids = new Set<string>()
    for (const writer of ['desktop', 'host'] as const) {
      const directory = path.join(this.directory, 'pending', writer)
      try {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          if (!isSafeChatId(entry.name) || !entry.isDirectory()) continue
          if (this.repairTickets(writer, entry.name).length) ids.add(entry.name)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return [...ids].sort()
  }

  private epochRecord(chatId?: string): EpochRecord {
    const filePath = this.epochPath(chatId)
    const value = this.readJson<EpochRecord>(filePath)
    if (value && typeof value.generation === 'string' && typeof value.erasing === 'boolean')
      return value
    // Corrupt and absent differ: a corrupt erasure fence cannot reopen writes.
    return this.filePresence(filePath) !== 'missing'
      ? { generation: 'unreadable', erasing: true }
      : { generation: 'initial', erasing: false }
  }

  private epochPath(chatId?: string): string {
    return chatId === undefined
      ? path.join(this.controlDirectory, 'epochs', 'global.json')
      : path.join(
          this.controlDirectory,
          'epochs',
          'chats',
          `${createHash('sha256').update(chatId).digest('hex')}.json`
        )
  }

  epoch(chatId: string): ThreadCatalogueEpoch {
    this.assertChatId(chatId)
    return { global: this.epochRecord().generation, chat: this.epochRecord(chatId).generation }
  }

  private isErasing(chatId: string): boolean {
    return this.epochRecord().erasing || this.epochRecord(chatId).erasing
  }

  registerWriter(): void {
    if (this.lifecycle(this.options.writer, this.options.writerId) !== 'active') {
      throw new Error('Thread catalogue source writer is not active')
    }
    this.writeJson(path.join(this.controlDirectory, 'owners', `${this.options.writer}.json`), {
      writerId: this.options.writerId,
      pid: process.pid
    })
    this.writeJson(this.ownerPath(this.options.writer, this.options.writerId), {
      writerId: this.options.writerId,
      pid: process.pid
    })
  }

  private ownerPath(writer: ThreadCatalogueWriter, id: string): string {
    return path.join(
      this.controlDirectory,
      'owners',
      writer,
      `${createHash('sha256').update(id).digest('hex')}.json`
    )
  }

  registeredWriter(
    writer: ThreadCatalogueWriter,
    id: string
  ): { writerId: string; pid: number } | null {
    const owner = this.readJson<{ writerId: string; pid: number }>(this.ownerPath(writer, id))
    return owner?.writerId === id && Number.isSafeInteger(owner.pid) && owner.pid > 1 ? owner : null
  }

  private lifecycle(
    writer: ThreadCatalogueWriter,
    writerId: string
  ): 'active' | 'retired' | 'unknown' {
    try {
      return this.options.writerLifecycle(writer, writerId)
    } catch {
      return 'unknown'
    }
  }

  currentRegisteredWriter(writer: ThreadCatalogueWriter): { writerId: string; pid: number } | null {
    const owner = this.readJson<{ writerId: string; pid: number }>(
      path.join(this.controlDirectory, 'owners', `${writer}.json`)
    )
    if (!owner || typeof owner.writerId !== 'string' || owner.writerId.length > 256) return null
    const registered = this.registeredWriter(writer, owner.writerId)
    return registered?.pid === owner.pid ? registered : null
  }

  assertSourceMutationAllowed(chatId: string, recoveryToken?: string): void {
    this.assertWritable()
    this.assertChatId(chatId)
    if (this.lifecycle(this.options.writer, this.options.writerId) !== 'active')
      throw new Error('History source writer is not active')
    if (this.isErasing(chatId)) throw new Error('Thread catalogue is fenced for history erasure')
    this.assertRecoveryHoldAllows(chatId, recoveryToken)
  }

  beginPublication(chatId: string, recoveryToken?: string): ThreadCatalogueTicket {
    this.assertWritable()
    this.assertChatId(chatId)
    if (this.lifecycle(this.options.writer, this.options.writerId) !== 'active') {
      throw new Error('Thread catalogue source writer is not active')
    }
    if (this.isErasing(chatId)) throw new Error('Thread catalogue is fenced for history erasure')
    this.assertSourceMutationAllowed(chatId, recoveryToken)
    const epoch = this.epoch(chatId)
    if (this.outstanding.get(chatId)?.finalizationPending) this.retryPublication(chatId)
    const current = this.outstanding.get(chatId)
    if (current && epochMatches(current.ticket.epoch, epoch)) {
      if (!this.head(this.options.writer, chatId)) {
        current.durabilityDebtId = randomUUID()
        this.writeJson(this.slot(this.options.writer, chatId), {
          version: THREAD_CATALOGUE_VERSION,
          ticket: current.ticket,
          phase: 'pending',
          durabilityDebtId: current.durabilityDebtId
        } satisfies PublicationHead)
      }
      const next = { ...current.ticket, sequence: current.ticket.sequence + 1 }
      current.ticket = next
      current.unsettled.add(next.sequence)
      try {
        this.assertSourceMutationAllowed(chatId, recoveryToken)
      } catch (error) {
        current.unsettled.delete(next.sequence)
        this.settleBurst(chatId, current)
        throw error
      }
      return this.copyTicket(next)
    }
    const ticket: ThreadCatalogueTicket = {
      chatId,
      writer: this.options.writer,
      writerId: this.options.writerId,
      operationId: randomUUID(),
      operationOrdinal:
        Math.max(
          this.nextOperationOrdinal,
          this.head(this.options.writer, chatId)?.ticket.operationOrdinal ?? 0,
          this.repairTickets(this.options.writer, chatId).reduce(
            (maximum, { ticket }) =>
              ticket?.writerId === this.options.writerId
                ? Math.max(maximum, ticket.operationOrdinal)
                : maximum,
            0
          )
        ) + 1,
      sequence: 1,
      epoch
    }
    this.nextOperationOrdinal = ticket.operationOrdinal
    const previousHead = this.head(this.options.writer, chatId)
    const inheritedDebt =
      previousHead?.phase === 'pending' ||
      (!previousHead && this.filePresence(this.slot(this.options.writer, chatId)) !== 'missing')
        ? randomUUID()
        : previousHead?.durabilityDebtId
    const burst: PendingBurst = {
      ticket,
      unsettled: new Set([1]),
      ...(inheritedDebt ? { durabilityDebtId: inheritedDebt } : {})
    }
    this.outstanding.set(chatId, burst)
    // The immutable debt name is visible before a source write can begin.
    try {
      this.writeJson(
        path.join(this.repairDirectory(ticket.writer, chatId), `${ticket.operationId}.json`),
        this.copyTicket(ticket)
      )
      this.writeJson(this.slot(ticket.writer, chatId), {
        version: THREAD_CATALOGUE_VERSION,
        ticket,
        phase: 'pending',
        ...(burst.durabilityDebtId ? { durabilityDebtId: burst.durabilityDebtId } : {})
      } satisfies PublicationHead)
      this.assertSourceMutationAllowed(chatId, recoveryToken)
    } catch (error) {
      // No ticket escaped, so no source operation was admitted. Retain the
      // retryable finalization if even publishing the aborted issuance fails.
      burst.unsettled.clear()
      burst.finalizationPending = true
      try {
        this.settleBurst(chatId, burst)
      } catch {
        /* retryPublication retains the debt */
      }
      throw error
    }
    // New debt is durable before older names are retired. This keeps streaming
    // repair work bounded without an acknowledgement ever deleting a new name.
    for (const previous of this.repairTickets(ticket.writer, chatId)) {
      if (previous.ticket?.operationId === ticket.operationId) continue
      if (
        previous.ticket?.writerId === ticket.writerId &&
        previous.ticket.operationOrdinal < ticket.operationOrdinal
      ) {
        try {
          fs.unlinkSync(previous.file)
        } catch {
          /* Resolution can retire this old debt. */
        }
      }
    }
    return this.copyTicket(ticket)
  }

  private recoveryHoldPath(chatId: string): string {
    this.assertChatId(chatId)
    return path.join(this.controlDirectory, 'recovery-holds', `${chatId}.json`)
  }

  recoveryHold(chatId: string): ThreadCatalogueRecoveryHold | null | 'unreadable' {
    const file = this.recoveryHoldPath(chatId)
    const hold = this.readJson<ThreadCatalogueRecoveryHold>(file)
    if (
      hold?.chatId === chatId &&
      [hold.token, hold.desktopWriterId ?? hold.hostWriterId, hold.hostIncarnation].every(
        (value) => typeof value === 'string' && value.length > 0 && value.length <= 256
      )
    )
      return hold
    return this.filePresence(file) === 'missing' ? null : 'unreadable'
  }

  assertRecoveryHoldAllows(chatId: string, token?: string): void {
    const hold = this.recoveryHold(chatId)
    if (hold && (hold === 'unreadable' || hold.token !== token))
      throw new Error('Chat history recovery is in progress')
  }

  holdRecovery(hold: ThreadCatalogueRecoveryHold): void {
    if (!this.options.canManageRecoveryHolds?.())
      throw new Error('History recovery hold authority is unavailable')
    if (this.recoveryHold(hold.chatId))
      throw new Error('Chat history recovery is already in progress')
    this.writeJson(this.recoveryHoldPath(hold.chatId), hold)
  }

  releaseRecoveryHold(chatId: string, token: string): boolean {
    if (!this.options.canManageRecoveryHolds?.()) return false
    const current = this.recoveryHold(chatId)
    if (!current || current === 'unreadable' || current.token !== token) return false
    fs.unlinkSync(this.recoveryHoldPath(chatId))
    this.syncDirectory(path.dirname(this.recoveryHoldPath(chatId)))
    return true
  }

  recoveryHolds(): ThreadCatalogueRecoveryHold[] {
    const directory = path.join(this.controlDirectory, 'recovery-holds')
    if (!fs.existsSync(directory)) return []
    return fs.readdirSync(directory).flatMap((name) => {
      const id = name.endsWith('.json') ? name.slice(0, -5) : ''
      if (!isSafeChatId(id)) return []
      const hold = this.recoveryHold(id)
      return hold && hold !== 'unreadable' ? [hold] : []
    })
  }

  private copyTicket(ticket: ThreadCatalogueTicket): ThreadCatalogueTicket {
    return Object.freeze({
      chatId: ticket.chatId,
      writer: ticket.writer,
      writerId: ticket.writerId,
      operationId: ticket.operationId,
      operationOrdinal: ticket.operationOrdinal,
      sequence: ticket.sequence,
      epoch: Object.freeze({ global: ticket.epoch.global, chat: ticket.epoch.chat })
    })
  }

  private ownsCurrent(ticket: ThreadCatalogueTicket): boolean {
    const current = this.outstanding.get(ticket.chatId)
    const durable = this.readJson<PublicationHead>(this.slot(this.options.writer, ticket.chatId))
    return Boolean(
      current &&
      current.ticket.operationId === ticket.operationId &&
      current.unsettled.has(ticket.sequence) &&
      ticket.writer === this.options.writer &&
      ticket.writerId === this.options.writerId &&
      this.lifecycle(ticket.writer, ticket.writerId) === 'active' &&
      durable?.ticket?.operationId === ticket.operationId &&
      durable.ticket.writerId === ticket.writerId &&
      epochMatches(ticket.epoch, this.epoch(ticket.chatId)) &&
      !this.isErasing(ticket.chatId)
    )
  }

  private settleBurst(chatId: string, burst: PendingBurst): boolean {
    if (burst.unsettled.size > 0) return false
    const candidate = burst.candidate
    const valid = Boolean(
      candidate && this.witnessIsCurrent(chatId, candidate.receipt.sourceWitness)
    )
    const head: PublicationHead =
      valid && candidate
        ? {
            version: THREAD_CATALOGUE_VERSION,
            ticket: burst.ticket,
            phase: 'durable',
            receipt: candidate.receipt,
            projection: candidate.projection
          }
        : { version: THREAD_CATALOGUE_VERSION, ticket: burst.ticket, phase: 'repair' }
    if (burst.durabilityDebtId) head.durabilityDebtId = burst.durabilityDebtId
    burst.finalizationPending = true
    this.writeJson(this.slot(this.options.writer, chatId), head)
    this.outstanding.delete(chatId)
    return valid
  }

  /** Acknowledges this source operation only. All covered operations must settle. */
  finishPublication(
    ticket: ThreadCatalogueTicket,
    receipt: ThreadCatalogueDurabilityReceipt,
    projection?: ThreadCatalogueProjection
  ): boolean {
    this.assertWritable()
    const finalizing = this.outstanding.get(ticket.chatId)
    if (finalizing?.finalizationPending && finalizing.ticket.operationId === ticket.operationId) {
      return this.retryPublication(ticket.chatId)
    }
    if (!this.ownsCurrent(ticket)) return false
    const bounded = copyThreadCatalogueProjection(projection, ticket.chatId)
    if (
      !receipt ||
      receipt.operationId !== ticket.operationId ||
      receipt.sequence !== ticket.sequence
    )
      return false
    const burst = this.outstanding.get(ticket.chatId)!
    burst.unsettled.delete(ticket.sequence)
    if (
      bounded &&
      receipt.revision === bounded.revision &&
      this.witnessIsCurrent(ticket.chatId, receipt.sourceWitness) &&
      (!burst.candidate ||
        receipt.revision > burst.candidate.receipt.revision ||
        (receipt.revision === burst.candidate.receipt.revision &&
          ticket.sequence > burst.candidate.ticket.sequence))
    ) {
      burst.candidate = {
        ticket: this.copyTicket(ticket),
        receipt: {
          operationId: receipt.operationId,
          sequence: receipt.sequence,
          revision: receipt.revision,
          sourceWitness: receipt.sourceWitness
        },
        projection: bounded
      }
    }
    return this.settleBurst(ticket.chatId, burst)
  }

  /** The caller proves this operation can no longer publish source bytes. */
  failPublication(
    ticket: ThreadCatalogueTicket,
    options: { source?: 'unchanged' | 'uncertain' } = {}
  ): boolean {
    this.assertWritable()
    const finalizing = this.outstanding.get(ticket.chatId)
    if (finalizing?.finalizationPending && finalizing.ticket.operationId === ticket.operationId) {
      this.retryPublication(ticket.chatId)
      return true
    }
    if (!this.ownsCurrent(ticket)) return false
    const burst = this.outstanding.get(ticket.chatId)!
    if (options.source !== 'unchanged') {
      burst.durabilityDebtId = randomUUID()
      // Persist uncertainty while the original pending head still fences the
      // operation. Neither a later aborted burst nor process exit erases it.
      this.writeJson(this.slot(ticket.writer, ticket.chatId), {
        version: THREAD_CATALOGUE_VERSION,
        ticket: burst.ticket,
        phase: 'pending',
        durabilityDebtId: burst.durabilityDebtId
      } satisfies PublicationHead)
    }
    burst.unsettled.delete(ticket.sequence)
    this.settleBurst(ticket.chatId, burst)
    return true
  }

  /** Retry metadata finalization without repeating an already-settled source write. */
  retryPublication(chatId: string): boolean {
    this.assertWritable()
    this.assertChatId(chatId)
    const burst = this.outstanding.get(chatId)
    if (
      !burst?.finalizationPending ||
      burst.unsettled.size > 0 ||
      this.lifecycle(this.options.writer, this.options.writerId) !== 'active' ||
      !epochMatches(burst.ticket.epoch, this.epoch(chatId)) ||
      this.isErasing(chatId)
    )
      return false
    return this.settleBurst(chatId, burst)
  }

  private head(writer: ThreadCatalogueWriter, chatId: string): PublicationHead | null {
    const head = this.readJson<PublicationHead>(this.slot(writer, chatId))
    return head?.version === THREAD_CATALOGUE_VERSION &&
      head.ticket?.chatId === chatId &&
      head.ticket.writer === writer &&
      typeof head.ticket.operationId === 'string' &&
      typeof head.ticket.writerId === 'string' &&
      (head.durabilityDebtId === undefined ||
        (typeof head.durabilityDebtId === 'string' && head.durabilityDebtId.length <= 128)) &&
      Number.isSafeInteger(head.ticket.operationOrdinal) &&
      Number.isSafeInteger(head.ticket.sequence) &&
      ['pending', 'durable', 'repair'].includes(head.phase)
      ? head
      : null
  }

  sourceHeads(chatId: string): ThreadCatalogueSourceHeads {
    const identity = (writer: ThreadCatalogueWriter): string | null => {
      const head = this.head(writer, chatId)
      if (head)
        return `${head.ticket.writerId}:${head.ticket.operationId}:${head.phase}:${head.ticket.sequence}:${head.durabilityDebtId ?? ''}`
      return this.filePresence(this.slot(writer, chatId)) !== 'missing' ? 'unreadable' : null
    }
    return { desktop: identity('desktop'), host: identity('host') }
  }

  private hasLivePublication(chatId: string): boolean {
    for (const debt of this.sourceDurabilityDebts(chatId)) {
      try {
        if (this.options.isSourceDurabilityProven?.(chatId, this.epoch(chatId), debt) !== true)
          return true
      } catch {
        return true
      }
    }
    for (const writer of ['desktop', 'host'] as const) {
      const head = this.head(writer, chatId)
      if (!head && this.filePresence(this.slot(writer, chatId)) !== 'missing') return true
      for (const { ticket } of this.repairTickets(writer, chatId)) {
        if (!ticket) return true
        if (this.lifecycle(writer, ticket.writerId) === 'retired') continue
        if (
          this.lifecycle(writer, ticket.writerId) !== 'active' ||
          !head ||
          head.ticket.writerId !== ticket.writerId ||
          head.ticket.operationOrdinal < ticket.operationOrdinal ||
          head.phase === 'pending'
        )
          return true
      }
      if (head?.phase === 'pending' && this.lifecycle(writer, head.ticket.writerId) !== 'retired')
        return true
    }
    return false
  }

  publicationPending(chatId: string): boolean {
    return this.hasLivePublication(chatId)
  }
  /** Source completion is a local fact even if optional metadata cannot be read. */
  settleLocalSource(ticket: ThreadCatalogueTicket): void {
    const burst = this.outstanding.get(ticket.chatId)
    if (
      !burst ||
      burst.ticket.operationId !== ticket.operationId ||
      ticket.writerId !== this.options.writerId
    )
      return
    burst.unsettled.delete(ticket.sequence)
    if (burst.unsettled.size === 0) burst.finalizationPending = true
  }

  /** Called by the source parent only after the durable erasure transaction succeeds. */
  forgetErasedPublications(chatId?: string): void {
    for (const id of chatId ? [chatId] : this.outstanding.keys()) this.outstanding.delete(id)
  }

  syncErasedCacheDirectories(): void {
    for (const relative of [
      'desktop',
      'host',
      'resolved',
      'pending/desktop',
      'pending/host',
      'pending',
      'prepared',
      ''
    ]) {
      const directory = path.join(this.directory, relative)
      if (this.filePresence(directory) === 'present') this.syncDirectory(directory)
    }
  }

  outstandingChatIds(): string[] {
    return [...this.outstanding.keys()]
  }

  hasOutstandingPublication(chatId: string): boolean {
    return this.outstanding.has(chatId)
  }

  sourceDurabilityDebts(chatId: string): string[] {
    const debts = new Set<string>()
    for (const writer of ['desktop', 'host'] as const) {
      const head = this.head(writer, chatId)
      if (head?.durabilityDebtId) debts.add(head.durabilityDebtId)
      if (head?.phase === 'pending' && this.lifecycle(writer, head.ticket.writerId) === 'retired')
        debts.add(`pending:${head.ticket.writerId}:${head.ticket.operationId}`)
      for (const { ticket } of this.repairTickets(writer, chatId)) {
        if (!ticket || this.lifecycle(writer, ticket.writerId) !== 'retired') continue
        if (
          head?.ticket.writerId === ticket.writerId &&
          head.ticket.operationOrdinal >= ticket.operationOrdinal &&
          head.phase !== 'pending'
        )
          continue
        debts.add(`pending:${ticket.writerId}:${ticket.operationId}`)
      }
    }
    return [...debts]
  }

  /** The parent publishes worker results; a worker never edits a writer slot. */
  publishResolution(
    input: Omit<ResolvedHead, 'version' | 'publicationId' | 'coveredWriters'>
  ): boolean {
    this.assertWritable()
    this.assertChatId(input.chatId)
    if (!this.options.canPublishResolution()) return false
    const projection = copyThreadCatalogueProjection(input.projection, input.chatId)
    if (
      this.isErasing(input.chatId) ||
      !epochMatches(input.epoch, this.epoch(input.chatId)) ||
      !headsMatch(input.heads, this.sourceHeads(input.chatId)) ||
      this.hasLivePublication(input.chatId) ||
      !projection ||
      !this.indexIsCommitted(input) ||
      !this.witnessIsCurrent(input.chatId, input.sourceWitness)
    )
      return false
    const coveredWriters: ResolvedHead['coveredWriters'] = {}
    for (const writer of ['desktop', 'host'] as const) {
      const head = this.head(writer, input.chatId)
      if (head)
        coveredWriters[writer] = {
          writerId: head.ticket.writerId,
          operationOrdinal: head.ticket.operationOrdinal
        }
    }
    this.writeJson(this.slot('resolved', input.chatId), {
      version: THREAD_CATALOGUE_VERSION,
      chatId: input.chatId,
      epoch: { global: input.epoch.global, chat: input.epoch.chat },
      heads: { desktop: input.heads.desktop, host: input.heads.host },
      sourceWitness: input.sourceWitness,
      projection,
      indexReference: {
        databaseId: input.indexReference.databaseId,
        generation: input.indexReference.generation
      },
      publicationId: randomUUID(),
      coveredWriters
    })
    return true
  }

  /** Called after activating the exact indexed generation referenced by this publication. */
  acknowledgeResolution(chatId: string, publicationId: string): boolean {
    this.assertWritable()
    if (!this.options.canPublishResolution()) return false
    const ready = this.read(chatId)
    if (ready.status !== 'ready' || ready.publicationId !== publicationId) return false
    const row = this.readJson<ResolvedHead>(this.slot('resolved', chatId))
    if (row?.publicationId !== publicationId || !row.coveredWriters) return false
    for (const writer of ['desktop', 'host'] as const) {
      for (const { file, ticket } of this.repairTickets(writer, chatId)) {
        if (!ticket) continue
        const covered = row.coveredWriters[writer]
        if (
          this.lifecycle(writer, ticket.writerId) === 'retired' ||
          (covered?.writerId === ticket.writerId &&
            ticket.operationOrdinal <= covered.operationOrdinal)
        ) {
          try {
            fs.unlinkSync(file)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
      }
      const directory = this.repairDirectory(writer, chatId)
      if (this.filePresence(directory) === 'present') {
        this.syncDirectory(directory)
        try {
          fs.rmdirSync(directory)
          this.durableDirectories.delete(directory)
          this.syncDirectory(path.dirname(directory))
        } catch (error) {
          if (
            !['ENOTEMPTY', 'ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')
          )
            throw error
        }
      }
    }
    return true
  }

  read(chatId: string): ThreadCatalogueRead {
    this.assertChatId(chatId)
    if (this.isErasing(chatId)) return { status: 'erasing' }
    const row = this.readJson<ResolvedHead>(this.slot('resolved', chatId))
    const projection = copyThreadCatalogueProjection(row?.projection, chatId)
    if (
      !row ||
      row.version !== THREAD_CATALOGUE_VERSION ||
      row.chatId !== chatId ||
      !row.epoch ||
      !row.heads ||
      typeof row.publicationId !== 'string' ||
      row.publicationId.length > 128 ||
      !projection
    )
      return { status: 'repair-pending' }
    if (!epochMatches(row.epoch, this.epoch(chatId))) return { status: 'repair-pending' }
    if (
      !headsMatch(row.heads, this.sourceHeads(chatId)) ||
      this.hasLivePublication(chatId) ||
      !this.indexIsCommitted(row) ||
      !this.witnessIsCurrent(chatId, row.sourceWitness)
    ) {
      return { status: 'repair-pending', summary: projection.summary }
    }
    return {
      status: 'ready',
      projection,
      publicationId: row.publicationId,
      indexReference: {
        databaseId: row.indexReference.databaseId,
        generation: row.indexReference.generation
      }
    }
  }

  /** Called by the existing history-erasure authority before quiescence. */
  beginErasure(chatId?: string): string {
    if (!this.options.canErase())
      throw new Error('Thread catalogue erasure authority is unavailable')
    if (chatId !== undefined) this.assertChatId(chatId)
    const generation = randomUUID()
    this.writeJson(this.epochPath(chatId), {
      generation,
      erasing: true
    } satisfies EpochRecord)
    if (chatId) this.outstanding.delete(chatId)
    else this.outstanding.clear()
    return generation
  }

  /** Invoke only after source and publication workers have quiesced and residues are removed. */
  finishErasure(generation: string, chatId?: string): boolean {
    if (!this.options.canErase()) return false
    if (chatId !== undefined) this.assertChatId(chatId)
    if (this.epochRecord(chatId).generation !== generation) return false
    this.writeJson(this.epochPath(chatId), {
      generation,
      erasing: false
    } satisfies EpochRecord)
    return true
  }
}
