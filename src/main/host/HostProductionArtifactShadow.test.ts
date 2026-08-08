/**
 * Host Arc Track4 Mixed Wave A — HostProductionArtifactShadow pins.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  createHostProductionArtifactShadow,
  mapArtifactShadowsToHostArtifacts,
  type HostArtifactShadowEntry
} from './HostProductionArtifactShadow'

function entry(overrides: Partial<HostArtifactShadowEntry> = {}): HostArtifactShadowEntry {
  return {
    artifactId: 'canvas-1',
    kind: 'canvas:web',
    title: 'Local preview',
    createdAt: 1_700_000_000_000,
    threadId: 'chat-1',
    ...overrides
  }
}

describe('mapArtifactShadowsToHostArtifacts', () => {
  it('returns empty for zero entries (a measured none)', () => {
    expect(mapArtifactShadowsToHostArtifacts([])).toEqual([])
  })

  it('keeps the artifactId verbatim — it is the client join key', () => {
    const rows = mapArtifactShadowsToHostArtifacts([entry()])
    expect(rows).toHaveLength(1)
    expect(rows[0].artifactId).toBe('canvas-1')
    expect(rows[0].kind).toBe('canvas:web')
    expect(rows[0].title).toBe('Local preview')
    expect(rows[0].createdAt).toBe(1_700_000_000_000)
    expect(rows[0].threadId).toBe('chat-1')
  })

  it('omits optional threadId/byteLength/sha256 when absent', () => {
    const rows = mapArtifactShadowsToHostArtifacts([
      entry({ threadId: undefined, byteLength: undefined, sha256: undefined })
    ])
    expect('threadId' in rows[0]).toBe(false)
    expect('byteLength' in rows[0]).toBe(false)
    expect('sha256' in rows[0]).toBe(false)
  })

  it('carries valid byteLength and lowercase hex sha256', () => {
    const sha = 'a'.repeat(64)
    const rows = mapArtifactShadowsToHostArtifacts([entry({ byteLength: 12, sha256: sha })])
    expect(rows[0].byteLength).toBe(12)
    expect(rows[0].sha256).toBe(sha)
  })

  it('skips rows without usable artifactId/kind/title', () => {
    const rows = mapArtifactShadowsToHostArtifacts([
      entry({ artifactId: '' }),
      entry({ kind: '' }),
      entry({ title: '   ' }),
      entry({ artifactId: 'y'.repeat(4096) })
    ])
    expect(rows).toEqual([])
  })

  it('skips rows with invalid createdAt', () => {
    const rows = mapArtifactShadowsToHostArtifacts([
      entry({ createdAt: Number.NaN }),
      entry({ createdAt: -1 }),
      entry({ createdAt: 1.5 })
    ])
    expect(rows).toEqual([])
  })

  it('bounds over-long kind/title rather than forwarding them', () => {
    const rows = mapArtifactShadowsToHostArtifacts([
      entry({ kind: 'k'.repeat(5000), title: 't'.repeat(5000) })
    ])
    expect(rows[0].kind.length).toBeLessThanOrEqual(200)
    expect(rows[0].title.length).toBeLessThanOrEqual(200)
  })

  it('omits invalid sha256 / byteLength rather than inventing them', () => {
    const rows = mapArtifactShadowsToHostArtifacts([
      entry({ sha256: 'not-hex', byteLength: -1 }),
      entry({ sha256: 'A'.repeat(64), byteLength: 1.5 })
    ])
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect('sha256' in row).toBe(false)
      expect('byteLength' in row).toBe(false)
    }
  })

  it('skips entries that smuggle body/url/content fields', () => {
    const rows = mapArtifactShadowsToHostArtifacts([
      { ...entry(), url: 'https://example.invalid/secret' } as HostArtifactShadowEntry,
      { ...entry({ artifactId: 'ok-2' }) }
    ])
    expect(rows.map((r) => r.artifactId)).toEqual(['ok-2'])
  })

  it('allowlists only HostArtifactProjection keys', () => {
    const rows = mapArtifactShadowsToHostArtifacts([
      entry({ byteLength: 3, sha256: 'b'.repeat(64) })
    ])
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['artifactId', 'byteLength', 'createdAt', 'kind', 'sha256', 'threadId', 'title'].sort()
    )
  })
})

describe('createHostProductionArtifactShadow', () => {
  it('re-reads listArtifacts on every call', () => {
    const listArtifacts = vi
      .fn()
      .mockReturnValueOnce([entry({ artifactId: 'a' })])
      .mockReturnValueOnce([entry({ artifactId: 'b' }), entry({ artifactId: 'c' })])
    const port = createHostProductionArtifactShadow({ listArtifacts })
    expect(port.listArtifacts()).toHaveLength(1)
    expect(port.listArtifacts()).toHaveLength(2)
    expect(listArtifacts).toHaveBeenCalledTimes(2)
  })

  it('propagates listArtifacts throws (fail closed)', () => {
    const port = createHostProductionArtifactShadow({
      listArtifacts: () => {
        throw new Error('canvas index unavailable')
      }
    })
    expect(() => port.listArtifacts()).toThrow('canvas index unavailable')
  })

  it('rejects a missing listArtifacts dependency', () => {
    expect(() =>
      createHostProductionArtifactShadow({
        listArtifacts: undefined as unknown as () => HostArtifactShadowEntry[]
      })
    ).toThrow(/listArtifacts/)
  })
})
