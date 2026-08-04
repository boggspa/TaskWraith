'use strict'

const path = require('path')
const { WORKLOADS, FX_POSTURES } = require('./schema.cjs')

/**
 * Build an isolated TaskWraith launch plan for perf baselines.
 * Does not spawn Electron — callers decide. Never targets live userData.
 *
 * Mirrors .claude/skills/verify/SKILL.md:
 *   TASKWRAITH_INSTANCE_ID=… IOS_REMOTE_TRUE=0 npx electron . --remote-debugging-port=…
 */

const DEFAULT_BASE_PORT = 9400
const DEFAULT_INSPECTOR_BASE_PORT = 9800

/**
 * @param {object} options
 * @param {string} options.instanceId — must be unique per concurrent session
 * @param {number} [options.remoteDebuggingPort]
 * @param {number} [options.mainInspectorPort]
 * @param {'30seat'|'50seat'|'dual_run'|'455_soak'|'50_chat_switch'} [options.workload]
 * @param {string} [options.fxPosture]
 * @param {string} [options.repoRoot]
 * @param {string} [options.electronEntry='.']
 * @param {string} [options.home] — synthetic isolated HOME propagated into child env (blocker F)
 */
function buildIsolatedLaunchPlan(options) {
  const instanceId = options.instanceId
  if (typeof instanceId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,80}$/.test(instanceId)) {
    throw new Error(
      'instanceId must be 2–81 chars of [A-Za-z0-9._-] and start alphanumeric (e.g. perf-30seat-baseline)'
    )
  }
  if (instanceId === 'verify') {
    throw new Error(
      'Refuse instanceId "verify" — reserved/shared by concurrent QA; pick a unique perf-* id'
    )
  }

  const workload = options.workload || '30seat'
  if (!WORKLOADS.includes(workload)) {
    throw new Error(`workload must be one of ${WORKLOADS.join(', ')}`)
  }
  const fxPosture = options.fxPosture || 'cinematic_default'
  if (!FX_POSTURES.includes(fxPosture)) {
    throw new Error(`fxPosture must be one of ${FX_POSTURES.join(', ')}`)
  }

  const port =
    options.remoteDebuggingPort == null
      ? DEFAULT_BASE_PORT + hashPortOffset(instanceId)
      : options.remoteDebuggingPort
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('remoteDebuggingPort must be an integer 1024–65535')
  }

  const mainInspectorPort =
    options.mainInspectorPort == null
      ? DEFAULT_INSPECTOR_BASE_PORT + hashPortOffset(instanceId)
      : options.mainInspectorPort
  if (
    !Number.isInteger(mainInspectorPort) ||
    mainInspectorPort < 1024 ||
    mainInspectorPort > 65535
  ) {
    throw new Error('mainInspectorPort must be an integer 1024–65535')
  }
  if (mainInspectorPort === port) {
    throw new Error('mainInspectorPort must differ from remoteDebuggingPort')
  }

  const repoRoot = path.resolve(options.repoRoot || process.cwd())
  const electronEntry = options.electronEntry || '.'

  const env = {
    TASKWRAITH_INSTANCE_ID: instanceId,
    IOS_REMOTE_TRUE: '0',
    TASKWRAITH_PERF_WORKLOAD: workload,
    TASKWRAITH_PERF_FX_POSTURE: fxPosture
  }
  const isolatedHome =
    options.home != null && String(options.home).trim() !== ''
      ? path.resolve(String(options.home).trim())
      : null
  if (isolatedHome) {
    env.HOME = isolatedHome
  }

  const argv = [
    'electron',
    electronEntry,
    `--remote-debugging-port=${port}`,
    `--inspect=${mainInspectorPort}`
  ]
  const shellCommand = [
    `TASKWRAITH_INSTANCE_ID=${shellQuote(instanceId)}`,
    'IOS_REMOTE_TRUE=0',
    ...(isolatedHome ? [`HOME=${shellQuote(isolatedHome)}`] : []),
    `npx electron ${shellQuote(electronEntry)} --remote-debugging-port=${port} --inspect=${mainInspectorPort}`
  ].join(' ')

  const safety = {
    neverKillLiveApp: true,
    neverMutateLiveUserData: true,
    iosRemoteForcedOff: true,
    // T1 dry CLI still refuses --launch; T2 runT2Baseline.cjs is the opt-in launcher.
    electronLaunchDisabledUntilT2: true,
    attachOnlyExactChild: true,
    terminateOnlyExactChild: true,
    neverAutoDeleteArtifacts: true,
    isolatedHomePropagated: Boolean(isolatedHome),
    preflight: [
      `curl -sS --max-time 2 http://127.0.0.1:${port}/json/version || true`,
      `curl -sS --max-time 2 http://127.0.0.1:${mainInspectorPort}/json || true`
    ],
    notes: [
      'Build from this worktree/checkout first: npx electron-vite build',
      'Materialize legacy_v1 into exact TaskWraith Dev <sanitizedId> before launch so chats/ skips legacy migration',
      'Authoritative launch requires --home under <worktree>/perf-homes and propagates HOME into the Electron child',
      'Do not attach CDP to the live v1.9.2 instance; only to this instanceId + ports',
      'Terminate only the spawned child pid — never broad pgrep/kill',
      'Never auto-delete artifact dirs or userData',
      'T1 runBaseline.cjs refuses --launch; use scripts/perf/runT2Baseline.cjs with explicit accept flags'
    ]
  }

  return {
    schemaVersion: 1,
    kind: 'taskwraith-perf-isolated-launch',
    instanceId,
    remoteDebuggingPort: port,
    mainInspectorPort,
    workload,
    fxPosture,
    repoRoot,
    electronEntry,
    home: isolatedHome,
    env,
    argv,
    shellCommand,
    cdpVersionUrl: `http://127.0.0.1:${port}/json/version`,
    cdpListUrl: `http://127.0.0.1:${port}/json`,
    inspectorJsonUrl: `http://127.0.0.1:${mainInspectorPort}/json`,
    safety
  }
}

function hashPortOffset(instanceId) {
  let h = 0
  for (let i = 0; i < instanceId.length; i++) {
    h = (h * 33 + instanceId.charCodeAt(i)) >>> 0
  }
  return h % 400
}

function shellQuote(value) {
  if (/^[a-zA-Z0-9_./-]+$/.test(value)) return value
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

module.exports = {
  DEFAULT_BASE_PORT,
  DEFAULT_INSPECTOR_BASE_PORT,
  buildIsolatedLaunchPlan
}
