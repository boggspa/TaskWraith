#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const DAY_MS = 24 * 60 * 60 * 1000
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/

function validateRuntimePolicy(packageJson, now = new Date()) {
  const errors = []
  const policy = packageJson?.taskwraithRelease?.tuiNodeRuntime
  if (!policy || typeof policy !== 'object') {
    return ['package.json is missing taskwraithRelease.tuiNodeRuntime']
  }

  const version = String(policy.version || '')
  if (!VERSION_PATTERN.test(version)) {
    errors.push(`TUI Node runtime policy has an invalid version: ${version || '<missing>'}`)
  } else if (!version.startsWith('22.')) {
    errors.push(`TUI Node runtime policy must stay on the supported Node 22 LTS line: ${version}`)
  }

  const releasedOn = String(policy.releasedOn || '')
  const releasedAt = /^\d{4}-\d{2}-\d{2}$/.test(releasedOn)
    ? Date.parse(`${releasedOn}T00:00:00.000Z`)
    : Number.NaN
  if (!Number.isFinite(releasedAt)) {
    errors.push(
      `TUI Node runtime policy has an invalid releasedOn date: ${releasedOn || '<missing>'}`
    )
  }

  const maximumAgeDays = policy.maximumAgeDays
  if (!Number.isInteger(maximumAgeDays) || maximumAgeDays < 1 || maximumAgeDays > 90) {
    errors.push(
      `TUI Node runtime policy maximumAgeDays must be an integer from 1 to 90: ${String(
        maximumAgeDays
      )}`
    )
  }

  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime()
  if (!Number.isFinite(nowMs)) {
    errors.push('TUI Node runtime policy check received an invalid current date')
  } else if (Number.isFinite(releasedAt) && Number.isInteger(maximumAgeDays)) {
    const ageDays = Math.floor((nowMs - releasedAt) / DAY_MS)
    if (ageDays < -1) {
      errors.push(`TUI Node runtime release date ${releasedOn} is in the future`)
    } else if (ageDays > maximumAgeDays) {
      errors.push(
        `TUI Node runtime ${version} is ${ageDays} days old; policy maximum is ${maximumAgeDays} days`
      )
    }
  }

  return errors
}

function resolveRuntimeNodeVersion(packageJson, env = process.env, now = new Date()) {
  const errors = validateRuntimePolicy(packageJson, now)
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }

  const policyVersion = packageJson.taskwraithRelease.tuiNodeRuntime.version
  const override = String(env.TASKWRAITH_TUI_NODE_VERSION || '').replace(/^v/, '')
  if (override && override !== policyVersion) {
    throw new Error(
      `TASKWRAITH_TUI_NODE_VERSION=${override} does not match package policy ${policyVersion}`
    )
  }
  return policyVersion
}

function readPackageJson(repoRoot = process.cwd()) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
}

function runCli(repoRoot = process.cwd(), env = process.env, now = new Date()) {
  try {
    const packageJson = readPackageJson(repoRoot)
    const version = resolveRuntimeNodeVersion(packageJson, env, now)
    const policy = packageJson.taskwraithRelease.tuiNodeRuntime
    console.log(
      `[tui-runtime-policy] Node ${version}, released ${policy.releasedOn}, maximum age ${policy.maximumAgeDays} days`
    )
    return 0
  } catch (error) {
    console.error(`[tui-runtime-policy] ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (require.main === module) {
  process.exitCode = runCli()
}

module.exports = {
  readPackageJson,
  resolveRuntimeNodeVersion,
  runCli,
  validateRuntimePolicy
}
