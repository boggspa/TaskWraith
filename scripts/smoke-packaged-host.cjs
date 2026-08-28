#!/usr/bin/env node

/**
 * Packaging smoke for the production Node Host sidecar.
 *
 * This validates only `taskwraith-host` resources. It never starts Electron,
 * never alters Electron authority. The launcher executes the bundled
 * `tui-runtime` Node binary in fixed production mode.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createConnection } = require('node:net')
const { spawn } = require('node:child_process')
const { createWindowsCmdInvocation } = require('./windows-cmd-invocation.cjs')

const repoRoot = process.cwd()
const argv = process.argv.slice(2)
const layoutOnly = argv.includes('--layout-only')
const sourceLauncher = argv.includes('--source-launcher')
const pathArgs = argv.filter((arg) => arg !== '--layout-only' && arg !== '--source-launcher')
const requirePackage = process.env.TASKWRAITH_HOST_REQUIRE_PACKAGE === '1'
const searchRoots = pathArgs[0]
  ? [path.resolve(repoRoot, pathArgs[0])]
  : ['dist', 'dist-debug'].map((dir) => path.join(repoRoot, dir))
const timeoutMs = readIntegerEnv('TASKWRAITH_HOST_SMOKE_TIMEOUT_MS', 12_000)

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})

async function main() {
  validateSourceLayout()
  if (sourceLauncher) {
    await validateSourceLauncher()
    console.log('packaged production Host source launcher smoke ok')
    return
  }
  if (layoutOnly) {
    console.log('packaged production Host layout smoke ok (layout-only)')
    return
  }

  const packageRoot = findPackagedApp(searchRoots)
  if (!packageRoot) {
    if (requirePackage) fail(`No packaged Electron app was found under ${searchRoots.join(', ')}.`)
    console.log('packaged production Host checks skipped: no package found (layout checks passed)')
    return
  }
  await validatePackagedHost(packageRoot)
  console.log(
    `packaged production Host smoke ok: ${path.relative(repoRoot, packageRoot) || packageRoot}`
  )
}

function validateSourceLayout() {
  const launcherDir = path.join(repoRoot, 'build', 'host-launcher')
  assertDir(launcherDir, 'build/host-launcher')
  for (const name of ['taskwraith-host', 'taskwraith-host.cmd', 'taskwraith-host.ps1']) {
    assertFile(path.join(launcherDir, name), `production Host launcher ${name}`)
  }
  if (process.platform !== 'win32') {
    assertExecutable(path.join(launcherDir, 'taskwraith-host'), 'production Host POSIX launcher')
  }
  for (const name of ['taskwraith-host', 'taskwraith-host.cmd', 'taskwraith-host.ps1']) {
    const body = fs.readFileSync(path.join(launcherDir, name), 'utf8')
    if (
      /export ELECTRON_RUN_AS_NODE=1|set "ELECTRON_RUN_AS_NODE=1"|\$env:ELECTRON_RUN_AS_NODE\s*=/.test(
        body
      )
    ) {
      fail(`production Host launcher ${name} must not set ELECTRON_RUN_AS_NODE=1`)
    }
    if (!/tui-runtime/.test(body) || !/host[\\/]host-runtime[\\/]cli\.js/.test(body)) {
      fail(
        `production Host launcher ${name} must resolve bundled Node and host/host-runtime/cli.js`
      )
    }
    if (!/serve\s+--mode\s+production/.test(body)) {
      fail(`production Host launcher ${name} must fix serve --mode production`)
    }
  }

  const yml = fs.readFileSync(path.join(repoRoot, 'electron-builder.yml'), 'utf8')
  for (const [from, to] of [
    ['from: out/host', 'to: host'],
    ['from: build/host-launcher', 'to: host-bin']
  ]) {
    if (!yml.includes(from) || !yml.includes(to)) {
      fail(`electron-builder.yml must ship ${from} as ${to}`)
    }
  }
  for (const exclusion of ['!out/host/**', '!build/host-launcher/**']) {
    if (!yml.includes(exclusion))
      fail(`electron-builder.yml must exclude ${exclusion} from app.asar`)
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  if (pkg.bin?.['taskwraith-host'] !== './out/host/host-runtime/cli.js') {
    fail('package.json#bin.taskwraith-host must point at the built Host CLI')
  }
  for (const script of [
    'host:build',
    'typecheck:host',
    'host:serve',
    'host:serve:diagnostic',
    'smoke:host-package'
  ]) {
    if (!pkg.scripts?.[script]) fail(`package.json must define ${script}`)
  }
  if (!pkg.scripts['host:serve'].includes('serve --mode production')) {
    fail('package.json#scripts.host:serve must fix production mode')
  }

  const compiledRoot = path.join(repoRoot, 'out', 'host')
  if (fs.existsSync(compiledRoot)) {
    validateHostPayload(compiledRoot, 'compiled production Host payload')
  } else {
    console.log('note: out/host missing — run npm run host:build before packaging')
  }
}

async function validateSourceLauncher() {
  const sourceHost = path.join(repoRoot, 'out', 'host')
  const sourceRuntime = path.join(repoRoot, 'build', 'tui-runtime')
  if (!fs.existsSync(sourceHost) || !fs.existsSync(sourceRuntime)) {
    fail(
      'source launcher smoke requires out/host and build/tui-runtime; run host:build and prepare:tui-runtime'
    )
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-host-source-launcher-'))
  const resources = path.join(root, 'resources')
  try {
    fs.mkdirSync(resources, { recursive: true })
    fs.cpSync(sourceHost, path.join(resources, 'host'), { recursive: true })
    fs.cpSync(path.join(repoRoot, 'build', 'host-launcher'), path.join(resources, 'host-bin'), {
      recursive: true
    })
    fs.symlinkSync(sourceRuntime, path.join(resources, 'tui-runtime'), 'dir')
    await validateHostResources(resources, inferCurrentTarget())
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

async function validatePackagedHost(packageRoot) {
  const resources = resolveResourcesDir(packageRoot)
  assertFile(path.join(resources, 'app.asar'), 'packaged app.asar')
  await validateHostResources(resources, inferPackageTarget(packageRoot))
}

async function validateHostResources(resources, target) {
  const hostRoot = path.join(resources, 'host')
  validateHostPayload(hostRoot, 'packaged production Host payload')
  const launcher = resolveHostLauncher(resources, target)
  if (target.platform === 'win32') assertFile(launcher, 'packaged production Host cmd launcher')
  else assertExecutable(launcher, 'packaged production Host launcher')
  const nodeBin = resolveBundledNode(resources, target)
  assertExecutable(nodeBin, 'bundled production Host Node runtime')
  await runProductionRoundTrip(launcher, target)
}

function validateHostPayload(hostRoot, label) {
  assertDir(hostRoot, label)
  const expectedMainProviderModules = new Set([
    ...[
      'MuseCliArgs.js',
      'MuseCronAssert.js',
      'MuseExecJson.js',
      'MuseIsolatedHome.js',
      'MuseMcpConfig.js',
      'MuseProbe.js',
      'MuseRun.js',
      'MuseSessionLog.js',
      'MuseSkillPin.js',
      'MuseToolProjection.js',
      'MuseTypes.js',
      'MuseUsage.js'
    ].map((name) => path.join('muse', name)),
    ...['MistralCliArgs.js', 'MistralCredentialLane.js', 'MistralQuotaEstimate.js'].map((name) =>
      path.join('mistral', name)
    )
  ])
  const mainRoot = path.join(hostRoot, 'main')
  if (!fs.existsSync(mainRoot)) {
    fail(`${label} must contain the exact production main provider closure`)
  } else {
    const emitted = filesUnder(mainRoot, () => true).map((candidate) =>
      path.relative(mainRoot, candidate)
    )
    const allowed = new Set([
      ...expectedMainProviderModules,
      ...[...expectedMainProviderModules].map((candidate) => `${candidate}.map`)
    ])
    const unexpected = emitted.filter((candidate) => !allowed.has(candidate))
    const missing = [...expectedMainProviderModules].filter(
      (candidate) => !emitted.includes(candidate)
    )
    if (unexpected.length > 0 || missing.length > 0) {
      fail(
        `${label} main provider closure mismatch` +
          ` (missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'})`
      )
    }
  }
  for (const segments of [
    ['host-runtime', 'cli.js'],
    ['host-runtime', 'HostDiagnosticAuthority.js'],
    ['host-runtime', 'HostDiagnosticCli.js'],
    ['host-runtime', 'HostDiagnosticIdentity.js'],
    ['host-runtime', 'HostDiagnosticServer.js'],
    ['host-runtime', 'HostLocalServer.js'],
    ['host-runtime', 'HostProfileAuthorityLease.js'],
    ['host-runtime', 'HostServerIdentity.js'],
    ['host-runtime', 'HostProductionCli.js'],
    ['host-node', 'HostNodeProductionServer.js'],
    ['host-node', 'HostNodeProductionFactory.js'],
    ['host-node', 'HostNodeDomainPorts.js'],
    ['host-node', 'HostNodeMuseResources.js'],
    ['host-node', 'HostNodeMuseCatalog.js'],
    ['host-node', 'HostNodeMuseAuthHandoff.js'],
    ['host-node', 'HostNodeMuseProvider.js'],
    ['host-node', 'HostNodeProfileRunPort.js'],
    ['host-node', 'HostNodeProviderRegistry.js'],
    ['host-node', 'HostNodeProviderResources.js'],
    ['host-node', 'HostNodeClaudeProvider.js'],
    ['host-node', 'HostNodeCodexProvider.js'],
    ['host-node', 'HostNodeCursorProvider.js'],
    ['host-node', 'HostNodeGrokProvider.js'],
    ['host-node', 'HostNodeKimiProvider.js'],
    ['host-node', 'HostNodeMistralProvider.js'],
    ['host-node', 'HostNodeOllamaProvider.js'],
    ['host-node', 'HostNodePiProvider.js'],
    ['host-shared', 'HostProviderCatalog.js']
  ]) {
    assertFile(path.join(hostRoot, ...segments), `${label} ${segments.join('/')}`)
  }
  for (const filePath of filesUnder(hostRoot, (candidate) => candidate.endsWith('.js'))) {
    const source = fs.readFileSync(filePath, 'utf8')
    if (/require\(['"]electron['"]\)|from ['"]electron['"]/.test(source)) {
      fail(`${label} must not import Electron: ${filePath}`)
    }
  }
}

function resolveHostLauncher(resources, target) {
  const bin = path.join(resources, 'host-bin')
  return path.join(bin, target.platform === 'win32' ? 'taskwraith-host.cmd' : 'taskwraith-host')
}

function resolveBundledNode(resources, target) {
  const root = path.join(resources, 'tui-runtime')
  const binary = target.platform === 'win32' ? 'node.exe' : 'node'
  const candidates =
    target.arch === 'universal'
      ? [
          path.join(
            root,
            `${target.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`,
            binary
          )
        ]
      : [path.join(root, `${target.platform}-${target.arch}`, binary)]
  const selected = candidates.find((candidate) => fs.existsSync(candidate))
  if (!selected) fail(`bundled Node runtime missing under ${root}`)
  return selected
}

async function runProductionRoundTrip(launcher, target) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-packaged-host-smoke-'))
  const canonicalProfile = fs.realpathSync(profile)
  const discoveryPath = path.join(profile, 'taskwraith-host-v2.json')
  const tokenPath = path.join(profile, 'taskwraith-host-v2.token')
  const leasePath = path.join(profile, 'taskwraith-host-authority-v1.json')
  const identityPath = path.join(profile, 'host-runtime', 'host-install-identity.json')
  const legacyChatsPath = path.join(profile, 'chats')
  const workspace = path.join(profile, 'workspace')
  const museBinary = path.join(profile, 'muse')
  let child = null
  try {
    fs.mkdirSync(workspace)
    // Real pre-Host Desktop profiles inherited the process umask and commonly
    // carry chats/ as 0755. The bundled Host must safely tighten that known
    // app-owned directory rather than fail before publishing discovery.
    fs.mkdirSync(legacyChatsPath, { mode: 0o755 })
    if (target.platform !== 'win32') fs.chmodSync(legacyChatsPath, 0o755)
    const launcherArgs = ['--profile', canonicalProfile]
    const childEnv = {}

    if (target.platform !== 'win32') {
      fs.writeFileSync(museBinary, '#!/bin/sh\n')
      fs.chmodSync(museBinary, 0o700)
      launcherArgs.push('--muse-binary', museBinary)
      childEnv.META_API_KEY = 'taskwraith-host-smoke-key'
    }
    child = spawnHostLauncher(launcher, launcherArgs, target, childEnv)
    await waitFor(
      () => fs.existsSync(discoveryPath) && fs.existsSync(tokenPath) && fs.existsSync(leasePath),
      'production Host did not publish owner-controlled discovery/token/lease'
    )
    const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'))
    assertOwnerOnly(discoveryPath, 'production Host discovery')
    assertOwnerOnly(tokenPath, 'production Host token')
    assertOwnerOnly(leasePath, 'production Host authority lease')
    assertOwnerOnly(identityPath, 'production Host identity')
    if (target.platform !== 'win32' && (fs.lstatSync(legacyChatsPath).mode & 0o7777) !== 0o700) {
      fail('production Host must tighten a legacy chats directory to owner-only')
    }

    const response = await hostRequest(discovery, fs.readFileSync(tokenPath, 'utf8').trim(), {
      type: 'request',
      transportVersion: 1,
      id: 'snapshot',
      kind: 'snapshot.get',
      params: {}
    })
    if (
      !Array.isArray(response.welcome?.capabilities) ||
      response.welcome.hostVersion !== 'node-host-v1' ||
      !response.welcome.capabilities.includes('setup') ||
      !response.welcome.capabilities.includes('provider-catalog') ||
      !response.welcome.capabilities.includes('history')
    ) {
      fail('production Host must advertise Node Host production capabilities')
    }
    if (response.frame?.ok !== true || response.frame.result?.kind !== 'snapshot.get') {
      fail('production Host did not return an authenticated snapshot')
    }
    const snapshotProviders = response.frame.result.frame?.snapshot?.providers
    if (!Array.isArray(snapshotProviders)) {
      fail('production Host snapshot must include a providers inventory')
    }

    const statusResponse = await hostRequest(discovery, fs.readFileSync(tokenPath, 'utf8').trim(), {
      type: 'request',
      transportVersion: 1,
      id: 'provider-status',
      kind: 'provider.status',
      params: {}
    })
    const statuses = statusResponse.frame?.result?.statuses
    if (statusResponse.frame?.ok !== true || !Array.isArray(statuses)) {
      fail('production Host did not return provider statuses')
    }
    if (statuses.length !== snapshotProviders.length) {
      fail(
        `production Host provider statuses (${statuses.length}) do not match the snapshot inventory (${snapshotProviders.length})`
      )
    }
    for (const status of statuses) {
      if (
        typeof status?.providerId !== 'string' ||
        !['ready', 'auth_required', 'unavailable', 'degraded'].includes(status?.status)
      ) {
        fail('production Host provider status row is invalid')
      }
    }

    if (target.platform !== 'win32') {
      const actor = {
        actorId: 'packaged-host-smoke',
        clientId: 'packaged-host-smoke',
        clientClass: 'test'
      }
      const command = (id, name, target_, arguments_) => ({
        type: 'host.command',
        protocolVersion: 2,
        commandId: id,
        idempotencyKey: `smoke-${id}`,
        actor,
        name,
        target: target_,
        arguments: arguments_,
        issuedAt: '2026-08-24T00:00:00.000Z'
      })
      const token = fs.readFileSync(tokenPath, 'utf8').trim()
      const workspaceReceipt = await hostRequest(discovery, token, {
        type: 'request',
        transportVersion: 1,
        id: 'workspace',
        kind: 'command.submit',
        params: command('workspace-command', 'workspace.register', {}, { path: workspace })
      })
      const workspaceId = workspaceReceipt.frame?.result?.receipt?.resultRef?.workspaceId
      if (!workspaceId) fail('production Host workspace.register did not return a workspace ref')
      const threadReceipt = await hostRequest(discovery, token, {
        type: 'request',
        transportVersion: 1,
        id: 'thread',
        kind: 'command.submit',
        params: command(
          'thread-command',
          'thread.create',
          {},
          { scope: 'workspace', workspaceId, title: 'Smoke' }
        )
      })
      const threadId = threadReceipt.frame?.result?.receipt?.resultRef?.threadId
      if (!threadId) fail('production Host thread.create did not return a thread ref')
      const offers = await hostRequest(discovery, token, {
        type: 'request',
        transportVersion: 1,
        id: 'offers',
        kind: 'provider.offers',
        params: { providerId: 'muse' }
      })
      const revision = offers.frame?.result?.offers?.offerRevision
      if (typeof revision !== 'string' || revision.length === 0) {
        fail('production Host provider.offers did not return a bounded revision')
      }
      const configured = await hostRequest(discovery, token, {
        type: 'request',
        transportVersion: 1,
        id: 'config',
        kind: 'command.submit',
        params: command(
          'config-command',
          'thread.configure',
          { threadId },
          {
            providerId: 'muse',
            modelId: 'muse-spark-1.2',
            postureId: 'default',
            offerRevision: revision
          }
        )
      })
      if (
        configured.frame?.ok !== true ||
        configured.frame?.result?.receipt?.status !== 'succeeded'
      ) {
        fail('production Host thread.configure did not succeed')
      }
      const history = await hostRequest(discovery, token, {
        type: 'request',
        transportVersion: 1,
        id: 'history',
        kind: 'thread.history',
        params: { threadId, limit: 10 }
      })
      if (history.frame?.ok !== true) fail('production Host history request failed')
      const replay = await hostRequest(discovery, token, {
        type: 'request',
        transportVersion: 1,
        id: 'replay',
        kind: 'receipt.lookup',
        params: { commandId: 'config-command' }
      })
      if (
        replay.frame?.result?.receipt?.commandId !== 'config-command' ||
        replay.frame?.result?.receipt?.status !== 'succeeded' ||
        replay.frame?.result?.receipt?.resultRef?.threadId !== threadId
      )
        fail('production Host receipt replay failed')
    }

    const duplicate = spawnHostLauncher(launcher, ['--profile', canonicalProfile], target)
    const duplicateExit = await waitForExit(duplicate)
    if (duplicateExit.code === 0)
      fail('duplicate production Host profile launch unexpectedly succeeded')

    // Normal cleanup proves the authenticated lifecycle RPC rather than
    // reaching into another process with a signal.
    const stopper = spawnHostLauncher(
      launcher,
      ['stop', '--profile', canonicalProfile],
      target,
      childEnv
    )
    const stopResult = await waitForExit(stopper)
    if (stopResult.code !== 0)
      fail(
        `production Host stop launcher exited ${String(stopResult.code)}: ${stopResult.stderr || 'no stderr'}`
      )
    const stopped = await waitForExit(child)
    child = null
    if (stopped.code !== 0)
      fail(`production Host launcher exited ${String(stopped.code)} during cleanup`)
    if (fs.existsSync(discoveryPath) || fs.existsSync(tokenPath) || fs.existsSync(leasePath)) {
      fail('production Host did not clean discovery/token/lease on shutdown')
    }
    if (!fs.existsSync(identityPath)) fail('production Host must retain its persisted identity')
    if (discovery.socketPath && fs.existsSync(discovery.socketPath)) {
      fail('production Host did not clean its socket on shutdown')
    }
  } finally {
    // Emergency-only cleanup for a smoke failure before authenticated stop.
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
      await waitForExit(child).catch(() => undefined)
    }
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

function spawnHostLauncher(launcher, args, target, extraEnv = {}) {
  if (target.platform === 'win32') {
    const invocation = createWindowsCmdInvocation(launcher, args)
    return spawn(invocation.command, invocation.arguments, {
      ...invocation.spawnOptions,
      cwd: path.dirname(launcher),
      env: { ...process.env, ...extraEnv, ELECTRON_RUN_AS_NODE: '' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  }
  return spawn(launcher, args, {
    cwd: path.dirname(launcher),
    env: { ...process.env, ...extraEnv, ELECTRON_RUN_AS_NODE: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

async function hostRequest(discovery, token, request) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(discovery.socketPath)
    let buffer = ''
    let welcome = null
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('timed out waiting for production Host response'))
    }, timeoutMs)
    const finish = (value) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    socket.on('error', reject)
    socket.on('connect', () => {
      socket.write(
        `${JSON.stringify({
          type: 'hello',
          transportVersion: 1,
          token,
          hello: {
            type: 'host.hello',
            protocolVersion: 2,
            projectionVersion: 2,
            client: {
              clientId: 'packaged-host-smoke',
              clientClass: 'test',
              clientVersion: '1.0.0'
            },
            capabilities: [
              'bootstrap',
              'snapshot',
              'health',
              'commands',
              'receipts',
              'provider-catalog',
              'provider-auth',
              'history',
              'setup'
            ]
          }
        })}\n`
      )
    })
    socket.on('data', (chunk) => {
      buffer += String(chunk)
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line) continue
        let frame
        try {
          frame = JSON.parse(line)
        } catch {
          reject(new Error('production Host sent malformed JSON'))
          return
        }
        if (frame.type === 'welcome') {
          welcome = frame.welcome
          socket.write(`${JSON.stringify(request)}\n`)
        } else if (frame.type === 'response') {
          finish({ welcome, frame })
          return
        }
      }
    })
  })
}

function assertOwnerOnly(filePath, label) {
  if (process.platform === 'win32') return
  if ((fs.statSync(filePath).mode & 0o077) !== 0) fail(`${label} is not owner-only`)
}

async function waitFor(check, message) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  fail(message)
}

async function waitForExit(child) {
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  if (child.exitCode !== null) return { code: child.exitCode, stderr }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('production Host launcher did not exit')),
      timeoutMs
    )
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stderr })
    })
  })
}

function resolveResourcesDir(packageRoot) {
  return packageRoot.endsWith('.app')
    ? path.join(packageRoot, 'Contents', 'Resources')
    : path.join(packageRoot, 'resources')
}

function findPackagedApp(roots) {
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    if (isPackagedRoot(root)) return root
    const found = findDirectories(root, isPackagedRoot, 5)
    if (found.length > 0) return found[0]
  }
  return null
}

function isPackagedRoot(candidate) {
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) return false
  return candidate.endsWith('.app')
    ? fs.existsSync(path.join(candidate, 'Contents', 'Resources', 'app.asar'))
    : fs.existsSync(path.join(candidate, 'resources', 'app.asar'))
}

function inferCurrentTarget() {
  return {
    platform: process.platform,
    arch: process.arch === 'arm64' ? 'arm64' : 'x64'
  }
}

function inferPackageTarget(packageRoot) {
  if (packageRoot.endsWith('.app')) {
    const base = path.basename(path.dirname(packageRoot)).toLowerCase()
    if (base.includes('arm64')) return { platform: 'darwin', arch: 'arm64' }
    if (base.includes('x64') || base.includes('x86_64')) return { platform: 'darwin', arch: 'x64' }
    return { platform: 'darwin', arch: 'universal' }
  }
  const base = path.basename(packageRoot).toLowerCase()
  if (base.includes('win') || fs.existsSync(path.join(packageRoot, 'TaskWraith.exe'))) {
    return { platform: 'win32', arch: base.includes('arm64') ? 'arm64' : 'x64' }
  }
  return { platform: 'linux', arch: process.arch === 'arm64' ? 'arm64' : 'x64' }
}

function findDirectories(root, predicate, maxDepth) {
  const found = []
  const walk = (directory, depth) => {
    if (depth > maxDepth) return
    for (const entry of safeReadDir(directory)) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git') continue
      const candidate = path.join(directory, entry.name)
      if (predicate(candidate)) found.push(candidate)
      else walk(candidate, depth + 1)
    }
  }
  walk(root, 0)
  return found
}

function filesUnder(root, predicate) {
  const files = []
  const walk = (directory) => {
    for (const entry of safeReadDir(directory)) {
      const candidate = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(candidate)
      else if (entry.isFile() && predicate(candidate)) files.push(candidate)
    }
  }
  walk(root)
  return files
}

function safeReadDir(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile())
    fail(`Missing ${label}: ${filePath}`)
}

function assertExecutable(filePath, label) {
  assertFile(filePath, label)
  try {
    fs.accessSync(filePath, fs.constants.X_OK)
  } catch {
    fail(`${label} is not executable: ${filePath}`)
  }
}

function assertDir(directory, label) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    fail(`Missing ${label}: ${directory}`)
  }
}

function readIntegerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10)
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function fail(message) {
  throw new Error(`[smoke-packaged-host] ${message}`)
}
