import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const { collectM5X2Artifacts } = require('./m5X2Artifacts.cjs')
const { x6EvidenceFromAttribution } = require('./m5X2Artifacts.cjs')
describe('real X2 artifact binding', () => {
  it('serializes canonical collector intervals and never fills unknown coverage', () => {
    const row = {
      qualified: true,
      profileSha256: 'a'.repeat(64),
      gapArtifactSha256: 'b'.repeat(64),
      attribution: {
        attributionEligible: true,
        censored: false,
        window: { id: 'w2', clockId: 'measured-clock', startMs: 100, endMs: 200 },
        coverage: { complete: true },
        gaps: [{ expectedFireMs: 120, observedFireMs: 180 }],
        evidence: [
          {
            gapIndex: 0,
            startMs: 120,
            endMs: 180,
            owner: 's7_run_event',
            kind: 'owner',
            exemptionReasons: []
          }
        ],
        nonExemptOwnerMs: 60,
        nonExemptOwnerGaps: [0],
        ownerAbsenceProven: false
      }
    }
    const result = x6EvidenceFromAttribution(row)
    expect(result.clockId).toBe('measured-clock')
    expect(result.attributionEligible).toBe(true)
    expect(result.censored).toBe(false)
    expect(result.gapCoverage[0].frames[0]).toMatchObject({
      startedAtMs: 120,
      endedAtMs: 180,
      owner: 's7_run_event',
      classification: 'listed'
    })
    expect(result.owners).toContain('s7_detail_batch')
    expect(
      x6EvidenceFromAttribution({ ...row, attribution: { ...row.attribution, censored: true } })
    ).toBeNull()
    expect(
      x6EvidenceFromAttribution({ ...row, attribution: { ...row.attribution, evidence: [] } })
        .gapCoverage[0].complete
    ).toBe(false)
  })
  it('refuses wall-clock receipts without synthesizing profile anchors or exemptions', () => {
    let written = ''
    const result = collectM5X2Artifacts({
      profilePath: '/profile',
      artifactPath: '/result',
      windows: [{ repetition: 2, mainWindow: { startedAtMs: 1, endedAtMs: 120001 } }],
      fsApi: {
        readFileSync: () => Buffer.from('{}'),
        writeFileSync: (_path: string, value: string) => {
          written = value
        }
      }
    })
    expect(result.qualified).toBe(false)
    expect(result.windows[0].reason).toBe('measured_monotonic_anchor_absent')
    expect(JSON.parse(written).windows[0].repetition).toBe(2)
  })
  it('refuses missing exact exemption instrumentation even with an anchor', () => {
    const result = collectM5X2Artifacts({
      profilePath: '/profile',
      artifactPath: '/result',
      windows: [{ mainWindow: { clockKind: 'monotonic', clockId: 'clock', profileAnchor: {} } }],
      fsApi: { readFileSync: () => Buffer.from('{}'), writeFileSync: () => {} }
    })
    expect(result.windows[0].reason).toBe('timestamped_exemption_evidence_absent')
  })
})
