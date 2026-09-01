import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  PACKAGE_EMULATOR_SMOKE_ARG,
  PACKAGE_EMULATOR_SMOKE_RESULT_ARG,
  PACKAGE_EMULATOR_SMOKE_RESULT_FILE,
  EXIT_STALE_BUNDLE,
  EXIT_UNSAFE_TO_LAUNCH,
  smokeExitCode,
  validatePackagedEmulatorSmokeResult
}: {
  PACKAGE_EMULATOR_SMOKE_ARG: string
  PACKAGE_EMULATOR_SMOKE_RESULT_ARG: string
  PACKAGE_EMULATOR_SMOKE_RESULT_FILE: string
  EXIT_STALE_BUNDLE: number
  EXIT_UNSAFE_TO_LAUNCH: number
  smokeExitCode: (error: unknown) => number
  validatePackagedEmulatorSmokeResult: (value: unknown) => unknown
} = require('./smoke-packaged-emulator.cjs')

function result() {
  return {
    ok: true,
    receipt: {
      schemaVersion: 1,
      sessionId: 'package-emulator-smoke',
      entryUrl: 'twemu://app/homebrew-demo/index.html',
      resourceReleased: true,
      before: {
        frameId: 12,
        emulationGeneration: 3,
        inputEpoch: 0,
        x: 80,
        y: 72,
        input: 0,
        frameCounter: 12,
        frame: {
          mimeType: 'image/png',
          width: 160,
          height: 144,
          byteLength: 25,
          hash: 'a'.repeat(64)
        }
      },
      after: {
        frameId: 13,
        emulationGeneration: 3,
        inputEpoch: 0,
        x: 81,
        y: 72,
        input: 16,
        frameCounter: 13,
        frame: {
          mimeType: 'image/png',
          width: 160,
          height: 144,
          byteLength: 25,
          hash: 'b'.repeat(64)
        }
      }
    }
  }
}

describe('packaged emulator runtime smoke launcher', () => {
  it('uses a dedicated argv and fixed private receipt filename', () => {
    expect(PACKAGE_EMULATOR_SMOKE_ARG).toBe('--taskwraith-package-emulator-smoke')
    expect(PACKAGE_EMULATOR_SMOKE_RESULT_ARG).toBe('--taskwraith-package-emulator-smoke-result=')
    expect(PACKAGE_EMULATOR_SMOKE_RESULT_FILE).toBe('emulator-package-smoke.json')
  })

  it('preserves stale and unsafe launch classifications as bounded process exits', () => {
    expect(smokeExitCode({ exitCode: EXIT_STALE_BUNDLE })).toBe(EXIT_STALE_BUNDLE)
    expect(smokeExitCode({ exitCode: EXIT_UNSAFE_TO_LAUNCH })).toBe(EXIT_UNSAFE_TO_LAUNCH)
    expect(smokeExitCode({ exitCode: 0 })).toBe(1)
    expect(smokeExitCode({ exitCode: 126 })).toBe(1)
  })

  it('accepts only the safe fixed-factory runtime evidence', () => {
    expect(validatePackagedEmulatorSmokeResult(result())).toMatchObject({
      before: { frameId: 12, x: 80, frameCounter: 12 },
      after: { frameId: 13, x: 81, frameCounter: 13 }
    })
  })

  it('rejects a receipt that did not advance exactly one Right frame', () => {
    const invalid = result()
    invalid.receipt.after.x = 80
    expect(() => validatePackagedEmulatorSmokeResult(invalid)).toThrow(/one bounded Right frame/i)
  })

  it('refuses disk receipts with PNG bytes or raw ABI data', () => {
    const invalid = result()
    Object.assign(invalid.receipt.before.frame, { data: 'base64-pixels' })
    expect(() => validatePackagedEmulatorSmokeResult(invalid)).toThrow(
      /must not persist PNG bytes/i
    )
  })
})
