import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
describe('verified T2 capture lifecycle seams', () => {
  it('holds after isolation, before profiles; holds completion before owned cleanup', () => {
    const source = readFileSync(join(__dirname, 'runT2Baseline.cjs'), 'utf8')
    const ready = source.indexOf('await options.onVerifiedCaptureSession(')
    const complete = source.indexOf('await options.onCaptureSessionComplete(')
    expect(ready).toBeGreaterThan(source.indexOf('report.serverInstance = await'))
    expect(ready).toBeLessThan(source.indexOf("setCapturePhase('profiles_start'"))
    expect(complete).toBeGreaterThan(source.indexOf("'capture_complete'"))
    expect(complete).toBeLessThan(source.indexOf('// C: always close sessions'))
  })
})
