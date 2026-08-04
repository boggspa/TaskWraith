'use strict'

/**
 * T2 blocker F — authoritative isolated HOME contract.
 *
 * Authoritative --launch requires an explicit absolute synthetic HOME under
 * <worktree>/perf-homes/… . Materializer and Electron child share that HOME so
 * userData resolves to:
 *   <isolated-home>/Library/Application Support/TaskWraith Dev <id>
 * (or platform equivalent). Real os.homedir() and live Application Support are
 * refused. Dry/unit DI may inject any home but must stay non-authoritative.
 */

const path = require('path')
const os = require('os')

const PERF_HOMES_DIRNAME = 'perf-homes'

/** Static main-inspector expression — no string interpolation of untrusted input. */
const ISOLATED_HOME_USERDATA_PROBE_EXPRESSION =
  "({home: process.env.HOME, userData: require('electron').app.getPath('userData')})"

/**
 * @param {string} repoRoot
 * @returns {string}
 */
function perfHomesBoundary(repoRoot) {
  return path.join(path.resolve(repoRoot), PERF_HOMES_DIRNAME)
}

/**
 * Fail-closed gate for authoritative launch HOME.
 *
 * @param {object} options
 * @param {string} options.home — must be absolute
 * @param {string} options.repoRoot
 * @param {string} [options.realHomedir]
 * @returns {{
 *   home: string,
 *   boundary: string,
 *   repoRoot: string,
 *   realHomedir: string,
 *   authoritative: true
 * }}
 */
function assertAuthoritativeIsolatedHome(options = {}) {
  const raw = options.home
  if (raw == null || String(raw).trim() === '') {
    throw new Error(
      'Authoritative --launch requires explicit --home=<absolute-isolated-home> under <worktree>/perf-homes/'
    )
  }
  const trimmed = String(raw).trim()
  if (!path.isAbsolute(trimmed)) {
    throw new Error(`Authoritative --home must be an absolute path (got relative "${trimmed}")`)
  }

  const home = path.resolve(trimmed)
  const repoRoot = path.resolve(options.repoRoot || '.')
  const realHomedir = path.resolve(
    options.realHomedir != null ? String(options.realHomedir) : os.homedir()
  )
  const boundary = perfHomesBoundary(repoRoot)

  if (home === realHomedir) {
    throw new Error(`Authoritative --home must not equal the real os.homedir() (${realHomedir})`)
  }

  const underRepo = home === repoRoot || home.startsWith(`${repoRoot}${path.sep}`)
  if (!underRepo) {
    throw new Error(
      `Authoritative --home must resolve inside the isolated worktree (${repoRoot}); got ${home}`
    )
  }

  const underBoundary = home === boundary || home.startsWith(`${boundary}${path.sep}`)
  if (!underBoundary) {
    throw new Error(`Authoritative --home must resolve under ${boundary} (got ${home})`)
  }

  return {
    home,
    boundary,
    repoRoot,
    realHomedir,
    authoritative: true
  }
}

/**
 * Resolve HOME for T2 CLI.
 * - willLaunch: require + assert authoritative isolated home
 * - otherwise: DI / dry path; any home allowed and labeled non-authoritative
 *
 * @param {object} options
 * @param {string|null|undefined} options.homeArg
 * @param {string} options.repoRoot
 * @param {boolean} options.willLaunch
 * @param {string} [options.realHomedir]
 * @param {string} [options.fallbackHome] — dry/unit default
 * @returns {{
 *   home: string,
 *   authoritativeHome: boolean,
 *   boundary: string|null,
 *   note: string
 * }}
 */
function resolveT2Home(options = {}) {
  const willLaunch = Boolean(options.willLaunch)
  const repoRoot = path.resolve(options.repoRoot || '.')
  const boundary = perfHomesBoundary(repoRoot)

  if (willLaunch) {
    const asserted = assertAuthoritativeIsolatedHome({
      home: options.homeArg,
      repoRoot,
      realHomedir: options.realHomedir
    })
    return {
      home: asserted.home,
      authoritativeHome: true,
      boundary: asserted.boundary,
      note: 'authoritative isolated HOME under worktree/perf-homes'
    }
  }

  const fallback =
    options.homeArg != null && String(options.homeArg).trim() !== ''
      ? path.resolve(String(options.homeArg).trim())
      : path.resolve(options.fallbackHome != null ? String(options.fallbackHome) : os.homedir())
  return {
    home: fallback,
    authoritativeHome: false,
    boundary,
    note: 'non-authoritative dry/unit HOME (DI allowed); runtime path verification required for authoritative claims'
  }
}

/**
 * After main-inspector attach and before deterministic replay: prove the child
 * sees the expected isolated HOME and exact sibling userData path.
 *
 * @param {object} mainInspector — attachMainInspectorSession result ({ post })
 * @param {object} expected
 * @param {string} expected.home
 * @param {string} expected.userDataPath
 * @returns {Promise<{
 *   ok: true,
 *   expectedHome: string,
 *   observedHome: string,
 *   expectedUserDataPath: string,
 *   observedUserDataPath: string,
 *   expression: string
 * }>}
 */
async function verifyIsolatedHomeAndUserDataViaMainInspector(mainInspector, expected) {
  if (!mainInspector || typeof mainInspector.post !== 'function') {
    throw new Error(
      'Refuse replay: main inspector session with post() required for isolated HOME/userData verification'
    )
  }
  const expectedHome = path.resolve(String(expected.home || ''))
  const expectedUserDataPath = path.resolve(String(expected.userDataPath || ''))
  if (!expectedHome || !expectedUserDataPath) {
    throw new Error('Refuse replay: expectedHome and expectedUserDataPath required')
  }

  let raw
  try {
    raw = await mainInspector.post('Runtime.evaluate', {
      expression: ISOLATED_HOME_USERDATA_PROBE_EXPRESSION,
      returnByValue: true
    })
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    throw new Error(`Refuse replay: isolated HOME/userData inspector protocol failed: ${message}`)
  }

  if (!raw || typeof raw !== 'object') {
    throw new Error('Refuse replay: isolated HOME/userData inspector returned unexpected type')
  }
  if (raw.exceptionDetails) {
    const text =
      (raw.exceptionDetails.exception && raw.exceptionDetails.exception.description) ||
      raw.exceptionDetails.text ||
      'exception'
    throw new Error(`Refuse replay: isolated HOME/userData inspector exception: ${text}`)
  }

  const value = raw.result && raw.result.value
  if (!value || typeof value !== 'object') {
    throw new Error('Refuse replay: isolated HOME/userData inspector missing returnByValue object')
  }
  if (typeof value.home !== 'string' || typeof value.userData !== 'string') {
    throw new Error('Refuse replay: isolated HOME/userData inspector values must be strings')
  }

  const observedHome = path.resolve(value.home)
  const observedUserDataPath = path.resolve(value.userData)

  if (observedHome !== expectedHome) {
    throw new Error(
      `Refuse replay: process.env.HOME mismatch (expected ${expectedHome}, observed ${observedHome})`
    )
  }
  if (observedUserDataPath !== expectedUserDataPath) {
    throw new Error(
      `Refuse replay: app.getPath('userData') mismatch (expected ${expectedUserDataPath}, observed ${observedUserDataPath})`
    )
  }

  return {
    ok: true,
    expectedHome,
    observedHome,
    expectedUserDataPath,
    observedUserDataPath,
    expression: ISOLATED_HOME_USERDATA_PROBE_EXPRESSION
  }
}

module.exports = {
  PERF_HOMES_DIRNAME,
  ISOLATED_HOME_USERDATA_PROBE_EXPRESSION,
  perfHomesBoundary,
  assertAuthoritativeIsolatedHome,
  resolveT2Home,
  verifyIsolatedHomeAndUserDataViaMainInspector
}
