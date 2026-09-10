'use strict'

/**
 * Wall 2a: T2 run-evidence descriptor builder (Independent Threads Programme,
 * M1 measurement contract).
 *
 * The T2 runner observes real coverage — fixture identity, replay outcome,
 * span folds — but until this module existed none of it reached the matrix
 * validators: `validateRunEvidence` / `pairRuns` / `validateInterferenceReport`
 * had no T2-produced descriptor to read. This builder maps observed T2 inputs
 * onto that descriptor shape and self-checks through `validateRunEvidence`,
 * mirroring the `runConcurrentReplayLanes` return pattern
 * (`{ run, evidenceErrors, evidenceEligible }`).
 *
 * Honesty rules, all pinned by `t2RunEvidence.test.ts`:
 *
 * - `windowMs` / `repetitions` state the programme's FIXED sampling contract
 *   (120 s × 3), never the T2 attempt's own duration. Observed coverage goes
 *   in `evidence.windows`; today T2 observes no fixed sampling windows, so it
 *   passes none and the validator reports exactly the coverage gap.
 * - Populations mirror the replayed fixture chats: the FIRST chat is the
 *   light population, the rest heavy. A declared role that contradicts the
 *   fixture (light-alone with two chats) surfaces the validator's
 *   contradiction error; the builder never reshapes populations to fit.
 * - `signals` pass through verbatim when the caller supplies measured
 *   summaries, and are OMITTED otherwise. T2 supplies none until window
 *   orchestration lands: with zero qualifying windows any signal count
 *   would fail the validator's light-coverage match, so claiming signals
 *   now would manufacture evidence.
 * - Operator-declared identity (`cell`, `role`, `buildId`) is omitted when
 *   undeclared and REJECTED when malformed — a typo fails fast instead of
 *   quietly widening the gap list.
 * - `diagnosticOnly` mirrors launch: a dry/plan path never launched, so it
 *   is explicitly non-measurement. Coverage is deep-copied, so later caller
 *   mutation cannot rewrite the emitted descriptor.
 */

const {
  MATRIX_SAMPLING,
  PAIRING_ROLES,
  RUN_EVIDENCE_VERSION,
  parseCellName,
  validateRunEvidence
} = require('./interferenceMatrix.cjs')
const { FIXTURE_GENERATOR_VERSION } = require('./fixtureGenerator.cjs')

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deepCopyJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function buildT2RunEvidence(options) {
  if (!isPlainObject(options)) throw new Error('t2RunEvidence options required')
  const { workload, seed, fixtureFingerprint, fixtureChatIds } = options
  if (typeof workload !== 'string' || workload.trim().length === 0) {
    throw new Error('t2RunEvidence workload must be a non-empty string')
  }
  if (typeof seed !== 'number') throw new Error('t2RunEvidence seed must be a number')
  if (typeof fixtureFingerprint !== 'string' || fixtureFingerprint.trim().length === 0) {
    throw new Error('t2RunEvidence fixtureFingerprint must be a non-empty string')
  }
  if (
    !Array.isArray(fixtureChatIds) ||
    fixtureChatIds.length === 0 ||
    fixtureChatIds.some((id) => typeof id !== 'string' || id.trim().length === 0)
  ) {
    throw new Error('t2RunEvidence requires at least one non-empty fixture chat id')
  }
  if (new Set(fixtureChatIds).size !== fixtureChatIds.length) {
    throw new Error('t2RunEvidence fixture chat ids must be unique')
  }
  const cell = options.cell === undefined || options.cell === null ? null : String(options.cell)
  if (cell !== null && parseCellName(cell) === null) {
    throw new Error(`t2RunEvidence cell must be a canonical matrix cell: ${cell}`)
  }
  const role = options.role === undefined || options.role === null ? null : String(options.role)
  if (role !== null && !PAIRING_ROLES.includes(role)) {
    throw new Error(`t2RunEvidence role must be one of ${PAIRING_ROLES.join('|')}: ${role}`)
  }
  const buildId =
    options.buildId === undefined || options.buildId === null ? null : String(options.buildId)
  if (buildId !== null && buildId.trim().length === 0) {
    throw new Error('t2RunEvidence buildId must be a non-empty string when declared')
  }
  const windows = options.windows === undefined ? [] : options.windows
  if (!Array.isArray(windows)) throw new Error('t2RunEvidence windows must be an array')
  const signals = options.signals === undefined ? undefined : options.signals
  if (signals !== undefined && !isPlainObject(signals)) {
    throw new Error('t2RunEvidence signals must be an object when supplied')
  }
  const launched = options.launched === true
  const diagnosticOnly = !launched
  const populations = fixtureChatIds.map((chatId, index) => ({
    role: index === 0 ? 'light' : 'heavy',
    chatId
  }))
  // Status derivation mirrors runConcurrentReplayLanes: flags describe the
  // observed coverage, and only clean, complete coverage reads 'complete'.
  const failed = windows.some((window) => Boolean(window) && window.failed === true)
  const unsupported = windows.some((window) => Boolean(window) && window.unsupported === true)
  const censored = windows.some((window) => Boolean(window) && window.censored === true)
  const incomplete =
    windows.length !== MATRIX_SAMPLING.repetitions ||
    windows.some((window) => !isPlainObject(window) || window.outcome === 'incomplete')
  const status = failed
    ? 'failed'
    : unsupported
      ? 'unsupported'
      : incomplete
        ? 'incomplete'
        : censored
          ? 'censored'
          : diagnosticOnly
            ? 'diagnostic'
            : 'complete'
  const run = {
    ...(cell === null ? {} : { cellName: cell }),
    ...(role === null ? {} : { role }),
    workload,
    seed,
    fixtureFingerprint,
    fixtureVersions: { fixtureGenerator: FIXTURE_GENERATOR_VERSION },
    ...(buildId === null ? {} : { buildId }),
    windowMs: MATRIX_SAMPLING.windowMs,
    repetitions: MATRIX_SAMPLING.repetitions,
    ...(signals === undefined ? {} : { signals: deepCopyJson(signals) }),
    failed,
    censored,
    unsupported,
    incomplete,
    diagnosticOnly,
    evidence: {
      schemaVersion: RUN_EVIDENCE_VERSION,
      status,
      diagnosticOnly,
      lightChatId: fixtureChatIds[0],
      populations,
      windows: deepCopyJson(windows)
    }
  }
  const evidenceErrors = validateRunEvidence(run)
  return { run, evidenceErrors, evidenceEligible: evidenceErrors.length === 0 }
}

module.exports = {
  buildT2RunEvidence
}
