import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { redactSecrets } from '../shared/secretRedaction'

export const EXTERNAL_PUBLISH_RECEIPT_SCHEMA_VERSION = 1
export const EXTERNAL_PUBLISH_RECEIPT_LEDGER_FILENAME = 'external-publish-receipts.json'
export const MAX_EXTERNAL_PUBLISH_RECEIPTS = 2000

export type ExternalPublishOrigin = 'desktop-ui' | 'ios-bridge' | 'agent'
export type ExternalPublishAction = 'gitPush' | 'githubCreatePr'
export type ExternalPublishDecision = 'allowed' | 'denied'
export type ExternalPublishOutcome = 'completed' | 'failed'

export interface ExternalPublishReceipt {
  schemaVersion: 1
  id: string
  origin: ExternalPublishOrigin
  action: ExternalPublishAction
  decision: ExternalPublishDecision
  reason: string
  requestedAt: string
  completedAt?: string
  outcome?: ExternalPublishOutcome
  workspaceId?: string
  workspacePath?: string
  repoPath?: string
  remote?: string
  setUpstream?: boolean
  title?: string
  draft?: boolean
  commitSha?: string
  prUrl?: string
  error?: string
  metadata?: Record<string, unknown>
}

export type ExternalPublishReceiptInput = Omit<
  ExternalPublishReceipt,
  'schemaVersion' | 'id' | 'requestedAt'
> &
  Partial<Pick<ExternalPublishReceipt, 'id' | 'requestedAt'>>

export interface ExternalPublishReceiptCompletion {
  id: string
  outcome: ExternalPublishOutcome
  completedAt?: string
  commitSha?: string
  prUrl?: string
  error?: string
  metadata?: Record<string, unknown>
}

export interface ExternalPublishReceiptWriter {
  begin(input: ExternalPublishReceiptInput): ExternalPublishReceipt | Promise<ExternalPublishReceipt>
  complete(
    input: ExternalPublishReceiptCompletion
  ): ExternalPublishReceipt | null | Promise<ExternalPublishReceipt | null>
}

export interface ExternalPublishReceiptLedgerOptions {
  storagePath?: string
  now?: () => string
  idFactory?: () => string
  log?: (line: string) => void
}

export function defaultExternalPublishReceiptLedgerPath(): string | null {
  if (!app || typeof app.getPath !== 'function') return null
  try {
    return join(app.getPath('userData'), EXTERNAL_PUBLISH_RECEIPT_LEDGER_FILENAME)
  } catch {
    return null
  }
}

export function createDefaultExternalPublishReceiptLedger(
  options: { log?: (line: string) => void } = {}
): ExternalPublishReceiptLedger | null {
  const storagePath = defaultExternalPublishReceiptLedgerPath()
  return storagePath ? new ExternalPublishReceiptLedger({ storagePath, log: options.log }) : null
}

export class ExternalPublishReceiptLedger implements ExternalPublishReceiptWriter {
  private readonly storagePath?: string
  private readonly now: () => string
  private readonly idFactory: () => string
  private readonly log: (line: string) => void
  private records: ExternalPublishReceipt[] = []

  constructor(options: ExternalPublishReceiptLedgerOptions = {}) {
    this.storagePath = options.storagePath
    this.now = options.now ?? (() => new Date().toISOString())
    this.idFactory = options.idFactory ?? (() => randomUUID())
    this.log = options.log ?? (() => {})
    if (this.storagePath) this.records = this.readFromDisk()
  }

  list(): ExternalPublishReceipt[] {
    return [...this.records]
  }

  begin(input: ExternalPublishReceiptInput): ExternalPublishReceipt {
    const record = normalizeReceipt(input, this.idFactory, this.now)
    const existing = this.records.find((row) => row.id === record.id)
    if (existing) return existing
    this.records = capExternalPublishReceipts([...this.records, record])
    this.persist()
    return record
  }

  complete(input: ExternalPublishReceiptCompletion): ExternalPublishReceipt | null {
    const id = input.id.trim()
    if (!id) return null
    const index = this.records.findIndex((row) => row.id === id)
    if (index < 0) return null
    const current = this.records[index]
    const next: ExternalPublishReceipt = {
      ...current,
      outcome: input.outcome,
      completedAt: input.completedAt || this.now(),
      ...(text(input.commitSha, 120) ? { commitSha: text(input.commitSha, 120) } : {}),
      ...(text(input.prUrl, 1000) ? { prUrl: text(input.prUrl, 1000) } : {}),
      ...(text(input.error, 1000) ? { error: text(input.error, 1000) } : {}),
      ...(input.metadata ? { metadata: sanitizeMetadata(input.metadata) } : {})
    }
    this.records = [
      ...this.records.slice(0, index),
      next,
      ...this.records.slice(index + 1)
    ]
    this.persist()
    return next
  }

  private readFromDisk(): ExternalPublishReceipt[] {
    if (!this.storagePath || !existsSync(this.storagePath)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, 'utf-8')) as unknown
      if (!Array.isArray(parsed)) {
        this.log(
          `[ExternalPublishReceiptLedger] discarded malformed ledger file at ${this.storagePath}`
        )
        return []
      }
      return capExternalPublishReceipts(parsed.map(normalizeStoredReceipt).filter(Boolean))
    } catch (err) {
      this.log(
        `[ExternalPublishReceiptLedger] load failed (starting empty): ${err instanceof Error ? err.message : String(err)}`
      )
      return []
    }
  }

  private persist(): void {
    if (!this.storagePath) return
    try {
      mkdirSync(dirname(this.storagePath), { recursive: true })
      const tmpPath = `${this.storagePath}.tmp`
      writeFileSync(tmpPath, JSON.stringify(this.records), 'utf-8')
      renameSync(tmpPath, this.storagePath)
    } catch (err) {
      this.log(
        `[ExternalPublishReceiptLedger] persist failed: ${err instanceof Error ? err.message : String(err)}`
      )
      throw err
    }
  }
}

export function capExternalPublishReceipts(
  records: ExternalPublishReceipt[],
  cap = MAX_EXTERNAL_PUBLISH_RECEIPTS
): ExternalPublishReceipt[] {
  if (!Array.isArray(records)) return []
  const normalized = records.filter(isExternalPublishReceipt)
  return normalized.length <= cap ? normalized : normalized.slice(normalized.length - cap)
}

function normalizeReceipt(
  input: ExternalPublishReceiptInput,
  idFactory: () => string,
  now: () => string
): ExternalPublishReceipt {
  const id = String(input.id || idFactory()).trim()
  if (!id) throw new Error('External publish receipt requires an id.')
  const reason = text(input.reason, 1000) || input.decision
  return {
    schemaVersion: EXTERNAL_PUBLISH_RECEIPT_SCHEMA_VERSION,
    id,
    origin: input.origin,
    action: input.action,
    decision: input.decision,
    reason,
    requestedAt: input.requestedAt || now(),
    ...(text(input.workspaceId, 200) ? { workspaceId: text(input.workspaceId, 200) } : {}),
    ...(text(input.workspacePath, 2000) ? { workspacePath: text(input.workspacePath, 2000) } : {}),
    ...(text(input.repoPath, 2000) ? { repoPath: text(input.repoPath, 2000) } : {}),
    ...(text(input.remote, 200) ? { remote: text(input.remote, 200) } : {}),
    ...(input.setUpstream !== undefined ? { setUpstream: input.setUpstream === true } : {}),
    ...(text(input.title, 500) ? { title: text(input.title, 500) } : {}),
    ...(input.draft !== undefined ? { draft: input.draft === true } : {}),
    ...(input.metadata ? { metadata: sanitizeMetadata(input.metadata) } : {})
  }
}

function normalizeStoredReceipt(value: unknown): ExternalPublishReceipt | null {
  if (!isExternalPublishReceipt(value)) return null
  return value
}

function isExternalPublishReceipt(value: unknown): value is ExternalPublishReceipt {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    record.schemaVersion === EXTERNAL_PUBLISH_RECEIPT_SCHEMA_VERSION &&
    typeof record.id === 'string' &&
    (record.origin === 'desktop-ui' ||
      record.origin === 'ios-bridge' ||
      record.origin === 'agent') &&
    (record.action === 'gitPush' || record.action === 'githubCreatePr') &&
    (record.decision === 'allowed' || record.decision === 'denied') &&
    typeof record.reason === 'string' &&
    typeof record.requestedAt === 'string' &&
    Number.isFinite(Date.parse(record.requestedAt)) &&
    (record.outcome === undefined ||
      record.outcome === 'completed' ||
      record.outcome === 'failed')
  )
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = redactSecrets(value.trim())
  return trimmed ? trimmed.slice(0, max) : undefined
}

function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string') {
      const safe = text(value, 1000)
      if (safe) sanitized[key] = safe
    } else if (
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      sanitized[key] = value
    }
  }
  return sanitized
}
