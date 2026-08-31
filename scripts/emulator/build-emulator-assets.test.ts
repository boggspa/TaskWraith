import { createRequire } from 'node:module'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

type BuildReceipt = {
  source: {
    fixture: {
      abi: {
        inputReady: {
          frameCounter: { minimumExclusive: number }
          lastInput: number
          magic: string
          schemaVersion: number
          status: string
        }
        state: { frameCounter: string }
      }
      rom: { byteLength: number; sha256: string }
    }
  }
  pins: {
    emscripten: { emscriptenSourceCommit: string }
    shippedCore: { commit: string; version: string }
  }
  validationOnly: {
    sameboy: { commit: string; version: string }
  }
  expectedBrowserArtifacts: {
    wasm: { sha256: string }
  }
}

type SpawnResult = {
  error?: Error
  status: number | null
  stderr?: string
  stdout?: string
}

type SpawnAdapter = {
  spawnSync: (command: string, args: string[], options?: unknown) => SpawnResult
}

type MutableReceipt = {
  pins: {
    emscripten: {
      emsdkCommit: string
      emscriptenSourceCommit: string
    }
    rgbds: {
      executables: Record<string, string>
    }
  }
}

const driver = require('./build-emulator-assets.cjs') as {
  assertSafeOutputDirectory: (output: string, root?: string) => string
  buildPlan: (
    input: {
      sameboyRoot: string
      emscriptenRoot: string
      emcc: string
      emmake: string
      rgbdsBin: string
      outputDirectory: string
    },
    root?: string
  ) => { coreMakeArguments: string[]; hostLinkArguments: string[] }
  localSharedCloneArguments: (sameboyRoot: string, coreRoot: string) => string[]
  runLocalBuild: (
    input: {
      emConfig?: string
      sameboyRoot: string
      emscriptenRoot: string
      emcc: string
      emmake: string
      rgbdsBin: string
      outputDirectory: string
      sourceRoot?: string
    },
    adapters?: SpawnAdapter
  ) => unknown
  readBuildReceipt: (root?: string) => BuildReceipt
  verifySourceInputs: (root?: string) => BuildReceipt
  verifyEmscriptenCheckout: (
    input: { emscriptenRoot: string; emcc: string; emmake: string },
    receipt: BuildReceipt,
    adapters?: SpawnAdapter
  ) => unknown
}

const temporaryRoots: string[] = []

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `taskwraith-emulator-${label}-`))
  temporaryRoots.push(root)
  return root
}

function copiedSourceRoot(): string {
  const root = temporaryRoot('source')
  const source = join(process.cwd(), 'scripts', 'emulator')
  const target = join(root, 'emulator')
  cpSync(source, target, { recursive: true })
  return target
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function placeholderFile(directory: string, name: string): string {
  const destination = join(directory, name)
  writeFileSync(destination, 'test placeholder\n')
  return destination
}

function updateReceipt(sourceRoot: string, mutate: (receipt: MutableReceipt) => void): void {
  const receiptPath = join(sourceRoot, 'build-receipt.json')
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as unknown as MutableReceipt
  mutate(receipt)
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('emulator source/build receipt', () => {
  it('pins the shipped core separately from the validation-only SameBoy checkout', () => {
    const receipt = driver.readBuildReceipt()
    expect(receipt.pins.shippedCore).toMatchObject({
      commit: 'aa158a889a48b538a0302873704a34577c8eb67d',
      version: '0.15.4'
    })
    expect(receipt.validationOnly.sameboy).toMatchObject({
      commit: '208ba4afabffab9edde416f2dbb8ae459e34adb8',
      version: '1.0.3'
    })
    expect(receipt.source.fixture.rom).toMatchObject({
      byteLength: 32768,
      sha256: '2175c6b758fdd76e4e878ccf10ee04f50135be74226f548df78dff4fea5806c7'
    })
    expect(receipt.source.fixture.abi.state.frameCounter).toBe('0xC109:u32le')
    expect(receipt.source.fixture.abi.inputReady).toEqual({
      magic: 'TWGB',
      schemaVersion: 1,
      status: '0x03',
      lastInput: 0,
      frameCounter: { minimumExclusive: 0 }
    })
  })

  it('verifies the reviewed host, fixture source, licenses, and u32le ABI offline', () => {
    const receipt = driver.verifySourceInputs()
    expect(receipt.expectedBrowserArtifacts.wasm.sha256).toBe(
      'b39d5364ad374d365ae1e3b5ef142b990a5a159713a2a26be379ae9c86dededf'
    )
    expect(
      existsSync(join(process.cwd(), 'scripts', 'emulator', 'fixture', 'taskwraith-fixture.gb'))
    ).toBe(false)

    const host = readFileSync(join(process.cwd(), 'scripts', 'emulator', 'twemu_host.c'), 'utf8')
    expect(host).toContain('TWEMU_ROM_PATH must name the reviewed embedded ROM path')
    expect(host).toContain('TWEMU_MAX_ROM_BYTES')
    expect(host).toContain('pitch < width * sizeof(uint32_t)')
    expect(host).toContain('if (!twemu_initialized) return 0;')
    expect(host).toContain('frames != 1')
  })

  it('fails closed when a source input drifts', () => {
    const sourceRoot = copiedSourceRoot()
    const source = join(sourceRoot, 'fixture', 'src', 'main.asm')
    writeFileSync(source, `${readFileSync(source, 'utf8')}\n; drift\n`)
    expect(() => driver.verifySourceInputs(sourceRoot)).toThrow(/source input hash mismatch/)
  })

  it('hard-pins both Emsdk and Emscripten source commits', () => {
    const sourceRoot = copiedSourceRoot()
    updateReceipt(sourceRoot, (receipt) => {
      receipt.pins.emscripten.emsdkCommit = '0'.repeat(40)
    })
    expect(() => driver.readBuildReceipt(sourceRoot)).toThrow(/Emsdk source commit drifted/)
  })

  it('requires an explicit RGBDS directory without pretending a bundled toolchain exists', () => {
    const makefile = readFileSync(
      join(process.cwd(), 'scripts', 'emulator', 'fixture', 'Makefile'),
      'utf8'
    )
    expect(makefile).toContain('ifndef RGBDS')
    expect(makefile).toContain('RGBDS must name the directory')
    expect(makefile).not.toContain('RGBDS ?= ./toolchain')
  })

  it('rejects an RGBDS binary hash before executing its otherwise valid version command', () => {
    const root = temporaryRoot('wrong-rgbds-hash')
    const rgbds = join(root, 'rgbds')
    const sameboy = join(root, 'sameboy')
    const emscripten = join(root, 'emscripten')
    const output = temporaryRoot('wrong-rgbds-version-output')
    mkdirSync(rgbds)
    mkdirSync(sameboy)
    mkdirSync(emscripten)
    placeholderFile(rgbds, 'rgbasm')
    placeholderFile(rgbds, 'rgblink')
    placeholderFile(rgbds, 'rgbfix')
    const emcc = placeholderFile(emscripten, 'emcc')
    const emmake = placeholderFile(emscripten, 'emmake')
    const calls: string[] = []

    expect(() =>
      driver.runLocalBuild(
        {
          sameboyRoot: sameboy,
          emscriptenRoot: emscripten,
          emcc,
          emmake,
          rgbdsBin: rgbds,
          outputDirectory: output
        },
        {
          spawnSync(command: string): SpawnResult {
            calls.push(command)
            return { status: 0, stdout: 'rgbasm v1.0.3\n' }
          }
        }
      )
    ).toThrow(/RGBASM SHA-256 mismatch/)
    expect(calls).toEqual([])
  })

  it('rejects a wrong RGBDS version through an injected local process seam', () => {
    const sourceRoot = copiedSourceRoot()
    const root = temporaryRoot('wrong-rgbds-version')
    const rgbds = join(root, 'rgbds')
    const sameboy = join(root, 'sameboy')
    const emscripten = join(root, 'emscripten')
    const output = temporaryRoot('wrong-rgbds-version-output')
    mkdirSync(rgbds)
    mkdirSync(sameboy)
    mkdirSync(emscripten)
    const rgbasm = placeholderFile(rgbds, 'rgbasm')
    const rgblink = placeholderFile(rgbds, 'rgblink')
    const rgbfix = placeholderFile(rgbds, 'rgbfix')
    const emcc = placeholderFile(emscripten, 'emcc')
    const emmake = placeholderFile(emscripten, 'emmake')
    updateReceipt(sourceRoot, (receipt) => {
      receipt.pins.rgbds.executables = {
        rgbasm: sha256File(rgbasm),
        rgblink: sha256File(rgblink),
        rgbfix: sha256File(rgbfix)
      }
    })

    expect(() =>
      driver.runLocalBuild(
        {
          sourceRoot,
          sameboyRoot: sameboy,
          emscriptenRoot: emscripten,
          emcc,
          emmake,
          rgbdsBin: rgbds,
          outputDirectory: output
        },
        {
          spawnSync(): SpawnResult {
            return { status: 0, stdout: 'rgbasm v0.0.0\n' }
          }
        }
      )
    ).toThrow(/RGBASM version mismatch/)
  })

  it('refuses an Emscripten checkout that is not the pinned source commit before running emcc', () => {
    const root = temporaryRoot('wrong-emscripten')
    const emscripten = join(root, 'emscripten')
    mkdirSync(emscripten)
    const emcc = placeholderFile(emscripten, 'emcc')
    const emmake = placeholderFile(emscripten, 'emmake')
    const receipt = driver.readBuildReceipt()
    const calls: string[] = []
    expect(() =>
      driver.verifyEmscriptenCheckout({ emscriptenRoot: emscripten, emcc, emmake }, receipt, {
        spawnSync(command: string, args: string[]): SpawnResult {
          calls.push(`${command} ${args.join(' ')}`)
          return { status: 0, stdout: 'not-the-recorded-commit\n' }
        }
      })
    ).toThrow(/not the recorded Emscripten source commit/)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatch(/git -C .*\/emscripten rev-parse HEAD/)
  })

  it('requires an empty external output directory and retains the exact core/link plan', () => {
    expect(() =>
      driver.assertSafeOutputDirectory(join(process.cwd(), 'scripts', 'emulator', 'out'))
    ).toThrow(/outside this repository/)

    const root = temporaryRoot('plan')
    const output = join(root, 'output')
    const plan = driver.buildPlan({
      sameboyRoot: join(root, 'sameboy'),
      emscriptenRoot: join(root, 'emscripten'),
      emcc: join(root, 'emcc'),
      emmake: join(root, 'emmake'),
      rgbdsBin: join(root, 'rgbds'),
      outputDirectory: output
    })
    expect(plan.coreMakeArguments).toEqual([
      '-f',
      'Makefile',
      'platform=emscripten',
      'SHARED=-shared'
    ])
    expect(plan.hostLinkArguments).toContain('-sDYNAMIC_EXECUTION=0')
    expect(plan.hostLinkArguments).toContain(
      '-sEXPORTED_FUNCTIONS=["_main","_twemu_initialize","_twemu_step","_twemu_shutdown","_twemu_framebuffer_ptr","_twemu_framebuffer_width","_twemu_framebuffer_height","_twemu_frames_presented","_twemu_system_ram_ptr","_twemu_system_ram_size"]'
    )
    expect(plan.hostLinkArguments).toContain('-DTWEMU_ROM_PATH="/roms/taskwraith-fixture.gb"')
  })

  it('has no network/bootstrap installer path: only a local shared Git clone may be used', () => {
    const source = readFileSync(
      join(process.cwd(), 'scripts', 'emulator', 'build-emulator-assets.cjs'),
      'utf8'
    )
    expect(source).not.toMatch(/https?:\/\//)
    expect(source).not.toMatch(/\b(?:curl|wget|npm)\b/)
    expect(source).not.toMatch(/\bfetch\s*\(/)
    expect(source).not.toMatch(/\bworktree\b/)
    const sameboyRoot = temporaryRoot('clone-source')
    const coreRoot = join(temporaryRoot('clone-destination'), 'sameboy')
    const clonePlan = driver.localSharedCloneArguments(sameboyRoot, coreRoot)
    expect(clonePlan).toEqual(['clone', '--shared', '--no-checkout', sameboyRoot, coreRoot])
    expect(clonePlan.join(' ')).not.toMatch(/\bworktree\b|https?:\/\//)
    expect(() =>
      driver.localSharedCloneArguments('https://example.invalid/SameBoy.git', coreRoot)
    ).toThrow(/absolute filesystem paths/)
    expect(() => driver.localSharedCloneArguments(sameboyRoot, `file://${coreRoot}`)).toThrow(
      /absolute filesystem paths/
    )
  })
})
