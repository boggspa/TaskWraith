#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const WORKFLOW_NAME = 'Provider permission conformance'
const RELEASE_ACTION = 'provider-permission-release'
const DEFAULT_MAX_AGE_HOURS = 24
const UTC_ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

function parseUtcIsoInstant(value) {
  if (typeof value !== 'string') return Number.NaN
  const match = value.match(UTC_ISO_INSTANT)
  if (!match) return Number.NaN
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = ''] = match
  const fields = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number)
  const [year, month, day, hour, minute, second] = fields
  const millisecond = Number(fraction.padEnd(3, '0'))
  const instant = new Date(0)
  instant.setUTCFullYear(year, month - 1, day)
  instant.setUTCHours(hour, minute, second, millisecond)
  if (
    instant.getUTCFullYear() !== year ||
    instant.getUTCMonth() !== month - 1 ||
    instant.getUTCDate() !== day ||
    instant.getUTCHours() !== hour ||
    instant.getUTCMinutes() !== minute ||
    instant.getUTCSeconds() !== second ||
    instant.getUTCMilliseconds() !== millisecond
  ) {
    return Number.NaN
  }
  return instant.getTime()
}

function expectedReleaseRunName(sha) {
  return `${RELEASE_ACTION} @ ${sha}`
}

function successfulReleaseAttestation(payload, options) {
  if (!payload || !Array.isArray(payload.workflow_runs)) {
    throw new Error('GitHub workflow-runs response is missing workflow_runs.')
  }
  const expectedName = options.runName || expectedReleaseRunName(options.sha)
  const nowMs = parseUtcIsoInstant(options.now)
  const maxAgeMs = options.maxAgeHours * 60 * 60 * 1000
  const candidates = payload.workflow_runs.filter(
    (run) =>
      run &&
      run.name === WORKFLOW_NAME &&
      run.display_title === expectedName &&
      run.head_sha === options.sha &&
      run.head_branch === options.defaultBranch &&
      run.event === 'repository_dispatch'
  )
  if (candidates.length === 0) return null
  const keyed = candidates.map((run) => ({
    run,
    createdAt: parseUtcIsoInstant(run.created_at),
    id: Number(run.id)
  }))
  if (
    keyed.some(
      (candidate) => !Number.isFinite(candidate.createdAt) || !Number.isFinite(candidate.id)
    )
  ) {
    return null
  }
  keyed.sort((left, right) => left.createdAt - right.createdAt || left.id - right.id)
  const newest = keyed.at(-1)
  const ageMs = nowMs - newest.createdAt
  if (
    newest.run.status !== 'completed' ||
    newest.run.conclusion !== 'success' ||
    newest.run.run_attempt !== 1 ||
    ageMs < 0 ||
    ageMs > maxAgeMs
  ) {
    return null
  }
  return newest.run
}

function parseArgs(argv) {
  const options = {
    input: null,
    sha: null,
    defaultBranch: 'master',
    runName: null,
    now: null,
    maxAgeHours: DEFAULT_MAX_AGE_HOURS
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const match = arg.match(/^--(input|sha|default-branch|run-name|now|max-age-hours)(?:=(.*))?$/)
    if (!match) throw new Error(`Unknown option: ${arg}`)
    const value = match[2] ?? argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`--${match[1]} requires a value.`)
    if (match[1] === 'input') options.input = value
    else if (match[1] === 'sha') options.sha = value
    else if (match[1] === 'default-branch') options.defaultBranch = value
    else if (match[1] === 'run-name') options.runName = value
    else if (match[1] === 'now') options.now = value
    else options.maxAgeHours = Number(value)
  }
  if (!options.input) throw new Error('--input is required.')
  if (!options.sha || !/^[0-9a-f]{40,64}$/i.test(options.sha)) {
    throw new Error('--sha must be a full hexadecimal commit id.')
  }
  if (!Number.isFinite(parseUtcIsoInstant(options.now))) {
    throw new Error('--now must be a UTC ISO-8601 timestamp.')
  }
  if (!Number.isFinite(options.maxAgeHours) || options.maxAgeHours <= 0) {
    throw new Error('--max-age-hours must be a positive number.')
  }
  return options
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const inputPath = path.resolve(options.input)
  const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
  const run = successfulReleaseAttestation(payload, options)
  if (!run) {
    process.stderr.write(
      `[provider-attestation] no fresh successful exact-SHA ${RELEASE_ACTION} run found for ${options.sha}\n`
    )
    return 1
  }
  process.stdout.write(
    `[provider-attestation] accepted run_id=${run.id} head_sha=${run.head_sha}\n`
  )
  return 0
}

if (require.main === module) {
  try {
    process.exitCode = main()
  } catch (error) {
    process.stderr.write(`[provider-attestation] ${error.message}\n`)
    process.exitCode = 2
  }
}

module.exports = {
  expectedReleaseRunName,
  parseArgs,
  successfulReleaseAttestation
}
