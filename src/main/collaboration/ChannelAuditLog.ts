import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
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
  | 'replay.completed'
  | 'member.revoked'
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
    const event: ChannelAuditEvent = {
      id: randomUUID(),
      at: Number.isFinite(input.at) ? input.at! : Date.now(),
      kind: input.kind,
      ...(input.channelId ? { channelId: String(input.channelId).slice(0, 512) } : {}),
      ...(input.memberId ? { memberId: String(input.memberId).slice(0, 512) } : {}),
      ...(input.code ? { code: String(input.code).slice(0, 80) } : {}),
      ...(input.contentHash ? { contentHash: String(input.contentHash).slice(0, 64) } : {}),
      ...(input.detail ? { detail: sanitizeDetail(input.detail) } : {})
    }
    this.events = capChannelAuditEvents([...this.events, event])
    this.persist()
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
    renameSync(temporary, this.storagePath)
  }
}
