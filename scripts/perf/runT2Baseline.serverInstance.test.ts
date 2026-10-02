import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { runT2BaselineCli } = require('./runT2Baseline.cjs')

describe('T2 server-instance evidence binding', () => {
  it('collects after isolation proof and before profiles and live windows', () => {
    const source = readFileSync(path.join(__dirname, 'runT2Baseline.cjs'), 'utf8')
    const identity = source.indexOf('report.serverInstance = await collectServerInstanceEvidence(')
    expect(identity).toBeGreaterThan(
      source.indexOf(
        'report.isolation = isolationVerification',
        source.indexOf("setCapturePhase('isolation_verify'")
      )
    )
    expect(identity).toBeLessThan(source.indexOf("setCapturePhase('profiles_start'"))
    expect(identity).toBeLessThan(source.indexOf("setCapturePhase('live_rounds'"))
    expect(source.slice(identity, identity + 600)).toContain(
      'isolationVerification.observedUserDataPath'
    )
  })

  it('does not manufacture authenticated identity on dry runs', async () => {
    const artifactDir = mkdtempSync(path.join(tmpdir(), 'gh-runner-'))
    try {
      const result = await runT2BaselineCli(
        [
          '--dry-run',
          '--workload=dual_run',
          '--lean',
          '--scale-down=40',
          `--artifact-dir=${artifactDir}`
        ],
        {
          repoRoot: path.resolve(__dirname, '..', '..'),
          provenance: {
            gitSha: 'a'.repeat(40),
            dirty: false,
            dirtyTreeFingerprint: 'b'.repeat(64),
            dirtyPaths: [],
            isolatedWorktree: true,
            authoritativeBaseline: true
          }
        }
      )
      expect(result.report.serverInstance).toBeNull()
    } finally {
      rmSync(artifactDir, { recursive: true, force: true })
    }
  })
})
