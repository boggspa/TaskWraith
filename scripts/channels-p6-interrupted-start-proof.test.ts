import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

interface InterruptedStartProofModule {
  INTERRUPTED_START_STAGE_ORDERS: Record<'membered' | 'empty', string[]>
  INTERRUPTED_START_PERMUTATIONS: Record<'membered' | 'empty', string[][]>
  runInterruptedStartMatrix(workRoot: string): Promise<{
    workerBundleBytes: number
    workerBundleSha256: string
    mission: {
      status: string
      profileKinds: string[]
      stageCounts: Record<'membered' | 'empty', number>
      permutationCounts: Record<'membered' | 'empty', number>
      permutationCount: number
      caseCount: number
      processKillCount: number
      cases: Array<{
        profileKind: 'membered' | 'empty'
        stages: string[]
        kills: Array<{ stage: string; terminationSignal: string }>
        observed: {
          terminalPlanId: string
          memberCount: number
          externalSeatIds: string[] | null
          assertions: Record<string, boolean>
        }
        verified: {
          terminalPlanId: string
          memberCount: number
          externalSeatIds: string[] | null
          assertions: Record<string, boolean>
        }
      }>
      knownEmpty: string[]
      cannotEnumerate: null
      assertionCount: number
      assertions: Record<string, boolean>
    }
  }>
}

const require = createRequire(import.meta.url)
const proof = require('./channels-p6-proof.cjs') as InterruptedStartProofModule

describe('Channels P6 repeated interrupted-start matrix', () => {
  it('covers every adjacent transition in the startup gate order', () => {
    expect(proof.INTERRUPTED_START_STAGE_ORDERS.membered).toEqual([
      'execution_durable',
      'recovery_prepared',
      'channels_applied',
      'cutover_applied',
      'write_gate_quiesced',
      'finalization_execution_durable',
      'recovery_fenced',
      'logs_durable',
      'policies_durable',
      'admission:terminal_escrow_durable',
      'admission:terminal_metadata_durable',
      'admission:superseded_invitations_retired',
      'admissions_durable',
      'legacy_retired',
      'receipt_durable'
    ])
    expect(proof.INTERRUPTED_START_STAGE_ORDERS.empty).toEqual([
      'execution_durable',
      'recovery_prepared',
      'channels_applied',
      'cutover_applied',
      'write_gate_quiesced',
      'finalization_execution_durable',
      'recovery_fenced',
      'logs_durable',
      'policies_durable',
      'admissions_durable',
      'receipt_durable'
    ])
    for (const profileKind of ['membered', 'empty'] as const) {
      const stages = proof.INTERRUPTED_START_STAGE_ORDERS[profileKind]
      expect(proof.INTERRUPTED_START_PERMUTATIONS[profileKind]).toEqual(
        stages.slice(0, -1).map((stage, index) => [stage, stages[index + 1]])
      )
    }
  })

  it('kills every transition twice across membered and empty profiles without collapsing unknown', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'taskwraith-channels-p6-start-matrix-'))
    try {
      const result = await proof.runInterruptedStartMatrix(directory)
      expect(result.workerBundleBytes).toBeGreaterThan(500_000)
      expect(result.workerBundleSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(result.mission).toMatchObject({
        status: 'passed',
        profileKinds: ['membered', 'empty'],
        stageCounts: { membered: 15, empty: 11 },
        permutationCounts: { membered: 14, empty: 10 },
        permutationCount: 24,
        caseCount: 24,
        processKillCount: 48,
        knownEmpty: [],
        cannotEnumerate: null,
        assertionCount: 11
      })
      expect(result.mission.cases).toHaveLength(24)
      expect(result.mission.cases.every((entry) => entry.kills.length === 2)).toBe(true)
      expect(
        result.mission.cases.every(
          (entry) =>
            entry.observed.terminalPlanId === entry.verified.terminalPlanId &&
            entry.observed.memberCount === entry.verified.memberCount &&
            JSON.stringify(entry.observed.externalSeatIds) ===
              JSON.stringify(entry.verified.externalSeatIds)
        )
      ).toBe(true)
      expect(result.mission.assertions).toMatchObject({
        everyTransitionRepeated: true,
        parentKilledEveryInterruptedStart: true,
        memberedMembershipExact: true,
        emptyMembershipExact: true,
        knownEmptyRemainedAnArray: true,
        cannotEnumerateRemainedNull: true,
        blockedStartupConstructedNoAuthority: true,
        terminalAuthorityStableAcrossRelaunch: true,
        noInconsistentStateServed: true
      })
      expect(Object.values(result.mission.assertions)).toEqual(Array(11).fill(true))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 180_000)
})
