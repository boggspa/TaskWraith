import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const { collectM5X2Artifacts } = require('./m5X2Artifacts.cjs')
const { x6EvidenceFromAttribution } = require('./m5X2Artifacts.cjs')
const { retainFrozenSourceBinding } = require('./m5X2Artifacts.cjs')
describe('real X2 artifact binding', () => {
  it('retains independently trusted receipt and rejects mismatched capture identities', () => {
    const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex')
    const captureManifest = Buffer.from('{}')
    const expected = {
      gitSha: 'a'.repeat(40),
      buildId: 'frozen',
      outputManifestSha256: 'b'.repeat(64)
    }
    const receipt = Buffer.from(
      JSON.stringify({ ...expected, captureManifestSha256: digest(captureManifest), outputs: [] })
    )
    const binding = {
      buildReceiptBytes: receipt,
      trustedBuildReceiptSha256: digest(receipt),
      build: { commitSha: expected.gitSha },
      captureManifest,
      trustedCaptureManifestSha256: digest(captureManifest),
      artifacts: [],
      sources: []
    }
    const writes = new Map<string, unknown>()
    const fsApi = { writeFileSync: (name: string, value: unknown) => writes.set(name, value) }
    expect(retainFrozenSourceBinding(binding, expected, '/a', fsApi).qualified).toBe(true)
    expect(writes.has('/a/x2-frozen-build-receipt.json')).toBe(true)
    expect(
      retainFrozenSourceBinding(binding, { ...expected, gitSha: 'c'.repeat(40) }, '/a', fsApi)
        .qualified
    ).toBe(false)
    expect(
      retainFrozenSourceBinding(
        { ...binding, trustedBuildReceiptSha256: '0'.repeat(64) },
        expected,
        '/a',
        fsApi
      ).qualified
    ).toBe(false)
  })
  it('qualifies actual interior intervals after frozen-byte mapping and measured calibration', () => {
    const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
    const sourcePath = 'src/main/store/ToolActivityDetailLedger.ts'
    const bundleBytes = Buffer.from('function commit(){ return 1 }\n')
    const mapBytes = Buffer.from(
      JSON.stringify({
        version: 3,
        file: 'index.js',
        sources: [sourcePath],
        sourcesContent: [bundleBytes.toString()],
        names: [],
        mappings: 'AAAA'
      })
    )
    const source = {
      path: sourcePath,
      bytes: bundleBytes,
      tracked: true,
      sha256: digest(bundleBytes)
    }
    const build = {
      commitSha: 'a'.repeat(40),
      sourceManifestSha256: digest(Buffer.from(JSON.stringify([[sourcePath, source.sha256]])))
    }
    const artifact = {
      profileUrl: 'file:///frozen/out/main/index.js',
      emittedFile: 'index.js',
      bundleBytes,
      mapBytes,
      bundleSha256: digest(bundleBytes),
      mapSha256: digest(mapBytes),
      buildCommitSha: build.commitSha,
      sourcePaths: { [sourcePath]: sourcePath }
    }
    const { bundleBytes: _bundle, mapBytes: _map, buildCommitSha: _commit, ...tuple } = artifact
    const captureManifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        commitSha: build.commitSha,
        sourceManifestSha256: build.sourceManifestSha256,
        artifacts: [tuple]
      })
    )
    const profile = {
      startTime: 1000000,
      endTime: 1117000,
      nodes: [
        { id: 3, children: [1, 2, 4], callFrame: { functionName: '(root)', url: '' } },
        { id: 1, callFrame: { functionName: 'start', url: 'taskwraith-calibration-start.js' } },
        { id: 2, callFrame: { functionName: 'end', url: 'taskwraith-calibration-end.js' } },
        {
          id: 4,
          callFrame: {
            functionName: 'commit',
            url: artifact.profileUrl,
            lineNumber: 0,
            columnNumber: 0
          }
        }
      ],
      samples: [1, 1, 4, 4, 4, 2, 2],
      timeDeltas: [11000, 6000, 4000, 70000, 14000, 6000, 6000]
    }
    const marker = (tag: string, beforeMs: number, afterMs: number) => ({
      tag,
      beforeMs,
      afterMs,
      pid: 42,
      timeOrigin: 100,
      identity: 'main:42:performance.timeOrigin:100',
      clockId: 'node.performance.now',
      windowId: 'w',
      source: tag,
      sourceSha256: digest(Buffer.from(tag))
    })
    const receipt = {
      id: 'w',
      clock: {
        clockId: 'node.performance.now',
        identity: 'main:42:performance.timeOrigin:100',
        provenance: 'node-performance-now'
      },
      startedAtMs: 30,
      endedAtMs: 80,
      loopGaps: {
        intervalMs: 5,
        thresholdMs: 25,
        startedAtMs: 30,
        endedAtMs: 80,
        observedForMs: 50,
        blockedMs: 30,
        gaps: [{ expectedAtMs: 40, observedAtMs: 70, durationMs: 30 }],
        dropped: 0,
        censored: false,
        reasons: [],
        suspensionProtection: { heldThroughout: true }
      },
      exemptions: { complete: true, entries: [] }
    }
    const result = collectM5X2Artifacts({
      profilePath: '/p',
      artifactPath: '/a',
      calibrationMarkers: [marker('start', 10, 18), marker('end', 110, 118)],
      windows: [{ repetition: 0, mainWindow: receipt }],
      sourceBinding: {
        build,
        sources: [source],
        artifacts: [artifact],
        captureManifest,
        trustedCaptureManifestSha256: digest(captureManifest)
      },
      fsApi: { readFileSync: () => Buffer.from(JSON.stringify(profile)), writeFileSync: () => {} }
    })
    expect(result.qualified).toBe(true)
    expect(result.windows[0].attribution.listedOwnerMsBounds).toEqual({ lower: 30, upper: 30 })
    expect(result.windows[0].exact).toBe(false)
    expect(result.windows[0].x6.attributionEligible).toBe(true)
  })
  it('refuses caller tuples without independently trusted receipt bytes', () => {
    expect(
      retainFrozenSourceBinding(
        { build: { commitSha: 'a'.repeat(40) } },
        { gitSha: 'a'.repeat(40), buildId: 'b' },
        '/artifacts'
      ).qualified
    ).toBe(false)
  })
  it('flat legacy fields cannot bypass calibration or source custody failures', () => {
    const result = collectM5X2Artifacts({
      profilePath: '/p',
      artifactPath: '/a',
      calibrationFailures: ['marker_failed'],
      windows: [
        {
          mainWindow: {
            clockKind: 'monotonic',
            clockId: 'invented',
            profileAnchor: {},
            exemptions: { complete: true, entries: [] }
          }
        }
      ],
      fsApi: { readFileSync: () => Buffer.from('{}'), writeFileSync: () => {} }
    })
    expect(result.qualified).toBe(false)
    expect(result.windows[0].reason).toBe('legacy_clock_diagnostic_only')
  })
  it('consumes actual runtime clock identity and retains unqualified calibration artifacts', () => {
    const artifacts = new Map<string, string>()
    const result = collectM5X2Artifacts({
      profilePath: '/profile',
      artifactPath: '/result',
      calibrationArtifactPath: '/calibration',
      calibrationMarkers: [
        {
          identity: 'main:123:performance.timeOrigin:100',
          pid: 123,
          clockId: 'node.performance.now',
          timeOrigin: 100
        }
      ],
      windows: [
        {
          repetition: 1,
          mainWindow: {
            clock: {
              clockId: 'node.performance.now',
              identity: 'main:123:performance.timeOrigin:100',
              provenance: 'node-performance-now'
            },
            startedAtMs: 10,
            endedAtMs: 120020
          }
        }
      ],
      fsApi: {
        readFileSync: () => Buffer.from('{}'),
        writeFileSync: (file: string, value: string) => artifacts.set(file, value)
      }
    })
    expect(result.windows[0].reason).toBe('profile_calibration_unqualified')
    expect(result.qualified).toBe(false)
    expect(JSON.parse(artifacts.get('/calibration')!).calibration.qualified).toBe(false)
    expect(result.sourceFailure).toBe('frozen_source_mapping_absent')
  })
  it('refuses same clock name from another runtime PID/time origin', () => {
    const result = collectM5X2Artifacts({
      profilePath: '/profile',
      artifactPath: '/result',
      calibrationMarkers: [{ identity: 'main:123:performance.timeOrigin:100' }],
      windows: [
        {
          mainWindow: {
            clock: {
              clockId: 'node.performance.now',
              identity: 'main:456:performance.timeOrigin:100',
              provenance: 'node-performance-now'
            }
          }
        }
      ],
      fsApi: { readFileSync: () => Buffer.from('{}'), writeFileSync: () => {} }
    })
    expect(result.windows[0].reason).toBe('measured_clock_identity_mismatch')
  })
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
    expect(result.windows[0].reason).toBe('legacy_clock_diagnostic_only')
    expect(JSON.parse(written).windows[0].repetition).toBe(2)
  })
  it('refuses missing exact exemption instrumentation even with an anchor', () => {
    const result = collectM5X2Artifacts({
      profilePath: '/profile',
      artifactPath: '/result',
      windows: [{ mainWindow: { clockKind: 'monotonic', clockId: 'clock', profileAnchor: {} } }],
      fsApi: { readFileSync: () => Buffer.from('{}'), writeFileSync: () => {} }
    })
    expect(result.windows[0].reason).toBe('legacy_clock_diagnostic_only')
  })
})
