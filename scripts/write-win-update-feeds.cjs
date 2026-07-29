#!/usr/bin/env node

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const WINDOWS_ARCHES = ['x64', 'arm64']

function cleanArtifactName(value) {
  if (!value || typeof value !== 'string') return undefined
  const trimmed = value.trim().replace(/^['"]|['"]$/g, '').split(/[?#]/)[0]
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

function writeFeedForArch({ distDir, version, arch, releaseDate }) {
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
  const channelPrefix = version.includes('-') ? 'beta' : 'latest'
  const feedNames = [`${channelPrefix}-win-${arch}.yml`]
  for (const feedName of feedNames) {
    fs.writeFileSync(path.join(distDir, feedName), feedText)
  }
  return { arch, artifactName, feedNames }
}

function writeWindowsUpdateFeeds({ repoRoot = process.cwd(), distDir = path.join(repoRoot, 'dist') } = {}) {
  if (!fs.existsSync(distDir)) {
    throw new Error(`Windows dist directory was not found: ${distDir}`)
  }
  const version = readPackageVersion(repoRoot)
  const releaseDate = new Date().toISOString()
  return WINDOWS_ARCHES.map((arch) => writeFeedForArch({ distDir, version, arch, releaseDate }))
}

function runCli(argv = process.argv.slice(2)) {
  const repoRoot = process.cwd()
  const distDir = path.resolve(repoRoot, argv[0] || 'dist')
  const results = writeWindowsUpdateFeeds({ repoRoot, distDir })
  for (const result of results) {
    console.log(
      `[write-win-update-feeds] ${result.arch}: ${result.artifactName} -> ${result.feedNames.join(', ')}`
    )
  }
  return 0
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
  writeWindowsUpdateFeeds
}
