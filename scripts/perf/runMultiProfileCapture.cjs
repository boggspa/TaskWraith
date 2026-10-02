'use strict'

const fs = require('node:fs')
const path = require('node:path')
const {
  buildMultiProfileConfiguration,
  runMultiProfileConfiguration,
  CONFIGURATIONS
} = require('./multiProfileCoordinator.cjs')
const { createMultiProfileLifecycle } = require('./multiProfileLifecycle.cjs')
const { parseCellName } = require('./interferenceMatrix.cjs')
const { parseRolloutFlagNames } = require('./rolloutFlags.cjs')

async function runMultiProfileCapture(argv = process.argv.slice(2), dependencies = {}) {
  const args = { flags: [] }
  for (const arg of argv) {
    if (['--dry-plan', '--launch', '--i-accept-isolated-launch'].includes(arg))
      args[arg.slice(2)] = true
    else {
      const match =
        /^--(configuration|home|repo-root|artifact-dir|cell|build-id|seed|port-base|inspect-base|flag)=(.+)$/.exec(
          arg
        )
      if (!match) throw new Error('Unknown capture argument')
      if (match[1] === 'flag') args.flags.push(match[2])
      else args[match[1]] = match[2]
    }
  }
  if (args.launch && (args['dry-plan'] || !args['i-accept-isolated-launch']))
    throw new Error('Explicit isolated launch acceptance required')
  if (!CONFIGURATIONS[args.configuration]) throw new Error('Named configuration required')
  for (const key of ['home', 'artifact-dir', 'cell', 'build-id']) {
    if (!args[key]) throw new Error(`${key} required`)
  }
  if (!path.isAbsolute(args['artifact-dir']))
    throw new Error('Absolute artifact directory required')
  parseCellName(args.cell)
  args.flags = parseRolloutFlagNames(args.flags)
  const count = CONFIGURATIONS[args.configuration].length
  const portBase = Number(args['port-base'] || 9400)
  const inspectorBase = Number(args['inspect-base'] || 9800)
  const options = {
    workload: 'light_beside_large_live',
    configuration: args.configuration,
    repoRoot: path.resolve(args['repo-root'] || path.join(__dirname, '../..')),
    home: args.home,
    artifactDir: args['artifact-dir'],
    cell: args.cell,
    buildId: args['build-id'],
    seed: args.seed || '1',
    flags: args.flags,
    instances: Array.from({ length: count }, (_, index) => ({
      instanceId: `gh-${args.configuration}-${index}`
        .replace('active-alone', 'alone')
        .replace('one-restart', 'restart'),
      remoteDebuggingPort: portBase + index,
      mainInspectorPort: inspectorBase + index
    }))
  }
  const plan = buildMultiProfileConfiguration(options)
  if (!args.launch)
    return {
      dryPlan: true,
      plan,
      evidenceEligibility: 'diagnostic-live-windows',
      acceptance: 'unmeasured'
    }
  const controller = new AbortController()
  const signalSource = dependencies.signalSource || process
  let cancelledSignal = null
  const interrupt = () => {
    cancelledSignal = 'SIGINT'
    controller.abort()
  }
  const terminate = () => {
    cancelledSignal = 'SIGTERM'
    controller.abort()
  }
  signalSource.on('SIGINT', interrupt)
  signalSource.on('SIGTERM', terminate)
  let lifecycle
  let report
  try {
    lifecycle = (dependencies.createLifecycle || createMultiProfileLifecycle)({
      ...options,
      signal: controller.signal
    })
    report = await (dependencies.runConfiguration || runMultiProfileConfiguration)(
      options,
      lifecycle
    )
  } finally {
    try {
      if (lifecycle?.cancel) await lifecycle.cancel()
    } finally {
      signalSource.removeListener('SIGINT', interrupt)
      signalSource.removeListener('SIGTERM', terminate)
    }
  }
  if (cancelledSignal) {
    report.ok = false
    report.cancelled = true
    report.cancelledSignal = cancelledSignal
    report.exitCode = cancelledSignal === 'SIGINT' ? 130 : 143
  }
  report.phaseReports = lifecycle.phaseReports
  report.evidenceEligibility = 'diagnostic-live-windows'
  fs.mkdirSync(options.artifactDir, { recursive: true })
  fs.writeFileSync(
    path.join(options.artifactDir, 'gh-capture-report.json'),
    JSON.stringify(report, null, 2) + '\n'
  )
  return report
}

if (require.main === module) {
  runMultiProfileCapture().then(
    (result) => {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n')
      if (result.ok === false) process.exitCode = result.exitCode || 1
    },
    () => {
      process.stderr.write('G-H capture failed; inspect owned capture artifacts\n')
      process.exitCode = 1
    }
  )
}

module.exports = { runMultiProfileCapture }
