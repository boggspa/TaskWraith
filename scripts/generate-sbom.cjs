#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { enrichSbom } = require('./enrich-tui-runtime-sbom.cjs')
const { resolvePlatformCommandInvocation } = require('./windows-cmd-invocation.cjs')

function defaultNpmSbomRunner(
  repoRoot,
  { platform = process.platform, env = process.env, spawn = spawnSync } = {}
) {
  const npmCommand = platform === 'win32' ? 'npm.cmd' : 'npm'
  const invocation = resolvePlatformCommandInvocation(
    npmCommand,
    ['sbom', '--sbom-format=cyclonedx', '--omit=dev'],
    platform,
    env
  )
  return spawn(invocation.command, invocation.arguments, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
    env
  })
}

function generateSbom({
  repoRoot = process.cwd(),
  outputPath = process.env.TASKWRAITH_SBOM_PATH || 'dist/sbom.cdx.json',
  runNpmSbom = defaultNpmSbomRunner
} = {}) {
  const result = runNpmSbom(repoRoot)
  if (result.error) {
    throw new Error(`npm sbom failed to spawn: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`npm sbom exited ${result.status}: ${result.stderr || result.stdout || ''}`)
  }

  let sbom
  try {
    sbom = JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(
      `npm sbom returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const runtimeMetadata = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'build', 'tui-runtime', 'RUNTIME.json'), 'utf8')
  )
  const expectedVersion = packageJson.taskwraithRelease?.tuiNodeRuntime?.version
  const enriched = enrichSbom(sbom, runtimeMetadata, expectedVersion)
  const absoluteOutput = path.resolve(repoRoot, outputPath)
  fs.mkdirSync(path.dirname(absoluteOutput), { recursive: true })
  fs.writeFileSync(absoluteOutput, `${JSON.stringify(enriched, null, 2)}\n`)
  return absoluteOutput
}

function runCli() {
  try {
    const outputPath = generateSbom()
    console.log(`[generate-sbom] wrote ${path.relative(process.cwd(), outputPath)}`)
    return 0
  } catch (error) {
    console.error(`[generate-sbom] ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (require.main === module) {
  process.exitCode = runCli()
}

module.exports = {
  defaultNpmSbomRunner,
  generateSbom,
  runCli
}
