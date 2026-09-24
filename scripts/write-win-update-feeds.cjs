#!/usr/bin/env node

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const WINDOWS_ARCHES = ['x64', 'arm64']

function cleanArtifactName(value) {
  if (!value || typeof value !== 'string') return undefined
  const trimmed = value
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .split(/[?#]/)[0]
  if (!trimmed) return undefined
  return trimmed.split('/').filter(Boolean).pop() || trimmed
}

function readPackageVersion(repoRoot) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  if (!packageJson.version || typeof packageJson.version !== 'string') {
    throw new Error('package.json version is missing.')
  }
  return packageJson.version
}

function sha512Base64(filePath) {
  const hash = crypto.createHash('sha512')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('base64')
}

function findWindowsInstaller(distDir, version, arch) {
  const expectedName = `TaskWraith-${version}-win-${arch}-setup.exe`
  const expectedPath = path.join(distDir, expectedName)
  if (fs.existsSync(expectedPath)) return expectedPath
  throw new Error(`Missing expected Windows ${arch} setup installer: ${expectedPath}`)
}

function writeFeedForArch({ distDir, version, arch, releaseDate, channel }) {
  const installerPath = findWindowsInstaller(distDir, version, arch)
  const artifactName = cleanArtifactName(path.basename(installerPath))
  const blockMapPath = `${installerPath}.blockmap`
  if (!fs.existsSync(blockMapPath)) {
    throw new Error(`Missing blockmap for ${artifactName}: ${blockMapPath}`)
  }
  const stat = fs.statSync(installerPath)
  const digest = sha512Base64(installerPath)
  const feedText = [
    `version: ${version}`,
    'files:',
    `  - url: ${artifactName}`,
    `    sha512: ${digest}`,
    `    size: ${stat.size}`,
    `path: ${artifactName}`,
    `sha512: ${digest}`,
    `releaseDate: '${releaseDate}'`,
    ''
  ].join('\n')
  const channelPrefix = channel || (version.includes('-') ? 'beta' : 'latest')
  const feedNames = [`${channelPrefix}-win-${arch}.yml`]
  for (const feedName of feedNames) {
    fs.writeFileSync(path.join(distDir, feedName), feedText)
  }
  return { arch, artifactName, feedNames }
}

function writeWindowsUpdateFeeds({
  repoRoot = process.cwd(),
  distDir = path.join(repoRoot, 'dist'),
  version: versionOverride,
  channel
} = {}) {
  if (!fs.existsSync(distDir)) {
    throw new Error(`Windows dist directory was not found: ${distDir}`)
  }
  const version = versionOverride || readPackageVersion(repoRoot)
  const releaseDate = new Date().toISOString()
  const results = WINDOWS_ARCHES.map((arch) =>
    writeFeedForArch({ distDir, version, arch, releaseDate, channel })
  )
  if (channel) {
    const allowed = new Set(results.flatMap((result) => result.feedNames))
    for (const entry of fs.readdirSync(distDir, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        /^(?:latest|beta|release)(?:-win-(?:x64|arm64))?\.ya?ml$/i.test(entry.name) &&
        !allowed.has(entry.name)
      ) {
        fs.rmSync(path.join(distDir, entry.name))
      }
    }
  }
  return results
}

function runCli(argv = process.argv.slice(2)) {
  const repoRoot = process.cwd()
  const parsed = parseCliArgs(argv)
  const distDir = path.resolve(repoRoot, parsed.targets[0] || 'dist')
  const results = writeWindowsUpdateFeeds({
    repoRoot,
    distDir,
    version: parsed.version,
    channel: parsed.channel
  })
  for (const result of results) {
    console.log(
      `[write-win-update-feeds] ${result.arch}: ${result.artifactName} -> ${result.feedNames.join(', ')}`
    )
  }
  return 0
}

function parseCliArgs(argv) {
  const options = { targets: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--version' || arg === '--channel') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`)
      options[arg.slice(2)] = value
      index += 1
      continue
    }
    options.targets.push(arg)
  }
  if (options.targets.length > 1) throw new Error('Only one dist directory may be provided.')
  return options
}

if (require.main === module) {
  try {
    process.exitCode = runCli()
  } catch (error) {
    console.error(
      `[write-win-update-feeds] ${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 1
  }
}

module.exports = {
  WINDOWS_ARCHES,
  cleanArtifactName,
  parseCliArgs,
  writeWindowsUpdateFeeds
}
