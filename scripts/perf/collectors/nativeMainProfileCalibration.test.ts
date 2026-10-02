import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const { calibrateMainProfile } = require('./mainProfileCalibration.cjs')

it('retains a genuine inspector profile and qualifies only observed marker bounds', async () => {
  const outputRoot = mkdtempSync(path.join(tmpdir(), 'native-calibration-test-'))
  try {
    const entry = require.resolve('./nativeMainProfileCalibration.cjs')
    const receipt = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '-e',
          'const {qualifyNativeMainProfile}=require(process.argv[1]);qualifyNativeMainProfile({outputRoot:process.argv[2]}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e);process.exitCode=1})',
          entry,
          outputRoot
        ],
        { encoding: 'utf8', timeout: 10000 }
      )
    )
    const profile = JSON.parse(
      readFileSync(path.join(receipt.directory, 'main.cpuprofile'), 'utf8')
    )
    expect(profile.samples.length).toBeGreaterThan(0)
    if (!receipt.calibration.qualified) {
      expect(receipt.calibration.reasons.length).toBeGreaterThan(0)
      expect(receipt.calibration.reasons).toEqual(expect.arrayContaining([expect.any(String)]))
      return
    }
    expect(receipt.calibration.exact).toBe(false)
    expect(receipt.calibration.markerExclusions).toHaveLength(2)
    const markers = receipt.calibration.markers
    expect(
      calibrateMainProfile(
        profile,
        markers.map((marker: object) => ({ ...marker, tag: 'missing' }))
      ).qualified
    ).toBe(false)
    expect(
      calibrateMainProfile(profile, [
        markers[0],
        { ...markers[1], afterMs: markers[1].afterMs + 100 }
      ]).qualified
    ).toBe(false)
  } finally {
    // Preserve native evidence even when platform sampling refuses qualification.
  }
})
