import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
  RUN_EVIDENCE_VERSION,
  MATRIX_SAMPLING,
  enumerateMatrixCells,
  validateRunEvidence
} = require('./interferenceMatrix.cjs')
const { PROPOSED_CROSS_THREAD_BOUNDS } = require('./perfGateThresholds.cjs')
const {
  PLAN_SCHEMA_VERSION,
  PLAN_KIND,
  PLAN_MODE,
  DEFAULT_DRIVER_REGISTRY,
  requiredCapabilities,
  validateT2MatrixPlan,
  buildT2MatrixPlan,
  runT2MatrixCli
} = require('./runT2Matrix.cjs')

type MatrixPlan = {
  schemaVersion: number
  kind: string
  mode: string
  diagnosticOnly: boolean
  doesNotLaunchElectron: boolean
  executesDrivers: boolean
  measuredEvidence: boolean
  liveExecutionContract: null
  thresholds: {
    status: string
    ratified: boolean
    references: string[]
    values: Record<string, unknown>
  }
  driverCapabilities: Array<{ capability: string }>
  cells: Array<{
    cell: { name: string; chats: number; saturation: string }
    role: string
    capabilities: string[]
    drivers: Array<{ capability: string; configuration: Record<string, unknown> }>
    attribution: {
      lightChatId: string
      populations: Array<{ chatId: string; role: string }>
    }
    plannedWindows: Array<{
      repetition: number
      durationMs: number
      percentiles: string[]
      executed: boolean
    }>
    proposedBoundReferences: string[]
    evidenceV1: {
      descriptor: {
        diagnosticOnly: boolean
        evidence: {
          schemaVersion: number
          status: string
          diagnosticOnly: boolean
          lightChatId: string
          populations: Array<{ chatId: string; role: string }>
          windows: unknown[]
        }
      }
      evidenceEligible: boolean
      evidenceErrors: string[]
      fixtureFingerprintKind: string
    }
  }>
}

function plan(): MatrixPlan {
  return buildT2MatrixPlan() as MatrixPlan
}

describe('T2 interference matrix dry runner', () => {
  it('maps every canonical cell to the landed driver capabilities', () => {
    const value = plan()
    expect(value.schemaVersion).toBe(PLAN_SCHEMA_VERSION)
    expect(value.kind).toBe(PLAN_KIND)
    expect(value.mode).toBe(PLAN_MODE)
    expect(value.cells).toHaveLength(480)
    expect(new Set(value.cells.map((block) => block.cell.name)).size).toBe(480)
    expect(value.driverCapabilities.map((driver) => driver.capability).sort()).toEqual(
      Object.keys(DEFAULT_DRIVER_REGISTRY).sort()
    )

    const counts = { none: 0, ensemble: 0, host: 0 }
    for (const block of value.cells) {
      expect(block.capabilities).toEqual(requiredCapabilities(block.cell))
      expect(block.drivers.map((driver) => driver.capability)).toEqual(block.capabilities)
      const drivers = Object.fromEntries(
        block.drivers.map((driver) => [driver.capability, driver.configuration])
      )
      expect(drivers.concurrent_per_chat_replay_lanes).toMatchObject({
        chats: block.cell.chats,
        windowMs: MATRIX_SAMPLING.windowMs,
        repetitions: MATRIX_SAMPLING.repetitions
      })
      expect(drivers.deterministic_replay_provider).toMatchObject({
        mix: expect.any(String),
        providerFamily: expect.any(String),
        diagnosticOnly: true
      })
      expect(drivers.control_action_replay_events.actions).toHaveLength(4)
      if (block.cell.saturation === 'none') {
        counts.none += 1
        expect(block.capabilities).toHaveLength(3)
      } else if (block.cell.saturation === 'ensemble_pool_30_join') {
        counts.ensemble += 1
        expect(block.capabilities).toContain('ensemble_pool_saturation_driver')
        expect(drivers.ensemble_pool_saturation_driver).toMatchObject({
          poolTarget: 30,
          arrivalCount: 1,
          diagnosticOnly: true
        })
      } else {
        counts.host += 1
        expect(block.capabilities).toContain('host_native_saturation_driver')
        expect(drivers.host_native_saturation_driver).toMatchObject({
          activeTarget: 16,
          queuedTarget: 1,
          requiresPersistProbe: true,
          diagnosticOnly: true
        })
      }
    }
    expect(counts).toEqual({ none: 160, ensemble: 160, host: 160 })
    expect(validateT2MatrixPlan(value)).toEqual([])
  })

  it('is deterministic byte-for-byte for the same source contracts', () => {
    expect(JSON.stringify(plan())).toBe(JSON.stringify(plan()))
  })

  it('emits diagnostic evidence-v1 attribution and planned 120s x 3 windows only', () => {
    const value = plan()
    expect(value.diagnosticOnly).toBe(true)
    expect(value.doesNotLaunchElectron).toBe(true)
    expect(value.executesDrivers).toBe(false)
    expect(value.measuredEvidence).toBe(false)
    expect(value.liveExecutionContract).toBeNull()

    let alone = 0
    let beside = 0
    for (const block of value.cells) {
      const descriptor = block.evidenceV1.descriptor
      expect(descriptor.evidence.schemaVersion).toBe(RUN_EVIDENCE_VERSION)
      expect(descriptor.evidence.windows).toEqual([])
      expect(descriptor.evidence.status).toBe('incomplete')
      expect(descriptor.diagnosticOnly).toBe(true)
      expect(block.evidenceV1.evidenceEligible).toBe(false)
      expect(block.evidenceV1.evidenceErrors).toEqual(validateRunEvidence(descriptor))
      expect(block.evidenceV1.evidenceErrors.length).toBeGreaterThan(0)
      expect(block.attribution.populations).toHaveLength(block.cell.chats)
      expect(block.attribution.populations[0]).toMatchObject({
        role: 'light',
        chatId: block.attribution.lightChatId
      })
      expect(block.attribution.populations.slice(1).every((entry) => entry.role === 'heavy')).toBe(
        true
      )
      expect(block.plannedWindows).toHaveLength(MATRIX_SAMPLING.repetitions)
      expect(
        block.plannedWindows.every(
          (window, repetition) =>
            window.repetition === repetition &&
            window.durationMs === MATRIX_SAMPLING.windowMs &&
            window.executed === false &&
            JSON.stringify(window.percentiles) === JSON.stringify(MATRIX_SAMPLING.percentiles)
        )
      ).toBe(true)
      if (block.role === 'light-alone') alone += 1
      else beside += 1
    }
    expect({ alone, beside }).toEqual({ alone: 120, beside: 360 })
  })

  it('labels every numeric bound proposed and unratified', () => {
    const value = plan()
    const references = Object.keys(PROPOSED_CROSS_THREAD_BOUNDS)
    expect(value.thresholds).toEqual({
      status: 'proposed-unratified',
      ratified: false,
      references,
      values: PROPOSED_CROSS_THREAD_BOUNDS
    })
    expect(
      value.cells.every((block) => block.proposedBoundReferences.join('|') === references.join('|'))
    ).toBe(true)
  })

  it('loads driver contracts without invoking run or dry-run functions', () => {
    const invoked: Array<ReturnType<typeof vi.fn>> = []
    const byModule = new Map(
      Object.values(DEFAULT_DRIVER_REGISTRY).map((descriptor: any) => [
        descriptor.module,
        descriptor
      ])
    )
    const loadDriver = vi.fn((modulePath: string) => {
      const descriptor: any = byModule.get(modulePath)
      const actual = require(modulePath)
      const run = vi.fn(() => {
        throw new Error('run export must not execute while planning')
      })
      const dry = vi.fn(() => {
        throw new Error('dry-run export must not execute while planning')
      })
      invoked.push(run, dry)
      return {
        ...actual,
        [descriptor.runExport]: run,
        [descriptor.dryRunExport]: dry
      }
    })

    const result = runT2MatrixCli(['--dry-run'], { loadDriver })
    expect(result.ok).toBe(true)
    expect(loadDriver).toHaveBeenCalledTimes(Object.keys(DEFAULT_DRIVER_REGISTRY).length)
    for (const spy of invoked) expect(spy).not.toHaveBeenCalled()
  })

  it('fails closed on incomplete cells, missing capabilities, and schema mismatch', () => {
    const cells = enumerateMatrixCells()
    expect(() => buildT2MatrixPlan({ cells: cells.slice(0, -1) })).toThrow(/incomplete/)

    const missing = { ...DEFAULT_DRIVER_REGISTRY }
    delete missing.host_native_saturation_driver
    expect(() => buildT2MatrixPlan({ driverRegistry: missing })).toThrow(
      /missing or invalid driver capability/
    )

    expect(() =>
      buildT2MatrixPlan({
        loadDriver: () => ({})
      })
    ).toThrow(/export mismatch/)

    const invalid = JSON.parse(JSON.stringify(plan())) as MatrixPlan
    invalid.cells[0]!.evidenceV1.descriptor.evidence.schemaVersion = 99
    expect(validateT2MatrixPlan(invalid)).toContain(
      'matrix plan evidence-v1 attribution is not diagnostic for ' + invalid.cells[0]!.cell.name
    )
  })

  it('refuses live, launch, and undeclared modes', () => {
    expect(() => runT2MatrixCli(['--live'])).toThrow(/future isolated runner contract/)
    expect(() => runT2MatrixCli(['--launch'])).toThrow(/future isolated runner contract/)
    expect(() => runT2MatrixCli([])).toThrow(/requires --dry-run/)
    expect(() => runT2MatrixCli(['--dry-run', '--unknown'])).toThrow(/unknown/)
  })
})
