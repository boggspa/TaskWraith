#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const {
  DEFAULT_RELEASE_BASE_URL,
  SOURCE_VERSION,
  validateBuilderIdentityFiles,
  validateManifest,
  verifyArtifactDirectory
} = require('./identity-handoff-manifest.cjs')

const DEFAULT_PAYLOAD = '.local-only/identity-handoff/identity-handoff.json'
const DEFAULT_ARTIFACT_DIR = '.local-only/identity-handoff/artifacts'
const ALLOWED_BUILD_SCRIPTS = new Set([
  'build:mac:notarized',
  'build:win:signed:handoff-smoke',
  'build:linux:nopublish'
])

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`)
    values[arg.slice(2)] = value
    index += 1
  }
  if (!values.script) throw new Error('--script is required')
  if (!ALLOWED_BUILD_SCRIPTS.has(values.script)) {
    throw new Error(`Unsupported final-beta build script: ${values.script}`)
  }
  return {
    script: values.script,
    payload: values.payload || DEFAULT_PAYLOAD,
    artifactDir: values['artifact-dir'] || DEFAULT_ARTIFACT_DIR,
    baseUrl: values['base-url'] || DEFAULT_RELEASE_BASE_URL
  }
}

async function prepareHandoffBuild(
  options,
  repoRoot = process.cwd(),
  resolveCommit = (root) =>
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
) {
  const payloadPath = path.resolve(repoRoot, options.payload)
  const artifactDir = path.resolve(repoRoot, options.artifactDir)
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(payloadPath, 'utf8'))
  } catch (error) {
    throw new Error(
      `Prepared identity handoff payload is unreadable at ${payloadPath}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const errors = [
    ...validateBuilderIdentityFiles(repoRoot),
    ...validateManifest(manifest, {
      requirePrepared: true,
      expectedBaseUrl: options.baseUrl
    }),
    ...(await verifyArtifactDirectory(manifest, artifactDir))
  ]
  let packageVersion
  try {
    packageVersion = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
    ).version
  } catch (error) {
    errors.push(
      `package.json is unreadable: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (packageVersion !== SOURCE_VERSION) {
    errors.push(
      `final-beta package version must be exactly ${SOURCE_VERSION}, got ${packageVersion}`
    )
  }
  const currentCommit = resolveCommit(repoRoot)
  if (manifest.sourceCommit !== currentCommit) {
    errors.push(
      `payload sourceCommit ${String(manifest.sourceCommit)} does not match current HEAD ${currentCommit}`
    )
  }
  if (errors.length > 0) {
    throw new Error(`Identity handoff build preflight failed:\n${errors.join('\n')}`)
  }
  return {
    script: options.script,
    payloadPath,
    artifactDir,
    env: {
      TASKWRAITH_IDENTITY_HANDOFF_PAYLOAD: payloadPath,
      TASKWRAITH_IDENTITY_HANDOFF_SOURCE_COMMIT: currentCommit,
      ...(options.baseUrl !== DEFAULT_RELEASE_BASE_URL
        ? { TASKWRAITH_HANDOFF_REHEARSAL_BASE_URL: options.baseUrl }
        : {})
    }
  }
}

async function runCli(
  argv = process.argv.slice(2),
  repoRoot = process.cwd(),
  run = (command, args, options) => spawnSync(command, args, options),
  resolveCommit
) {
  const prepared = await prepareHandoffBuild(parseArgs(argv), repoRoot, resolveCommit)
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = run(npmCommand, ['run', prepared.script], {
    cwd: repoRoot,
    env: { ...process.env, ...prepared.env },
    encoding: 'utf8',
    stdio: 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Identity handoff build ${prepared.script} exited ${result.status ?? 'null'}.`)
  }
  return 0
}

if (require.main === module) {
  runCli().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(
        `[identity-handoff-build] ${error instanceof Error ? error.message : String(error)}`
      )
      process.exitCode = 1
    }
  )
}

module.exports = {
  DEFAULT_ARTIFACT_DIR,
  DEFAULT_PAYLOAD,
  parseArgs,
  prepareHandoffBuild,
  runCli
}
