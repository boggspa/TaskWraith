/**
 * The Host's answers to `thread.owner`: which app process writes a thread.
 *
 * The thread log authority switch is read once, when the service is built,
 * and kept for the life of the Host. Off, the Host takes no claims: a claim is
 * refused `disabled`, and `advanced` and `release` name no grant it holds.
 * That is also the answer of a Host started with `TASKWRAITH_HOST_TXN_PERSIST=1`,
 * which feeds its public window only from its own writes. On, one
 * `HostThreadOwnerRegistry` answers them, ruled by the profile's authority
 * files.
 *
 * Which app processes are alive, and attached to this Host:
 * - A connection speaks for the app process whose writer id it first claims
 *   with. Only that exact connection may report on its grants. It is the same per-socket
 *   identity the lease registry keys leases by, and the socket's close, which
 *   ends its lease, detaches it.
 * - The app drops every grant when its connection to the Host closes, so the
 *   Host does too: closing a connection gives back exactly its grants, even
 *   when the writer has another connection. A grant therefore never outlives its holder's
 *   connection, and a writer the table holds is always attached.
 * - The only processes that can hold a thread from before this Host started
 *   are those named by authority files: a grant's file is durable before the
 *   first append under it, and a grant from another Host is dropped with the
 *   connection to it. Each file's writer is alive unless its process id is
 *   gone (signal 0, as the catalogue's recovery decides), and until it claims
 *   the thread from this Host its file keeps the thread for it. So "every live
 *   app process has attached since the Host started" is decided thread by
 *   thread, by the thread's file, and the registry is told that app processes
 *   are attached: one process that has not come back holds only its own
 *   threads, never every thread.
 *
 * A damaged authority folder never stops the Host. A folder it cannot list at
 * start is logged and counted, and the Host starts: each decision reads its
 * thread's file again, and a file it cannot read, whether the file or the
 * folder is at fault, keeps the thread as a live writer's would, so the Host
 * neither grants the thread nor writes it. The counts are in its snapshot.
 *
 * The Host asks it, through `requestHostWrite`, before it changes a thread's
 * full copy itself. A file whose writer is alive keeps the thread; a file
 * whose writer has ended, under a log above the full copy, waits for a fold.
 * Taking a file away is what lets the Host write: one it cannot take away
 * keeps the thread too, and is counted.
 */
import * as path from 'node:path'

import {
  ThreadAuthorityFiles,
  type ThreadAuthorityRead,
  type ThreadAuthorityWriter,
  type ThreadWriterLiveness
} from '../host-shared/thread-log/ThreadAuthorityFile'
import { isThreadLogAuthorityEnabled } from '../host-shared/thread-log/ThreadLogAuthoritySwitch'
import type {
  HostThreadOwnerTableSnapshot,
  HostWriteDecision,
  ThreadOwnerEpoch
} from '../host-shared/thread-log/ThreadOwnership'
import {
  HostThreadPublicationGuard,
  threadPublicationAuthorityWitness,
  type HostThreadPublicationCommit,
  type HostThreadPublicationPermit,
  type HostThreadPublicationResult
} from './HostThreadPublicationGuard'
import { isSafeChatId } from '../shared/ChatPath'
import type {
  HostLocalTransportSuccessResult,
  HostLocalTransportThreadOwnerParams
} from '../shared/hostProtocolTransport'
import type { HostLocalServerThreadOwners } from './HostLocalServer'
import { readThreadLogHead } from './HostThreadLogHead'
import { HostThreadOwnerRegistry, type HostThreadOwnerRebuild } from './HostThreadOwnerRegistry'

export type HostThreadOwnerResult = Extract<
  HostLocalTransportSuccessResult,
  { kind: 'thread.owner' }
>

/** `off-txn-persist`: the switch is on, and the Host was started with transactional persists. */
export type HostThreadOwnerServiceMode = 'off' | 'on' | 'off-txn-persist'

export interface HostThreadOwnerServiceOptions {
  /** Read here, once, for the thread log authority switch. */
  readonly environment: Readonly<Record<string, string | undefined>>
  /** Whether the Host was started with `TASKWRAITH_HOST_TXN_PERSIST=1`, as it read that switch. */
  readonly transactionalPersist: boolean
  readonly profilePath: string
  /** This Host's incarnation, as its welcome carries it (`bootEpoch`): part of every grant. */
  readonly incarnation: string
  /** Revision of the Host's full copy of the thread, or null when it has none. */
  fullCopyRevision(threadId: string): number | null
  /** A Host run is live on the thread. */
  hostRunActive(threadId: string): boolean
  /** Defaults to the profile's own authority files. */
  readonly files?: Pick<ThreadAuthorityFiles, 'read' | 'list' | 'remove'>
  /** Defaults to the head of the thread's log in `<profile>/chat-journal-v2`. */
  logRevision?(threadId: string): Promise<number | null>
  /** Defaults to signal 0 to the writer's process id. */
  liveness?(writer: ThreadAuthorityWriter): ThreadWriterLiveness
  assertProfileAuthority?(): void
  erasing?(threadId: string): boolean
  erasureGeneration?(threadId: string): string | null
  /** The clock a request to a writer to let go is timed by; defaults to `Date.now`. */
  readonly now?: () => number
  readonly log?: (line: string) => void
  /** Told what the writers say about their threads; its failures change no answer. */
  readonly observer?: HostThreadOwnerServiceObserver
}

export interface HostThreadOwnerServiceObserver {
  /** A writer's `advanced` was recorded: the thread's log has grown. */
  advanced?(threadId: string): void
  /** A grant was released: its writer removed the thread's authority file before it said so. */
  released?(threadId: string): void
}

/** How the profile's authority files have read since the Host started. */
export interface HostThreadOwnerAuthorityHealth {
  /** Starts at which the authority folder could not be listed. */
  readonly folderUnreadable: number
  readonly lastFolderError: string | null
  /** Decisions that met a thread's file it could not read, and so kept the thread. */
  readonly damagedReads: number
  /** The threads among them, the first DAMAGED_THREADS_KEPT. */
  readonly damagedThreads: readonly string[]
  /** Host writes refused because the thread's file could not be taken away. */
  readonly removeFailures: number
  readonly lastRemoveError: string | null
}

export interface HostThreadOwnerServiceSnapshot {
  readonly mode: HostThreadOwnerServiceMode
  /** Writers with a connection open, and how many. */
  readonly attached: readonly { readonly writerId: string; readonly connections: number }[]
  readonly table: HostThreadOwnerTableSnapshot | null
  /** Only while it takes claims: off, it reads no authority file. */
  readonly authority?: HostThreadOwnerAuthorityHealth
}

/** What the authority files said at start; `folderUnreadable` when they could not be listed. */
export type HostThreadOwnerStart = HostThreadOwnerRebuild & { readonly folderUnreadable?: string }

/** Threads with a file it could not read named in the snapshot; the count goes on past them. */
const DAMAGED_THREADS_KEPT = 32

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200)
}

/** The journal's directory under a profile, where each thread's log lives. */
export function threadLogDirectory(profilePath: string): string {
  return path.join(profilePath, 'chat-journal-v2')
}

/** What a Host that takes no claims answers. */
export function refusedThreadOwnerResult(
  params: HostLocalTransportThreadOwnerParams
): HostThreadOwnerResult {
  switch (params.action) {
    case 'claim':
      return {
        kind: 'thread.owner',
        action: 'claim',
        reply: {
          threadId: params.threadId,
          claimId: params.claimId,
          granted: false,
          reason: 'disabled',
          revision: null
        }
      }
    case 'release':
      return { kind: 'thread.owner', action: 'release', released: false }
    case 'advanced':
      return { kind: 'thread.owner', action: 'advanced', recorded: false }
  }
}

interface OwnerConnection {
  writerId?: string
  readonly grants: Map<string, ThreadOwnerEpoch>
}

export class HostThreadOwnerService implements HostLocalServerThreadOwners {
  readonly mode: HostThreadOwnerServiceMode
  private readonly registry: HostThreadOwnerRegistry | null
  private readonly log: (line: string) => void
  private readonly observer: HostThreadOwnerServiceObserver | undefined
  private readonly connections = new Map<number, OwnerConnection>()
  private readonly grantConnections = new Map<string, OwnerConnection>()
  private readonly publicationVersions = new Map<string, object>()
  private readonly publications: HostThreadPublicationGuard
  private readonly connectionsOfWriter = new Map<string, Set<number>>()
  private folderUnreadable = 0
  private lastFolderError: string | null = null
  private damagedReads = 0
  private readonly damagedThreads = new Set<string>()
  private removeFailures = 0
  private lastRemoveError: string | null = null
  private readonly now: () => number

  constructor(options: HostThreadOwnerServiceOptions) {
    const switchedOn = isThreadLogAuthorityEnabled(options.environment)
    this.mode = !switchedOn ? 'off' : options.transactionalPersist ? 'off-txn-persist' : 'on'
    this.log = options.log ?? (() => {})
    this.observer = options.observer
    this.now = options.now ?? Date.now
    if (this.mode === 'off-txn-persist') {
      this.log(
        'taskwraith-host: TASKWRAITH_THREAD_LOG_AUTHORITY=1 ignored: a Host with TASKWRAITH_HOST_TXN_PERSIST=1 takes no thread claims\n'
      )
    }
    const directory = threadLogDirectory(options.profilePath)
    const files = options.files ?? new ThreadAuthorityFiles(options.profilePath)
    this.registry =
      this.mode === 'on'
        ? new HostThreadOwnerRegistry({
            incarnation: options.incarnation,
            enabled: true,
            files: {
              read: (threadId) => this.read(files, threadId),
              list: () => files.list(),
              remove: (threadId, guard) => this.remove(files, threadId, guard)
            },
            fullCopyRevision: (threadId) => options.fullCopyRevision(threadId),
            logRevision: options.logRevision
              ? (threadId) => options.logRevision!(threadId)
              : async (threadId) => {
                  const head = await readThreadLogHead(directory, threadId)
                  if (head.kind === 'unreadable') {
                    throw new Error(`Thread log head is unreadable: ${head.reason}`)
                  }
                  return head.kind === 'head' ? head.revision : null
                },
            hostRunActive: (threadId) => options.hostRunActive(threadId),
            publicationWitness: (threadId) =>
              threadPublicationAuthorityWitness(options.profilePath, threadId),
            // A writer the table holds is attached, and every other process
            // is judged by its thread's authority file: see the module comment.
            desktopPresence: () => 'attached',
            otherDesktopUnattached: () => false,
            ...(options.assertProfileAuthority ? { assertProfileAuthority: options.assertProfileAuthority } : {}),
            ...(options.erasing ? { erasing: options.erasing } : {}),
            ...(options.erasureGeneration ? { erasureGeneration: options.erasureGeneration } : {}),
            ...(options.liveness ? { liveness: options.liveness } : {})
          })
        : null
    this.publications = new HostThreadPublicationGuard(this.registry)
  }

  /**
   * Once, before the listener opens: lists the authority files, which makes
   * durable what a writer left half done, and reports them. Each decision
   * reads its thread's file again.
   */
  async start(): Promise<HostThreadOwnerStart | null> {
    if (!this.registry) return null
    let rebuilt: HostThreadOwnerRebuild
    try {
      rebuilt = await this.registry.rebuild()
    } catch (error) {
      const reason = errorText(error)
      this.folderUnreadable += 1
      this.lastFolderError = reason
      this.log(
        `taskwraith-host: thread owners: the authority folder cannot be listed (${reason}): ` +
          'each thread is judged by its own file, and one that cannot be read is kept as busy\n'
      )
      return { held: [], fold: [], damaged: [], folderUnreadable: reason }
    }
    this.log(
      `taskwraith-host: thread owners: ${rebuilt.held.length} held by a live app process, ` +
        `${rebuilt.fold.length} left by an ended one, ${rebuilt.damaged.length} unreadable\n`
    )
    return rebuilt
  }

  async answer(
    connectionId: number,
    params: HostLocalTransportThreadOwnerParams
  ): Promise<HostThreadOwnerResult | 'invalid_payload'> {
    // An authority file is named after its thread.
    if (!isSafeChatId(params.threadId)) return 'invalid_payload'
    const registry = this.registry
    if (!registry) return refusedThreadOwnerResult(params)
    switch (params.action) {
      case 'claim': {
        const writerId = params.writerId
        // HostLocalServer calls answer only from a live authenticated socket,
        // synchronously before dispatch's first await. Numeric ids never recur
        // within this service; captures themselves never register connections.
        this.authenticated(connectionId)
        const connection = this.connections.get(connectionId)!
        if (connection.writerId !== undefined && connection.writerId !== writerId)
          return 'invalid_payload'
        this.attach(connectionId, connection, writerId)
        const reply = await registry.claim(params, {
          isCurrent: () =>
            this.connections.get(connectionId) === connection &&
            (!this.grantConnections.has(params.threadId) ||
              this.grantConnections.get(params.threadId) === connection),
          granted: (epoch) => {
            const previous = connection.grants.get(params.threadId)
            if (previous?.host !== epoch.host || previous?.grant !== epoch.grant)
              this.publicationVersions.set(params.threadId, {})
            connection.grants.set(params.threadId, epoch)
            this.grantConnections.set(params.threadId, connection)
          }
        })
        return { kind: 'thread.owner', action: 'claim', reply }
      }
      case 'advanced': {
        const current = this.currentGrant(connectionId, params.threadId, params.epoch)
        const recorded = current ? await registry.advanced(params, current) : false
        if (recorded) this.tell((observer) => observer.advanced?.(params.threadId))
        return { kind: 'thread.owner', action: 'advanced', recorded }
      }
      case 'release': {
        const current = this.currentGrant(connectionId, params.threadId, params.epoch)
        const released = current ? await registry.release(params, current) : false
        if (released) {
          this.connections.get(connectionId)?.grants.delete(params.threadId)
          this.grantConnections.delete(params.threadId)
          this.publicationVersions.delete(params.threadId)
          this.tell((observer) => observer.released?.(params.threadId))
        }
        return { kind: 'thread.owner', action: 'release', released }
      }
    }
  }

  /**
   * Asked before the Host changes a thread's full copy itself; only `write`
   * lets it. A Host that takes no claims lets every write through. A caller
   * let through holds the thread for its write, as `hostRunActive` reports,
   * from the moment it is answered.
   */
  async requestHostWrite(threadId: string): Promise<HostWriteDecision> {
    if (!this.registry) return { kind: 'write' }
    return this.registry.requestHostWrite(threadId, this.now())
  }

  /**
   * Future publication wiring must call this on authentication, before any
   * dispatch, including for sockets that never claim. Trusted server lifecycle
   * only: call once for a fresh, monotonically allocated live connection id.
   * It must never be called to revive a closed id. No transport is wired yet.
   */
  authenticated(connectionId: number): void {
    if (this.registry && !this.connections.has(connectionId))
      this.connections.set(connectionId, { grants: new Map() })
  }

  /** Inert ingress seam: an unknown/closed numeric id never creates a connection. */
  capturePublication(connectionId: number, threadId: string): HostThreadPublicationPermit {
    const connection = this.connections.get(connectionId)
    const epoch = connection?.grants.get(threadId)
    let version = this.publicationVersions.get(threadId)
    if (connection && !version) {
      version = {}
      this.publicationVersions.set(threadId, version)
    }
    const owner =
      epoch && connection?.writerId ? { writerId: connection.writerId, epoch: { ...epoch } } : null
    return this.publications.capture(threadId, {
      owner,
      isCurrent: () => {
        if (
          !connection ||
          this.connections.get(connectionId) !== connection ||
          this.publicationVersions.get(threadId) !== version
        )
          return false
        const current = connection.grants.get(threadId)
        return owner
          ? current?.host === owner.epoch.host &&
              current?.grant === owner.epoch.grant &&
              this.grantConnections.get(threadId) === connection
          : current === undefined && !this.grantConnections.has(threadId)
      }
    })
  }

  /** Inert final seam; the executor will supply its concrete synchronous CAS/adopt callback. */
  publish<T>(
    permit: HostThreadPublicationPermit,
    commit: HostThreadPublicationCommit<T>
  ): Promise<HostThreadPublicationResult<T>> {
    return this.publications.publish(permit, commit)
  }

  /** The socket closed: revoke its exact grants, independently of other writer sockets. */
  closed(connectionId: number): void {
    const connection = this.connections.get(connectionId)
    if (!connection) return
    this.connections.delete(connectionId)
    for (const [threadId, epoch] of connection.grants) {
      if (this.grantConnections.get(threadId) !== connection) continue
      this.grantConnections.delete(threadId)
      this.publicationVersions.delete(threadId)
      this.registry?.revoke(threadId, epoch)
    }
    const writerId = connection.writerId
    if (writerId === undefined) return
    const connections = this.connectionsOfWriter.get(writerId)!
    connections.delete(connectionId)
    if (connections.size === 0) this.connectionsOfWriter.delete(writerId)
  }

  snapshot(): HostThreadOwnerServiceSnapshot {
    return {
      mode: this.mode,
      attached: [...this.connectionsOfWriter]
        .map(([writerId, connections]) => ({ writerId, connections: connections.size }))
        .sort((a, b) => (a.writerId < b.writerId ? -1 : a.writerId > b.writerId ? 1 : 0)),
      table: this.registry?.snapshot() ?? null,
      ...(this.registry
        ? {
            authority: {
              folderUnreadable: this.folderUnreadable,
              lastFolderError: this.lastFolderError,
              damagedReads: this.damagedReads,
              damagedThreads: [...this.damagedThreads],
              removeFailures: this.removeFailures,
              lastRemoveError: this.lastRemoveError
            }
          }
        : {})
    }
  }

  /** A thread's file; one that cannot be read, however that fails, is damaged, and counted. */
  private async read(
    files: Pick<ThreadAuthorityFiles, 'read'>,
    threadId: string
  ): Promise<ThreadAuthorityRead> {
    let read: ThreadAuthorityRead
    try {
      read = await files.read(threadId)
    } catch (error) {
      read = { kind: 'damaged', reason: `unreadable (${errorText(error)})` }
    }
    if (read.kind === 'damaged') {
      this.damagedReads += 1
      if (this.damagedThreads.size < DAMAGED_THREADS_KEPT) this.damagedThreads.add(threadId)
    }
    return read
  }

  /** Takes a thread's file away; one it cannot is counted, and the write it was for refused. */
  private async remove(
    files: Pick<ThreadAuthorityFiles, 'remove'>,
    threadId: string,
    guard?: Parameters<ThreadAuthorityFiles['remove']>[1]
  ): Promise<boolean> {
    try {
      return await files.remove(threadId, guard)
    } catch (error) {
      this.removeFailures += 1
      this.lastRemoveError = errorText(error)
      throw error
    }
  }

  private tell(call: (observer: HostThreadOwnerServiceObserver) => void): void {
    if (!this.observer) return
    try {
      call(this.observer)
    } catch {
      // What the observer does with it is its own affair; the writer's answer stands.
    }
  }

  private currentGrant(
    connectionId: number,
    threadId: string,
    epoch: ThreadOwnerEpoch
  ): (() => boolean) | null {
    const connection = this.connections.get(connectionId)
    if (!connection) return null
    const current = (): boolean => {
      const grant = connection.grants.get(threadId)
      return (
        this.connections.get(connectionId) === connection &&
        this.grantConnections.get(threadId) === connection &&
        grant?.host === epoch.host &&
        grant?.grant === epoch.grant
      )
    }
    return current() ? current : null
  }

  private attach(connectionId: number, connection: OwnerConnection, writerId: string): void {
    connection.writerId = writerId
    let connections = this.connectionsOfWriter.get(writerId)
    if (!connections) {
      connections = new Set()
      this.connectionsOfWriter.set(writerId, connections)
    }
    connections.add(connectionId)
  }
}
