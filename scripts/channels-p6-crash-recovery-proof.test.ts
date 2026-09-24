import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

interface CrashRecoveryProofModule {
  parseArgs(argv: string[]): { evidencePath: string }
  runCrashRecoveryMission(workRoot: string): Promise<{
    workerBundleBytes: number
    workerBundleSha256: string
    mission: {
      status: string
      profileKind: string
      crashCount: number
      relaunchCount: number
      boundaryCount: number
      boundaries: Array<{
        boundary: string
        operation: string
        temporaryFileBytes: number
        destinationExistsBeforePublish: boolean
        terminationSignal: string
      }>
      assertionCount: number
      assertions: Record<string, boolean>
    }
  }>
}

const require = createRequire(import.meta.url)
const proof = require('./channels-p6-proof.cjs') as CrashRecoveryProofModule

describe('Channels P6 real-process crash recovery proof', () => {
  it('accepts only the private evidence override', () => {
    expect(proof.parseArgs([]).evidencePath).toContain(
      join('.local-only', 'channels-p6-crash-recovery-evidence.json')
    )
    expect(proof.parseArgs(['--evidence', './evidence.json']).evidencePath).toMatch(
      /evidence\.json$/
    )
    expect(() => proof.parseArgs(['--profile', '/Users/real-profile'])).toThrow('unknown argument')
  })

  it('uses a parent SIGKILL rendezvous inside real fsynced production writes', () => {
    const worker = readFileSync(
      join(process.cwd(), 'scripts', 'channels-p6-proof-worker.ts'),
      'utf8'
    )
    const harness = readFileSync(join(process.cwd(), 'scripts', 'channels-p6-proof.cjs'), 'utf8')

    expect(worker).toContain('beforeDurablePublish: writeWindowInterlock(args)')
    expect(worker).toContain('temporaryFileBytes: statSync(temporary).size')
    expect(worker).toContain('Atomics.wait(')
    expect(harness).toContain("child.kill('SIGKILL')")
    expect(worker).not.toContain('tampered migrated history')
    expect(worker).not.toContain('injected crash')
  })

  it('kills two distinct durable publications, then converges without queue loss or duplicate delivery', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'taskwraith-channels-p6-crash-mission-'))
    try {
      const result = await proof.runCrashRecoveryMission(directory)
      expect(result.workerBundleBytes).toBeGreaterThan(500_000)
      expect(result.workerBundleSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(result.mission).toMatchObject({
        status: 'passed',
        profileKind: 'disposable',
        crashCount: 2,
        relaunchCount: 4,
        boundaryCount: 2,
        assertionCount: 11
      })
      expect(result.mission.boundaries).toMatchObject([
        {
          boundary: 'migration_execution_publish',
          operation: 'link',
          destinationExistsBeforePublish: false
        },
        {
          boundary: 'finalization_execution_publish',
          operation: 'rename',
          destinationExistsBeforePublish: false
        }
      ])
      expect(result.mission.boundaries.every((boundary) => boundary.temporaryFileBytes > 0)).toBe(
        true
      )
      expect(result.mission.assertions).toMatchObject({
        parentIssuedTwoRealProcessKills: true,
        migrationConvergedAfterRelaunch: true,
        realMembershipConverged: true,
        noQueueLoss: true,
        deliveryExactlyOnce: true,
        settlementSurvivedFinalRelaunch: true,
        exactlyOnceSurvivedFinalRelaunch: true
      })
      expect(Object.values(result.mission.assertions)).toEqual(Array(11).fill(true))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 120_000)
})
