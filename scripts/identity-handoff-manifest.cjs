#!/usr/bin/env node

const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const {
  createReadStream,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  statSync,
  writeFileSync
} = require('node:fs')
const { basename, dirname, join, resolve } = require('node:path')

const REPO_ROOT = join(__dirname, '..')
const SCHEMA_VERSION = 1
const HANDOFF_ID = 'taskwraith-1.9.9-to-0.1.0-v1'
const SOURCE_VERSION = '1.9.9'
const TARGET_VERSION = '0.1.0'
const SOURCE_APP_ID = 'com.chrisizatt.taskwraith'
const TARGET_APP_ID = 'com.taskwraith.desktop'
const DEFAULT_MANIFEST_PATH = join(REPO_ROOT, 'resources', 'identity-handoff.json')
const DEFAULT_RELEASE_BASE_URL = 'https://github.com/boggspa/TaskWraith/releases/download/v0.1.0'

const ARTIFACT_CONTRACT = Object.freeze({
  'darwin-universal': {
    platform: 'darwin',
    arch: 'universal',
    fileName: 'TaskWraith-0.1.0-universal-mac.dmg',
    launchKind: 'dmg',
    instructions:
      'Open the disk image, replace TaskWraith in Applications, then launch TaskWraith Release. The beta app remains the repair/retry surface until Release writes the completion receipt.'
  },
  'win32-x64': {
    platform: 'win32',
    arch: 'x64',
    fileName: 'TaskWraith-0.1.0-win-x64-setup.exe',
    launchKind: 'nsis',
    instructions:
      'Complete the signed TaskWraith Release installer, then launch TaskWraith. Windows verifies the publisher and the 1.9.9 payload independently pins the exact installer hash.'
  },
  'win32-arm64': {
    platform: 'win32',
    arch: 'arm64',
    fileName: 'TaskWraith-0.1.0-win-arm64-setup.exe',
    launchKind: 'nsis',
    instructions:
      'Complete the signed TaskWraith Release installer, then launch TaskWraith. Windows verifies the publisher and the 1.9.9 payload independently pins the exact installer hash.'
  },
  'linux-x64': {
    platform: 'linux',
    arch: 'x64',
    fileName: 'TaskWraith-0.1.0.AppImage',
    launchKind: 'appimage',
    instructions:
      'Launch the verified TaskWraith Release AppImage and replace your beta launcher or desktop entry when ready. Keep the beta package only for bounded repair.'
  }
})

function baseManifest(prepared, artifacts = {}, sourceCommit = null) {
  return {
    schemaVersion: SCHEMA_VERSION,
    handoffId: HANDOFF_ID,
    prepared,
    sourceCommit,
    source: {
      distributionIdentity: 'beta',
      appId: SOURCE_APP_ID,
      version: SOURCE_VERSION,
      updateFeedChannel: 'latest'
    },
    target: {
      distributionIdentity: 'release',
      appId: TARGET_APP_ID,
      version: TARGET_VERSION,
      updateFeedChannel: 'release'
    },
    supportUrl: 'https://github.com/boggspa/TaskWraith/releases/tag/v0.1.0',
    artifacts
  }
}

async function sha256File(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

async function prepareManifest(artifactDir, baseUrl = DEFAULT_RELEASE_BASE_URL, sourceCommit) {
  const normalizedBaseUrl = normalizeReleaseBaseUrl(baseUrl)
  if (!normalizedBaseUrl) {
    throw new Error('Identity handoff base URL must be the HTTPS TaskWraith GitHub release path.')
  }
  const artifacts = {}
  for (const [key, contract] of Object.entries(ARTIFACT_CONTRACT)) {
    const filePath = join(artifactDir, contract.fileName)
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      throw new Error(`Missing frozen identity-handoff artifact: ${contract.fileName}`)
    }
    if (contract.platform === 'win32' && !hasAuthenticodeCertificate(filePath)) {
      throw new Error(
        `Final identity-handoff Windows artifact has no Authenticode certificate: ${contract.fileName}`
      )
    }
    const stat = statSync(filePath)
    artifacts[key] = {
      ...contract,
      url: `${normalizedBaseUrl}/${encodeURIComponent(contract.fileName)}`,
      size: stat.size,
      sha256: await sha256File(filePath)
    }
  }
  return baseManifest(true, artifacts, sourceCommit)
}

function validateManifest(manifest, options = {}) {
  const errors = []
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['identity-handoff manifest must be an object']
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION) errors.push('schemaVersion must be 1')
  if (manifest.handoffId !== HANDOFF_ID) errors.push(`handoffId must be ${HANDOFF_ID}`)
  if (typeof manifest.prepared !== 'boolean') errors.push('prepared must be boolean')
  if (
    (manifest.prepared && !isGitCommit(manifest.sourceCommit)) ||
    (!manifest.prepared && manifest.sourceCommit !== null)
  ) {
    errors.push('sourceCommit must be null for the template or an exact commit for a payload')
  }
  if (
    !manifest.source ||
    manifest.source.distributionIdentity !== 'beta' ||
    manifest.source.appId !== SOURCE_APP_ID ||
    manifest.source.version !== SOURCE_VERSION ||
    manifest.source.updateFeedChannel !== 'latest'
  ) {
    errors.push('source identity/version/feed declaration drifted')
  }
  if (
    !manifest.target ||
    manifest.target.distributionIdentity !== 'release' ||
    manifest.target.appId !== TARGET_APP_ID ||
    manifest.target.version !== TARGET_VERSION ||
    manifest.target.updateFeedChannel !== 'release'
  ) {
    errors.push('target identity/version/feed declaration drifted')
  }
  if (!isHttpsUrl(manifest.supportUrl)) errors.push('supportUrl must be HTTPS')
  const artifacts = manifest.artifacts
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    errors.push('artifacts must be an object')
    return errors
  }
  const keys = Object.keys(artifacts)
  if (!manifest.prepared && keys.length > 0) {
    errors.push('unprepared manifest must not contain artifacts')
  }
  if ((options.requirePrepared || manifest.prepared) && !manifest.prepared) {
    errors.push('the 1.9.9 ship gate requires a prepared artifact inventory')
  }
  if (manifest.prepared) {
    const expectedBaseUrl = normalizeReleaseBaseUrl(
      options.expectedBaseUrl || DEFAULT_RELEASE_BASE_URL
    )
    if (!expectedBaseUrl) {
      errors.push('expectedBaseUrl must be the HTTPS TaskWraith GitHub release path')
      return errors
    }
    for (const key of Object.keys(ARTIFACT_CONTRACT)) {
      const contract = ARTIFACT_CONTRACT[key]
      const artifact = artifacts[key]
      if (!artifact) {
        errors.push(`missing artifact ${key}`)
        continue
      }
      const expectedUrl = `${expectedBaseUrl}/${encodeURIComponent(contract.fileName)}`
      if (
        artifact.platform !== contract.platform ||
        artifact.arch !== contract.arch ||
        artifact.fileName !== contract.fileName ||
        artifact.launchKind !== contract.launchKind ||
        artifact.instructions !== contract.instructions
      ) {
        errors.push(`${key} identity-handoff declaration drifted`)
      }
      if (artifact.url !== expectedUrl) errors.push(`${key} URL must be ${expectedUrl}`)
      if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) {
        errors.push(`${key} size must be a positive integer`)
      }
      if (typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
        errors.push(`${key} sha256 must be a lowercase 64-character digest`)
      }
    }
    for (const key of keys) {
      if (!ARTIFACT_CONTRACT[key]) errors.push(`unexpected artifact ${key}`)
    }
  }
  return errors
}

async function verifyArtifactDirectory(manifest, artifactDir) {
  const errors = []
  if (!manifest.prepared) return ['cannot verify artifacts from an unprepared manifest']
  for (const [key, contract] of Object.entries(ARTIFACT_CONTRACT)) {
    const artifact = manifest.artifacts[key]
    if (!artifact) continue
    const filePath = join(artifactDir, contract.fileName)
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      errors.push(`missing artifact bytes ${contract.fileName}`)
      continue
    }
    const stat = statSync(filePath)
    if (stat.size !== artifact.size) errors.push(`${contract.fileName} size mismatch`)
    if ((await sha256File(filePath)) !== artifact.sha256) {
      errors.push(`${contract.fileName} sha256 mismatch`)
    }
  }
  return errors
}

function validateBuilderIdentityFiles(repoRoot = REPO_ROOT) {
  const errors = []
  const beta = readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8')
  const release = readFileSync(join(repoRoot, 'electron-builder.debut.yml'), 'utf8')
  const combined = `${beta}\n${release}`
  for (const [text, label] of [
    [beta, `appId: ${SOURCE_APP_ID}`],
    [beta, 'taskwraithDistributionIdentity: beta'],
    [beta, 'taskwraithUpdateFeedChannel: latest'],
    [release, `appId: ${TARGET_APP_ID}`],
    [release, `version: ${TARGET_VERSION}`],
    [release, 'taskwraithDistributionIdentity: release'],
    [release, 'taskwraithUpdateFeedChannel: release'],
    [release, 'generateUpdatesFilesForAllChannels: false'],
    [release, 'channel: release']
  ]) {
    if (!text.includes(label)) errors.push(`builder identity is missing ${label}`)
  }
  if (/allowDowngrade\s*:\s*true/i.test(combined)) {
    errors.push('allowDowngrade must never be enabled for the identity handoff')
  }
  return errors
}

function isHttpsUrl(value) {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}

function normalizeReleaseBaseUrl(value) {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'github.com' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/boggspa\/TaskWraith\/releases\/download\/[^/]+\/?$/.test(url.pathname)
    ) {
      return undefined
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return undefined
  }
}

function hasAuthenticodeCertificate(filePath) {
  let fd
  try {
    const fileSize = statSync(filePath).size
    if (fileSize < 256) return false
    fd = openSync(filePath, 'r')
    const dos = readBytes(fd, 64, 0)
    if (dos[0] !== 0x4d || dos[1] !== 0x5a) return false
    const peOffset = dos.readUInt32LE(0x3c)
    if (peOffset <= 0 || peOffset + 192 > fileSize) return false
    const header = readBytes(fd, 192, peOffset)
    if (header.toString('ascii', 0, 4) !== 'PE\0\0') return false
    const optionalOffset = 24
    const magic = header.readUInt16LE(optionalOffset)
    const directoryOffset =
      magic === 0x10b ? optionalOffset + 96 : magic === 0x20b ? optionalOffset + 112 : 0
    const countOffset =
      magic === 0x10b ? optionalOffset + 92 : magic === 0x20b ? optionalOffset + 108 : 0
    if (!directoryOffset || header.readUInt32LE(countOffset) < 5) return false
    const securityOffset = directoryOffset + 4 * 8
    const certificateFileOffset = header.readUInt32LE(securityOffset)
    const certificateSize = header.readUInt32LE(securityOffset + 4)
    if (
      certificateFileOffset <= 0 ||
      certificateSize < 8 ||
      certificateFileOffset + certificateSize > fileSize
    ) {
      return false
    }
    const certificate = readBytes(fd, 8, certificateFileOffset)
    const certificateLength = certificate.readUInt32LE(0)
    const revision = certificate.readUInt16LE(4)
    const certificateType = certificate.readUInt16LE(6)
    return (
      certificateLength >= 8 &&
      certificateLength <= certificateSize &&
      revision === 0x0200 &&
      certificateType === 0x0002
    )
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function readBytes(fd, length, position) {
  const buffer = Buffer.alloc(length)
  const bytesRead = readSync(fd, buffer, 0, length, position)
  if (bytesRead !== length) throw new Error('Unexpected end of PE file.')
  return buffer
}

function isGitCommit(value) {
  return typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value)
}

function resolveSourceCommit(repoRoot) {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8'
  }).trim()
}

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'verify'
  const rest = command === argv[0] ? argv.slice(1) : argv
  const values = {}
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`)
    const key = arg.slice(2)
    const value = rest[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`)
    values[key] = value
    index += 1
  }
  return { command, values }
}

async function runCli(argv = process.argv.slice(2), env = process.env) {
  const { command, values } = parseArgs(argv)
  const manifestPath = resolve(values.manifest || values.output || DEFAULT_MANIFEST_PATH)
  if (command === 'prepare') {
    if (!values['artifact-dir']) throw new Error('prepare requires --artifact-dir')
    const sourceCommit = values['source-commit'] || resolveSourceCommit(REPO_ROOT)
    const manifest = await prepareManifest(
      resolve(values['artifact-dir']),
      values['base-url'] || DEFAULT_RELEASE_BASE_URL,
      sourceCommit
    )
    const errors = validateManifest(manifest, {
      requirePrepared: true,
      expectedBaseUrl: values['base-url'] || DEFAULT_RELEASE_BASE_URL
    })
    if (errors.length > 0) throw new Error(errors.join('\n'))
    mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 })
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`[identity-handoff] prepared ${basename(manifestPath)}`)
    return 0
  }
  if (command !== 'verify') throw new Error(`Unknown command: ${command}`)

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const requirePrepared = env.TASKWRAITH_REQUIRE_PREPARED_HANDOFF === '1'
  const errors = [
    ...validateBuilderIdentityFiles(),
    ...validateManifest(manifest, {
      requirePrepared,
      expectedBaseUrl: env.TASKWRAITH_HANDOFF_REHEARSAL_BASE_URL || DEFAULT_RELEASE_BASE_URL
    })
  ]
  if (values['artifact-dir']) {
    errors.push(...(await verifyArtifactDirectory(manifest, resolve(values['artifact-dir']))))
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`[identity-handoff] ${error}`)
    return 1
  }
  console.log(
    `[identity-handoff] ${manifest.prepared ? 'prepared payload' : 'preparation template'} verified`
  )
  return 0
}

if (require.main === module) {
  runCli().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(`[identity-handoff] ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  )
}

module.exports = {
  ARTIFACT_CONTRACT,
  DEFAULT_RELEASE_BASE_URL,
  HANDOFF_ID,
  hasAuthenticodeCertificate,
  SOURCE_APP_ID,
  SOURCE_VERSION,
  TARGET_APP_ID,
  TARGET_VERSION,
  baseManifest,
  parseArgs,
  prepareManifest,
  normalizeReleaseBaseUrl,
  resolveSourceCommit,
  runCli,
  sha256File,
  validateBuilderIdentityFiles,
  validateManifest,
  verifyArtifactDirectory
}
