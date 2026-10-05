/**
 * Desktop-side custody of committed receipt evidence.
 *
 * The Host keeps the command receipts; the desktop only ever saw their
 * `ThreadOwnershipReceiptEvidence` projection and dropped it. Ownership
 * activation needs that evidence after a restart: an exact command handle is how
 * an ambiguous write is rechecked, and how a frozen head is shown to have
 * reached the Host. This store keeps it, in insertion order, behind an injected
 * persistence port so a restart is just a new store over the same file.
 *
 * Evidence is additive. Recording it grants nothing, and a failed write is
 * reported to the caller without changing what the store already holds.
 */
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { ThreadOwnershipReceiptEvidence } from './ThreadOwnershipReceiptEvidence'

export type { ThreadOwnershipReceiptEvidence } from './ThreadOwnershipReceiptEvidence'

type UnavailableReason = Extract<ThreadOwnershipReceiptEvidence, { kind: 'unavailable' }>['reason']

const UNAVAILABLE_REASONS: Record<UnavailableReason, true> = {
  invalid_submission: true,
  invalid_receipt: true,
  command_mismatch: true,
  descriptor_mismatch: true,
  legacy_receipt: true
}

export const OWNERSHIP_RECEIPT_EVIDENCE_FORMAT = 'taskwraith.ownership-receipt-evidence' as const
export const OWNERSHIP_RECEIPT_EVIDENCE_VERSION = 1 as const
export const OWNERSHIP_RECEIPT_EVIDENCE_FILENAME = 'ownership-receipt-evidence.json'
/** The oldest evidence for a chat goes first once it holds this many. */
export const MAX_RECEIPT_EVIDENCE_PER_CHAT = 128
export const MAX_RECEIPT_EVIDENCE_TOTAL = 20_000

/** Where evidence belongs when the evidence itself does not say. */
export interface ReceiptEvidenceRef {
  readonly chatId: string
  readonly commandId?: string
}

export interface ReceiptEvidencePersistence {
  /** The stored document, or null when none exists. */
  read(): Promise<string | null>
  /** Resolves once the document would survive a power loss. */
  write(text: string): Promise<void>
  /** Keep an unreadable document out of the way of the next write. */
  quarantine?(text: string): Promise<void>
}

interface StoredEntry {
  readonly chatId: string
  readonly commandId: string | null
  readonly evidence: ThreadOwnershipReceiptEvidence
}

export class HostOwnershipReceiptEvidenceStore {
  private entries: StoredEntry[] = []
  private loaded: Promise<void> | null = null
  private isLoaded = false
  private tail: Promise<void> = Promise.resolve()
  private quarantined = false

  constructor(private readonly persistence: ReceiptEvidencePersistence) {}

  /**
   * Record a receipt and resolve once it is durable. `unavailable` evidence
   * carries no chat, so the caller supplies it. A later `unavailable` never
   * replaces exact or re-anchor evidence for the same command.
   */
  async record(evidence: ThreadOwnershipReceiptEvidence, ref?: ReceiptEvidenceRef): Promise<void> {
    const entry = this.entryFor(evidence, ref)
    await this.load()
    await this.serialize(async () => {
      const next = this.merge(this.entries, entry)
      if (next === this.entries) return
      await this.persistence.write(serialize(next))
      this.entries = next
    })
  }

  /** Evidence by exact command handle; null when none was recorded. */
  async get(commandId: string): Promise<ThreadOwnershipReceiptEvidence | null> {
    await this.load()
    return this.find(commandId)
  }

  /** A chat's evidence in insertion order. */
  async listForChat(chatId: string): Promise<ThreadOwnershipReceiptEvidence[]> {
    await this.load()
    return this.list(chatId)
  }

  /** Synchronous view of what is already loaded; null before the first load. */
  getLoaded(commandId: string): ThreadOwnershipReceiptEvidence | null {
    return this.isLoaded ? this.find(commandId) : null
  }

  listLoaded(chatId: string): readonly ThreadOwnershipReceiptEvidence[] {
    return this.isLoaded ? this.list(chatId) : []
  }

  /** Read the stored document now, so synchronous views have something to show. */
  load(): Promise<void> {
    this.loaded ??= this.readDocument().catch((error) => {
      // An unreadable store is not an empty one: leave it unloaded so the next
      // call reads again, and let no write replace what could not be read.
      this.loaded = null
      throw error
    })
    return this.loaded
  }

  /**
   * Merge evidence a chat record carried back into memory. Nothing is written:
   * the record is itself a durable copy, and the next `record` persists the lot.
   */
  async hydrate(
    chatId: string,
    evidence: readonly ThreadOwnershipReceiptEvidence[]
  ): Promise<void> {
    await this.load()
    await this.serialize(async () => {
      let next = this.entries
      for (const item of evidence) {
        const entry = safeEntryFor(item, { chatId })
        if (entry) next = this.merge(next, entry)
      }
      this.entries = next
    })
  }

  /** Whether an unreadable document was set aside when this store loaded. */
  wasQuarantined(): boolean {
    return this.quarantined
  }

  /** Adapter for HostThreadRecordPersistClient's `onPersistedEvidence`. */
  persistedEvidenceSink(
    onError: (error: unknown) => void = (error) =>
      console.error('[ownership-receipts] could not record evidence', error)
  ): (input: { readonly chatId: string }, evidence: ThreadOwnershipReceiptEvidence) => void {
    return (input, evidence) => {
      void this.record(evidence, { chatId: input.chatId }).catch(onError)
    }
  }

  private find(commandId: string): ThreadOwnershipReceiptEvidence | null {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index]
      if (entry.commandId === commandId) return entry.evidence
    }
    return null
  }

  private list(chatId: string): ThreadOwnershipReceiptEvidence[] {
    return this.entries.filter((entry) => entry.chatId === chatId).map((entry) => entry.evidence)
  }

  private entryFor(
    evidence: ThreadOwnershipReceiptEvidence,
    ref?: ReceiptEvidenceRef
  ): StoredEntry {
    const entry = safeEntryFor(evidence, ref)
    if (!entry) throw new Error('Receipt evidence is malformed or has no chat')
    return entry
  }

  private merge(current: StoredEntry[], entry: StoredEntry): StoredEntry[] {
    if (sameEntry(current, entry)) return current
    const at =
      entry.commandId === null
        ? -1
        : current.findIndex(
            (existing) => existing.chatId === entry.chatId && existing.commandId === entry.commandId
          )
    let next: StoredEntry[]
    if (at >= 0) {
      const existing = current[at]
      if (existing.evidence.kind !== 'unavailable' && entry.evidence.kind === 'unavailable') {
        return current
      }
      if (sameEvidence(existing.evidence, entry.evidence)) return current
      next = current.slice()
      next[at] = entry
    } else {
      next = [...current, entry]
    }
    return trim(next, entry.chatId)
  }

  private serialize(work: () => Promise<void>): Promise<void> {
    const run = this.tail.then(work, work)
    this.tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async readDocument(): Promise<void> {
    const text = await this.persistence.read()
    if (text === null) {
      this.isLoaded = true
      return
    }
    const parsed = parseDocument(text)
    if (!parsed) {
      this.quarantined = true
      await this.persistence.quarantine?.(text).catch(() => undefined)
    } else {
      this.entries = parsed
    }
    this.isLoaded = true
  }
}

function safeEntryFor(
  evidence: ThreadOwnershipReceiptEvidence,
  ref?: ReceiptEvidenceRef
): StoredEntry | null {
  if (!validEvidence(evidence)) return null
  if (evidence.kind === 'unavailable') {
    if (!ref?.chatId) return null
    return { chatId: ref.chatId, commandId: ref.commandId ?? null, evidence: freeze(evidence) }
  }
  if (ref && ref.chatId !== evidence.threadId) return null
  if (ref?.commandId && ref.commandId !== evidence.commandId) return null
  return { chatId: evidence.threadId, commandId: evidence.commandId, evidence: freeze(evidence) }
}

function freeze(evidence: ThreadOwnershipReceiptEvidence): ThreadOwnershipReceiptEvidence {
  return Object.freeze({ ...evidence })
}

function validEvidence(value: unknown): value is ThreadOwnershipReceiptEvidence {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  const text = (key: string): boolean => typeof item[key] === 'string' && item[key] !== ''
  const revision = (): boolean =>
    Number.isSafeInteger(item.revision) && (item.revision as number) >= 0
  if (item.kind === 'exact') {
    return (
      text('threadId') &&
      text('commandId') &&
      revision() &&
      typeof item.sha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(item.sha256)
    )
  }
  if (item.kind === 'reanchor') return text('threadId') && text('commandId') && revision()
  if (item.kind === 'unavailable') {
    return typeof item.reason === 'string' && Object.hasOwn(UNAVAILABLE_REASONS, item.reason)
  }
  return false
}

function sameEvidence(
  a: ThreadOwnershipReceiptEvidence,
  b: ThreadOwnershipReceiptEvidence
): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function sameEntry(entries: readonly StoredEntry[], entry: StoredEntry): boolean {
  return entries.some(
    (existing) =>
      existing.chatId === entry.chatId &&
      existing.commandId === entry.commandId &&
      sameEvidence(existing.evidence, entry.evidence)
  )
}

function trim(entries: StoredEntry[], chatId: string): StoredEntry[] {
  let next = entries
  const own = next.filter((entry) => entry.chatId === chatId).length
  if (own > MAX_RECEIPT_EVIDENCE_PER_CHAT) {
    let drop = own - MAX_RECEIPT_EVIDENCE_PER_CHAT
    next = next.filter((entry) => entry.chatId !== chatId || drop-- <= 0)
  }
  if (next.length > MAX_RECEIPT_EVIDENCE_TOTAL) {
    next = next.slice(next.length - MAX_RECEIPT_EVIDENCE_TOTAL)
  }
  return next
}

function serialize(entries: readonly StoredEntry[]): string {
  return JSON.stringify({
    format: OWNERSHIP_RECEIPT_EVIDENCE_FORMAT,
    version: OWNERSHIP_RECEIPT_EVIDENCE_VERSION,
    entries
  })
}

function parseDocument(text: string): StoredEntry[] | null {
  try {
    const document = JSON.parse(text) as Record<string, unknown>
    if (
      document?.format !== OWNERSHIP_RECEIPT_EVIDENCE_FORMAT ||
      document.version !== OWNERSHIP_RECEIPT_EVIDENCE_VERSION ||
      !Array.isArray(document.entries)
    ) {
      return null
    }
    const entries: StoredEntry[] = []
    for (const raw of document.entries as unknown[]) {
      const item = raw as Record<string, unknown> | null
      if (!item || typeof item.chatId !== 'string' || item.chatId === '') continue
      const commandId = typeof item.commandId === 'string' ? item.commandId : null
      if (!validEvidence(item.evidence)) continue
      const entry = safeEntryFor(item.evidence, {
        chatId: item.chatId,
        ...(commandId ? { commandId } : {})
      })
      if (entry) entries.push(entry)
    }
    return entries
  } catch {
    return null
  }
}

/** Atomic file persistence: write a sibling, sync it, rename, sync the directory. */
export function createFileReceiptEvidencePersistence(file: string): ReceiptEvidencePersistence {
  return {
    async read() {
      try {
        return await readFile(file, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    async write(text) {
      const directory = path.dirname(file)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temporary = `${file}.tmp`
      try {
        const handle = await open(temporary, 'w', 0o600)
        try {
          await handle.writeFile(text, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
        await rename(temporary, file)
      } catch (error) {
        await unlink(temporary).catch(() => undefined)
        throw error
      }
      if (process.platform !== 'win32') {
        const handle = await open(directory, 'r')
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
    },
    async quarantine() {
      await rename(file, `${file}.corrupt`)
    }
  }
}
