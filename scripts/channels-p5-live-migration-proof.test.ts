import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildSync } from 'esbuild'
import { describe, expect, it } from 'vitest'

interface LiveProofModule {
  parseArgs(argv: string[]): { evidencePath: string }
  runMission(workRoot: string): {
    workerBundleBytes: number
    workerBundleSha256: string
    mission: {
      status: string
      profileKind: string
      relaunchCount: number
      assertionCount: number
      assertions: Record<string, boolean>
    }
  }
}

const require = createRequire(import.meta.url)
const proof = require('./channels-p5-live-migration-proof.cjs') as LiveProofModule

describe('Channels P5 disposable-profile live migration proof', () => {
  it('accepts only the private evidence override', () => {
    expect(proof.parseArgs([]).evidencePath).toContain(
      '.local-only/channels-p5-live-migration-evidence.json'
    )
    expect(proof.parseArgs(['--evidence', './evidence.json']).evidencePath).toMatch(
      /evidence\.json$/
    )
    expect(() => proof.parseArgs(['--profile', '/Users/real-profile'])).toThrow('unknown argument')
  })

  it('bundles a worker that owns its disposable profile and real production boundaries', () => {
    const source = readFileSync(
      join(process.cwd(), 'scripts', 'channels-p5-live-migration-proof-worker.ts'),
      'utf8'
    )
    for (const marker of [
      'startPeopleToChannelMigrationBootstrap',
      'PeopleToChannelMigrationFinalizationProductionRunner',
      'ChannelExternalSeatAuthority',
      'ExternalContributionQueueStore',
      'EnsembleOrchestrator',
      'deliverExternalSeatTurns',
      'recoveryBlockedChannelCount'
    ]) {
      expect(source).toContain(marker)
    }
    expect(source).not.toContain("app.getPath('userData')")

    const directory = mkdtempSync(join(tmpdir(), 'taskwraith-channels-p5-live-bundle-'))
    const outfile = join(directory, 'worker.cjs')
    try {
      buildSync({
        entryPoints: [join(process.cwd(), 'scripts', 'channels-p5-live-migration-proof-worker.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        external: ['electron'],
        outfile,
        sourcemap: false,
        logLevel: 'silent'
      })
      expect(readFileSync(outfile).byteLength).toBeGreaterThan(500_000)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('defers a blocked Channel without loss and settles it after multiple relaunches', () => {
    const directory = mkdtempSync(join(tmpdir(), 'taskwraith-channels-p5-live-mission-'))
    try {
      const result = proof.runMission(directory)
      expect(result.workerBundleBytes).toBeGreaterThan(500_000)
      expect(result.workerBundleSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(result.mission).toMatchObject({
        status: 'passed',
        profileKind: 'disposable',
        relaunchCount: 4,
        assertionCount: 12
      })
      expect(result.mission.assertions).toMatchObject({
        corruptChannelRecoveryBlocked: true,
        blockedEnsembleDeliveryDeferred: true,
        queuedEntrySurvivedBlockedRelaunch: true,
        repairedChannelReadyOnHealthyRelaunch: true,
        queuedEntryDeliveredExactlyOnce: true,
        queueSettlementSurvivedFinalRelaunch: true
      })
      expect(Object.values(result.mission.assertions)).toEqual(Array(12).fill(true))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
