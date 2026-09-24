import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { HOST_REGISTRY_ROOT_ENV as PRODUCT_HOST_REGISTRY_ROOT_ENV } from '../src/host-runtime/HostRegistry'

const require = createRequire(import.meta.url)
const {
  PACKAGE_EMULATOR_SMOKE_ARG,
  PACKAGE_EMULATOR_SMOKE_RESULT_ARG,
  PACKAGE_EMULATOR_SMOKE_RESULT_FILE,
  EXIT_STALE_BUNDLE,
  EXIT_UNSAFE_TO_LAUNCH,
  HOST_REGISTRY_ROOT_ENV,
  launchPackagedApp,
  packagedAppEnvironment,
  smokeExitCode,
  validatePackagedEmulatorSmokeResult
}: {
  PACKAGE_EMULATOR_SMOKE_ARG: string
  PACKAGE_EMULATOR_SMOKE_RESULT_ARG: string
  PACKAGE_EMULATOR_SMOKE_RESULT_FILE: string
  EXIT_STALE_BUNDLE: number
  EXIT_UNSAFE_TO_LAUNCH: number
  HOST_REGISTRY_ROOT_ENV: string
  launchPackagedApp: (
    packageRoot: string,
    launchArgs: readonly string[],
    registryRoot: string,
    spawnProcess: (
      file: string,
      args: readonly string[],
      options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv }
    ) => unknown
  ) => unknown
  packagedAppEnvironment: (registryRoot: unknown, env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv
  smokeExitCode: (error: unknown) => number
  validatePackagedEmulatorSmokeResult: (value: unknown, output?: string) => unknown
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
  it("gives the packaged app the smoke's own Host registry root, over any inherited one", () => {
    expect(HOST_REGISTRY_ROOT_ENV).toBe(PRODUCT_HOST_REGISTRY_ROOT_ENV)
    const registryRoot = join(tmpdir(), 'taskwraith-emulator-smoke-registry-x')
    const env = packagedAppEnvironment(registryRoot, {
      PATH: '/usr/bin',
      TASKWRAITH_AUTO_UPDATE: 'on',
      [HOST_REGISTRY_ROOT_ENV]: '/somewhere/else'
    })
    expect(env).toEqual({
      PATH: '/usr/bin',
      TASKWRAITH_AUTO_UPDATE: 'off',
      [HOST_REGISTRY_ROOT_ENV]: registryRoot
    })
    for (const bad of [undefined, '', 'relative/hosts']) {
      expect(() => packagedAppEnvironment(bad, {})).toThrow(/registry root must be absolute/)
    }
  })

  it('launches the packaged executable with that environment (a recorded spawn, nothing runs)', () => {
    const packageRoot = realpathSync(mkdtempSync(join(tmpdir(), 'emulator-smoke-package-')))
    try {
      // The executable names each platform's resolver looks for first; a
      // package root that is not an .app bundle takes the linux shape on darwin.
      writeFileSync(join(packageRoot, 'taskwraith'), '')
      writeFileSync(join(packageRoot, 'TaskWraith.exe'), '')
      const registryRoot = join(packageRoot, 'registry')
      const calls: Array<{
        file: string
        args: readonly string[]
        options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv }
      }> = []
      launchPackagedApp(packageRoot, ['--smoke'], registryRoot, (file, args, options) => {
        calls.push({ file, args, options })
        return {}
      })
      expect(calls).toHaveLength(1)
      expect(calls[0].file.startsWith(packageRoot)).toBe(true)
      expect(calls[0].args).toContain('--smoke')
      expect(calls[0].options.cwd).toBe(packageRoot)
      expect(calls[0].options.env[HOST_REGISTRY_ROOT_ENV]).toBe(registryRoot)
      expect(calls[0].options.env.TASKWRAITH_AUTO_UPDATE).toBe('off')
      expect(() => launchPackagedApp(packageRoot, [], 'relative', () => ({}))).toThrow(
        /registry root must be absolute/
      )
    } finally {
      rmSync(packageRoot, { recursive: true, force: true })
    }
  })

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

  it('appends bounded captured child output when the envelope reports a failure', () => {
    const failure = { ok: false, error: 'emulator_smoke_failed' }
    expect(() =>
      validatePackagedEmulatorSmokeResult(
        failure,
        '[emulator-smoke] phase=observe: adapter missing\n'
      )
    ).toThrow(/^Packaged emulator smoke did not report success: emulator_smoke_failed/)
    expect(() =>
      validatePackagedEmulatorSmokeResult(failure, 'stderr-line-one\nstderr-line-two')
    ).toThrow(/stderr-line-two/)
  })

  it('caps captured child output at the bounded diagnostic window', () => {
    const failure = { ok: false, error: 'emulator_smoke_failed' }
    let message = ''
    try {
      validatePackagedEmulatorSmokeResult(failure, 'x'.repeat(9000))
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('x'.repeat(100))
    expect(message).not.toContain('x'.repeat(5000))
  })
})
