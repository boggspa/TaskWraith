import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { WorkProvenanceProjection } from '../../shared/workProvenance'
import { WorkProvenanceQueryService } from './WorkProvenanceQueryService'

function fixture(root: string, coherent = true): WorkProvenanceProjection {
  const totals = {
    files: 0,
    trackedFiles: 0,
    untrackedFiles: 0,
    binaryFiles: 0,
    additions: 0,
    deletions: 0
  }
  const bucket = { ...totals, paths: [] }
  return {
    projectionVersion: 1,
    classifierVersion: 1,
    eventSchemaVersion: 1,
    cursor: 'a'.repeat(64),
    generatedAt: '2026-08-03T20:00:00.000Z',
    repository: {
      root,
      gitDir: join(root, '.git'),
      gitCommonDir: join(root, '.git'),
      repositoryId: 'b'.repeat(64),
      worktreeId: 'c'.repeat(64)
    },
    gitGeneration: {
      id: 'd'.repeat(64),
      coherent,
      reason: coherent ? null : 'Git changed during sampling.',
      attempt: 1,
      observedAt: '2026-08-03T20:00:00.000Z',
      headCommit: 'e'.repeat(40),
      statusDigest: 'f'.repeat(64),
      numstatDigest: '0'.repeat(64),
      fingerprintDigest: '1'.repeat(64)
    },
    attribution: {
      root: totals,
      unique: bucket,
      sharedAmbiguous: bucket,
      unclaimedUnknown: bucket,
      invariant: { files: true, additions: true, deletions: true, satisfied: true }
    },
    window: { limit: 200, totalItems: 0, returnedItems: 0, truncated: false },
    workItems: []
  }
}

describe('WorkProvenanceQueryService', () => {
  it('accepts a coherent projection for the canonical worktree', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'taskwraith-provenance-')))
    const driver = vi.fn(async () => fixture(root))
    const service = new WorkProvenanceQueryService(driver)

    const snapshot = await service.query(root)

    expect(snapshot.available).toBe(true)
    expect(snapshot.stale).toBe(false)
    expect(snapshot.repository?.root).toBe(root)
    expect(driver).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent reads and caches the coherent generation', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'taskwraith-provenance-')))
    const driver = vi.fn(async () => fixture(root))
    const service = new WorkProvenanceQueryService(driver)

    const [first, second] = await Promise.all([service.query(root), service.query(root)])
    const cached = await service.query(root)

    expect(first.cursor).toBe(second.cursor)
    expect(cached.cursor).toBe(first.cursor)
    expect(driver).toHaveBeenCalledTimes(1)
  })

  it('retains the last coherent generation as stale after churn', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'taskwraith-provenance-')))
    let now = 1_000
    const driver = vi
      .fn<() => Promise<WorkProvenanceProjection>>()
      .mockResolvedValueOnce(fixture(root))
      .mockResolvedValueOnce(fixture(root, false))
    const service = new WorkProvenanceQueryService(driver, { now: () => now })

    await service.query(root)
    now += 5_000
    const stale = await service.query(root)

    expect(stale.available).toBe(true)
    expect(stale.stale).toBe(true)
    expect(stale.reason).toContain('last coherent')
  })

  it('reports incompatible or mismatched projections as unavailable, never empty/clean', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'taskwraith-provenance-')))
    const otherRoot = realpathSync(mkdtempSync(join(tmpdir(), 'taskwraith-provenance-other-')))
    const incompatible = fixture(otherRoot)
    incompatible.projectionVersion = 2
    const service = new WorkProvenanceQueryService(async () => incompatible)

    const snapshot = await service.query(root)

    expect(snapshot.available).toBe(false)
    expect(snapshot.reason).toContain('Unsupported work provenance contract')
    expect(snapshot.workItems).toEqual([])
  })
})
