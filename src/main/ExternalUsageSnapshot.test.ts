import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { UsageRecord } from './store/types'
import { loadExternalUsageSnapshot, persistExternalUsageSnapshot } from './ExternalUsageSnapshot'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

async function temporaryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'taskwraith-external-snapshot-'))
  temporaryDirectories.push(directory)
  return join(directory, 'external-activity-snapshot.json')
}

function usageRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: 'external-agg-codex-test',
    provider: 'codex',
    workspaceId: 'external',
    chatId: 'external-codex',
    runId: 'external-codex',
    usageKind: 'run',
    model: 'gpt-5.6',
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
    cacheReadInputTokens: 3,
    durationMs: 0,
    runCount: 2,
    timestamp: Date.now() - 1_000,
    ...overrides
  }
}

describe('ExternalUsageSnapshot', () => {
  it('round-trips a path-free aggregate through an owner-only atomic file', async () => {
    const snapshotPath = await temporaryPath()
    const scannedAt = Date.now() - 500
    const records = [usageRecord()]

    await persistExternalUsageSnapshot(snapshotPath, { scannedAt, records })

    await expect(loadExternalUsageSnapshot(snapshotPath)).resolves.toEqual({ scannedAt, records })
    if (process.platform !== 'win32') {
      expect((await stat(snapshotPath)).mode & 0o777).toBe(0o600)
    }
    expect(await readFile(snapshotPath, 'utf8')).not.toContain('/Users/')
  })

  it('rejects malformed records instead of projecting untrusted cache data', async () => {
    const snapshotPath = await temporaryPath()
    await writeFile(
      snapshotPath,
      JSON.stringify({
        version: 1,
        scannedAt: Date.now(),
        records: [{ ...usageRecord(), workspaceId: 'someone-else' }]
      })
    )

    await expect(loadExternalUsageSnapshot(snapshotPath)).resolves.toBeNull()
  })

  it('clamps a future cache timestamp so it cannot suppress refreshes indefinitely', async () => {
    const snapshotPath = await temporaryPath()
    await writeFile(
      snapshotPath,
      JSON.stringify({
        version: 1,
        scannedAt: Date.now() + 24 * 60 * 60 * 1_000,
        records: [usageRecord()]
      })
    )

    const before = Date.now()
    const loaded = await loadExternalUsageSnapshot(snapshotPath)
    expect(loaded?.scannedAt).toBeGreaterThanOrEqual(before)
    expect(loaded?.scannedAt).toBeLessThanOrEqual(Date.now())
  })
})
