#!/usr/bin/env node

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const {
  ARTIFACT_CONTRACT,
  SOURCE_VERSION,
  validateManifest,
  verifyArtifactDirectory
} = require('./identity-handoff-manifest.cjs')

const RELEASE_REPOSITORY = 'boggspa/TaskWraith'
const TARGET_TAG = 'v0.1.0'
const PAYLOAD_NAME = 'identity-handoff.json'

async function prepareCiIdentityHandoff(options, adapters = {}) {
  const repoRoot = options.repoRoot || path.join(__dirname, '..')
  const expectedDigest = options.expectedPayloadSha256
  if (typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    throw new Error('The locally verified handoff payload SHA-256 is required.')
  }
  const downloadTag = options.downloadTag || TARGET_TAG
  if (!/^v0\.1\.0(?:-handoff-rc\.[1-9]\d*)?$/.test(downloadTag)) {
    throw new Error('The target bytes must come from the final release or a handoff candidate.')
  }
  const run = adapters.execFileSync || execFileSync
  const source = run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  if (pkg.version !== SOURCE_VERSION || pkg.taskwraithRelease?.distribution !== 'beta') {
    throw new Error('CI handoff requires the frozen 1.9.9 beta source.')
  }
  const artifactDir = fs.mkdtempSync(path.join(options.temporaryRoot || os.tmpdir(), 'tw-handoff-'))
  const download = (name) =>
    run(
      'gh',
      [
        'release',
        'download',
        downloadTag,
        '--repo',
        RELEASE_REPOSITORY,
        '--pattern',
        name,
        '--dir',
        artifactDir
      ],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
  download(PAYLOAD_NAME)
  const payloadPath = path.join(artifactDir, PAYLOAD_NAME)
  if (fs.statSync(payloadPath).size > 64 * 1024) throw new Error('Handoff payload is oversized.')
  const bytes = fs.readFileSync(payloadPath)
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== expectedDigest) {
    throw new Error('Downloaded handoff payload does not match the approved SHA-256.')
  }
  const manifest = JSON.parse(bytes.toString('utf8'))
  const errors = validateManifest(manifest, { requirePrepared: true })
  if (manifest.sourceCommit !== source) {
    errors.push('Handoff payload belongs to a different source commit.')
  }
  if (errors.length) throw new Error(errors.join('\n'))
  // Download names only from the local frozen contract, never remote manifest text.
  for (const artifact of Object.values(ARTIFACT_CONTRACT)) download(artifact.fileName)
  const byteErrors = await verifyArtifactDirectory(manifest, artifactDir)
  if (byteErrors.length) throw new Error(byteErrors.join('\n'))
  return { payloadPath, artifactDir, sourceCommit: source }
}

async function runCli(env = process.env) {
  const prepared = await prepareCiIdentityHandoff({
    expectedPayloadSha256: env.TASKWRAITH_HANDOFF_PAYLOAD_SHA256,
    downloadTag: env.TASKWRAITH_HANDOFF_DOWNLOAD_TAG
  })
  if (!env.GITHUB_ENV) throw new Error('GITHUB_ENV is required for the CI build handoff.')
  const values = {
    TASKWRAITH_IDENTITY_HANDOFF_PAYLOAD: prepared.payloadPath,
    TASKWRAITH_IDENTITY_HANDOFF_ARTIFACT_DIR: prepared.artifactDir,
    TASKWRAITH_IDENTITY_HANDOFF_SOURCE_COMMIT: prepared.sourceCommit
  }
  for (const value of Object.values(values)) {
    if (/[\r\n]/.test(value)) throw new Error('Invalid multiline CI handoff value.')
  }
  fs.appendFileSync(
    env.GITHUB_ENV,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join('')
  )
  console.log('[identity-handoff-ci] Verified the pinned target inventory for this exact source.')
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error(`[identity-handoff-ci] ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = { prepareCiIdentityHandoff }
