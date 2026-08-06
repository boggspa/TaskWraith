'use strict'

/**
 * Phase-2 frame-cadence triage runner — wires attach → runTriageWindow.
 *
 * The harness (`frameCadenceTriage.cjs`) expects pre-attached CDP sessions.
 * This CLI is the missing launch/attach half that `runT2Baseline.cjs` already
 * solved for T2; it does NOT invent a new Electron spawn capability.
 *
 * Safety defaults (match T2 posture):
 *   • No Electron spawn from this file — attach only to explicit local ports
 *   • Never targets production TaskWraith blindly; operator supplies ports
 *   • Gate flag TASKWRAITH_FRAME_CADENCE_TRIAGE=1 is set for this process only
 *     when --attach runs (harness stays off by default in CI)
 *
 * Honest load caveat:
 *   An idle/clean collection window correctly returns decision=insufficient-data
 *   after the zero-miss fix. Reproduce fan-out choppiness inside the target
 *   instance (or accept "instrument only").
 *
 * Examples:
 *   node scripts/perf/runFrameCadenceTriage.cjs --help
 *   node scripts/perf/runFrameCadenceTriage.cjs --dry-run --cdp-port=9222 --inspect-port=9229
 *   TASKWRAITH_FRAME_CADENCE_TRIAGE=1 node scripts/perf/runFrameCadenceTriage.cjs \
 *     --attach --cdp-port=9222 --inspect-port=9229 --window-seconds=30
 *
 * Spawn an isolated child first (operator / T2), then attach to its ports:
 *   node scripts/perf/runT2Baseline.cjs --workload=dual_run --launch \
 *     --i-accept-isolated-launch --home=<worktree>/perf-homes/<id> ...
 *   # then --attach to that child's --port / --inspect-port
 */

const fs = require('fs')
const path = require('path')
const {
  attachRendererCdpSession,
  attachMainInspectorSession,
  discoverMainInspectorUrl
} = require('./cdpWebSocketSession.cjs')
const {
  TRIAGE_ENV_FLAG,
  isFrameCadenceTriageEnabled,
  runTriageWindow
} = require('./frameCadenceTriage.cjs')

const DEFAULT_WINDOW_SECONDS = 30
const DEFAULT_CDP_PORT = 9222
const DEFAULT_INSPECT_PORT = 9229

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean | number>} */
  const out = {
    help: false,
    dryRun: false,
    attach: false,
    pretty: false,
    cdpPort: DEFAULT_CDP_PORT,
    inspectPort: DEFAULT_INSPECT_PORT,
    windowSeconds: DEFAULT_WINDOW_SECONDS
  }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--attach') out.attach = true
    else if (arg === '--pretty') out.pretty = true
    else if (arg.startsWith('--cdp-port=')) out.cdpPort = Number(arg.slice('--cdp-port='.length))
    else if (arg.startsWith('--inspect-port='))
      out.inspectPort = Number(arg.slice('--inspect-port='.length))
    else if (arg.startsWith('--window-seconds='))
      out.windowSeconds = Number(arg.slice('--window-seconds='.length))
    else if (arg.startsWith('--out=')) out.out = arg.slice('--out='.length)
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return out
}

function printHelp() {
  console.log(
    `
TaskWraith Phase-2 frame-cadence triage runner (attach → correlate)

Usage:
  node scripts/perf/runFrameCadenceTriage.cjs [options]

Safety defaults:
  • Attach-only — does not spawn Electron (reuse runT2Baseline.cjs --launch for spawn)
  • Requires explicit --attach (or --dry-run / --help)
  • Enables ${TRIAGE_ENV_FLAG}=1 for this Node process when attaching
  • Attaches only to the ports you name (127.0.0.1)

Options:
  --help                         Show this help
  --dry-run                      Print attach plan + gate status; no sockets
  --attach                       Attach CDP + main inspector, run triage window
  --cdp-port=<n>                 Renderer remote-debugging port (default: ${DEFAULT_CDP_PORT})
  --inspect-port=<n>             Main --inspect port (default: ${DEFAULT_INSPECT_PORT})
  --window-seconds=<n>           Collection window (default: ${DEFAULT_WINDOW_SECONDS})
  --out=<path>                   Write JSON result to this path
  --pretty                       Pretty-print JSON to stdout

Decision matrix (from frameCadenceTriage.cjs):
  main-first         >60% of frame misses overlap main lag / long-task spikes
  compositor-first   <30% overlap (caveat: paint/composite not independently measured)
  mixed              30–60%
  insufficient-data  gate off, attach failure, OR zero frame misses (clean window)

Load caveat:
  The production TaskWraith hosting an ensemble often has NO remote-debugging port.
  Isolated T2 children have clean userData and will not reproduce fan-out choppiness
  unless you drive a live ensemble round inside them. A clean window correctly returns
  insufficient-data — that means the load was not reproduced, not "no problem".
`.trim()
  )
}

/**
 * @param {ReturnType<typeof parseArgs>} args
 */
function buildDryRunPlan(args) {
  return {
    ok: true,
    mode: 'dry-run',
    attach: {
      cdpPort: args.cdpPort,
      inspectPort: args.inspectPort,
      host: '127.0.0.1',
      windowSeconds: args.windowSeconds
    },
    gate: {
      flag: TRIAGE_ENV_FLAG,
      enabledInThisProcess: isFrameCadenceTriageEnabled(),
      note: `--attach sets ${TRIAGE_ENV_FLAG}=1 for this process before runTriageWindow`
    },
    spawnHint:
      'Spawn via scripts/perf/runT2Baseline.cjs --launch --i-accept-isolated-launch (same dual-flag gate), then --attach to that child\'s ports. This runner does not spawn.',
    loadCaveat:
      'Idle/clean windows return decision=insufficient-data after the zero-miss fix. Drive fan-out load in the target instance.'
  }
}

/**
 * @param {object} options
 * @param {number} options.cdpPort
 * @param {number} options.inspectPort
 * @param {number} options.windowSeconds
 * @param {(phase: string, info: object) => void} [options.onProgress]
 * @param {object} [options.cdpAdapters]
 * @param {new (url: string) => object} [options.WebSocket]
 */
async function attachAndRunTriage(options) {
  const cdpPort = Number(options.cdpPort)
  const inspectPort = Number(options.inspectPort)
  const windowSeconds = Number(options.windowSeconds)
  if (!Number.isInteger(cdpPort) || cdpPort < 1024 || cdpPort > 65535) {
    throw new Error('--cdp-port must be an integer 1024–65535')
  }
  if (!Number.isInteger(inspectPort) || inspectPort < 1024 || inspectPort > 65535) {
    throw new Error('--inspect-port must be an integer 1024–65535')
  }
  if (cdpPort === inspectPort) {
    throw new Error('--cdp-port and --inspect-port must differ')
  }
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    throw new Error('--window-seconds must be a positive number')
  }

  process.env[TRIAGE_ENV_FLAG] = '1'

  let renderer = null
  let mainInspector = null
  try {
    if (typeof options.onProgress === 'function') {
      options.onProgress('renderer_attach', { cdpPort })
    }
    renderer = await attachRendererCdpSession({
      port: cdpPort,
      WebSocket: options.WebSocket,
      adapters: options.cdpAdapters || {}
    })

    if (typeof options.onProgress === 'function') {
      options.onProgress('main_inspector_discover', { inspectPort })
    }
    const inspectorUrl =
      options.mainInspectorUrl ||
      (await discoverMainInspectorUrl({
        port: inspectPort,
        adapters: options.cdpAdapters || {}
      }))

    if (typeof options.onProgress === 'function') {
      options.onProgress('main_inspector_attach', { url: inspectorUrl })
    }
    mainInspector = await attachMainInspectorSession({
      webSocketDebuggerUrl: inspectorUrl,
      WebSocket: options.WebSocket
    })

    if (typeof options.onProgress === 'function') {
      options.onProgress('triage_window', { windowSeconds })
    }
    const result = await runTriageWindow({
      rendererSession: renderer,
      mainInspector,
      windowSeconds,
      onProgress: options.onProgress
    })

    return {
      ok: Boolean(result && result.ok !== false),
      mode: 'attach',
      ports: { cdpPort, inspectPort },
      windowSeconds,
      result
    }
  } finally {
    if (mainInspector && typeof mainInspector.close === 'function') {
      try {
        mainInspector.close()
      } catch {
        /* ignore close errors */
      }
    }
    if (renderer && typeof renderer.close === 'function') {
      try {
        renderer.close()
      } catch {
        /* ignore close errors */
      }
    }
  }
}

/**
 * @param {string[]} [argv]
 * @param {object} [options] — DI for tests
 */
async function runFrameCadenceTriageCli(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv)
  if (args.help) {
    printHelp()
    return { ok: true, helped: true }
  }

  if (!Number.isInteger(Number(args.cdpPort)) || !Number.isInteger(Number(args.inspectPort))) {
    throw new Error('--cdp-port and --inspect-port must be integers')
  }
  args.cdpPort = Number(args.cdpPort)
  args.inspectPort = Number(args.inspectPort)
  args.windowSeconds = Number(args.windowSeconds)

  if (args.dryRun) {
    const plan = buildDryRunPlan(args)
    if (options.writeStdout !== false) {
      console.log(JSON.stringify(plan, null, args.pretty ? 2 : 0))
    }
    return plan
  }

  if (!args.attach) {
    throw new Error('Pass --attach to run triage, --dry-run to print the plan, or --help')
  }

  const onProgress =
    typeof options.onProgress === 'function'
      ? options.onProgress
      : (phase, info) => {
          if (require.main === module) {
            console.error(`[frame-cadence-triage] ${phase}`, info || {})
          }
        }

  const report = await attachAndRunTriage({
    cdpPort: args.cdpPort,
    inspectPort: args.inspectPort,
    windowSeconds: args.windowSeconds,
    onProgress,
    WebSocket: options.WebSocket,
    cdpAdapters: options.cdpAdapters,
    mainInspectorUrl: options.mainInspectorUrl
  })

  const text = JSON.stringify(report, null, args.pretty ? 2 : 0)
  if (args.out) {
    const outPath = path.resolve(String(args.out))
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, `${text}\n`, 'utf8')
  }
  if (options.writeStdout !== false) {
    console.log(text)
  }
  return report
}

module.exports = {
  parseArgs,
  printHelp,
  buildDryRunPlan,
  attachAndRunTriage,
  runFrameCadenceTriageCli,
  DEFAULT_WINDOW_SECONDS,
  DEFAULT_CDP_PORT,
  DEFAULT_INSPECT_PORT
}

if (require.main === module) {
  runFrameCadenceTriageCli().catch((error) => {
    console.error(String(error && error.stack ? error.stack : error))
    process.exitCode = 1
  })
}
