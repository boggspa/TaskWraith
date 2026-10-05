'use strict'

/**
 * The off-against-on pair for barrier durability: one build and one workload
 * launched six times in turn with `TASKWRAITH_THREAD_BARRIER_DURABILITY` off,
 * on, off, on, off, on (the order the flag pairs use, `m5FlagPairPlan.cjs`),
 * one measured window a capture; and the six captures read back as a pair.
 *
 * Both workloads have a plan: the two-lane baseline (`light_beside_large_live`,
 * launched exactly as the existing flag pairs launch it) and the many-agent
 * workload (`many_agents_live`, in a shape the caller gives). The plan is the
 * runner's argv only: it launches nothing.
 *
 * Read back, the captures are a pair when they are off and on in turn, off
 * first, as many of each, in the order they ran; share one workload, commit,
 * build, seed, fixture and shape; pin every other programme flag the same; and
 * main itself says the switch was in effect as each capture asked
 * (the `threadBarrierDurability` section, read at each window's fences). A
 * build without that section cannot say so, and its captures are no pair.
 */

const path = require('node:path')
const { PROGRAMME_ROLLOUT_FLAGS, resolveRolloutFlags } = require('./rolloutFlags.cjs')

const DURABILITY_SWITCH = 'TASKWRAITH_THREAD_BARRIER_DURABILITY'
/** Each workload with a pair, and the short name its captures carry. */
const PAIR_WORKLOADS = Object.freeze({
  light_beside_large_live: 'lanes',
  many_agents_live: 'agents'
})
const CAPTURES = 6
const AGENT_MODES = Object.freeze(['serial', 'parallel'])
/** Arguments the plan sets itself, which an extra argument may not set again. */
const PLAN_ARGUMENTS = Object.freeze([
  '--workload',
  '--live-lanes',
  '--live-agents',
  '--live-repetitions',
  '--live-repetition-index',
  '--agent-threads',
  '--agent-seats',
  '--agent-mode',
  '--agent-window-ms',
  '--launch',
  '--i-accept-isolated-launch',
  '--materialize-instance-userdata',
  '--home',
  '--artifact-dir',
  '--out-dir',
  '--instance-id',
  '--git-sha',
  '--build-id',
  '--cell',
  '--accept-unfolded-cross-thread',
  '--seed',
  '--port',
  '--inspect-port',
  '--flag'
])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

/** The agents' shape, checked; the runner checks its ranges again. */
function agentShape(agents) {
  if (
    !isPlainObject(agents) ||
    !positiveInteger(agents.threads) ||
    !positiveInteger(agents.seats) ||
    !AGENT_MODES.includes(agents.mode) ||
    !positiveInteger(agents.windowMs)
  ) {
    throw new Error('the many-agent pair needs its shape: threads, seats, mode and windowMs')
  }
  return agents
}

function checkedExtraArgv(extraArgv) {
  if (!Array.isArray(extraArgv)) throw new Error('extra arguments must be a list')
  for (const arg of extraArgv) {
    const name = typeof arg === 'string' && arg.startsWith('--') ? arg.split('=')[0] : null
    if (name === null || PLAN_ARGUMENTS.includes(name)) {
      throw new Error(`extra argument the plan cannot take: ${JSON.stringify(arg)}`)
    }
  }
  return extraArgv
}

/**
 * The six captures of the pair, in the order they are to run.
 *
 * @param {{
 *   workload: 'light_beside_large_live' | 'many_agents_live',
 *   repoRoot: string, homeRoot: string, artifactRoot: string,
 *   gitSha: string, seed?: number,
 *   cell?: string,       required for the two-lane workload
 *   agents?: { threads: number, seats: number, mode: 'serial' | 'parallel', windowMs: number },
 *   port?: number, inspectPort?: number,
 *   extraArgv?: string[] given to every capture alike
 * }} options
 */
function buildDurabilityPairPlan(options) {
  const {
    workload,
    repoRoot,
    homeRoot,
    artifactRoot,
    gitSha,
    seed = 42,
    cell,
    port = 9420,
    inspectPort = 9820
  } = options
  const short = PAIR_WORKLOADS[workload]
  if (short === undefined) throw new Error(`no pair for workload ${JSON.stringify(workload)}`)
  if (![repoRoot, homeRoot, artifactRoot].every((p) => typeof p === 'string' && path.isAbsolute(p)))
    throw new Error('absolute roots required')
  if (!/^[a-f0-9]{40}$/.test(gitSha || '')) throw new Error('the full commit id is required')
  if (short === 'lanes' && (typeof cell !== 'string' || cell.trim() === '')) {
    throw new Error('the two-lane pair needs its cell')
  }
  const workloadArgv =
    short === 'lanes'
      ? (repetition) => [
          '--workload=light_beside_large_live',
          '--live-lanes',
          '--live-repetitions=1',
          `--live-repetition-index=${repetition}`
        ]
      : (() => {
          const shape = agentShape(options.agents)
          return () => [
            '--workload=many_agents_live',
            '--live-agents',
            `--agent-threads=${shape.threads}`,
            `--agent-seats=${shape.seats}`,
            `--agent-mode=${shape.mode}`,
            `--agent-window-ms=${shape.windowMs}`
          ]
        })()
  const extraArgv = checkedExtraArgv(options.extraArgv ?? [])
  const captures = Array.from({ length: CAPTURES }, (_, index) => {
    const state = index % 2 ? 'on' : 'off'
    const repetition = Math.floor(index / 2)
    const id = `bd-${short}-${state}-${repetition}`
    const declared = state === 'on' ? [DURABILITY_SWITCH] : []
    return {
      id,
      state,
      repetition,
      rolloutFlags: resolveRolloutFlags({ declared }).record,
      argv: [
        ...workloadArgv(repetition),
        '--launch',
        '--i-accept-isolated-launch',
        '--materialize-instance-userdata',
        `--home=${path.join(homeRoot, id)}`,
        `--artifact-dir=${path.join(artifactRoot, id)}`,
        `--out-dir=${path.join(artifactRoot, id)}`,
        `--instance-id=${id}`,
        `--git-sha=${gitSha}`,
        `--build-id=${gitSha}`,
        ...(typeof cell === 'string' && cell.trim() !== ''
          ? [`--cell=${cell}`]
          : ['--accept-unfolded-cross-thread']),
        `--seed=${seed}`,
        `--port=${port}`,
        `--inspect-port=${inspectPort}`,
        ...extraArgv,
        ...declared.map((flag) => `--flag=${flag}`)
      ]
    }
  })
  return {
    workload,
    switch: DURABILITY_SWITCH,
    runner: path.join(repoRoot, 'scripts/perf/runT2Baseline.cjs'),
    captures,
    note: 'Run each capture to its end before the next, in this order, on the same build; one measured window each.'
  }
}

/** The live phase a report's windows are in: a run drives one workload or the other. */
function phaseOf(report) {
  const live = isPlainObject(report.liveRounds) ? report.liveRounds : {}
  return [live.lanes, live.agents].find(
    (candidate) => isPlainObject(candidate) && Array.isArray(candidate.windows)
  )
}

/** What one capture records of itself, for the pair to compare. */
function identityOf(report) {
  const environment = isPlainObject(report.environment) ? report.environment : {}
  const evidence = isPlainObject(report.runEvidence) ? report.runEvidence : {}
  const phase = phaseOf(report)
  return {
    workload: environment.workload ?? null,
    gitSha: environment.gitSha ?? null,
    buildId: evidence.buildId ?? null,
    seed: environment.seed ?? null,
    fixtureFingerprint: evidence.fixtureFingerprint ?? null,
    shape: phase
      ? JSON.stringify({ asked: phase.asked ?? null, options: phase.options ?? null })
      : null
  }
}

/** What main said of the switch in one window, from the section at its fences. */
function switchInWindow(window) {
  const record = isPlainObject(window) ? window.barrierDurability : null
  if (!isPlainObject(record)) return 'unconfirmed:not_read'
  const section = isPlainObject(record.after) ? record.after : record.before
  if (!isPlainObject(section)) return `unconfirmed:${record.unavailable ?? 'not_read'}`
  if (section.enabled === true) return 'on'
  return typeof section.ignored === 'string' ? 'ignored' : 'off'
}

/**
 * Whether these captures are an off-against-on pair, and why not.
 *
 * @param {Array<{ id: string, report: unknown }>} captures in any order
 */
function qualifyDurabilityPair(captures) {
  const reasons = []
  const read = []
  for (const { id, report } of Array.isArray(captures) ? captures : []) {
    if (!isPlainObject(report)) {
      reasons.push(`report_unreadable:${id}`)
      continue
    }
    const environment = isPlainObject(report.environment) ? report.environment : {}
    const effective = isPlainObject(environment.rolloutFlags)
      ? environment.rolloutFlags.effective
      : null
    const state = isPlainObject(effective) ? effective[DURABILITY_SWITCH] : undefined
    const startedMs = Date.parse(environment.startedAt)
    const phase = phaseOf(report)
    const windows = phase ? phase.windows : []
    const inMain = [...new Set(windows.map(switchInWindow))]
    read.push({
      id,
      report,
      state: state === 'on' || state === 'off' ? state : null,
      effective: isPlainObject(effective) ? effective : {},
      startedMs,
      summary: {
        id,
        state: state === 'on' || state === 'off' ? state : null,
        startedAt: Number.isFinite(startedMs) ? environment.startedAt : null,
        windows: windows.length,
        switchInMain:
          inMain.length === 0 ? 'unconfirmed:no_window' : inMain.length === 1 ? inMain[0] : 'mixed'
      }
    })
  }
  read.sort((a, b) => (a.startedMs || 0) - (b.startedMs || 0))

  for (const capture of read) {
    if (capture.state === null) reasons.push(`switch_unrecorded:${capture.id}`)
    if (!Number.isFinite(capture.startedMs)) reasons.push(`started_at_unrecorded:${capture.id}`)
  }
  const states = read.map((capture) => capture.state)
  const inTurn =
    states.length >= 2 &&
    states.length % 2 === 0 &&
    states.every((state, index) => state === (index % 2 ? 'on' : 'off'))
  if (!inTurn) reasons.push('not_off_and_on_in_turn')

  const identities = read.map((capture) => identityOf(capture.report))
  const workload = identities.length > 0 ? identities[0].workload : null
  if (workload !== null && PAIR_WORKLOADS[workload] === undefined) {
    reasons.push(`workload_has_no_pair:${workload}`)
  }
  for (const field of Object.keys(identities[0] ?? {})) {
    if (identities.some((identity) => identity[field] === null)) {
      reasons.push(`unrecorded:${field}`)
    } else if (new Set(identities.map((identity) => JSON.stringify(identity[field]))).size > 1) {
      reasons.push(`differs:${field}`)
    }
  }
  for (const flag of PROGRAMME_ROLLOUT_FLAGS) {
    if (flag === DURABILITY_SWITCH) continue
    if (new Set(read.map((capture) => capture.effective[flag])).size > 1) {
      reasons.push(`flag_differs:${flag}`)
    }
  }
  for (const capture of read) {
    const inMain = capture.summary.switchInMain
    if (inMain.startsWith('unconfirmed:')) {
      reasons.push(`switch_unconfirmed:${capture.id}:${inMain.slice('unconfirmed:'.length)}`)
    } else if (inMain === 'ignored') reasons.push(`switch_ignored:${capture.id}`)
    else if (capture.state !== null && inMain !== capture.state) {
      reasons.push(`switch_not_in_effect:${capture.id}`)
    }
  }
  return {
    qualified: reasons.length === 0,
    reasons,
    workload,
    captures: read.map((capture) => capture.summary)
  }
}

module.exports = {
  DURABILITY_SWITCH,
  PAIR_WORKLOADS,
  buildDurabilityPairPlan,
  qualifyDurabilityPair
}
