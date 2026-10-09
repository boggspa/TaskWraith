#!/usr/bin/env node

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const { createSmokeUserDataPath, buildSmokeLaunchArgv } = require('./smoke-host-boot-electron.cjs')

function assertStaticRuntime(result) {
  if (result.error) throw result.error
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  if (!/not a dynamic executable|statically linked/i.test(output) || /libfuse/i.test(output)) {
    throw new Error('The public AppImage runtime must be static, without a libfuse dependency.')
  }
}

function hasMainStartup(output) {
  return /\[local-control\] listening at /.test(output)
}

async function waitForMain(child, timeoutMs = 90_000) {
  let output = ''
  let error = null
  const append = (chunk) => {
    output = (output + chunk.toString()).slice(-16_384)
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  child.once('error', (cause) => {
    error = cause
  })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (error) throw error
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`AppImage exited before main startup: ${output.slice(-4000)}`)
    }
    if (hasMainStartup(output)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(
    `AppImage main startup was not observed within ${timeoutMs} ms: ${output.slice(-4000)}`
  )
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const deadline = Date.now() + 5000
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  child.stdout?.destroy()
  child.stderr?.destroy()
  child.unref()
}

async function main(argv = process.argv.slice(2)) {
  if (process.platform !== 'linux') throw new Error('The AppImage runtime smoke requires Linux.')
  const [input, receiptPath] = argv
  if (!input || !receiptPath) throw new Error('Pass the exact AppImage and a new receipt path.')
  const appImage = path.resolve(input)
  if (fs.existsSync(receiptPath)) throw new Error('Refusing to overwrite an AppImage receipt.')
  fs.accessSync(appImage, fs.constants.X_OK)
  assertStaticRuntime(spawnSync('ldd', [appImage], { encoding: 'utf8', timeout: 10_000 }))
  const userData = createSmokeUserDataPath()
  const registry = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-appimage-registry-'))
  fs.mkdirSync(userData, { mode: 0o700 })
  // Exercise the shipped AppRun's user-namespace/sandbox decision, just as
  // the handoff does. Do not mask it with a harness-only --no-sandbox flag.
  const args = [
    '--appimage-extract-and-run',
    '--disable-gpu',
    ...buildSmokeLaunchArgv(userData)
  ]
  let child
  try {
    child = spawn(appImage, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: registry,
      env: {
        ...process.env,
        TASKWRAITH_AUTO_UPDATE: 'off',
        TASKWRAITH_HOST_REGISTRY_ROOT: registry
      }
    })
    await waitForMain(child)
    const hash = createHash('sha256')
    for await (const chunk of fs.createReadStream(appImage)) hash.update(chunk)
    const receipt = {
      schemaVersion: 1,
      platform: process.platform,
      arch: process.arch,
      artifact: path.basename(appImage),
      sha256: hash.digest('hex'),
      staticRuntime: true,
      extractAndRun: true,
      fuseDevicePresent: fs.existsSync('/dev/fuse'),
      mainStartupObserved: true,
      userData,
      hostRegistryRoot: registry,
      at: new Date().toISOString()
    }
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
    console.log(
      '[smoke-appimage-runtime] actual AppImage reached TaskWraith main using extract-and-run'
    )
  } finally {
    await stopChild(child)
    // Retain these disposable roots: a detached Host may still be draining its
    // lease. Runner cleanup owns them; never remove a live Host's profile.
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

module.exports = { assertStaticRuntime, hasMainStartup, waitForMain }
