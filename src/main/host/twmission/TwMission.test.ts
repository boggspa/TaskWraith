/**
 * Host Arc Wave 5 — `.twmission` scaffold + capture next-slice pins (not AC9 PASS).
 */

import { describe, expect, it } from 'vitest'
import {
  HOST_PROJECTION_VERSION,
  HOST_PROTOCOL_VERSION,
  type HostSnapshot
} from '../../../shared/hostProtocol'
import { captureTwMissionFromHostSnapshot } from './TwMissionHostCapture'
import { exportTwMissionBundle } from './TwMissionExport'
import { importTwMissionBundleBytes } from './TwMissionImport'
import { TW_MISSION_MAX_BUNDLE_BYTES } from './TwMissionTypes'

function minimalSnapshot(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    protocolVersion: HOST_PROTOCOL_VERSION,
    projectionVersion: HOST_PROJECTION_VERSION,
    generatedAt: '2026-08-08T00:00:00.000Z',
    generation: 1,
    cursor: 3,
    freshness: 'live',
    health: {
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: true,
      freshness: 'live'
    },
    workspaces: [],
    threads: [],
    runs: [],
    missions: [],
    rounds: [],
    participants: [],
    providers: [],
    questions: [],
    approvals: [],
    schedules: [],
    usage: { availability: 'unavailable', confidence: 'unknown', band: 'unknown' },
    artifacts: [],
    warnings: [],
    recovery: { reopenStatus: 'clean' },
    ...overrides
  }
}

describe('twmission scaffold', () => {
  it('round-trips export → import as a detached replay', () => {
    const snapshot = minimalSnapshot({
      participants: [
        {
          id: 'p1',
          threadId: 'thread-1',
          providerId: 'codex',
          role: 'Worker',
          order: 0,
          enabled: true,
          active: false
        }
      ]
    })
    const exported = exportTwMissionBundle({
      snapshot,
      cursorRange: { generation: 1, fromCursor: 0, toCursor: 3 },
      exportedAt: '2026-08-08T01:00:00.000Z',
      hostId: 'host-test'
    })
    expect(exported.ok).toBe(true)
    if (!exported.ok) return

    const imported = importTwMissionBundleBytes(exported.bytes)
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(imported.replay.snapshot.participants).toHaveLength(1)
    expect(imported.replay.manifest.integrityDigest).toBe(exported.bundle.manifest.integrityDigest)
    expect(imported.replay.manifest.redaction.transcriptsOmitted).toBe(true)
    expect(imported.replay.manifest.redaction.artifactBodiesOmitted).toBe(true)
  })

  it('is deterministic across a second identical export/import', () => {
    const snapshot = minimalSnapshot()
    const input = {
      snapshot,
      cursorRange: { generation: 2, fromCursor: 1, toCursor: 4 },
      exportedAt: '2026-08-08T02:00:00.000Z'
    }
    const a = exportTwMissionBundle(input)
    const b = exportTwMissionBundle(input)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.bundle.manifest.integrityDigest).toBe(b.bundle.manifest.integrityDigest)
    const ia = importTwMissionBundleBytes(a.bytes)
    const ib = importTwMissionBundleBytes(b.bytes)
    expect(ia.ok && ib.ok).toBe(true)
    if (!ia.ok || !ib.ok) return
    expect(ia.replay.manifest.integrityDigest).toBe(ib.replay.manifest.integrityDigest)
  })

  it('rejects a truncated / tampered integrity digest', () => {
    const exported = exportTwMissionBundle({
      snapshot: minimalSnapshot(),
      cursorRange: { generation: 1, fromCursor: 0, toCursor: 0 },
      exportedAt: '2026-08-08T03:00:00.000Z'
    })
    expect(exported.ok).toBe(true)
    if (!exported.ok) return
    const text = Buffer.from(exported.bytes).toString('utf8')
    const tampered = text.replace(exported.bundle.manifest.integrityDigest, '0'.repeat(64))
    const imported = importTwMissionBundleBytes(new TextEncoder().encode(tampered))
    expect(imported.ok).toBe(false)
    if (imported.ok) return
    expect(imported.error).toMatch(/integrityDigest mismatch/)
  })

  it('rejects oversized bundles', () => {
    const huge = new Uint8Array(TW_MISSION_MAX_BUNDLE_BYTES + 1)
    const imported = importTwMissionBundleBytes(huge)
    expect(imported.ok).toBe(false)
    if (imported.ok) return
    expect(imported.error).toMatch(/size ceiling/)
  })

  it('round-trips redaction notes after filtering empty strings identically', () => {
    const exported = exportTwMissionBundle({
      snapshot: minimalSnapshot(),
      cursorRange: { generation: 1, fromCursor: 0, toCursor: 1 },
      exportedAt: '2026-08-08T05:00:00.000Z',
      redactionNotes: ['kept', '', 'also-kept']
    })
    expect(exported.ok).toBe(true)
    if (!exported.ok) return
    expect(exported.bundle.manifest.redaction.notes).toEqual(['kept', 'also-kept'])
    const imported = importTwMissionBundleBytes(exported.bytes)
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(imported.replay.manifest.integrityDigest).toBe(exported.bundle.manifest.integrityDigest)
    expect(imported.replay.manifest.redaction.notes).toEqual(['kept', 'also-kept'])
  })

  it('rejects unsupported schemaVersion / protocolVersion / projectionVersion', () => {
    const exported = exportTwMissionBundle({
      snapshot: minimalSnapshot(),
      cursorRange: { generation: 1, fromCursor: 0, toCursor: 0 },
      exportedAt: '2026-08-08T06:00:00.000Z'
    })
    expect(exported.ok).toBe(true)
    if (!exported.ok) return
    const raw = JSON.parse(Buffer.from(exported.bytes).toString('utf8')) as {
      manifest: Record<string, unknown>
      snapshot: unknown
    }
    raw.manifest.schemaVersion = 999
    const badSchema = importTwMissionBundleBytes(new TextEncoder().encode(JSON.stringify(raw)))
    expect(badSchema.ok).toBe(false)
    if (!badSchema.ok) expect(badSchema.error).toMatch(/schemaVersion/)

    raw.manifest.schemaVersion = 1
    raw.manifest.protocolVersion = 999
    const badProto = importTwMissionBundleBytes(new TextEncoder().encode(JSON.stringify(raw)))
    expect(badProto.ok).toBe(false)
    if (!badProto.ok) expect(badProto.error).toMatch(/protocolVersion/)

    raw.manifest.protocolVersion = HOST_PROTOCOL_VERSION
    raw.manifest.projectionVersion = 999
    const badProj = importTwMissionBundleBytes(new TextEncoder().encode(JSON.stringify(raw)))
    expect(badProj.ok).toBe(false)
    if (!badProj.ok) expect(badProj.error).toMatch(/projectionVersion/)
  })

  it('never claims live Host mutation — import returns detached replay only', () => {
    const exported = exportTwMissionBundle({
      snapshot: minimalSnapshot(),
      cursorRange: { generation: 1, fromCursor: 0, toCursor: 1 },
      exportedAt: '2026-08-08T04:00:00.000Z'
    })
    expect(exported.ok).toBe(true)
    if (!exported.ok) return
    const imported = importTwMissionBundleBytes(exported.bytes)
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    // Structural pin: only manifest + snapshot — no authority/journal handles.
    expect(Object.keys(imported.replay).sort()).toEqual(['manifest', 'snapshot'])
  })
})

describe('twmission capture next-slice (not AC9 PASS)', () => {
  it('derives cursorRange from live snapshot generation/cursor', () => {
    const snapshot = minimalSnapshot({ generation: 7, cursor: 42 })
    const captured = captureTwMissionFromHostSnapshot({
      snapshot,
      hostId: 'host-live',
      exportedAt: '2026-08-08T07:00:00.000Z'
    })
    expect(captured.ok).toBe(true)
    if (!captured.ok) return
    expect(captured.bundle.manifest.cursorRange).toEqual({
      generation: 7,
      fromCursor: 0,
      toCursor: 42
    })
    expect(captured.bundle.manifest.hostId).toBe('host-live')

    const imported = importTwMissionBundleBytes(captured.bytes)
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(imported.replay.snapshot.generation).toBe(7)
    expect(imported.replay.snapshot.cursor).toBe(42)
    expect(Object.keys(imported.replay).sort()).toEqual(['manifest', 'snapshot'])
  })

  it('strips smuggled schedule prompt fields on capture export (privacy pin)', () => {
    const snapshot = minimalSnapshot({
      schedules: [
        {
          scheduleId: 'sched-1',
          title: 'daily',
          enabled: true,
          // Smuggled body — must not survive decodeHostSnapshot on export.
          prompt: 'SECRET_PROMPT_BODY_NEVER_EXPORT',
          displayPrompt: 'also-secret'
        } as unknown as HostSnapshot['schedules'][number]
      ]
    })
    const captured = captureTwMissionFromHostSnapshot({
      snapshot,
      exportedAt: '2026-08-08T08:00:00.000Z'
    })
    expect(captured.ok).toBe(true)
    if (!captured.ok) return
    const schedule = captured.bundle.snapshot.schedules[0]
    expect(schedule).toBeDefined()
    expect(Object.keys(schedule).sort()).toEqual(['enabled', 'scheduleId', 'title'])
    expect(JSON.stringify(captured.bundle)).not.toContain('SECRET_PROMPT_BODY_NEVER_EXPORT')
    expect(JSON.stringify(captured.bundle)).not.toContain('also-secret')

    const imported = importTwMissionBundleBytes(captured.bytes)
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(JSON.stringify(imported.replay.snapshot.schedules)).not.toContain(
      'SECRET_PROMPT_BODY_NEVER_EXPORT'
    )
  })

  it('rejects capture when snapshot position is invalid', () => {
    const bad = captureTwMissionFromHostSnapshot({
      snapshot: minimalSnapshot({ generation: -1 as unknown as number }),
      exportedAt: '2026-08-08T09:00:00.000Z'
    })
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.error).toMatch(/position invalid/)
  })
})
