'use strict'

/**
 * Programme rollout flags for T2 launches (Independent Threads M1).
 *
 * Every programme cutover ships behind a default-off `TASKWRAITH_*` flag that
 * the app and its Host read as the exact token '1'. The measured child used to
 * inherit the runner's whole environment, so a flag exported in the operator's
 * shell reached the app and the external Host without appearing in the run's
 * environment record. This module makes the state of every programme flag a
 * declared property of the launch instead:
 *
 * - A flag is ON only when declared (`--flag=NAME`). Every programme flag is
 *   pinned by value in the spawn plan, the ON token when declared and the OFF
 *   token otherwise. The spawn layers the plan env over the inherited one, so
 *   an exported value can no longer reach the child.
 * - The recorded command carries the same pins (`env NAME=VALUE ...`).
 * - The record states each programme flag as 'on' or 'off' and names any
 *   inherited value the pin replaced, so an exported flag that did not reach
 *   the measurement is visible rather than assumed.
 *
 * Only flags that the source reads today are listed, each with the token its
 * reader treats as on and one it treats as off. Adding one is a deliberate
 * edit here plus its test; unknown names are refused, never passed through.
 */

/** Every reader compares against the exact string '1'; '0' is off for each. */
const ROLLOUT_FLAG_TOKENS = Object.freeze({
  TASKWRAITH_CHECKPOINT_WORKER: Object.freeze({ on: '1', off: '0' }),
  TASKWRAITH_CODEX_COHORT_FAIRNESS: Object.freeze({ on: '1', off: '0' }),
  TASKWRAITH_HOST_QUEUED_START: Object.freeze({ on: '1', off: '0' }),
  TASKWRAITH_HOST_TXN_PERSIST: Object.freeze({ on: '1', off: '0' }),
  TASKWRAITH_JOURNAL_FLUSHER: Object.freeze({ on: '1', off: '0' }),
  TASKWRAITH_RUN_EVENT_FLUSHER: Object.freeze({ on: '1', off: '0' })
})

const PROGRAMME_ROLLOUT_FLAGS = Object.freeze(Object.keys(ROLLOUT_FLAG_TOKENS).sort())

const ROLLOUT_FLAGS_SCHEMA_VERSION = 1

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Validate declared names: programme flags only, each at most once, sorted. */
function parseRolloutFlagNames(values) {
  if (values === undefined || values === null) return []
  if (!Array.isArray(values)) throw new Error('rollout flags must be an array of flag names')
  const names = new Set()
  for (const value of values) {
    const name = typeof value === 'string' ? value.trim() : ''
    if (!PROGRAMME_ROLLOUT_FLAGS.includes(name)) {
      throw new Error(
        `--flag must name a programme rollout flag (${PROGRAMME_ROLLOUT_FLAGS.join('|')}): ${JSON.stringify(value)}`
      )
    }
    if (names.has(name)) throw new Error(`--flag ${name} is declared more than once`)
    names.add(name)
  }
  return [...names].sort()
}

/**
 * Resolve the pinned value of every programme flag for one launch.
 *
 * @param {{ declared?: string[], inheritedEnv?: Record<string, string | undefined> }} [options]
 * @returns {{ values: Record<string, string>, record: object }}
 */
function resolveRolloutFlags(options = {}) {
  const declared = parseRolloutFlagNames(options.declared)
  const inheritedEnv = isPlainObject(options.inheritedEnv) ? options.inheritedEnv : {}
  const values = {}
  const effective = {}
  const inheritedOverridden = []
  for (const name of PROGRAMME_ROLLOUT_FLAGS) {
    const on = declared.includes(name)
    const value = on ? ROLLOUT_FLAG_TOKENS[name].on : ROLLOUT_FLAG_TOKENS[name].off
    values[name] = value
    effective[name] = on ? 'on' : 'off'
    const inherited = Object.prototype.hasOwnProperty.call(inheritedEnv, name)
      ? inheritedEnv[name]
      : undefined
    if (inherited !== undefined && inherited !== value) inheritedOverridden.push(name)
  }
  return Object.freeze({
    values: Object.freeze(values),
    record: Object.freeze({
      schemaVersion: ROLLOUT_FLAGS_SCHEMA_VERSION,
      declared: Object.freeze(declared),
      effective: Object.freeze(effective),
      inheritedOverridden: Object.freeze(inheritedOverridden)
    })
  })
}

/**
 * Return a copy of a spawn plan with every programme flag pinned in its env
 * and in its recorded command. The plan must not already set a programme
 * flag: the pin is the only writer, so there is exactly one stated value.
 */
function pinRolloutFlagsOnSpawnPlan(spawnPlan, resolved) {
  if (!isPlainObject(spawnPlan) || !isPlainObject(spawnPlan.env)) {
    throw new Error('spawn plan with an env is required')
  }
  if (typeof spawnPlan.shellCommand !== 'string' || spawnPlan.shellCommand.length === 0) {
    throw new Error('spawn plan with a recorded shellCommand is required')
  }
  if (!isPlainObject(resolved) || !isPlainObject(resolved.values)) {
    throw new Error('rollout flags must come from resolveRolloutFlags')
  }
  const names = Object.keys(resolved.values).sort()
  if (names.join(',') !== PROGRAMME_ROLLOUT_FLAGS.join(',')) {
    throw new Error('rollout flags must pin every programme flag exactly once')
  }
  for (const name of names) {
    const { on, off } = ROLLOUT_FLAG_TOKENS[name]
    if (resolved.values[name] !== on && resolved.values[name] !== off) {
      throw new Error(`rollout flag ${name} has no recognised token`)
    }
    if (Object.prototype.hasOwnProperty.call(spawnPlan.env, name)) {
      throw new Error(`spawn plan already sets ${name}; the pin must be its only writer`)
    }
  }
  const assignments = names.map((name) => `${name}=${resolved.values[name]}`)
  return {
    ...spawnPlan,
    env: { ...spawnPlan.env, ...resolved.values },
    shellCommand: `env ${assignments.join(' ')} ${spawnPlan.shellCommand}`
  }
}

/** Additive environment-record check: absent is legacy-valid, malformed is not. */
function validateRolloutFlagRecord(record) {
  if (record === undefined) return []
  const errors = []
  if (!isPlainObject(record)) return ['rolloutFlags must be an object when present']
  if (record.schemaVersion !== ROLLOUT_FLAGS_SCHEMA_VERSION) {
    errors.push(`rolloutFlags.schemaVersion must be ${ROLLOUT_FLAGS_SCHEMA_VERSION}`)
  }
  const effective = record.effective
  if (
    !isPlainObject(effective) ||
    Object.keys(effective).sort().join(',') !== PROGRAMME_ROLLOUT_FLAGS.join(',') ||
    Object.values(effective).some((state) => state !== 'on' && state !== 'off')
  ) {
    errors.push('rolloutFlags.effective must state every programme flag as on or off')
  }
  let declared = null
  try {
    declared = parseRolloutFlagNames(record.declared)
  } catch {
    errors.push('rolloutFlags.declared must list programme flags only')
  }
  if (
    declared !== null &&
    isPlainObject(effective) &&
    PROGRAMME_ROLLOUT_FLAGS.some((name) => (effective[name] === 'on') !== declared.includes(name))
  ) {
    errors.push('rolloutFlags.effective must match rolloutFlags.declared')
  }
  if (
    !Array.isArray(record.inheritedOverridden) ||
    record.inheritedOverridden.some((name) => !PROGRAMME_ROLLOUT_FLAGS.includes(name))
  ) {
    errors.push('rolloutFlags.inheritedOverridden must list programme flags only')
  }
  return errors
}

module.exports = {
  PROGRAMME_ROLLOUT_FLAGS,
  ROLLOUT_FLAG_TOKENS,
  ROLLOUT_FLAGS_SCHEMA_VERSION,
  parseRolloutFlagNames,
  resolveRolloutFlags,
  pinRolloutFlagsOnSpawnPlan,
  validateRolloutFlagRecord
}
