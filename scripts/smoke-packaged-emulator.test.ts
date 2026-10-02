import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
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
  persistSmokeEvidence,
  stopSmokeChild,
  finalizeSmokeCleanup,
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
  persistSmokeEvidence: (root: string, raw: unknown) => string
  stopSmokeChild: (child: unknown, wait?: () => Promise<boolean>) => Promise<void>
  finalizeSmokeCleanup: (
    input: Record<string, unknown>,
    stop?: () => Promise<void>,
    remove?: typeof rmSync
  ) => Promise<void>
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
  it.each([0, 1])(
    'retains removal failures and remaining roots after %i removals',
    async (successful) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'emulator-rm-failure-')))
      const home = join(root, 'home')
      const registry = join(root, 'registry')
      const primary = new Error('primary smoke failure')
      const removal = new Error('root removal failed')
      mkdirSync(home)
      mkdirSync(registry)
      let calls = 0
      try {
        await expect(
          finalizeSmokeCleanup(
            {
              child: null,
              smokeUserDataPath: home,
              registryRoot: registry,
              evidenceRoot: root,
              primaryError: primary
            },
            async () => {},
            (target, options) => {
              if (calls++ >= successful) throw removal
              rmSync(target, options)
            }
          )
        ).rejects.toMatchObject({
          errors: successful === 0 ? [primary, removal, removal] : [primary, removal]
        })
        expect(existsSync(home)).toBe(successful === 0)
        expect(existsSync(registry)).toBe(true)
        expect(JSON.parse(readFileSync(join(root, 'cleanup-failure.json'), 'utf8'))).toMatchObject({
          primaryFailurePresent: true,
          rootsRemaining: { userData: successful === 0, registry: true }
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it('rejects a stubborn child after both termination waits fail', async () => {
    const signals: string[] = []
    const child = {
      exitCode: null,
      signalCode: null,
      kill: (signal: string) => signals.push(signal)
    }
    await expect(stopSmokeChild(child, async () => false)).rejects.toThrow(
      /termination.*unconfirmed/i
    )
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('preserves roots and both failures when final cleanup cannot confirm termination', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'emulator-cleanup-')))
    const home = join(root, 'home')
    const registry = join(root, 'registry')
    const primary = new Error('original smoke failure')
    mkdirSync(home)
    mkdirSync(registry)
    try {
      await expect(
        finalizeSmokeCleanup(
          {
            child: {},
            smokeUserDataPath: home,
            registryRoot: registry,
            evidenceRoot: root,
            primaryError: primary
          },
          async () => {
            throw new Error('termination unconfirmed')
          }
        )
      ).rejects.toMatchObject({
        errors: [primary, expect.any(Error)]
      })
      expect(existsSync(home)).toBe(true)
      expect(existsSync(registry)).toBe(true)
      expect(JSON.parse(readFileSync(join(root, 'cleanup-failure.json'), 'utf8'))).toMatchObject({
        ok: false,
        rootsPreserved: true,
        primaryFailurePresent: true
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('replaces inherited home directories with a disposable home inside the private registry', () => {
    const registry = join(tmpdir(), 'emulator-private-registry')
    const env = packagedAppEnvironment(registry, {
      HOME: '/real/home',
      CFFIXED_USER_HOME: '/real/corefoundation/home'
    })
    expect(env.HOME).toBe(join(registry, 'home'))
    expect(env.CFFIXED_USER_HOME).toBe(env.HOME)
  })

  it('retains the bounded raw receipt after disposable launch roots are removed', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'emulator-evidence-')))
    const raw = result()
    try {
      const disposable = join(root, 'launch-profile')
      mkdirSync(disposable)
      writeFileSync(join(disposable, 'receipt.json'), JSON.stringify(raw))
      const target = persistSmokeEvidence(join(root, 'evidence'), raw)
      rmSync(disposable, { recursive: true })
      expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(raw)
      expect(() => persistSmokeEvidence(join(root, 'evidence'), raw)).toThrow()
      const unsafe = result()
      Object.assign(unsafe.receipt.after, { ram: 'private-memory' })
      expect(() => persistSmokeEvidence(join(root, 'unsafe'), unsafe)).toThrow(/unexpected/i)
      expect(existsSync(join(root, 'unsafe'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('retains fixed failure receipts and safe failed observations without accepting arbitrary payloads', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'emulator-failure-evidence-')))
    try {
      const failure = { ok: false, error: 'emulator_smoke_failed' }
      const target = persistSmokeEvidence(join(root, 'failed'), failure)
      expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(failure)
      const wrongStep = result()
      wrongStep.receipt.after.x = 80
      const wrongTarget = persistSmokeEvidence(join(root, 'wrong-step'), wrongStep)
      expect(JSON.parse(readFileSync(wrongTarget, 'utf8'))).toEqual(wrongStep)
      expect(() => validatePackagedEmulatorSmokeResult(wrongStep)).toThrow(/Right frame/)
      expect(() =>
        persistSmokeEvidence(join(root, 'arbitrary'), { ok: false, error: 'raw RAM' })
      ).toThrow()
      const pixels = result()
      Object.assign(pixels.receipt.before.frame, { data: 'pixels' })
      expect(() => persistSmokeEvidence(join(root, 'pixels'), pixels)).toThrow()
      const extra = result()
      Object.assign(extra, { data: 'x'.repeat(20_000) })
      expect(() => persistSmokeEvidence(join(root, 'oversize'), extra)).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

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
      HOME: join(registryRoot, 'home'),
      CFFIXED_USER_HOME: join(registryRoot, 'home'),
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
      if (process.platform === 'darwin') {
        expect(calls[0].args).toContain('--use-mock-keychain')
      }
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
