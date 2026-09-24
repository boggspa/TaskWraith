#!/usr/bin/env node
'use strict'

const path = require('path')
const crypto = require('crypto')
const {
  runMultiviewSoak,
  DEFAULT_SOAK_DURATION_MS,
  DEFAULT_SMOKE_DURATION_MS,
  DEFAULT_PANE_COUNT,
  DEFAULT_REPO_COUNT,
  MAX_SOAK_DURATION_MS
} = require('./multiviewSoakDriver.cjs')

const HELP = `Usage: node scripts/perf/runMultiviewSoak.cjs [options]

Build current shared source to unique output and launch an isolated Electron
child. Always diagnostic-only, including dirty source. Real rendered multiview
and saveChat IPC traffic; provider/Ensemble fanout traffic is simulated.

  --smoke                 90 seconds (default: 30 minutes)
  --duration-ms=N         Streaming duration, 5000..14400000
  --panes=N               2,3,4,6,8 (default 4)
  --repos=N               2..8, at most panes (default 3)
  --sample-ms=N           Sample interval, 500..120000 (default 5000)
  --tick-ms=N             Concurrent per-pane publication cadence (default 700)
  --padding-chars=N       Text added per pane per tick (default 400)
  --home=/absolute/path   Fresh empty HOME beneath this repo's perf-homes/
                          Default: generated unique path
  --port=N                CDP port; refuses existing listeners
  --inspect-port=N        Main inspector port; must differ from CDP port
  --skip-bridge-build     Explicitly omit Swift bridge build (recorded)
  --help

Artifacts (build provenance, child logs, JSONL time series, final report) stay
under HOME. SIGINT/SIGTERM trigger cleanup of only the spawned Electron group.
No attach mode, no baseline/clean-tree override, no artifact deletion.
`

function parseArgs(argv, repoRoot = path.resolve(__dirname, '..', '..')) {
  const values = {}
  const flags = new Set()
  const names = new Set([
    'duration-ms',
    'panes',
    'repos',
    'sample-ms',
    'tick-ms',
    'padding-chars',
    'home',
    'port',
    'inspect-port'
  ])
  for (const arg of argv) {
    if (['--smoke', '--help', '--skip-bridge-build'].includes(arg)) flags.add(arg)
    else {
      const match = /^--([^=]+)=(.+)$/.exec(arg)
      if (!match || !names.has(match[1])) throw new Error('Unknown option: ' + arg)
      if (Object.prototype.hasOwnProperty.call(values, match[1]))
        throw new Error('Duplicate option: ' + match[1])
      values[match[1]] = match[2]
    }
  }
  const number = (name, fallback, min, max) => {
    if (values[name] == null) return fallback
    const n = Number(values[name])
    if (!Number.isInteger(n) || n < min || n > max)
      throw new Error(name + ' must be an integer ' + min + '..' + max)
    return n
  }
  const paneCount = number('panes', DEFAULT_PANE_COUNT, 2, 8)
  if (![2, 3, 4, 6, 8].includes(paneCount)) throw new Error('panes must be 2,3,4,6,8')
  const instanceId = 'perf-soak-' + crypto.randomUUID()
  const options = {
    repoRoot,
    instanceId,
    help: flags.has('--help'),
    home: values.home || path.join(repoRoot, 'perf-homes', instanceId),
    durationMs: number(
      'duration-ms',
      flags.has('--smoke') ? DEFAULT_SMOKE_DURATION_MS : DEFAULT_SOAK_DURATION_MS,
      5000,
      MAX_SOAK_DURATION_MS
    ),
    paneCount,
    repoCount: number('repos', Math.min(DEFAULT_REPO_COUNT, paneCount), 2, paneCount),
    sampleIntervalMs: number('sample-ms', 5000, 500, 120000),
    streamTickMs: number('tick-ms', 700, 50, 60000),
    streamPaddingChars: number('padding-chars', 400, 0, 20000),
    port: number('port', undefined, 1024, 65535),
    inspectPort: number('inspect-port', undefined, 1024, 65535),
    skipBridgeBuild: flags.has('--skip-bridge-build')
  }
  if (options.port != null && options.port === options.inspectPort)
    throw new Error('Debug ports must differ')
  return options
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(HELP)
    return
  }
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    console.log('[soak] HOME=' + options.home)
    const result = await runMultiviewSoak({
      ...options,
      signal: controller.signal,
      log: console.log
    })
    console.log('[soak] report=' + result.reportPath)
    console.log('[soak] time series=' + result.timeSeriesPath)
    if (!result.ok || result.report.status !== 'passed' || !result.report.childTerminationSucceeded)
      process.exitCode = 1
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error('[soak] FAILED: ' + (error.stack || error))
    process.exitCode = 1
  })

module.exports = { parseArgs, main, HELP }
