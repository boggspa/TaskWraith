/**
 * The Host's holder of the thread owner table.
 *
 * `HostThreadOwnerTable` decides who may write a thread from the revisions it
 * is given, and two revisions cannot tell a log its owner wrote and has not
 * published from a save the Host refused or overtook: the app appends to its
 * log before the Host judges a save. Only the first may be folded into the
 * full copy, or carried on by a new process. The authority file tells them
 * apart. An app process writes one for a thread when it is granted the thread,
 * before its first append under the grant, so this registry reads a thread's
 * log revision, and gives it to the table, only while that file is there.
 * Without it, a log above the full copy is a mirror of saves the Host has
 * already judged, and the table never sees it.
 *
 * The table is kept in memory and is lost when the Host stops; the files are
 * what survives. The registry reads a thread's file each time it decides on
 * the thread, so a Host that has just started is ruled by them:
 * - a file whose writer is alive keeps the thread for that writer. The Host
 *   neither writes the thread nor grants it to another process until the
 *   writer claims it again, and is granted it afresh by this Host, or removes
 *   the file;
 * - a file whose writer has ended marks work it never published. The Host
 *   folds that into its full copy before it writes, then removes the file and
 *   owns the thread; or a new app process claims the thread by carrying the
 *   log on from its head;
 * - a file that is there and cannot be read keeps the thread as a live
 *   writer's file does;
 * - with no file, the thread is the Host's.
 * `rebuild` lists the files once at start: listing makes durable what a writer
 * left half done, before anyone acts on it, and names the threads to fold.
 *
 * It decides one thing at a time for each thread, and starts the next a turn
 * of the event loop after it answers. The reads that wait come first; the
 * facts that can change while it waits (the Host's full copy, its runs, which
 * app processes have attached) are read after the last wait, in the same turn
 * as the table's decision.
 */
import {
  commitThreadPublication,
  THREAD_PUBLICATION_BUSY,
  type HostThreadPublicationBinding,
  type HostThreadPublicationCommit,
  type HostThreadPublicationResult
} from './HostThreadPublicationGuard'
import { isSafeChatId } from '../shared/ChatPath'
import {
  threadWriterLiveness,
  type ThreadAuthorityFiles,
  type ThreadAuthorityRecord,
  type ThreadAuthorityWriter,
  type ThreadWriterLiveness
} from '../host-shared/thread-log/ThreadAuthorityFile'
import {
  retireOrphanThreadAuthority,
  type ThreadAuthorityRetirementOutcome
} from '../host-shared/thread-log/ThreadAuthorityRetirement'
import {
  HostThreadOwnerTable,
  type HostDesktopPresence,
  type HostThreadOwnerTableSnapshot,
  type HostWriteDecision,
  type HostWriteFacts,
  type ThreadAdvancedMessage,
  type ThreadClaimFacts,
  type ThreadClaimRefusalReason,
  type ThreadClaimReply,
  type ThreadClaimRequest,
  type ThreadReleaseMessage,
  type ThreadWriter,
  type ThreadOwnerEpoch
} from '../host-shared/thread-log/ThreadOwnership'

export interface HostThreadOwnerRegistryOptions {
  /** New for every Host process, and part of every epoch it grants. */
  readonly incarnation: string
  /** Whether this Host grants claims at all. Off, it grants none and reads no authority file. */
  readonly enabled: boolean
  readonly releaseBoundMs?: number
  /** The profile's authority files. Only the Host's taking of a thread removes one here. */
  readonly files: Pick<ThreadAuthorityFiles, 'read' | 'list' | 'remove'>
  /** Revision of the Host's full copy of the thread, or null when it has none. */
  fullCopyRevision(threadId: string): number | null
  /** Head revision of the thread's log, or null when it has none. Asked under a file only. */
  logRevision(threadId: string): Promise<number | null>
  /** A Host run, or any other Host write, is live on the thread. */
  hostRunActive(threadId: string): boolean
  /** Whether app processes run, and whether all have attached since the Host started. */
  desktopPresence(): HostDesktopPresence
  /** A live app process other than this writer has not attached since the Host started. */
  otherDesktopUnattached(writerId: string): boolean
  /** Synchronous metadata witness captured before publication's asynchronous reads. */
  publicationWitness?(threadId: string): () => boolean
  /** Whether an authority file's writer still runs. By default, signal 0 to its process id. */
  liveness?(writer: ThreadAuthorityWriter): ThreadWriterLiveness
}

/** What the authority files said when the Host started. */
export interface HostThreadOwnerRebuild {
  /** Threads whose writer may still run, kept for it until it claims them again. */
  readonly held: readonly { readonly threadId: string; readonly writerId: string }[]
  /** Threads whose writer has ended: the Host folds what the log holds above its full copy. */
  readonly fold: readonly string[]
  /** Threads whose file cannot be read, kept as a live writer's would be. */
  readonly damaged: readonly string[]
}

const WRITE: HostWriteDecision = { kind: 'write' }
const BUSY: HostWriteDecision = { kind: 'busy', reason: 'thread_busy_in_desktop' }

/** A thread's next decision starts a turn after the last is answered, once its asker has acted. */
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function requireThreadId(threadId: unknown): void {
  // An authority file is named after its thread, so an id must be one a file can carry.
  if (!isSafeChatId(threadId)) throw new Error('Invalid thread id')
}

/** The newest revision the Host can read: the log where it leads, else the full copy. */
function durableHead(fullCopyRevision: number | null, logRevision: number | null): number | null {
  return logRevision !== null && (fullCopyRevision === null || logRevision > fullCopyRevision)
    ? logRevision
    : fullCopyRevision
}

function refused(
  request: ThreadClaimRequest,
  reason: ThreadClaimRefusalReason,
  revision: number | null
): ThreadClaimReply {
  return { threadId: request.threadId, claimId: request.claimId, granted: false, reason, revision }
}

export class HostThreadOwnerRegistry {
  private readonly table: HostThreadOwnerTable
  private readonly liveness: (writer: ThreadAuthorityWriter) => ThreadWriterLiveness
  /** The latest decision queued for each thread that has one waiting or running. */
  private readonly queues = new Map<string, Promise<void>>()

  constructor(private readonly options: HostThreadOwnerRegistryOptions) {
    this.table = new HostThreadOwnerTable({
      incarnation: options.incarnation,
      enabled: options.enabled,
      ...(options.releaseBoundMs !== undefined ? { releaseBoundMs: options.releaseBoundMs } : {})
    })
    this.liveness = options.liveness
      ? (writer) => options.liveness!(writer)
      : (writer) => threadWriterLiveness(writer)
  }

  /**
   * For a Host that has just started. Listing syncs the files' directory
   * first, so a file a writer removed, or renamed into place, just before the
   * restart stays the way the Host found it. Nothing is changed here: each
   * decision reads its thread's file again.
   */
  async rebuild(): Promise<HostThreadOwnerRebuild> {
    const held: { threadId: string; writerId: string }[] = []
    const fold: string[] = []
    const damaged: string[] = []
    if (this.options.enabled) {
      for (const { threadId, read } of await this.options.files.list()) {
        if (read.kind === 'damaged') damaged.push(threadId)
        else if (this.writerEnded(read.record.writer)) fold.push(threadId)
        else held.push({ threadId, writerId: read.record.writer.writerId })
      }
    }
    return { held, fold, damaged }
  }

  /**
   * Grants a thread nobody holds only to a claimer standing on the Host's full
   * copy and, under an authority file, on the head of the log the file marks.
   * A live writer's file keeps the thread for that writer.
   */
  async claim(
    request: ThreadClaimRequest,
    connection?: { isCurrent(): boolean; granted(epoch: ThreadOwnerEpoch): void }
  ): Promise<ThreadClaimReply> {
    requireThreadId(request.threadId)
    return this.serial(request.threadId, async () => {
      const { threadId, writerId } = request
      if (!this.options.enabled) return this.table.claim(request, this.claimFacts(request, null))
      const read = await this.options.files.read(threadId)
      const record = read.kind === 'held' ? read.record : null
      const logRevision = record ? await this.options.logRevision(threadId) : null
      // Nothing waits from here to the answer: the facts read below still hold when it is given.
      this.forgetEndedOwner(threadId, record)
      if (connection && !connection.isCurrent())
        return refused(request, 'owned_by_other_writer', this.options.fullCopyRevision(threadId))
      if (this.table.writerOf(threadId).kind === 'host') {
        const fullCopyRevision = this.options.fullCopyRevision(threadId)
        const otherWriter =
          read.kind === 'damaged' ||
          (record !== null &&
            record.writer.writerId !== writerId &&
            !this.writerEnded(record.writer))
        if (otherWriter) {
          const head = durableHead(fullCopyRevision, logRevision)
          return refused(request, 'owned_by_other_writer', head)
        }
      }
      const reply = this.table.claim(request, this.claimFacts(request, logRevision))
      if (reply.granted) connection?.granted(reply.epoch)
      return reply
    })
  }

  /** Records how far the writer's log has got. False when the message names no current grant. */
  async advanced(
    message: ThreadAdvancedMessage,
    isCurrent: () => boolean = () => true
  ): Promise<boolean> {
    requireThreadId(message.threadId)
    return this.serial(message.threadId, async () => isCurrent() && this.table.advanced(message))
  }

  /**
   * Gives the thread back to the Host. False when the message names no current
   * grant. The writer removes its authority file before it sends this: a file
   * that is still there names a live writer, and keeps the thread for it.
   */
  async release(
    message: ThreadReleaseMessage,
    isCurrent: () => boolean = () => true
  ): Promise<boolean> {
    requireThreadId(message.threadId)
    return this.serial(message.threadId, async () => isCurrent() && this.table.release(message))
  }

  /** A socket closes synchronously, invalidating exactly the grant it held. */
  revoke(threadId: string, epoch: ThreadOwnerEpoch): void {
    this.table.release({ action: 'release', threadId, epoch, revision: null })
  }

  /**
   * Final publication check, after transfer preparation. All asynchronous
   * reads precede the last connection/grant check and synchronous commit.
   * An orphan remains untouched until the separate fold/retirement path exists.
   */
  async publishFullCopy<T>(
    threadId: string,
    binding: HostThreadPublicationBinding,
    commit: HostThreadPublicationCommit<T>
  ): Promise<HostThreadPublicationResult<T>> {
    requireThreadId(threadId)
    return this.serial(threadId, async () => {
      if (!this.options.enabled) return commitThreadPublication(commit)
      let read: Awaited<ReturnType<ThreadAuthorityFiles['read']>>
      let logRevision: number | null
      let authorityUnchanged: () => boolean
      try {
        if (!this.options.publicationWitness) return THREAD_PUBLICATION_BUSY
        authorityUnchanged = this.options.publicationWitness(threadId)
        read = await this.options.files.read(threadId)
        logRevision = read.kind === 'held' ? await this.options.logRevision(threadId) : null
      } catch {
        return THREAD_PUBLICATION_BUSY
      }
      const record = read.kind === 'held' ? read.record : null
      if (!authorityUnchanged() || !binding.isCurrent() || read.kind === 'damaged')
        return THREAD_PUBLICATION_BUSY
      this.forgetEndedOwner(threadId, record)
      const writer = this.table.writerOf(threadId)
      const expected = binding.owner
      if (writer.kind === 'desktop') {
        if (
          !expected ||
          writer.writerId !== expected.writerId ||
          writer.epoch.host !== expected.epoch.host ||
          writer.epoch.grant !== expected.epoch.grant ||
          (record && record.writer.writerId !== expected.writerId) ||
          !this.table.mayReplaceFullCopy(threadId, expected.writerId, {
            otherDesktopUnattached: this.options.otherDesktopUnattached(expected.writerId)
          })
        )
          return THREAD_PUBLICATION_BUSY
      } else {
        // A permit captured under an old grant never falls back to a legacy write.
        if (expected) return THREAD_PUBLICATION_BUSY
        if (record) {
          if (!this.writerEnded(record.writer)) return THREAD_PUBLICATION_BUSY
          const full = this.options.fullCopyRevision(threadId)
          if (logRevision !== null && (full === null || logRevision > full))
            return { kind: 'refused', errorCode: 'thread_fold_first' }
          // I7 retires even a caught-up mark durably. This guard never removes it.
          return THREAD_PUBLICATION_BUSY
        }
        if (this.options.desktopPresence() === 'unattached') return THREAD_PUBLICATION_BUSY
      }
      return commitThreadPublication(commit)
    })
  }

  /**
   * Asked before the Host changes a thread itself; only `write` lets it. A
   * caller answered `write` marks its write live, as `hostRunActive` reports
   * it, before it waits on anything: the next decision on the thread is taken
   * a turn of the event loop later.
   */
  async requestHostWrite(threadId: string, now: number): Promise<HostWriteDecision> {
    requireThreadId(threadId)
    return this.serial(threadId, async () => {
      if (!this.options.enabled) return WRITE
      const read = await this.options.files.read(threadId)
      const record = read.kind === 'held' ? read.record : null
      const logRevision = record ? await this.options.logRevision(threadId) : null
      this.forgetEndedOwner(threadId, record)
      let facts: HostWriteFacts
      if (this.table.writerOf(threadId).kind === 'desktop') {
        facts = this.writeFacts(threadId, logRevision, this.options.desktopPresence())
      } else {
        if (record && !this.writerEnded(record.writer)) return BUSY
        const presence = this.options.desktopPresence()
        // A process that has not attached may still hold the thread from before
        // the Host started, with its file on its way.
        if (presence === 'unattached') return BUSY
        // Under a file, the only process that could hold work above the full
        // copy has ended, so the Host may fold it.
        facts = this.writeFacts(threadId, logRevision, record ? 'none' : presence)
      }
      const decision = this.table.requestHostWrite(threadId, facts, now)
      if (decision.kind !== 'write') return decision
      // A file that is there and cannot be read may be anyone's: never written over.
      if (read.kind === 'damaged') return BUSY
      // The Host takes the thread: it has no file, and that is durable. A file
      // removed by a writer that stopped before its directory sync could
      // otherwise come back after a power loss, and mark a log the Host has
      // written past as owned work.
      try {
        await this.options.files.remove(threadId)
      } catch {
        // A file the Host cannot take away may still name a writer: never written over.
        return BUSY
      }
      return decision
    })
  }

  /**
   * Retire an orphaned authority mark: a writer's mark whose writer has
   * ended and whose log the Host has folded into its full copy. The orphan
   * pathway is the only one that may retire a mark when no live desktop is
   * attached; ordinary routes cannot borrow this method to skip the
   * live-desktop exemption. Directory sync is awaited inside `files.remove`,
   * and the witness is read again after the sync so a racing recreate is
   * caught and reported as uncertain retirement, not durable success.
   *
   * The reservation must match the mark's recorded epoch: a writer cannot
   * ask for retirement on a mark it never captured, and a future Host
   * incarnation cannot retire a mark by an older host's grant.
   */
  async retireOrphanAuthority(
    threadId: string,
    reservation: ThreadOwnerEpoch
  ): Promise<ThreadAuthorityRetirementOutcome> {
    requireThreadId(threadId)
    if (!this.options.enabled) return { kind: 'busy', reason: 'damaged' }
    return this.serial(threadId, async () => {
      const read = await this.options.files.read(threadId)
      if (read.kind === 'none') return { kind: 'retired' }
      if (read.kind === 'damaged') return { kind: 'busy', reason: 'damaged' }
      const record = read.record
      if (record.epoch.host !== reservation.host || record.epoch.grant !== reservation.grant) {
        return { kind: 'busy', reason: 'damaged' }
      }
      if (!this.writerEnded(record.writer)) return { kind: 'busy', reason: 'live_writer' }
      const witness = this.options.publicationWitness?.(threadId)
      if (!witness || !witness()) return { kind: 'busy', reason: 'damaged' }
      return retireOrphanThreadAuthority(threadId, {
        reservation,
        observation: {
          reservation: record.epoch,
          exactMarkWitness: witness,
          writerEnded: true,
          erasing: false
        },
        removeAndSync: async () => {
          // The unlinked file + temp sibling + directory sync are awaited
          // together: the orphan hold stays open across the await, so a power
          // loss during the sync cannot resurrect the mark.
          await this.options.files.remove(threadId)
        }
      })
    })
  }

  /**
   * The writer has let go of every grant: its process ended, or its last
   * connection to this Host closed, which makes the app drop them too. Its
   * threads go back to the Host, which still folds whatever the writer's file
   * marks as unpublished before it writes them.
   */
  writerGone(writerId: string): string[] {
    return this.table.writerGone(writerId)
  }

  writerOf(threadId: string): ThreadWriter {
    return this.table.writerOf(threadId)
  }

  snapshot(): HostThreadOwnerTableSnapshot {
    return this.table.snapshot()
  }

  /** A writer whose process has ended holds nothing, and no app process running means none can. */
  private writerEnded(writer: ThreadAuthorityWriter): boolean {
    return this.options.desktopPresence() === 'none' || this.liveness(writer) === 'dead'
  }

  /** The table keeps a writer until told it is gone; the writer's own authority file can tell. */
  private forgetEndedOwner(threadId: string, record: ThreadAuthorityRecord | null): void {
    const owner = this.table.writerOf(threadId)
    if (
      owner.kind === 'desktop' &&
      record?.writer.writerId === owner.writerId &&
      this.writerEnded(record.writer)
    ) {
      this.table.writerGone(owner.writerId)
    }
  }

  private claimFacts(request: ThreadClaimRequest, logRevision: number | null): ThreadClaimFacts {
    return {
      fullCopyRevision: this.options.fullCopyRevision(request.threadId),
      logRevision,
      hostRunActive: this.options.hostRunActive(request.threadId),
      otherDesktopUnattached: this.options.otherDesktopUnattached(request.writerId)
    }
  }

  private writeFacts(
    threadId: string,
    logRevision: number | null,
    desktop: HostDesktopPresence
  ): HostWriteFacts {
    return { fullCopyRevision: this.options.fullCopyRevision(threadId), logRevision, desktop }
  }

  private serial<T>(threadId: string, decide: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(threadId)
    const decision = previous ? previous.then(decide) : decide()
    const done = decision.then(nextTurn, nextTurn)
    this.queues.set(threadId, done)
    void done.then(() => {
      if (this.queues.get(threadId) === done) this.queues.delete(threadId)
    })
    return decision
  }
}
