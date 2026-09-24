#!/usr/bin/env node

/*
 * Rebuild the reviewed local emulator proof from explicit local inputs.
 *
 * This script deliberately never downloads a toolchain or source checkout. It
 * builds an isolated shared clone of the supplied SameBoy checkout beneath the
 * temporary build directory, compiles the first-party fixture there, and writes
 * browser output only to an explicit empty directory outside this repository.
 */

const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep
} = require('node:path')

const SCRIPT_ROOT = __dirname
const RECEIPT_FILE = 'build-receipt.json'
const SHA256 = /^[a-f0-9]{64}$/
const FIXTURE_ROM_PATH = '/roms/taskwraith-fixture.gb'

function fail(message) {
  throw new Error(`Emulator build: ${message}`)
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} is required.`)
  return value.trim()
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`${label} must be a SHA-256 hex.`)
  return value
}

function isInside(root, candidate) {
  const value = relative(root, candidate)
  return Boolean(value) && value !== '..' && !value.startsWith(`..${sep}`)
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function assertExactSha256(filePath, expectedSha256, label) {
  const actual = sha256File(filePath)
  if (actual !== expectedSha256) {
    fail(`${label} SHA-256 mismatch: expected ${expectedSha256}, got ${actual}.`)
  }
}

function regularFile(filePath, label) {
  const raw = requireString(filePath, label)
  if (!isAbsolute(raw)) fail(`${label} must be absolute.`)
  const absolute = resolve(raw)
  const stat = lstatSync(absolute)
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file.`)
  return realpathSync(absolute)
}

function regularDirectory(directory, label) {
  const raw = requireString(directory, label)
  if (!isAbsolute(raw)) fail(`${label} must be absolute.`)
  const absolute = resolve(raw)
  const stat = lstatSync(absolute)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a regular directory.`)
  return realpathSync(absolute)
}

function readBuildReceipt(root = SCRIPT_ROOT) {
  const receiptPath = join(resolve(root), RECEIPT_FILE)
  const bytes = readFileSync(receiptPath)
  let receipt
  try {
    receipt = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    fail(
      `${RECEIPT_FILE} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!receipt || receipt.schemaVersion !== 1) fail(`${RECEIPT_FILE} must use schemaVersion 1.`)
  const shipped = receipt?.pins?.shippedCore
  const fixture = receipt?.source?.fixture
  const host = receipt?.source?.host
  const emscripten = receipt?.pins?.emscripten
  const rgbds = receipt?.pins?.rgbds
  const browser = receipt?.expectedBrowserArtifacts
  if (!shipped || !fixture || !host || !emscripten || !rgbds) {
    fail(`${RECEIPT_FILE} is missing required source or pin records.`)
  }
  if (shipped.commit !== 'aa158a889a48b538a0302873704a34577c8eb67d') {
    fail('shipped SameBoy core commit drifted.')
  }
  if (shipped.version !== '0.15.4') fail('shipped SameBoy core version drifted.')
  if (emscripten.version !== '3.1.46') fail('Emscripten version drifted.')
  if (emscripten.emsdkCommit !== '93360d3670018769b424e4e8f1d3d9b26d32c977') {
    fail('Emsdk source commit drifted.')
  }
  if (emscripten.emscriptenSourceCommit !== '19607820c447a13fd8d0b7680c56148427d6e1b8') {
    fail('Emscripten source commit drifted.')
  }
  if (rgbds.version !== '1.0.3') fail('RGBDS version drifted.')
  if (rgbds.platform !== 'darwin-universal' || rgbds.toolOnly !== true) {
    fail('RGBDS receipt must identify the universal macOS tool-only asset.')
  }
  if (fixture?.rom?.sha256 !== '2175c6b758fdd76e4e878ccf10ee04f50135be74226f548df78dff4fea5806c7') {
    fail('fixture ROM SHA-256 drifted.')
  }
  if (fixture?.rom?.byteLength !== 32768) fail('fixture ROM byte length drifted.')
  const inputReady = fixture?.abi?.inputReady
  if (
    !inputReady ||
    inputReady.magic !== 'TWGB' ||
    inputReady.schemaVersion !== 1 ||
    inputReady.status !== '0x03' ||
    inputReady.lastInput !== 0 ||
    inputReady.frameCounter?.minimumExclusive !== 0
  ) {
    fail('fixture input-ready contract drifted.')
  }
  requireSha256(host.sha256, 'host source SHA-256')
  requireSha256(shipped?.object?.sha256, 'core object SHA-256')
  requireSha256(rgbds?.executables?.rgbasm, 'RGBASM SHA-256')
  requireSha256(rgbds?.executables?.rgblink, 'RGBLINK SHA-256')
  requireSha256(rgbds?.executables?.rgbfix, 'RGBFIX SHA-256')
  if (!browser || !Array.isArray(browser.linkFlags) || !Array.isArray(browser.exports)) {
    fail('expected browser artifact build contract is malformed.')
  }
  for (const artifact of [browser.mjs, browser.wasm]) {
    requireString(artifact?.path, 'browser artifact path')
    requireSha256(artifact?.sha256, 'browser artifact SHA-256')
    if (!Number.isSafeInteger(artifact?.byteLength) || artifact.byteLength <= 0) {
      fail('browser artifact byte length is invalid.')
    }
  }
  if (!browser.linkFlags.includes('-sDYNAMIC_EXECUTION=0')) {
    fail('browser build must keep DYNAMIC_EXECUTION=0.')
  }
  if (!browser.exports.includes('_twemu_shutdown')) {
    fail('browser build must export twemu_shutdown.')
  }
  return receipt
}

function assertSourceHash(root, relativePath, expectedSha256) {
  const filePath = join(root, relativePath)
  if (!existsSync(filePath)) fail(`source input is missing: ${relativePath}`)
  const actual = sha256File(filePath)
  if (actual !== expectedSha256) {
    fail(
      `source input hash mismatch for ${relativePath}: expected ${expectedSha256}, got ${actual}.`
    )
  }
}

function verifySourceInputs(root = SCRIPT_ROOT) {
  const sourceRoot = resolve(root)
  const receipt = readBuildReceipt(sourceRoot)
  const fixture = receipt.source.fixture
  assertSourceHash(sourceRoot, receipt.source.host.path, receipt.source.host.sha256)
  assertSourceHash(sourceRoot, fixture.licensePath, fixture.licenseSha256)
  for (const [relativePath, expectedSha256] of Object.entries(fixture.files)) {
    assertSourceHash(sourceRoot, join(fixture.root, relativePath), expectedSha256)
  }
  const source = readFileSync(join(sourceRoot, fixture.root, 'src', 'main.asm'), 'utf8')
  const makefile = readFileSync(join(sourceRoot, fixture.root, 'Makefile'), 'utf8')
  if (!source.includes('wFrameCounter::   ds 4') || !source.includes('TWGB')) {
    fail('fixture source no longer exposes the reviewed TWGB u32le ABI.')
  }
  if (!makefile.includes('ifndef RGBDS') || !makefile.includes('RGBDS v1.0.3')) {
    fail('fixture Makefile must require an explicit RGBDS v1.0.3 directory.')
  }
  if (/rgbfix[^\n]*-f[^\n]*l/i.test(makefile)) {
    fail('fixture Makefile must not inject Nintendo logo bytes.')
  }
  return receipt
}

function assertSafeOutputDirectory(
  outputDirectory,
  sourceRoot = SCRIPT_ROOT,
  repositoryRoot = resolve(SCRIPT_ROOT, '..', '..')
) {
  const output = resolve(requireString(outputDirectory, 'output directory'))
  const checkedSourceRoot = resolve(sourceRoot)
  const checkedRepositoryRoot = resolve(repositoryRoot)
  if (
    output === parse(output).root ||
    output === checkedSourceRoot ||
    isInside(checkedSourceRoot, output) ||
    output === checkedRepositoryRoot ||
    isInside(checkedRepositoryRoot, output)
  ) {
    fail('output directory must be an explicit directory outside this repository.')
  }
  if (existsSync(output)) {
    const stat = lstatSync(output)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail('output directory must be a non-symlink directory.')
    }
    if (readdirSync(output).length > 0) fail('output directory must be empty.')
  } else {
    mkdirSync(output, { recursive: true })
  }
  return realpathSync(output)
}

function localSharedCloneArguments(sameboyRoot, coreRoot) {
  const source = requireString(sameboyRoot, 'sameboyRoot')
  const destination = requireString(coreRoot, 'temporary SameBoy clone')
  if (!isAbsolute(source) || !isAbsolute(destination)) {
    fail('local shared clone paths must be absolute filesystem paths.')
  }
  return ['clone', '--shared', '--no-checkout', resolve(source), resolve(destination)]
}

function buildPlan(input, sourceRoot = SCRIPT_ROOT) {
  const receipt = verifySourceInputs(sourceRoot)
  const required = [
    'sameboyRoot',
    'emscriptenRoot',
    'emcc',
    'emmake',
    'rgbdsBin',
    'outputDirectory'
  ]
  for (const key of required) requireString(input?.[key], key)
  const fixture = receipt.source.fixture
  const core = receipt.pins.shippedCore
  const outputs = receipt.expectedBrowserArtifacts
  return {
    receipt,
    fixtureRomPath: FIXTURE_ROM_PATH,
    coreMakeArguments: core.object.makeArguments,
    hostLinkArguments: [
      '-O3',
      ...outputs.linkFlags.slice(1),
      `-sEXPORTED_FUNCTIONS=${JSON.stringify(outputs.exports)}`,
      `-DTWEMU_ROM_PATH="${FIXTURE_ROM_PATH}"`,
      '--embed-file',
      `<fixture>/${fixture.rom.path}@${FIXTURE_ROM_PATH}`,
      '-o',
      `<output>/${outputs.mjs.path}`
    ]
  }
}

function command(command, args, options = {}, adapters = {}) {
  const spawn = adapters.spawnSync ?? spawnSync
  const result = spawn(command, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    ...options
  })
  if (result.error) fail(`${basename(command)} failed to start: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = `${result.stdout || ''}${result.stderr || ''}`.trim()
    fail(`${basename(command)} failed (${result.status}): ${detail.slice(-1200)}`)
  }
  return String(result.stdout || '')
}

function assertToolVersion(executable, expected, label, adapters) {
  const actual = command(executable, ['-V'], {}, adapters).trim()
  if (actual !== expected) fail(`${label} version mismatch: expected ${expected}, got ${actual}.`)
}

function assertPinnedTool(executable, expectedSha256, expectedVersion, label, adapters) {
  assertExactSha256(executable, expectedSha256, label)
  assertToolVersion(executable, expectedVersion, label, adapters)
}

function verifyEmscriptenCheckout(input, receipt, adapters) {
  const emscriptenRoot = regularDirectory(input.emscriptenRoot, 'emscriptenRoot')
  const expectedEmcc = regularFile(join(emscriptenRoot, 'emcc'), 'emscriptenRoot/emcc')
  const expectedEmmake = regularFile(join(emscriptenRoot, 'emmake'), 'emscriptenRoot/emmake')
  const emcc = regularFile(input.emcc, 'emcc')
  const emmake = regularFile(input.emmake, 'emmake')
  if (emcc !== expectedEmcc || emmake !== expectedEmmake) {
    fail('emcc and emmake must come from the same explicit Emscripten checkout.')
  }
  const head = command('git', ['-C', emscriptenRoot, 'rev-parse', 'HEAD'], {}, adapters).trim()
  if (head !== receipt.pins.emscripten.emscriptenSourceCommit) {
    fail('emscriptenRoot is not the recorded Emscripten source commit.')
  }
  if (command('git', ['-C', emscriptenRoot, 'status', '--porcelain'], {}, adapters).trim()) {
    fail('emscriptenRoot must be clean.')
  }
  return { emcc, emmake, emscriptenRoot }
}

function assertArtifact(filePath, expected, label) {
  const stat = statSync(filePath)
  if (!stat.isFile() || stat.size !== expected.byteLength) {
    fail(`${label} byte length mismatch.`)
  }
  const actual = sha256File(filePath)
  if (actual !== expected.sha256)
    fail(`${label} SHA-256 mismatch: expected ${expected.sha256}, got ${actual}.`)
}

function runLocalBuild(input, adapters = {}) {
  const sourceRoot = resolve(input?.sourceRoot ?? SCRIPT_ROOT)
  const receipt = verifySourceInputs(sourceRoot)
  const sameboyRoot = regularDirectory(input.sameboyRoot, 'sameboyRoot')
  const rgbdsBin = regularDirectory(input.rgbdsBin, 'rgbdsBin')
  const outputDirectory = assertSafeOutputDirectory(
    input.outputDirectory,
    sourceRoot,
    input.repositoryRoot
  )
  const emConfig = input.emConfig ? regularFile(input.emConfig, 'emConfig') : undefined
  const rgbasm = regularFile(join(rgbdsBin, 'rgbasm'), 'rgbasm')
  const rgblink = regularFile(join(rgbdsBin, 'rgblink'), 'rgblink')
  const rgbfix = regularFile(join(rgbdsBin, 'rgbfix'), 'rgbfix')
  assertPinnedTool(
    rgbasm,
    receipt.pins.rgbds.executables.rgbasm,
    'rgbasm v1.0.3',
    'RGBASM',
    adapters
  )
  assertPinnedTool(
    rgblink,
    receipt.pins.rgbds.executables.rgblink,
    'rgblink v1.0.3',
    'RGBLINK',
    adapters
  )
  assertPinnedTool(
    rgbfix,
    receipt.pins.rgbds.executables.rgbfix,
    'rgbfix v1.0.3',
    'RGBFIX',
    adapters
  )
  const { emcc, emmake } = verifyEmscriptenCheckout(input, receipt, adapters)
  const environment = {
    ...process.env,
    PATH: [dirname(emcc), rgbdsBin, process.env.PATH || ''].join(delimiter),
    ...(emConfig ? { EM_CONFIG: emConfig } : {})
  }
  if (!command(emcc, ['--version'], { env: environment }, adapters).includes('3.1.46')) {
    fail('emcc must report Emscripten 3.1.46.')
  }
  const head = command('git', ['-C', sameboyRoot, 'rev-parse', 'HEAD'], {}, adapters).trim()
  if (head !== receipt.pins.shippedCore.commit)
    fail('sameboyRoot is not the pinned shipped core commit.')

  const temporaryRoot = mkdtempSync(join(tmpdir(), 'taskwraith-emulator-build-'))
  const coreRoot = join(temporaryRoot, 'sameboy')
  try {
    command('git', localSharedCloneArguments(sameboyRoot, coreRoot), {}, adapters)
    command('git', ['-C', coreRoot, 'checkout', '--detach', head], {}, adapters)
    const fixtureSource = join(sourceRoot, receipt.source.fixture.root)
    const fixtureBuild = join(temporaryRoot, 'fixture')
    mkdirSync(join(fixtureBuild, 'src'), { recursive: true })
    for (const relativePath of ['Makefile', 'LICENSE', 'src/main.asm', 'src/hardware.inc']) {
      copyFileSync(join(fixtureSource, relativePath), join(fixtureBuild, relativePath))
    }
    command('make', [`RGBDS=${rgbdsBin}`], { cwd: fixtureBuild, env: environment }, adapters)
    const fixtureRom = join(fixtureBuild, receipt.source.fixture.rom.path)
    assertArtifact(fixtureRom, receipt.source.fixture.rom, 'fixture ROM')

    const coreDirectory = join(coreRoot, 'libretro')
    command(
      emmake,
      ['make', ...receipt.pins.shippedCore.object.makeArguments],
      { cwd: coreDirectory, env: environment },
      adapters
    )
    const coreObject = join(coreDirectory, receipt.pins.shippedCore.object.path.split('/').pop())
    assertArtifact(coreObject, receipt.pins.shippedCore.object, 'SameBoy core object')

    const artifactDirectory = join(temporaryRoot, 'artifacts')
    mkdirSync(artifactDirectory)
    const mjsOutput = join(artifactDirectory, receipt.expectedBrowserArtifacts.mjs.path)
    command(
      emcc,
      [
        join(sourceRoot, receipt.source.host.path),
        coreObject,
        '-I',
        join(coreDirectory, 'libretro-common', 'include'),
        `-DTWEMU_ROM_PATH="${FIXTURE_ROM_PATH}"`,
        ...receipt.expectedBrowserArtifacts.linkFlags,
        `-sEXPORTED_FUNCTIONS=${JSON.stringify(receipt.expectedBrowserArtifacts.exports)}`,
        '--embed-file',
        `${fixtureRom}@${FIXTURE_ROM_PATH}`,
        '-o',
        mjsOutput
      ],
      { cwd: temporaryRoot, env: environment },
      adapters
    )
    assertArtifact(mjsOutput, receipt.expectedBrowserArtifacts.mjs, 'browser mjs')
    const wasmOutput = join(artifactDirectory, receipt.expectedBrowserArtifacts.wasm.path)
    assertArtifact(wasmOutput, receipt.expectedBrowserArtifacts.wasm, 'browser wasm')
    const stagedMjs = join(outputDirectory, receipt.expectedBrowserArtifacts.mjs.path)
    const stagedWasm = join(outputDirectory, receipt.expectedBrowserArtifacts.wasm.path)
    copyFileSync(mjsOutput, stagedMjs)
    copyFileSync(wasmOutput, stagedWasm)
    assertArtifact(stagedMjs, receipt.expectedBrowserArtifacts.mjs, 'staged browser mjs')
    assertArtifact(stagedWasm, receipt.expectedBrowserArtifacts.wasm, 'staged browser wasm')
    return {
      coreObjectSha256: receipt.pins.shippedCore.object.sha256,
      fixtureSha256: receipt.source.fixture.rom.sha256,
      mjsPath: stagedMjs,
      wasmPath: stagedWasm
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

function parseCli(argv) {
  const input = { sourceRoot: SCRIPT_ROOT }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--plan') {
      input.plan = true
      continue
    }
    if (token === '--help') return { help: true }
    const key = {
      '--sameboy-root': 'sameboyRoot',
      '--emscripten-root': 'emscriptenRoot',
      '--emcc': 'emcc',
      '--emmake': 'emmake',
      '--em-config': 'emConfig',
      '--rgbds-bin': 'rgbdsBin',
      '--output-dir': 'outputDirectory'
    }[token]
    if (!key) fail(`unknown argument ${token}.`)
    const value = argv[++index]
    input[key] = requireString(value, token)
  }
  return input
}

function usage() {
  return [
    'Usage:',
    '  node scripts/emulator/build-emulator-assets.cjs --plan --sameboy-root <abs> --emscripten-root <abs> --emcc <abs> --emmake <abs> --rgbds-bin <abs> --output-dir <empty-abs>',
    '  node scripts/emulator/build-emulator-assets.cjs --sameboy-root <abs> --emscripten-root <abs> --emcc <abs> --emmake <abs> [--em-config <abs>] --rgbds-bin <abs> --output-dir <empty-abs>',
    '',
    'All inputs are local and explicit. The script never downloads or vendors toolchains/source checkouts.'
  ].join('\n')
}

function main(argv = process.argv.slice(2)) {
  const input = parseCli(argv)
  if (input.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  const result = input.plan ? buildPlan(input) : runLocalBuild(input)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

module.exports = {
  FIXTURE_ROM_PATH,
  assertSafeOutputDirectory,
  buildPlan,
  localSharedCloneArguments,
  parseCli,
  readBuildReceipt,
  runLocalBuild,
  usage,
  verifyEmscriptenCheckout,
  verifySourceInputs
}
