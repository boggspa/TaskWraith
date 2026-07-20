#!/usr/bin/env node

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const DARWIN_CLAUDE_SDK_PACKAGES = [
  '@anthropic-ai/claude-agent-sdk-darwin-arm64',
  '@anthropic-ai/claude-agent-sdk-darwin-x64'
]

// pdfjs-dist legacy requires @napi-rs/canvas for DOMMatrix under Node.
// Optional platform packages only install for the host arch, so the universal
// mac build must explicitly land both Darwin slices before electron-builder.
const DARWIN_NAPI_CANVAS_PACKAGES = [
  '@napi-rs/canvas-darwin-arm64',
  '@napi-rs/canvas-darwin-x64'
]

const DARWIN_NODE_PTY_PREBUILDS = [
  path.join('prebuilds', 'darwin-arm64', 'pty.node'),
  path.join('prebuilds', 'darwin-arm64', 'spawn-helper'),
  path.join('prebuilds', 'darwin-x64', 'pty.node'),
  path.join('prebuilds', 'darwin-x64', 'spawn-helper')
]

const DARWIN_NODE_PTY_EXECUTABLE_PREBUILDS = [
  path.join('prebuilds', 'darwin-arm64', 'spawn-helper'),
  path.join('prebuilds', 'darwin-x64', 'spawn-helper')
]

function resolveLockPackages(lock, packageNames) {
  const packages = lock && typeof lock === 'object' ? lock.packages || {} : {}
  return packageNames.map((name) => {
    const entry = packages[`node_modules/${name}`]
    if (!entry || typeof entry.version !== 'string' || entry.version.length === 0) {
      throw new Error(`Missing ${name} version in package-lock.json.`)
    }
    return { name, version: entry.version, spec: `${name}@${entry.version}` }
  })
}

function resolveDarwinClaudeSdkPackages(lock) {
  return resolveLockPackages(lock, DARWIN_CLAUDE_SDK_PACKAGES)
}

function resolveDarwinNapiCanvasPackages(lock) {
  return resolveLockPackages(lock, DARWIN_NAPI_CANVAS_PACKAGES)
}

function missingPackageSpecs(repoRoot, packages) {
  return missingPackages(repoRoot, packages).map(({ spec }) => spec)
}

function packageDir(repoRoot, name) {
  return path.join(repoRoot, 'node_modules', ...name.split('/'))
}

function ensureDarwinNodePtyPrebuilds(repoRoot) {
  const nodePtyDir = packageDir(repoRoot, 'node-pty')
  const missing = DARWIN_NODE_PTY_PREBUILDS.filter((relativePath) => {
    return !fs.existsSync(path.join(nodePtyDir, relativePath))
  })
  if (missing.length > 0) {
    throw new Error(`Missing node-pty Darwin prebuilds: ${missing.join(', ')}`)
  }
  for (const relativePath of DARWIN_NODE_PTY_EXECUTABLE_PREBUILDS) {
    const helperPath = path.join(nodePtyDir, relativePath)
    const mode = fs.statSync(helperPath).mode & 0o777
    if ((mode & 0o111) !== 0o111) {
      fs.chmodSync(helperPath, mode | 0o755)
    }
  }
  return DARWIN_NODE_PTY_PREBUILDS
}

function pruneMacNodePtyHostBuild(repoRoot) {
  const buildDir = path.join(packageDir(repoRoot, 'node-pty'), 'build')
  const existed = fs.existsSync(buildDir)
  fs.rmSync(buildDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
  return existed
}

function hasNativeNodeBinding(packagePath) {
  if (!fs.existsSync(packagePath)) return false
  try {
    return fs.readdirSync(packagePath).some((entry) => entry.endsWith('.node'))
  } catch {
    return false
  }
}

function missingPackages(repoRoot, packages) {
  return packages.filter(({ name }) => {
    const packagePath = packageDir(repoRoot, name)
    const packageJson = path.join(packagePath, 'package.json')
    const claudeBinary = path.join(packagePath, 'claude')
    return !fs.existsSync(packageJson) || !fs.existsSync(claudeBinary)
  })
}

function missingNapiCanvasPackages(repoRoot, packages) {
  return packages.filter(({ name }) => {
    const packagePath = packageDir(repoRoot, name)
    const packageJson = path.join(packagePath, 'package.json')
    return !fs.existsSync(packageJson) || !hasNativeNodeBinding(packagePath)
  })
}

function parseNpmPackOutput(output) {
  const parsed = JSON.parse(String(output || '').trim())
  if (!Array.isArray(parsed) || !parsed[0] || typeof parsed[0].filename !== 'string') {
    throw new Error(`Unexpected npm pack output: ${String(output || '').slice(0, 200)}`)
  }
  return parsed[0].filename
}

function installPackageFromPack({ repoRoot, npmCommand, exec, packageInfo }) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-optional-dep-'))
  try {
    const packOutput = exec(
      npmCommand,
      ['pack', '--json', '--ignore-scripts', '--pack-destination', tempRoot, packageInfo.spec],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit']
      }
    )
    const filename = parseNpmPackOutput(packOutput)
    const tarballPath = path.join(tempRoot, filename)
    const extractRoot = path.join(tempRoot, 'extract')
    fs.mkdirSync(extractRoot)

    exec('tar', ['-xzf', tarballPath, '-C', extractRoot], {
      cwd: repoRoot,
      stdio: 'inherit'
    })

    const unpackedPackage = path.join(extractRoot, 'package')
    const destination = packageDir(repoRoot, packageInfo.name)
    fs.rmSync(destination, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.cpSync(unpackedPackage, destination, { recursive: true })
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

function ensureMacUniversalOptionalDeps({
  repoRoot = process.cwd(),
  platform = process.platform,
  npmCommand = 'npm',
  exec = execFileSync
} = {}) {
  if (platform !== 'darwin') {
    return { installed: false, reason: `skipped on ${platform}`, specs: [] }
  }

  const lockPath = path.join(repoRoot, 'package-lock.json')
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
  const claudePackages = resolveDarwinClaudeSdkPackages(lock)
  const canvasPackages = resolveDarwinNapiCanvasPackages(lock)
  const missingClaude = missingPackages(repoRoot, claudePackages)
  const missingCanvas = missingNapiCanvasPackages(repoRoot, canvasPackages)
  const missing = [...missingClaude, ...missingCanvas]

  for (const packageInfo of missing) {
    installPackageFromPack({ repoRoot, npmCommand, exec, packageInfo })
  }
  ensureDarwinNodePtyPrebuilds(repoRoot)
  const prunedNodePtyHostBuild = pruneMacNodePtyHostBuild(repoRoot)
  if (missing.length === 0) {
    return {
      installed: false,
      reason: prunedNodePtyHostBuild ? 'already present; pruned node-pty host build' : 'already present',
      prunedNodePtyHostBuild,
      specs: []
    }
  }
  return {
    installed: true,
    reason: 'installed missing packages',
    prunedNodePtyHostBuild,
    specs: missing.map(({ spec }) => spec)
  }
}

function main() {
  const result = ensureMacUniversalOptionalDeps()
  if (result.specs.length > 0) {
    console.log(`Prepared mac universal optional deps: ${result.specs.join(', ')}`)
  } else {
    console.log(`Prepared mac universal optional deps: ${result.reason}`)
  }
}

if (require.main === module) {
  main()
}

module.exports = {
  DARWIN_CLAUDE_SDK_PACKAGES,
  DARWIN_NAPI_CANVAS_PACKAGES,
  DARWIN_NODE_PTY_EXECUTABLE_PREBUILDS,
  DARWIN_NODE_PTY_PREBUILDS,
  ensureDarwinNodePtyPrebuilds,
  ensureMacUniversalOptionalDeps,
  installPackageFromPack,
  missingNapiCanvasPackages,
  missingPackageSpecs,
  missingPackages,
  parseNpmPackOutput,
  pruneMacNodePtyHostBuild,
  resolveDarwinClaudeSdkPackages,
  resolveDarwinNapiCanvasPackages
}
