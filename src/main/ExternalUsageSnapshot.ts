import { promises as fs } from 'fs'
import { dirname } from 'path'
import type { ProviderId, UsageRecord } from './store/types'

const EXTERNAL_USAGE_SNAPSHOT_VERSION = 1
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024
const MAX_SNAPSHOT_RECORDS = 100_000
const EXTERNAL_PROVIDERS = new Set<string>(['codex', 'claude', 'gemini', 'kimi', 'cursor', 'grok'])

interface StoredExternalUsageSnapshot {
  version: number
  scannedAt: number
  records: unknown[]
}

export interface ExternalUsageSnapshot {
  scannedAt: number
  records: UsageRecord[]
}

function finiteNonNegative(value: unknown): number | null {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null
}

function normalizeRecord(value: unknown): UsageRecord | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<UsageRecord>
  if (
    typeof record.id !== 'string' ||
    !record.id ||
    record.id.length > 512 ||
    typeof record.provider !== 'string' ||
    !EXTERNAL_PROVIDERS.has(record.provider) ||
    record.workspaceId !== 'external' ||
    record.chatId !== `external-${record.provider}` ||
    record.runId !== `external-${record.provider}` ||
    (record.usageKind !== undefined && record.usageKind !== 'run') ||
    typeof record.model !== 'string' ||
    !record.model ||
    record.model.length > 512 ||
    !Number.isFinite(record.timestamp) ||
    Number(record.timestamp) <= 0
  ) {
    return null
  }
  const inputTokens = finiteNonNegative(record.inputTokens)
  const outputTokens = finiteNonNegative(record.outputTokens)
  const totalTokens = finiteNonNegative(record.totalTokens)
  const durationMs = finiteNonNegative(record.durationMs)
  if (
    inputTokens === null ||
    outputTokens === null ||
    totalTokens === null ||
    durationMs === null
  ) {
    return null
  }
  const cacheReadInputTokens = finiteNonNegative(record.cacheReadInputTokens)
  const cacheCreationInputTokens = finiteNonNegative(record.cacheCreationInputTokens)
  const runCount = finiteNonNegative(record.runCount)
  const costRateModel = typeof record.costRateModel === 'string' ? record.costRateModel.trim() : ''
  if (costRateModel.length > 512) return null
  return {
    id: record.id,
    provider: record.provider as ProviderId,
    workspaceId: 'external',
    chatId: record.chatId,
    runId: record.runId,
    usageKind: 'run',
    model: record.model,
    ...(costRateModel ? { costRateModel } : {}),
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cacheReadInputTokens !== null && cacheReadInputTokens > 0 ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens !== null && cacheCreationInputTokens > 0
      ? { cacheCreationInputTokens }
      : {}),
    durationMs,
    timestamp: Number(record.timestamp),
    ...(runCount !== null && runCount >= 1 ? { runCount: Math.trunc(runCount) } : {})
  }
}

/**
 * Load the small, path-free result snapshot produced by the last completed
 * scan. The file is only a presentation cache: malformed or oversized data is
 * ignored and the normal background refresh remains authoritative.
 */
export async function loadExternalUsageSnapshot(
  snapshotPath: string
): Promise<ExternalUsageSnapshot | null> {
  try {
    const stat = await fs.stat(snapshotPath)
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SNAPSHOT_BYTES) return null
    const raw = await fs.readFile(snapshotPath, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > MAX_SNAPSHOT_BYTES) return null
    const parsed = JSON.parse(raw) as StoredExternalUsageSnapshot
    if (
      parsed?.version !== EXTERNAL_USAGE_SNAPSHOT_VERSION ||
      !Number.isFinite(parsed.scannedAt) ||
      !Array.isArray(parsed.records) ||
      parsed.records.length > MAX_SNAPSHOT_RECORDS
    ) {
      return null
    }
    const records: UsageRecord[] = []
    for (const value of parsed.records) {
      const record = normalizeRecord(value)
      if (!record) return null
      records.push(record)
    }
    return {
      scannedAt: Math.min(parsed.scannedAt, Date.now()),
      records
    }
  } catch {
    return null
  }
}

/** Persist a completed aggregate atomically. No source paths, prompts or
 * provider transcript content are present in these records. */
export async function persistExternalUsageSnapshot(
  snapshotPath: string,
  snapshot: ExternalUsageSnapshot
): Promise<void> {
  const tempPath = `${snapshotPath}.tmp-${process.pid}`
  try {
    const payload = JSON.stringify({
      version: EXTERNAL_USAGE_SNAPSHOT_VERSION,
      scannedAt: snapshot.scannedAt,
      records: snapshot.records
    })
    if (Buffer.byteLength(payload, 'utf8') > MAX_SNAPSHOT_BYTES) return
    await fs.mkdir(dirname(snapshotPath), { recursive: true })
    await fs.writeFile(tempPath, payload, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(tempPath, snapshotPath)
  } catch {
    try {
      await fs.rm(tempPath, { force: true })
    } catch {
      // Best-effort presentation cache.
    }
  }
}
