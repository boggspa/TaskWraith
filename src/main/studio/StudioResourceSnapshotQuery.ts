import { randomBytes } from 'node:crypto'
import {
  isStudioResourceSnapshot,
  STUDIO_RESOURCE_ACTIVITY_FIELDS,
  type StudioResourceSnapshot,
  type StudioResourceSnapshotFailureCode,
  type StudioResourceSnapshotOutcome
} from '../../shared/studioResourceSnapshot'
import { STUDIO_METHODS, type StudioRequestMessage } from './StudioProtocol'

export const STUDIO_RESOURCE_QUERY_TIMEOUT_MS = 5000
export const STUDIO_RESOURCE_QUERY_LIMIT = 4
export const STUDIO_RESOURCE_REPLY_MAX_BYTES = 64 * 1024

export interface StudioResourceQueryTicket {
  readonly pending: boolean
  readonly result: Promise<StudioResourceSnapshotOutcome>
  send(revision: number, write: (message: StudioRequestMessage) => boolean): void
  cancel(code: StudioResourceSnapshotFailureCode, message: string): void
}

interface PendingQuery {
  child: object
  pid: number
  nonce: string
  revision: number | null
  timer: ReturnType<typeof setTimeout>
  resolve: (result: StudioResourceSnapshotOutcome) => void
}

function failure(
  code: StudioResourceSnapshotFailureCode,
  message: string
): StudioResourceSnapshotOutcome {
  return { ok: false, code, message }
}

/** One supervisor's bounded queries. Child identity is the spawn generation fence. */
export class StudioResourceSnapshotQueries {
  private nextId = -1
  private readonly queries = new Map<number, PendingQuery>()
  private readonly latest = new WeakMap<
    object,
    Pick<
      StudioResourceSnapshot,
      'processInstanceId' | 'sampleSequence' | 'monotonicMs' | 'activity'
    >
  >()

  constructor(private readonly timeoutMs = STUDIO_RESOURCE_QUERY_TIMEOUT_MS) {}

  reserve(child: object, pid: number): StudioResourceQueryTicket {
    if (
      this.queries.size >= STUDIO_RESOURCE_QUERY_LIMIT ||
      this.nextId <= Number.MIN_SAFE_INTEGER
    ) {
      return {
        pending: false,
        result: Promise.resolve(
          failure('resource_query_capacity', 'Studio resource query capacity reached.')
        ),
        send: () => undefined,
        cancel: () => undefined
      }
    }
    const id = this.nextId--
    const nonce = randomBytes(24).toString('hex')
    const result = new Promise<StudioResourceSnapshotOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.finish(id, failure('resource_query_timeout', 'Studio resource snapshot timed out.'))
      }, this.timeoutMs)
      this.queries.set(id, { child, pid, nonce, revision: null, timer, resolve })
    })
    const queries = this.queries
    return {
      get pending() {
        return queries.has(id)
      },
      result,
      send: (revision, write) => {
        const query = this.queries.get(id)
        // Expired queued work must not become a late request on the wire.
        if (!query || query.revision !== null) return
        query.revision = revision
        try {
          if (
            write({
              jsonrpc: '2.0',
              id,
              method: STUDIO_METHODS.getResourceSnapshot,
              params: { schemaVersion: 1, nonce, expectedRevision: revision }
            })
          )
            return
        } catch {
          // A failed write is diagnostic failure, never a reason to restart Studio.
        }
        this.finish(
          id,
          failure('resource_query_delivery_failed', 'Studio resource query could not be delivered.')
        )
      },
      cancel: (code, message) => this.finish(id, failure(code, message))
    }
  }

  /** Called before ordinary RPC dispatch, on the existing inbound serial lane. */
  handle(child: object, value: unknown): boolean {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const message = value as Record<string, unknown>
    if (!Number.isSafeInteger(message.id) || 'method' in message) return false
    const id = message.id as number
    const query = this.queries.get(id)
    if (!query || query.child !== child) return false
    const invalid = (reason: string): boolean => {
      this.finish(id, failure('resource_snapshot_invalid', reason))
      return true
    }
    let bytes: number
    try {
      bytes = Buffer.byteLength(JSON.stringify(message), 'utf8')
    } catch {
      return invalid('Unserializable Studio resource reply.')
    }
    if (bytes > STUDIO_RESOURCE_REPLY_MAX_BYTES)
      return invalid('Studio resource reply exceeds its byte budget.')
    if (message.jsonrpc !== '2.0' || query.revision === null)
      return invalid('Unexpected Studio resource response envelope.')
    if ('error' in message) {
      if ('result' in message) return invalid('Ambiguous Studio resource reply.')
      const error = message.error as { data?: { studioCode?: string }; message?: unknown } | null
      if (error?.data?.studioCode !== 'resource_snapshot_unavailable')
        return invalid('Studio rejected the resource query.')
      this.finish(
        id,
        failure(
          'resource_snapshot_unavailable',
          'The Companion cannot provide a resource snapshot.'
        )
      )
      return true
    }
    const snapshot = message.result
    if (!isStudioResourceSnapshot(snapshot)) return invalid('Malformed Studio resource snapshot.')
    if (
      snapshot.nonce !== query.nonce ||
      snapshot.processPid !== query.pid ||
      snapshot.documentRevision !== query.revision
    ) {
      return invalid('Studio resource request, process, or revision identity changed.')
    }
    const previous = this.latest.get(child)
    if (
      previous &&
      (snapshot.processInstanceId !== previous.processInstanceId ||
        snapshot.sampleSequence <= previous.sampleSequence ||
        snapshot.monotonicMs <= previous.monotonicMs ||
        STUDIO_RESOURCE_ACTIVITY_FIELDS.some(
          (field) => snapshot.activity[field] < previous.activity[field]
        ))
    )
      return invalid('Studio resource snapshot is stale, replaced, or has reset activity totals.')
    this.latest.set(child, {
      processInstanceId: snapshot.processInstanceId,
      sampleSequence: snapshot.sampleSequence,
      monotonicMs: snapshot.monotonicMs,
      activity: { ...snapshot.activity }
    })
    this.finish(id, { ok: true, snapshot })
    return true
  }

  cancelChild(child: object, code: StudioResourceSnapshotFailureCode, message: string): void {
    for (const [id, query] of this.queries) {
      if (query.child === child) this.finish(id, failure(code, message))
    }
  }

  private finish(id: number, result: StudioResourceSnapshotOutcome): void {
    const query = this.queries.get(id)
    if (!query) return
    this.queries.delete(id)
    clearTimeout(query.timer)
    query.resolve(result)
  }
}
