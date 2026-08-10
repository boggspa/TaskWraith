import { randomUUID } from 'crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { basename, dirname, join } from 'path'
import { redactSecrets } from '../../shared/secretRedaction'

export type ChannelAuditEventKind =
  | 'channel.created'
  | 'invite.created'
  | 'admission.began'
  | 'admission.confirmed'
  | 'admission.failed'
  | 'session.reconnected'
  | 'session.disconnected'
  | 'message.accepted'
  | 'message.deduplicated'
  | 'message.rejected'
  | 'human.review.queued'
  | 'human.review.deduplicated'
  | 'human.review.approved'
  | 'human.review.denied'
  | 'human.review.lapsed'
  | 'human.review.materialized'
  | 'replay.completed'
  | 'member.revoked'
  | 'agent.enrolled'
  | 'agent.grant.issued'
  | 'agent.revoked'
  | 'agent.key.rotated'
  | 'agent.mention.rejected'
  | 'agent.dispatch.blocked'
  | 'agent.dispatch.started'
  | 'agent.dispatch.completed'
  | 'agent.dispatch.failed'
  | 'agent.post.committed'
  | 'protocol.rejected'

export interface ChannelAuditEvent {
  id: string
  at: number
  kind: ChannelAuditEventKind
  channelId?: string
  memberId?: string
  code?: string
  contentHash?: string
  detail?: string
  /** Main-only idempotency hash. Omitted from renderer/member projections. */
  dedupeKey?: string
}

export type ChannelAuditInput = Omit<ChannelAuditEvent, 'id' | 'at'> & { at?: number }

export interface ChannelAuditLike {
  append(event: ChannelAuditInput): void
}

export const MAX_CHANNEL_AUDIT_EVENTS = 2_000
const MAX_DETAIL_LENGTH = 160

function sanitizeDetail(value: string): string {
  return redactSecrets(String(value))
    .replace(/(?:\/Users\/|\/home\/)[^/\s]+(?:\/[^\s]*)?/g, '[redacted-path]')
    .replace(/\/private\/var\/[^\s]+/g, '[redacted-path]')
    .replace(/\/tmp\/[^\s]+/g, '[redacted-path]')
    .replace(/\b[A-Za-z]:\\Users\\[^\\\s]+(?:\\[^\s]*)*/g, '[redacted-path]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DETAIL_LENGTH)
}

export function capChannelAuditEvents(
  events: ChannelAuditEvent[],
  maximum = MAX_CHANNEL_AUDIT_EVENTS
): ChannelAuditEvent[] {
  return events.length <= maximum ? events : events.slice(events.length - maximum)
}

export class ChannelAuditLog implements ChannelAuditLike {
  private events: ChannelAuditEvent[]

  constructor(private readonly storagePath?: string) {
    this.events = this.load()
  }

  append(input: ChannelAuditInput): void {
    if (input.dedupeKey !== undefined && !/^[a-f0-9]{64}$/.test(input.dedupeKey)) {
      throw new Error('Channel audit dedupe key is invalid')
    }
    if (input.dedupeKey && this.events.some((event) => event.dedupeKey === input.dedupeKey)) {
      return
    }
    const event: ChannelAuditEvent = {
      id: randomUUID(),
      at: Number.isFinite(input.at) ? input.at! : Date.now(),
      kind: input.kind,
      ...(input.channelId ? { channelId: String(input.channelId).slice(0, 512) } : {}),
      ...(input.memberId ? { memberId: String(input.memberId).slice(0, 512) } : {}),
      ...(input.code ? { code: String(input.code).slice(0, 80) } : {}),
      ...(input.contentHash ? { contentHash: String(input.contentHash).slice(0, 64) } : {}),
      ...(input.detail ? { detail: sanitizeDetail(input.detail) } : {}),
      ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {})
    }
    const previous = this.events
    this.events = capChannelAuditEvents([...previous, event])
    try {
      this.persist()
    } catch (error) {
      this.events = previous
      throw error
    }
  }

  list(args?: { channelId?: string; limit?: number }): ChannelAuditEvent[] {
    const limit = Math.max(1, Math.min(1_000, Math.floor(args?.limit ?? 200)))
    const filtered = args?.channelId
      ? this.events.filter((event) => event.channelId === args.channelId)
      : this.events
    return filtered
      .slice(-limit)
      .reverse()
      .map((event) => ({ ...event }))
  }

  purgeChannels(channelIds: readonly string[]): number {
    const targets = new Set(channelIds)
    const previous = this.events
    const next = previous.filter(
      (event) => event.channelId === undefined || !targets.has(event.channelId)
    )
    const removed = previous.length - next.length
    this.removeStaleTemporaryFiles()
    if (removed === 0) return 0
    this.events = next
    try {
      this.persist()
    } catch (error) {
      this.events = previous
      throw error
    }
    return removed
  }

  purgeAll(): number {
    const previous = this.events
    const durableFileExists = Boolean(this.storagePath && existsSync(this.storagePath))
    this.removeStaleTemporaryFiles()
    if (previous.length === 0 && !durableFileExists) return 0
    this.events = []
    try {
      this.persist()
    } catch (error) {
      this.events = previous
      throw error
    }
    return previous.length
  }

  private load(): ChannelAuditEvent[] {
    if (!this.storagePath || !existsSync(this.storagePath)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, 'utf8')) as {
        events?: unknown[]
      }
      if (!Array.isArray(parsed.events)) return []
      return capChannelAuditEvents(
        parsed.events.filter(
          (value): value is ChannelAuditEvent =>
            Boolean(value && typeof value === 'object') &&
            typeof (value as ChannelAuditEvent).id === 'string' &&
            typeof (value as ChannelAuditEvent).kind === 'string' &&
            Number.isFinite((value as ChannelAuditEvent).at)
        )
      )
    } catch {
      return []
    }
  }

  private persist(): void {
    if (!this.storagePath) return
    mkdirSync(dirname(this.storagePath), { recursive: true })
    const temporary = `${this.storagePath}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify({ events: this.events }), {
      encoding: 'utf8',
      mode: 0o600
    })
    const descriptor = openSync(temporary, 'r')
    try {
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    renameSync(temporary, this.storagePath)
    this.syncStorageDirectory()
  }

  private removeStaleTemporaryFiles(): void {
    if (!this.storagePath) return
    const directory = dirname(this.storagePath)
    if (!existsSync(directory)) return
    const prefix = `${basename(this.storagePath)}.`
    let deleted = false
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.tmp')) {
        continue
      }
      unlinkSync(join(directory, entry.name))
      deleted = true
    }
    if (deleted) this.syncStorageDirectory()
  }

  private syncStorageDirectory(): void {
    if (!this.storagePath) return
    try {
      const directoryDescriptor = openSync(dirname(this.storagePath), 'r')
      try {
        fsyncSync(directoryDescriptor)
      } finally {
        closeSync(directoryDescriptor)
      }
    } catch {
      // Some platforms do not allow directory fsync. The file itself is synced.
    }
  }
}
