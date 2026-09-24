// Phase 2 (P2a) — durable, BOUNDED collaboration audit log
// (the Phase 2 collaboration contract §5 "Audit").
//
// Every host-visible collaboration event (rules changed, invites, admission,
// contributions received/rejected, drafts inserted, revocations) gets a small
// durable row so the host can answer "what did this collaborator do, and what
// did I approve?" after the fact.
//
// Follows the codebase's bounded-persistence pattern (ApprovalLedger /
// RunQueue / the store's idempotency cap): a named MAX_* constant, a pure cap
// function, and a SINGLE choke-point writer doing a synchronous atomic
// tmp+rename rewrite — the cap exists precisely because that write is
// synchronous and would freeze the main thread if the file grew unbounded.
//
// Audit rows never store raw unbounded collaborator content: previews are
// redacted + truncated and paired with a content hash (spec §5).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { createHash, randomUUID } from 'crypto'
import type { HumanCollaborationDenialCode } from './HumanContributionRules'

export type HumanCollaborationAuditEventKind =
  | 'share.created'
  | 'share.rules_changed'
  | 'share.revoked'
  | 'participant.revoked'
  | 'invite.created'
  | 'invite.consumed'
  | 'admission.began'
  | 'admission.sas_confirmed'
  | 'admission.sas_failed'
  | 'session.disconnected'
  | 'contribution.received'
  | 'contribution.deduped'
  | 'contribution.rejected'
  // Host review of a queued external contribution. `approved` records only
  // that the host released it for delivery — delivery itself happens later, at
  // the contributor's dispatch turn, and is not this row's claim.
  | 'contribution.approved'
  | 'contribution.denied'
  | 'draft.inserted'

export interface HumanCollaborationAuditEvent {
  id: string
  at: number
  kind: HumanCollaborationAuditEventKind
  chatId?: string
  shareId?: string
  collaboratorId?: string
  /** Denial code for rejected contributions / failed admissions. */
  code?: HumanCollaborationDenialCode | string
  /** Bounded, redacted preview of collaborator-supplied text (never raw). */
  preview?: string
  /** sha256 (b64url, truncated) of the full original content, for correlation. */
  contentHash?: string
  /** Small free-form detail (preset name, displayName, reason) — bounded. */
  detail?: string
}

/** Everything a producer supplies; id/at are stamped by the log. */
export type HumanCollaborationAuditInput = Omit<HumanCollaborationAuditEvent, 'id' | 'at'> & {
  at?: number
}

/** Minimal producer-facing surface (lets ChatService/Runtime take a fake). */
export interface HumanCollaborationAuditLike {
  append(event: HumanCollaborationAuditInput): void
}

// ~2000 rows of this shape is well under 1MB — a synchronous rewrite stays
// cheap. Oldest rows are dropped first; there is no "liveness" class here
// (audit is history, nothing must survive the cap).
export const MAX_HUMAN_COLLABORATION_AUDIT_EVENTS = 2000
const PREVIEW_MAX_CHARS = 120
const DETAIL_MAX_CHARS = 160

/** Bounded, newline-flattened, secret-scrubbed preview of untrusted text. */
export function boundedAuditPreview(content: string): string {
  const flattened = String(content).replace(/\s+/g, ' ').trim()
  // Scrub the obvious credential shapes (mirrors HumanShareProjection's intent
  // without importing its chat-specific machinery).
  const scrubbed = flattened
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted-key]')
    .replace(/\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY)[A-Z0-9_]*\s*=\s*\S+/gi, '[redacted]')
  return scrubbed.length > PREVIEW_MAX_CHARS ? `${scrubbed.slice(0, PREVIEW_MAX_CHARS)}…` : scrubbed
}

export function auditContentHash(content: string): string {
  return createHash('sha256').update(String(content), 'utf8').digest('base64url').slice(0, 16)
}

/** Pure cap: keep the NEWEST maxEvents rows (input is append-ordered). */
export function capAuditEvents(
  events: HumanCollaborationAuditEvent[],
  maxEvents: number = MAX_HUMAN_COLLABORATION_AUDIT_EVENTS
): HumanCollaborationAuditEvent[] {
  return events.length <= maxEvents ? events : events.slice(events.length - maxEvents)
}

export class HumanCollaborationAuditLog implements HumanCollaborationAuditLike {
  private events: HumanCollaborationAuditEvent[] = []

  constructor(private readonly storagePath?: string) {
    this.events = this.load()
  }

  append(event: HumanCollaborationAuditInput): void {
    const row: HumanCollaborationAuditEvent = {
      id: randomUUID(),
      at: typeof event.at === 'number' && Number.isFinite(event.at) ? event.at : Date.now(),
      kind: event.kind,
      ...(event.chatId ? { chatId: String(event.chatId) } : {}),
      ...(event.shareId ? { shareId: String(event.shareId) } : {}),
      ...(event.collaboratorId ? { collaboratorId: String(event.collaboratorId) } : {}),
      ...(event.code ? { code: String(event.code) } : {}),
      ...(typeof event.preview === 'string'
        ? { preview: boundedAuditPreview(event.preview) }
        : {}),
      ...(event.contentHash ? { contentHash: String(event.contentHash).slice(0, 32) } : {}),
      ...(typeof event.detail === 'string'
        ? { detail: String(event.detail).replace(/\s+/g, ' ').trim().slice(0, DETAIL_MAX_CHARS) }
        : {})
    }
    this.events = capAuditEvents([...this.events, row])
    this.persist()
  }

  /**
   * History-erasure step: drop rows for erased chats/shares. Rows carry
   * bounded previews and content hashes of chat contributions, so they follow
   * the approval/feedback ledgers out of durable history. Share-id matching
   * covers rows (admission, invites) that never carried a chat id. Persist
   * failures throw so the outer deletion transaction stays pending.
   */
  purgeEntries(input: {
    chatIds?: readonly string[]
    shareIds?: readonly string[]
  }): number {
    const chatIds = new Set(input.chatIds ?? [])
    const shareIds = new Set(input.shareIds ?? [])
    const retained = this.events.filter(
      (event) =>
        !(event.chatId && chatIds.has(event.chatId)) &&
        !(event.shareId && shareIds.has(event.shareId))
    )
    const removed = this.events.length - retained.length
    if (removed === 0) return 0
    this.events = retained
    this.persist()
    return removed
  }

  /** Global history clear: remove every audit row. */
  purgeAll(): number {
    const removed = this.events.length
    if (removed === 0) return 0
    this.events = []
    this.persist()
    return removed
  }

  /** Newest-first, optionally filtered by chat, bounded by `limit`. */
  list(args?: { chatId?: string; limit?: number }): HumanCollaborationAuditEvent[] {
    const limit = Math.max(1, Math.min(1000, Math.floor(args?.limit ?? 200)))
    const filtered = args?.chatId
      ? this.events.filter((event) => event.chatId === args.chatId)
      : this.events
    return filtered.slice(-limit).reverse()
  }

  private load(): HumanCollaborationAuditEvent[] {
    if (!this.storagePath || !existsSync(this.storagePath)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, 'utf8')) as {
        events?: HumanCollaborationAuditEvent[]
      }
      const events = Array.isArray(parsed?.events) ? parsed.events : []
      // Compact on read too, so an already-bloated file self-heals at launch.
      return capAuditEvents(
        events.filter(
          (event): event is HumanCollaborationAuditEvent =>
            Boolean(event && typeof event === 'object' && event.id && event.kind) &&
            typeof event.at === 'number'
        )
      )
    } catch {
      return []
    }
  }

  // Single choke-point writer (bounded-store pattern): every persist path goes
  // through here, so the file can never exceed the cap.
  private persist(): void {
    if (!this.storagePath) return
    mkdirSync(dirname(this.storagePath), { recursive: true })
    const tmp = `${this.storagePath}.tmp`
    writeFileSync(tmp, JSON.stringify({ events: this.events }, null, 2))
    renameSync(tmp, this.storagePath)
  }
}
