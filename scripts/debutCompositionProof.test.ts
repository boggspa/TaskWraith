import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const proofPath = join(process.cwd(), 'docs/debut-composition-proof.md')

describe('debut composition proof record', () => {
  it('keeps the live-hardware closure gate explicit', () => {
    const proof = readFileSync(proofPath, 'utf8')

    expect(proof).toContain('**Record status:** OPEN')
    expect(proof).toContain('on real hardware')
    expect(proof).toContain('The result is **PASS** only when every required row is `PASS`')
    for (const row of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
      expect(proof).toMatch(new RegExp(`^\\| ${row}\\s+\\|`, 'm'))
    }
    expect(proof).toContain('physical device, not only a simulator')
    expect(proof).toContain('TASKWRAITH_REQUIRE_PRODUCTION_SIGNING=1')
  })

  it('records the blocked package preflight without claiming a live pass', () => {
    const proof = readFileSync(proofPath, 'utf8')
    const pendingAttempt = proof.slice(proof.indexOf('### Attempt 1'))

    expect(pendingAttempt).toContain(
      'BLOCKED — production package smoke rejected mixed/unknown distribution identity'
    )
    expect(pendingAttempt).toContain(
      'Packaged app contains an unknown or mixed distribution identity/appId/update feed.'
    )
    expect(pendingAttempt).toMatch(/the operator did not schedule an\s+Ensemble/)
    expect(pendingAttempt).not.toContain('Result | `PASS`')
  })
})
