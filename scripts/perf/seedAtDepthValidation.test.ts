import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ABOVE_THRESHOLD_CONSTRUCTION_SAVES,
  DIAGNOSTIC_GENERATOR_FLAGS,
  INFEASIBLE_CONSTRUCTION_WALK_SAVES,
  PER_SAVE_DESCRIPTIVE_FIELDS,
  PER_SAVE_EQUALITY_FIELDS,
  productionSnapshotByteThresholdSourcePin,
  runSeedAtDepthValidation,
  SEEDED_PREFIX_NOT_COMPARABLE,
  SNAPSHOT_BYTE_THRESHOLD_BYTES,
  UNDER_THRESHOLD_MESSAGE_COUNT
} from './seedAtDepthValidation'

const MEASURE_TIMEOUT_MS = 180_000
const here = dirname(fileURLToPath(import.meta.url))

describe('seed-at-depth validation (A1.49 Ruling 1)', () => {
  // Cheap pins first; the regime measurement is a single named test so the
  // under-threshold control cannot be deleted as an appendix.
  it('pins production SNAPSHOT_BYTE_THRESHOLD at 16 MiB so a silent threshold change reds', () => {
    const src = productionSnapshotByteThresholdSourcePin()
    expect(src).toContain('const SNAPSHOT_BYTE_THRESHOLD = 16 * 1024 * 1024')
    expect(SNAPSHOT_BYTE_THRESHOLD_BYTES).toBe(16 * 1024 * 1024)
    expect(src).toContain('if (state.bytesSinceSnapshot > SNAPSHOT_BYTE_THRESHOLD) return true')
  })

  it('records diagnostic generator flags verbatim, including lean', () => {
    expect(DIAGNOSTIC_GENERATOR_FLAGS).toEqual({
      workload: 'large_history',
      seed: 42,
      lean: true,
      scaleDown: 1
    })
    expect(Object.keys(DIAGNOSTIC_GENERATOR_FLAGS).sort()).toEqual([
      'lean',
      'scaleDown',
      'seed',
      'workload'
    ])
    expect(DIAGNOSTIC_GENERATOR_FLAGS.lean).toBe(true)
  })

  it('bans bytesWritten from per-save equality and cumulative citation from the seeded path', () => {
    expect(PER_SAVE_EQUALITY_FIELDS).toEqual(['appends', 'linesWritten', 'snapshotsWritten'])
    expect(PER_SAVE_EQUALITY_FIELDS).not.toContain('bytesWritten')
    expect(PER_SAVE_DESCRIPTIVE_FIELDS).toEqual(['bytesWritten'])
    expect(SEEDED_PREFIX_NOT_COMPARABLE).toBe('seeded_prefix_not_comparable')
    expect(INFEASIBLE_CONSTRUCTION_WALK_SAVES).toBe(27_000)
  })

  it('does not import the fenced matrix module', () => {
    const harness = readFileSync(join(here, 'seedAtDepthValidation.ts'), 'utf8')
    expect(harness.includes('interference' + 'Matrix')).toBe(false)
  })

  it(
    'per-save ChatJournal match is conditional on SNAPSHOT_BYTE_THRESHOLD, not universal',
    () => {
      const report = runSeedAtDepthValidation()

      expect(report.generatorFlags).toEqual({
        workload: 'large_history',
        seed: 42,
        lean: true,
        scaleDown: 1
      })
      expect(report.generatorFlags.lean).toBe(true)
      expect(report.evidentiaryLaunchMustBeNonLean).toBe(true)
      expect(report.fixtureGeneratorVersion).toBe(4)
      expect(report.snapshotByteThresholdBytes).toBe(SNAPSHOT_BYTE_THRESHOLD_BYTES)

      const above = report.aboveThreshold
      expect(above.exceedsSnapshotByteThreshold).toBe(true)
      expect(above.recordBytes).toBeGreaterThan(SNAPSHOT_BYTE_THRESHOLD_BYTES)
      expect(above.messages).toBe(27_001)
      expect(above.accumulatedRuns).toBe(10_000)
      expect(above.linkedRoundIds).toBe(1_000)
      expect(above.activeRuns).toBe(2)
      expect(above.construction.saves).toBe(ABOVE_THRESHOLD_CONSTRUCTION_SAVES)
      expect(above.construction.lastSaveDelta).toMatchObject({
        appends: 1,
        linesWritten: 1,
        snapshotsWritten: 1
      })
      expect(above.seededTail.lastSaveDelta).toMatchObject({
        appends: 1,
        linesWritten: 1,
        snapshotsWritten: 1
      })
      expect(above.perSaveLastEqual).toBe(true)
      expect(above.construction.cumulative.appends).toBe(3)
      expect(above.construction.cumulative.linesWritten).toBe(3)
      expect(above.construction.cumulative.snapshotsWritten).toBe(3)
      expect(above.seededTail.cumulative).toBe(SEEDED_PREFIX_NOT_COMPARABLE)
      expect(typeof above.seededTail.cumulative).toBe('string')
      expect(above.seededTail.lastSaveDelta.bytesWritten).toBeGreaterThan(
        above.construction.lastSaveDelta.bytesWritten
      )
      expect(above.seededTail.lastSaveDelta.bytesWritten).not.toBe(
        above.construction.lastSaveDelta.bytesWritten
      )

      const below = report.belowThreshold
      expect(below).toBeDefined()
      expect(below.exceedsSnapshotByteThreshold).toBe(false)
      expect(below.recordBytes).toBeLessThan(SNAPSHOT_BYTE_THRESHOLD_BYTES)
      expect(below.messages).toBe(UNDER_THRESHOLD_MESSAGE_COUNT)
      expect(below.accumulatedRuns).toBe(10_000)
      expect(below.linkedRoundIds).toBe(1_000)
      expect(below.activeRuns).toBe(2)
      expect(below.construction.saves).toBeGreaterThan(2)
      expect(below.construction.saves * below.journalLineBytes).toBeGreaterThan(
        SNAPSHOT_BYTE_THRESHOLD_BYTES
      )
      expect((below.construction.saves - 1) * below.journalLineBytes).toBeLessThanOrEqual(
        SNAPSHOT_BYTE_THRESHOLD_BYTES
      )
      expect(2 * below.journalLineBytes).toBeLessThanOrEqual(SNAPSHOT_BYTE_THRESHOLD_BYTES)
      expect(below.construction.cumulative.appends).toBe(below.construction.saves)
      expect(below.construction.cumulative.linesWritten).toBe(below.construction.saves)
      expect(below.construction.cumulative.snapshotsWritten).toBe(1)
      expect(below.seededTail.lastSaveDelta).toMatchObject({
        appends: 1,
        linesWritten: 1,
        snapshotsWritten: 0
      })
      expect(below.perSaveLastEqual).toBe(false)
      expect(below.seededTail.cumulative).toBe(SEEDED_PREFIX_NOT_COMPARABLE)
      expect(above.perSaveLastEqual).not.toBe(below.perSaveLastEqual)

      const barrier = report.persistBarrier
      expect(barrier.checkpointsWritten).toBe(1)
      expect(barrier.checkpointBytes).toBeGreaterThan(SNAPSHOT_BYTE_THRESHOLD_BYTES)
      expect(barrier.checkpointRuns).toBe(10_000)
      expect(barrier.checkpointLinkedRoundIds).toBe(1_000)
      expect(barrier.checkpointActiveRuns).toBe(2)
      expect(new Set(barrier.tailOperationTypes)).toEqual(
        new Set(['messages_splice', 'record_patch'])
      )
      expect(barrier.tailOperationTypes).toHaveLength(2)
      expect(barrier.tailOperationTypes).not.toContain('runs_splice')
      expect(barrier.tailOperationTypes).not.toContain('run_put')
      expect(barrier.mutationBytesWritten).toBeLessThan(1024)
      expect(barrier.mutationBytesWritten * 1000).toBeLessThan(barrier.checkpointBytes)
    },
    MEASURE_TIMEOUT_MS
  )
})
