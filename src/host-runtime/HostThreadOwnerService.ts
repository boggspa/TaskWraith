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
 *   with, or whose grant it first reports on. It is the same per-socket
 *   identity the lease registry keys leases by, and the socket's close, which
 *   ends its lease, detaches it.
 * - The app drops every grant when its connection to the Host closes, so the
 *   Host does too: once the last connection a writer spoke on closes, its
 *   threads go back to the Host. A grant therefore never outlives its holder's
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
 */
import * as path from 'node:path'

import {
  ThreadAuthorityFiles,
  type ThreadAuthorityWriter,
  type ThreadWriterLiveness
} from '../host-shared/thread-log/ThreadAuthorityFile'
import { isThreadLogAuthorityEnabled } from '../host-shared/thread-log/ThreadLogAuthoritySwitch'
import type { HostThreadOwnerTableSnapshot } from '../host-shared/thread-log/ThreadOwnership'
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
  readonly log?: (line: string) => void
}

export interface HostThreadOwnerServiceSnapshot {
  readonly mode: HostThreadOwnerServiceMode
  /** Writers with a connection open, and how many. */
  readonly attached: readonly { readonly writerId: string; readonly connections: number }[]
  readonly table: HostThreadOwnerTableSnapshot | null
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

export class HostThreadOwnerService implements HostLocalServerThreadOwners {
  readonly mode: HostThreadOwnerServiceMode
  private readonly registry: HostThreadOwnerRegistry | null
  private readonly log: (line: string) => void
  private readonly writerOfConnection = new Map<number, string>()
  private readonly connectionsOfWriter = new Map<string, Set<number>>()

  constructor(options: HostThreadOwnerServiceOptions) {
    const switchedOn = isThreadLogAuthorityEnabled(options.environment)
    this.mode = !switchedOn ? 'off' : options.transactionalPersist ? 'off-txn-persist' : 'on'
    this.log = options.log ?? (() => {})
    if (this.mode === 'off-txn-persist') {
      this.log(
        'taskwraith-host: TASKWRAITH_THREAD_LOG_AUTHORITY=1 ignored: a Host with TASKWRAITH_HOST_TXN_PERSIST=1 takes no thread claims\n'
      )
    }
    const directory = threadLogDirectory(options.profilePath)
    this.registry =
      this.mode === 'on'
        ? new HostThreadOwnerRegistry({
            incarnation: options.incarnation,
            enabled: true,
            files: options.files ?? new ThreadAuthorityFiles(options.profilePath),
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
            // A writer the table holds is attached, and every other process
            // is judged by its thread's authority file: see the module comment.
            desktopPresence: () => 'attached',
            otherDesktopUnattached: () => false,
            ...(options.liveness ? { liveness: options.liveness } : {})
          })
        : null
  }

  /**
   * Once, before the listener opens: lists the authority files, which makes
   * durable what a writer left half done, and reports them. Each decision
   * reads its thread's file again.
   */
  async start(): Promise<HostThreadOwnerRebuild | null> {
    if (!this.registry) return null
    const rebuilt = await this.registry.rebuild()
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
        const speaksFor = this.writerOfConnection.get(connectionId)
        if (speaksFor !== undefined && speaksFor !== writerId) return 'invalid_payload'
        this.attach(connectionId, writerId)
        const reply = await registry.claim(params)
        // Its connection closed while the Host decided: the app has dropped the grant already.
        if (reply.granted && !this.connectionsOfWriter.has(writerId)) registry.writerGone(writerId)
        return { kind: 'thread.owner', action: 'claim', reply }
      }
      case 'advanced': {
        const recorded = await registry.advanced(params)
        const writer = registry.writerOf(params.threadId)
        if (recorded && writer.kind === 'desktop') {
          const speaksFor = this.writerOfConnection.get(connectionId)
          if (speaksFor === undefined) this.attach(connectionId, writer.writerId)
        }
        return { kind: 'thread.owner', action: 'advanced', recorded }
      }
      case 'release': {
        const released = await registry.release(params)
        return { kind: 'thread.owner', action: 'release', released }
      }
    }
  }

  /** The socket closed. The last of a writer's gives its threads back to the Host. */
  closed(connectionId: number): void {
    const writerId = this.writerOfConnection.get(connectionId)
    if (writerId === undefined) return
    this.writerOfConnection.delete(connectionId)
    const connections = this.connectionsOfWriter.get(writerId)!
    connections.delete(connectionId)
    if (connections.size > 0) return
    this.connectionsOfWriter.delete(writerId)
    this.registry?.writerGone(writerId)
  }

  snapshot(): HostThreadOwnerServiceSnapshot {
    return {
      mode: this.mode,
      attached: [...this.connectionsOfWriter]
        .map(([writerId, connections]) => ({ writerId, connections: connections.size }))
        .sort((a, b) => (a.writerId < b.writerId ? -1 : a.writerId > b.writerId ? 1 : 0)),
      table: this.registry?.snapshot() ?? null
    }
  }

  private attach(connectionId: number, writerId: string): void {
    this.writerOfConnection.set(connectionId, writerId)
    let connections = this.connectionsOfWriter.get(writerId)
    if (!connections) {
      connections = new Set()
      this.connectionsOfWriter.set(writerId, connections)
    }
    connections.add(connectionId)
  }
}
