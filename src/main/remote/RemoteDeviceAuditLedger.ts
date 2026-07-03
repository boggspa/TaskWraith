import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

import type { RemoteWorkspaceCapability } from '../RemoteWorkspaceAllowlist'

export type RemoteDeviceAuditDecision = 'allowed' | 'denied'
export type RemoteDeviceAuditCapability = RemoteWorkspaceCapability | 'system'
export type RemoteDeviceAuditMetadataValue = string | number | boolean

export interface RemoteDeviceAuditRecord {
  id: string
  deviceId: string
  capability: RemoteDeviceAuditCapability
  action: string
  chatId?: string
  decision: RemoteDeviceAuditDecision
  reasonCode?: string
  reason: string
  metadata?: Record<string, RemoteDeviceAuditMetadataValue>
  timestamp: string
}

export type RemoteDeviceAuditRecordInput = Omit<
  RemoteDeviceAuditRecord,
  'id' | 'timestamp' | 'metadata'
> &
  Partial<Pick<RemoteDeviceAuditRecord, 'id' | 'timestamp'>> & {
    metadata?: Record<string, unknown>
  }

export interface RemoteDeviceAuditLedgerWriter {
  append(record: RemoteDeviceAuditRecordInput): RemoteDeviceAuditRecord | Promise<RemoteDeviceAuditRecord>
}

export interface RemoteDeviceAuditLedgerOptions {
  storagePath?: string
  now?: () => string
  idFactory?: () => string
  log?: (line: string) => void
}

export const REMOTE_DEVICE_AUDIT_LEDGER_FILENAME = 'remote-device-audit-ledger.json'

/**
 * Cap on retained audit records. The ledger is rewritten in full on every
 * append (see `persist`), so leaving it unbounded turns each remote device
 * action into an ever-slower synchronous main-thread write — a connected phone
 * polling thread snapshots appends ~1/sec, which froze the UI once the file
 * grew into the megabytes. Newest records are kept.
 */
export const MAX_REMOTE_DEVICE_AUDIT_RECORDS = 2000
const MAX_REMOTE_DEVICE_AUDIT_FIELD_LENGTH = 256
const MAX_REMOTE_DEVICE_AUDIT_REASON_LENGTH = 512
const MAX_REMOTE_DEVICE_AUDIT_METADATA_KEYS = 12

export function defaultRemoteDeviceAuditLedgerPath(): string | null {
  if (!app || typeof app.getPath !== 'function') return null
  try {
    return join(app.getPath('userData'), 'bridge', REMOTE_DEVICE_AUDIT_LEDGER_FILENAME)
  } catch {
    return null
  }
}

export function createDefaultRemoteDeviceAuditLedger(options: {
  log?: (line: string) => void
} = {}): RemoteDeviceAuditLedger | null {
  const storagePath = defaultRemoteDeviceAuditLedgerPath()
  return storagePath ? new RemoteDeviceAuditLedger({ storagePath, log: options.log }) : null
}

export class RemoteDeviceAuditLedger implements RemoteDeviceAuditLedgerWriter {
  private readonly storagePath?: string
  private readonly now: () => string
  private readonly idFactory: () => string
  private readonly log: (line: string) => void
  private records: RemoteDeviceAuditRecord[] = []

  constructor(options: RemoteDeviceAuditLedgerOptions = {}) {
    this.storagePath = options.storagePath
    this.now = options.now ?? (() => new Date().toISOString())
    this.idFactory = options.idFactory ?? (() => randomUUID())
    this.log = options.log ?? (() => {})
    if (this.storagePath) {
      this.records = this.readFromDisk()
    }
  }

  list(): RemoteDeviceAuditRecord[] {
    return [...this.records]
  }

  append(input: RemoteDeviceAuditRecordInput): RemoteDeviceAuditRecord {
    const record = normalizeRecord(input, this.idFactory, this.now)
    const existing = this.records.find((row) => row.id === record.id)
    if (existing) return existing
    this.records = [...this.records, record]
    if (this.records.length > MAX_REMOTE_DEVICE_AUDIT_RECORDS) {
      this.records = this.records.slice(-MAX_REMOTE_DEVICE_AUDIT_RECORDS)
    }
    this.persist()
    return record
  }

  private readFromDisk(): RemoteDeviceAuditRecord[] {
    if (!this.storagePath || !existsSync(this.storagePath)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, 'utf-8')) as unknown
      if (!Array.isArray(parsed)) {
        this.log(
          `[RemoteDeviceAuditLedger] discarded malformed ledger file at ${this.storagePath}`
        )
        return []
      }
      return parsed
        .filter(isRemoteDeviceAuditRecord)
        .map((record) => normalizeRecord(record, this.idFactory, this.now))
    } catch (err) {
      this.log(
        `[RemoteDeviceAuditLedger] load failed (starting empty): ${err instanceof Error ? err.message : String(err)}`
      )
      return []
    }
  }

  private persist(): void {
    if (!this.storagePath) return
    try {
      mkdirSync(dirname(this.storagePath), { recursive: true })
      const tmpPath = `${this.storagePath}.tmp`
      // Compact (not pretty-printed): this is a machine-read audit log that is
      // rewritten on every append; the 2-space indent ~doubled the bytes and
      // the serialize cost on the main thread for no human benefit.
      writeFileSync(tmpPath, JSON.stringify(this.records), { encoding: 'utf-8', mode: 0o600 })
      renameSync(tmpPath, this.storagePath)
      chmodSync(this.storagePath, 0o600)
    } catch (err) {
      this.log(
        `[RemoteDeviceAuditLedger] persist failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
}

function normalizeRecord(
  input: RemoteDeviceAuditRecordInput,
  idFactory: () => string,
  now: () => string
): RemoteDeviceAuditRecord {
  const id = String(input.id || idFactory()).trim()
  if (!id) throw new Error('Remote device audit record requires an id.')
  const deviceId = clampField(input.deviceId.trim())
  if (!deviceId) throw new Error('Remote device audit record requires a deviceId.')
  const action = clampField(input.action.trim())
  if (!action) throw new Error('Remote device audit record requires an action.')
  const reason = clampReason(input.reason.trim())
  const reasonCode = normalizeReasonCode(input.reasonCode)
  const metadata = normalizeMetadata(input.metadata)
  return {
    id: clampField(id),
    deviceId,
    capability: input.capability,
    action,
    ...(input.chatId ? { chatId: clampField(input.chatId) } : {}),
    decision: input.decision,
    ...(reasonCode ? { reasonCode } : {}),
    reason: reason || input.decision,
    ...(metadata ? { metadata } : {}),
    timestamp: input.timestamp || now()
  }
}

function isRemoteDeviceAuditRecord(value: unknown): value is RemoteDeviceAuditRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.deviceId === 'string' &&
    typeof record.capability === 'string' &&
    typeof record.action === 'string' &&
    (record.chatId === undefined || typeof record.chatId === 'string') &&
    (record.decision === 'allowed' || record.decision === 'denied') &&
    (record.reasonCode === undefined || typeof record.reasonCode === 'string') &&
    typeof record.reason === 'string' &&
    (record.metadata === undefined || isMetadataRecord(record.metadata)) &&
    typeof record.timestamp === 'string' &&
    Number.isFinite(Date.parse(record.timestamp))
  )
}

function clampField(value: string): string {
  return value.length <= MAX_REMOTE_DEVICE_AUDIT_FIELD_LENGTH
    ? value
    : value.slice(0, MAX_REMOTE_DEVICE_AUDIT_FIELD_LENGTH)
}

function clampReason(value: string): string {
  return value.length <= MAX_REMOTE_DEVICE_AUDIT_REASON_LENGTH
    ? value
    : value.slice(0, MAX_REMOTE_DEVICE_AUDIT_REASON_LENGTH)
}

function normalizeReasonCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return clampField(trimmed.replace(/[^A-Za-z0-9_.:-]/g, '_'))
}

function normalizeMetadata(
  value: unknown
): Record<string, RemoteDeviceAuditMetadataValue> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const output: Record<string, RemoteDeviceAuditMetadataValue> = {}
  for (const key of Object.keys(value as Record<string, unknown>).slice(
    0,
    MAX_REMOTE_DEVICE_AUDIT_METADATA_KEYS
  )) {
    const normalizedKey = clampField(key.trim().replace(/[^A-Za-z0-9_.:-]/g, '_'))
    if (!normalizedKey) continue
    const raw = (value as Record<string, unknown>)[key]
    if (typeof raw === 'string') {
      output[normalizedKey] = clampField(raw)
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      output[normalizedKey] = raw
    } else if (typeof raw === 'boolean') {
      output[normalizedKey] = raw
    }
  }
  return Object.keys(output).length > 0 ? output : undefined
}

function isMetadataRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every(
    (entry) =>
      typeof entry === 'string' ||
      typeof entry === 'boolean' ||
      (typeof entry === 'number' && Number.isFinite(entry))
  )
}
