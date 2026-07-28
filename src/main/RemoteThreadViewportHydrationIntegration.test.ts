import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

function between(startMarker: string, endMarker: string): string {
  const start = indexSource.indexOf(startMarker)
  const end = indexSource.indexOf(endMarker, start + startMarker.length)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return indexSource.slice(start, end)
}

describe('remote thread viewport hydration integration', () => {
  it('uses viewport units for initial pulls while preserving row-based pagination', () => {
    const requestBuilder = between(
      'const buildRemoteThreadSnapshotPayload = (',
      'const pushRemoteThreadSnapshot = ('
    )

    expect(requestBuilder).toContain("? { kind: 'beforeRow', rowId: beforeRowId, n: clamped }")
    expect(requestBuilder).toContain(": { kind: 'latestViewportN', n: clamped }")
    expect(requestBuilder).not.toContain(": { kind: 'latestN', n: clamped }")
  })

  it('uses viewport units for periodic recent-thread snapshots', () => {
    const periodicSnapshot = between(
      'if (chatIndex < REMOTE_THREAD_SNAPSHOT_CAP) {',
      'if (taskCard.diffSummary) {'
    )

    expect(periodicSnapshot).toContain("mode: { kind: 'latestViewportN', n: 24 }")
    expect(periodicSnapshot).not.toContain("mode: { kind: 'latestN', n: 24 }")
  })
})
