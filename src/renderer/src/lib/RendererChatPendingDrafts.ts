import type { ChatRecord } from '../../../main/store/types'
import { plainDataEqual } from '../../../shared/chatUpdateTransport'
import { chatPersistenceRevision } from '../../../shared/rendererChatTranscriptMutation'
import { isTranscriptPagedShell } from '../../../shared/transcriptPage'
import { advanceRendererRecord, type RendererRecordAdvance } from './advanceRendererRecord'

const stamps = new Set(['updatedAt', 'persistenceRevision'])
const fields = (a: ChatRecord, b: ChatRecord): string[] =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => !stamps.has(key))
const value = (record: ChatRecord, key: string): unknown =>
  (record as unknown as Record<string, unknown>)[key]
const differs = (a: ChatRecord, b: ChatRecord): boolean =>
  fields(a, b).some((key) => !plainDataEqual(value(a, key), value(b, key)))
const partial = (record: ChatRecord): boolean =>
  (record as ChatRecord & { summaryOnly?: boolean }).summaryOnly === true ||
  isTranscriptPagedShell(record)

interface PendingDraft {
  canonical: ChatRecord
  record: ChatRecord
  conflicts: string[]
}

/** Transient immutable references only: never attach these fields to ChatRecord. */
export class RendererChatPendingDrafts {
  private readonly drafts = new Map<string, PendingDraft>()
  private readonly targets = new WeakMap<ChatRecord, string>()
  private readonly epochs = new Map<string, number>()
  private globalEpoch = 0
  private version = 0
  private readonly listeners = new Set<() => void>()
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  snapshot = (): number => this.version
  private changed(): void {
    this.version += 1
    for (const listener of this.listeners) listener()
  }

  /** Explicit user choice; prepare the local intent against the latest full record. */
  resolveLocal(canonical: ChatRecord, current?: ChatRecord): ChatRecord {
    const pending = this.drafts.get(canonical.appChatId)
    if (!pending) return canonical
    const advanced = advanceRendererRecord(pending.canonical, canonical, current ?? pending.record)
    if (pending.conflicts.includes('messages') || advanced.conflicts.includes('messages'))
      throw new Error('The transcript has overlapping edits; the local draft is retained')
    return { ...advanced.record, persistenceRevision: canonical.persistenceRevision }
  }

  /** Call for a local update before giving its target to the transcript queue. */
  trackTarget(target: ChatRecord): void {
    this.targets.set(target, this.epoch(target.appChatId))
  }

  isCurrentTarget(target: ChatRecord): boolean {
    return this.targets.get(target) === this.epoch(target.appChatId)
  }

  /** `canonical` is the actual saved/read record; `next` may include queued ops. */
  advance(
    before: ChatRecord,
    next: ChatRecord,
    current: ChatRecord | null | undefined,
    canonical: ChatRecord = next
  ): RendererRecordAdvance | null {
    const token = this.targets.get(before) ?? this.epoch(before.appChatId)
    // Propagate even a discarded token so a recovery retry's later ACK is stale too.
    this.targets.set(next, token)
    if (token !== this.epoch(before.appChatId)) return null
    if (partial(canonical)) throw new Error('A pending draft requires a complete canonical record')
    return this.remember(canonical, advanceRendererRecord(before, next, current))
  }

  /** Apply after the existing render/hydration merge, retaining its special rows. */
  apply(canonical: ChatRecord, rendered: ChatRecord, current?: ChatRecord | null): ChatRecord {
    const pending = this.drafts.get(canonical.appChatId)
    if (!pending) return rendered
    const local = current && !partial(current) ? current : pending.record
    if (partial(canonical)) {
      // A summary/page is presentation state. It cannot acknowledge a draft or
      // replace the complete canonical predecessor used for a three-way merge.
      return this.overlay(pending.canonical, local, rendered)
    }
    if (chatPersistenceRevision(canonical) < chatPersistenceRevision(pending.canonical))
      return local
    const advanced = this.remember(
      canonical,
      advanceRendererRecord(pending.canonical, canonical, local)
    )
    return advanced.pending ? this.overlay(canonical, advanced.record, rendered) : rendered
  }

  conflicts(chatId: string): readonly string[] {
    return this.drafts.get(chatId)?.conflicts ?? []
  }

  has(chatId: string): boolean {
    return this.drafts.has(chatId)
  }

  /** Explicit reset/delete/rewind, after its existing persistence cancellation. */
  discard(chatId: string): void {
    this.drafts.delete(chatId)
    this.changed()
    this.epochs.set(chatId, (this.epochs.get(chatId) ?? 0) + 1)
  }

  clear(): void {
    this.drafts.clear()
    this.epochs.clear()
    this.globalEpoch += 1
    this.changed()
  }

  private epoch(chatId: string): string {
    return `${this.globalEpoch}:${this.epochs.get(chatId) ?? 0}`
  }

  private remember(canonical: ChatRecord, advanced: RendererRecordAdvance): RendererRecordAdvance {
    const prior = this.drafts.get(canonical.appChatId)
    if (!differs(canonical, advanced.record)) {
      if (this.drafts.delete(canonical.appChatId)) this.changed()
      return { record: canonical, pending: false, conflicts: [] }
    }
    const priorConcrete = (prior?.conflicts ?? []).filter((key) => key !== 'persistenceRevision')
    const currentConcrete = advanced.conflicts.filter((key) => key !== 'persistenceRevision')
    const conflicts = [...new Set([...priorConcrete, ...currentConcrete])].filter((path) => {
      const root = path.split('.')[0]
      return !plainDataEqual(value(canonical, root), value(advanced.record, root))
    })
    // Preserve an unexplained stale revision. Once a known field conflict is
    // acknowledged canonically, unrelated remaining draft edits can rebase.
    if (advanced.conflicts.includes('persistenceRevision') && priorConcrete.length === 0) {
      conflicts.push('persistenceRevision')
    }
    const record =
      conflicts.length === 0
        ? { ...advanced.record, persistenceRevision: canonical.persistenceRevision }
        : advanced.record
    this.drafts.set(canonical.appChatId, { canonical, record, conflicts })
    this.changed()
    return { record, pending: true, conflicts }
  }

  private overlay(base: ChatRecord, draft: ChatRecord, rendered: ChatRecord): ChatRecord {
    const output = { ...rendered } as ChatRecord & Record<string, unknown>
    for (const key of fields(base, draft)) {
      if (plainDataEqual(value(base, key), value(draft, key))) continue
      const next = value(draft, key)
      if (next === undefined) delete output[key]
      else output[key] = next
    }
    output.persistenceRevision = draft.persistenceRevision
    return output
  }
}
