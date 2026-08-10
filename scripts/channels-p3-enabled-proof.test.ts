import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildSync } from 'esbuild'
import { describe, expect, it } from 'vitest'

interface EnabledProofModule {
  ACCEPTANCE_COMMIT: string
  ACCEPTED_CANDIDATE: string
  ENABLE_COMMIT: string
  FLEET_WORKTREE_SOURCE_COMMIT: string
  PACKAGED_FORBIDDEN_MARKERS: Record<string, string[]>
  PACKAGED_REQUIRED_MARKERS: Record<string, string[]>
  PACKAGE_PROVENANCE_COMMIT: string
  parseArgs(argv: string[]): {
    evidencePath: string
    packageInput: string
    candidateInput: string
  }
  runMission(workRoot: string): {
    workerBundleBytes: number
    workerBundleSha256: string
    mission: {
      status: string
      dispatchCount: number
      finalHighWaterSequence: number
      assertionCount: number
      assertions: Record<string, boolean>
    }
  }
  verifyPackagedGroups(
    groups: Record<string, Array<{ path: string; contents: string | Buffer }>>
  ): Record<
    string,
    {
      fileCount: number
      requiredMarkerCount: number
      forbiddenMarkerCount: number
      forbiddenMarkersSha256: string
    }
  >
  verifyProtectedChanges(
    changedFiles: string[],
    rootDiffs?: Record<string, string>
  ): {
    protectedChangeCount: number
    rootDiffCount: number
  }
}

const require = createRequire(import.meta.url)
const proof = require('./channels-p3-enabled-proof.cjs') as EnabledProofModule

describe('Channels P3 enabled proof harness', () => {
  it('requires an exact package and full candidate commit', () => {
    expect(() => proof.parseArgs([])).toThrow('--package')
    expect(() =>
      proof.parseArgs(['--package', '.', '--candidate', proof.ENABLE_COMMIT.slice(0, 12)])
    ).toThrow('full 40-character')
    expect(proof.parseArgs(['--package', '.', '--candidate', proof.ENABLE_COMMIT])).toMatchObject({
      candidateInput: proof.ENABLE_COMMIT
    })
    expect(() =>
      proof.parseArgs(['--package', '.', '--candidate', proof.ENABLE_COMMIT, '--toggle'])
    ).toThrow('unknown argument')
  })

  it('requires accepted enabled package markers and rejects toggles or blocked copy', () => {
    const groups = Object.fromEntries(
      Object.entries(proof.PACKAGED_REQUIRED_MARKERS).map(([group, markers]) => [
        group,
        [{ path: `${group}.js`, contents: markers.join('\n') }]
      ])
    )
    const accepted = proof.verifyPackagedGroups(groups)
    expect(accepted.main.requiredMarkerCount).toBeGreaterThan(5)
    expect(accepted.renderer.requiredMarkerCount).toBe(3)
    expect(accepted.preload.forbiddenMarkerCount).toBeGreaterThan(0)
    expect(accepted.preload.forbiddenMarkersSha256).toMatch(/^[a-f0-9]{64}$/)

    const stale = structuredClone(groups)
    stale.renderer[0].contents += '\nmention dispatch remains disabled pending security review'
    expect(() => proof.verifyPackagedGroups(stale)).toThrow('packaged renderer exposes forbidden')

    const toggle = structuredClone(groups)
    toggle.main[0].contents += '\nchannels:agent:enable'
    expect(() => proof.verifyPackagedGroups(toggle)).toThrow('packaged main exposes forbidden')
  })

  it('allows only the accepted gate/copy/test transition across protected boundaries', () => {
    expect(
      proof.verifyProtectedChanges([
        'src/shared/collaboration/ChannelAgentReviewGate.ts',
        'src/renderer/src/components/ChannelHostPanel.tsx',
        'src/main/run/AgentRunTypes.ts',
        'src/main/SubThreadEphemeralFleet.ts'
      ])
    ).toMatchObject({ protectedChangeCount: 3 })

    expect(() =>
      proof.verifyProtectedChanges(['src/shared/collaboration/ChannelAgentProtocol.ts'])
    ).toThrow('protected review boundary changed')
    expect(() =>
      proof.verifyProtectedChanges([], {
        'src/main/index.ts':
          'diff --git a/src/main/index.ts b/src/main/index.ts\n+enableChannelAgentOverride()\n'
      })
    ).toThrow('composition-root Channel wiring changed')
  })

  it('bundles a worker rooted in the real production service and public proof verifier', () => {
    const source = readFileSync(
      join(process.cwd(), 'scripts', 'channels-p3-enabled-proof-worker.ts'),
      'utf8'
    )
    for (const marker of [
      'createChannelProductionService',
      'resolveChannelAgentGrantAuthority',
      'hooks.finalAuthorization.authorizeBeforeAdapterRun',
      'hooks.observer.onAdapterInvoked',
      'verifyChannelAgentMessageProof',
      'signedPostSurvivedRestart'
    ]) {
      expect(source).toContain(marker)
    }
    expect(source).not.toContain('channelAgentParticipationEnabled: () => true')

    const directory = mkdtempSync(join(tmpdir(), 'taskwraith-channels-p3-enabled-test-'))
    const outfile = join(directory, 'worker.cjs')
    try {
      buildSync({
        entryPoints: [join(process.cwd(), 'scripts', 'channels-p3-enabled-proof-worker.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        external: ['electron'],
        outfile,
        sourcemap: false,
        logLevel: 'silent'
      })
      expect(readFileSync(outfile).byteLength).toBeGreaterThan(100_000)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('pins the reviewed, accepted, and enabled commit chain', () => {
    expect(proof.ACCEPTED_CANDIDATE).toBe('b0f4d84e1fd84e2312f8375dcf7e6fc2d4ee63e4')
    expect(proof.ACCEPTANCE_COMMIT).toBe('92ad1e98259a95377b78c689b586e5e9f8d120d0')
    expect(proof.ENABLE_COMMIT).toBe('191e5e37d6602f8a60e5cf280d416dc342b96492')
    expect(proof.PACKAGE_PROVENANCE_COMMIT).toBe('e0d7d1be4e4e5af1ad0ab8e91ffe65cf26338828')
    expect(proof.FLEET_WORKTREE_SOURCE_COMMIT).toBe('7a2561c47519036e529308b93fbc425303b3c12a')
  })

  it('runs one real production dispatch and verifies its signed post after restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'taskwraith-channels-p3-enabled-mission-'))
    try {
      const result = proof.runMission(directory)
      expect(result.workerBundleBytes).toBeGreaterThan(100_000)
      expect(result.workerBundleSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(result.mission).toMatchObject({
        status: 'passed',
        dispatchCount: 1,
        finalHighWaterSequence: 2,
        assertionCount: 14
      })
      expect(Object.values(result.mission.assertions)).toEqual(Array(14).fill(true))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
