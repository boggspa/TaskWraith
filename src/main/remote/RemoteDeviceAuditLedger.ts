import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

import type { RemoteWorkspaceCapability } from '../RemoteWorkspaceAllowlist'

export type RemoteDeviceAuditDecision = 'allowed' | 'denied'

export interface RemoteDeviceAuditRecord {
  id: string
  deviceId: string
  capability: RemoteWorkspaceCapability
  action: string
  chatId?: string
  decision: RemoteDeviceAuditDecision
  reason: string
  timestamp: string
}

export type RemoteDeviceAuditRecordInput = Omit<RemoteDeviceAuditRecord, 'id' | 'timestamp'> &
  Partial<Pick<RemoteDeviceAuditRecord, 'id' | 'timestamp'>>

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
      return parsed.filter(isRemoteDeviceAuditRecord)
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
      writeFileSync(tmpPath, JSON.stringify(this.records), 'utf-8')
      renameSync(tmpPath, this.storagePath)
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
  const deviceId = input.deviceId.trim()
  if (!deviceId) throw new Error('Remote device audit record requires a deviceId.')
  const action = input.action.trim()
  if (!action) throw new Error('Remote device audit record requires an action.')
  const reason = input.reason.trim()
  return {
    id,
    deviceId,
    capability: input.capability,
    action,
    ...(input.chatId ? { chatId: input.chatId } : {}),
    decision: input.decision,
    reason: reason || input.decision,
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
    typeof record.reason === 'string' &&
    typeof record.timestamp === 'string' &&
    Number.isFinite(Date.parse(record.timestamp))
  )
}
