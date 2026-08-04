'use strict'

/**
 * T2 blockers F+G — authoritative isolated HOME contract with realpath containment.
 *
 * Authoritative --launch requires an explicit absolute synthetic HOME under
 * <worktree>/perf-homes/… . Materializer and Electron child share that HOME so
 * userData resolves to:
 *   <isolated-home>/Library/Application Support/TaskWraith Dev <id>
 * (or platform equivalent). Real os.homedir() and live Application Support are
 * refused. Dry/unit DI may inject any home but must stay non-authoritative.
 *
 * Blocker G: lexical checks alone are insufficient — refuse symlink / non-dir
 * components from the worktree perf-homes boundary through HOME, canonicalize
 * with realpath, and prove lexical + canonical HOME/userData via the main
 * inspector before replay.
 */

const path = require('path')
const os = require('os')
const fs = require('fs')

const PERF_HOMES_DIRNAME = 'perf-homes'

/** Static main-inspector expression — no string interpolation of untrusted input. */
const ISOLATED_HOME_USERDATA_PROBE_EXPRESSION =
  "(() => { const fs = require('fs'); const home = process.env.HOME; const userData = require('electron').app.getPath('userData'); return { home: home, userData: userData, homeRealpath: fs.realpathSync(home), userDataRealpath: fs.realpathSync(userData) }; })()"

/**
 * @param {string} repoRoot
 * @returns {string}
 */
function perfHomesBoundary(repoRoot) {
  return path.join(path.resolve(repoRoot), PERF_HOMES_DIRNAME)
}

/**
 * @param {object} [options]
 * @returns {typeof fs}
 */
function resolveFs(options = {}) {
  return options.fs || fs
}

/**
 * Ordered prefixes from filesystem root through absPath (inclusive).
 * @param {string} absPath
 * @returns {string[]}
 */
function pathPrefixes(absPath) {
  const resolved = path.resolve(absPath)
  const prefixes = []
  let cur = resolved
  for (;;) {
    prefixes.unshift(cur)
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return prefixes
}

/**
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
function isPathEqualOrBeneath(child, parent) {
  const c = path.resolve(child)
  const p = path.resolve(parent)
  return c === p || c.startsWith(`${p}${path.sep}`)
}

/**
 * Fail closed on symlink or non-directory for an existing path component.
 * @param {string} componentPath
 * @param {typeof fs} fsApi
 * @returns {{ exists: boolean }}
 */
function assertExistingComponentIsRealDirectory(componentPath, fsApi) {
  let st
  try {
    st = fsApi.lstatSync(componentPath)
  } catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false }
    const message = error && error.message ? error.message : String(error)
    throw new Error(`Refuse isolated HOME path: lstat failed for ${componentPath}: ${message}`)
  }
  if (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) {
    throw new Error(`Refuse isolated HOME path: symlink component ${componentPath}`)
  }
  if (typeof st.isDirectory !== 'function' || !st.isDirectory()) {
    throw new Error(`Refuse isolated HOME path: non-directory component ${componentPath}`)
  }
  return { exists: true }
}

/**
 * Walk from `root` through `target` (both inclusive under root). Existing
 * components must be real directories (lstat). Optionally create missing dirs
 * one level at a time after parents are proven.
 *
 * @param {string} root
 * @param {string} target
 * @param {object} [options]
 * @param {typeof fs} [options.fs]
 * @param {boolean} [options.createMissing]
 */
function assertDirectoryChain(root, target, options = {}) {
  const fsApi = resolveFs(options)
  const createMissing = Boolean(options.createMissing)
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)

  if (!isPathEqualOrBeneath(resolvedTarget, resolvedRoot)) {
    throw new Error(
      `Refuse isolated HOME path: target ${resolvedTarget} is not under root ${resolvedRoot}`
    )
  }

  const rootCheck = assertExistingComponentIsRealDirectory(resolvedRoot, fsApi)
  if (!rootCheck.exists) {
    throw new Error(`Refuse isolated HOME path: missing root directory ${resolvedRoot}`)
  }

  const prefixes = pathPrefixes(resolvedTarget).filter(
    (p) => p === resolvedRoot || p.startsWith(`${resolvedRoot}${path.sep}`)
  )

  for (const component of prefixes) {
    const result = assertExistingComponentIsRealDirectory(component, fsApi)
    if (result.exists) continue
    if (!createMissing) {
      throw new Error(`Refuse isolated HOME path: missing component ${component}`)
    }
    try {
      fsApi.mkdirSync(component, { recursive: false })
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      throw new Error(`Refuse isolated HOME path: failed to create ${component}: ${message}`)
    }
    const created = assertExistingComponentIsRealDirectory(component, fsApi)
    if (!created.exists) {
      throw new Error(`Refuse isolated HOME path: created path missing after mkdir ${component}`)
    }
  }

  return {
    root: resolvedRoot,
    target: resolvedTarget,
    prefixes
  }
}

/**
 * @param {string} absPath
 * @param {typeof fs} fsApi
 * @param {string} label
 * @returns {string}
 */
function realpathOrThrow(absPath, fsApi, label) {
  if (typeof fsApi.realpathSync !== 'function') {
    throw new Error(`Refuse isolated HOME: realpathSync unsupported while resolving ${label}`)
  }
  try {
    return fsApi.realpathSync(path.resolve(absPath))
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    throw new Error(`Refuse isolated HOME: cannot realpath ${label} (${absPath}): ${message}`)
  }
}

/**
 * Fail-closed gate for authoritative launch HOME (lexical only).
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
 * Lexical + lstat + realpath containment for repoRoot → boundary → home
 * (and optional userData under home).
 *
 * @param {object} options
 * @param {string} options.home
 * @param {string} options.repoRoot
 * @param {string} [options.boundary]
 * @param {string} [options.userDataPath]
 * @param {string} [options.realHomedir]
 * @param {typeof fs} [options.fs]
 * @param {boolean} [options.createMissing]
 * @returns {{
 *   home: string,
 *   boundary: string,
 *   repoRoot: string,
 *   realHomedir: string,
 *   userDataPath: string|null,
 *   canonicalRepoRoot: string,
 *   canonicalBoundary: string,
 *   canonicalHome: string,
 *   canonicalUserData: string|null,
 *   authoritative: true
 * }}
 */
function assertFilesystemIsolatedHomeContainment(options = {}) {
  const lexical = assertAuthoritativeIsolatedHome(options)
  const fsApi = resolveFs(options)
  const createMissing = Boolean(options.createMissing)

  assertDirectoryChain(lexical.repoRoot, lexical.boundary, { fs: fsApi, createMissing })
  assertDirectoryChain(lexical.boundary, lexical.home, { fs: fsApi, createMissing })

  const canonicalRepoRoot = realpathOrThrow(lexical.repoRoot, fsApi, 'repoRoot')
  const canonicalBoundary = realpathOrThrow(lexical.boundary, fsApi, 'perf-homes boundary')
  const canonicalHome = realpathOrThrow(lexical.home, fsApi, 'isolated HOME')

  if (!isPathEqualOrBeneath(canonicalBoundary, canonicalRepoRoot)) {
    throw new Error(
      `Refuse isolated HOME: canonical boundary ${canonicalBoundary} escapes canonical worktree ${canonicalRepoRoot}`
    )
  }
  if (!isPathEqualOrBeneath(canonicalHome, canonicalBoundary)) {
    throw new Error(
      `Refuse isolated HOME: canonical HOME ${canonicalHome} escapes canonical boundary ${canonicalBoundary}`
    )
  }
  if (canonicalHome === path.resolve(lexical.realHomedir)) {
    throw new Error(
      `Refuse isolated HOME: canonical HOME resolves to real os.homedir() (${canonicalHome})`
    )
  }

  let userDataPath = null
  let canonicalUserData = null
  if (options.userDataPath != null && String(options.userDataPath).trim() !== '') {
    userDataPath = path.resolve(String(options.userDataPath).trim())
    if (!isPathEqualOrBeneath(userDataPath, lexical.home)) {
      throw new Error(
        `Refuse isolated HOME: userData ${userDataPath} is not under isolated HOME ${lexical.home}`
      )
    }
    assertDirectoryChain(lexical.home, userDataPath, { fs: fsApi, createMissing: false })
    canonicalUserData = realpathOrThrow(userDataPath, fsApi, 'userData')
    if (!isPathEqualOrBeneath(canonicalUserData, canonicalHome)) {
      throw new Error(
        `Refuse isolated HOME: canonical userData ${canonicalUserData} escapes canonical HOME ${canonicalHome}`
      )
    }
  }

  return {
    home: lexical.home,
    boundary: lexical.boundary,
    repoRoot: lexical.repoRoot,
    realHomedir: lexical.realHomedir,
    userDataPath,
    canonicalRepoRoot,
    canonicalBoundary,
    canonicalHome,
    canonicalUserData,
    authoritative: true
  }
}

/**
 * Safely prepare boundary + HOME after lexical gate, then prove canonical containment.
 * @param {object} options — same as assertFilesystemIsolatedHomeContainment
 */
function prepareAuthoritativeIsolatedHome(options = {}) {
  return assertFilesystemIsolatedHomeContainment({
    ...options,
    createMissing: true
  })
}

/**
 * Resolve HOME for T2 CLI.
 * - willLaunch: require + prepare authoritative isolated home (lexical + realpath)
 * - otherwise: DI / dry path; any home allowed and labeled non-authoritative
 *
 * @param {object} options
 * @param {string|null|undefined} options.homeArg
 * @param {string} options.repoRoot
 * @param {boolean} options.willLaunch
 * @param {string} [options.realHomedir]
 * @param {string} [options.fallbackHome] — dry/unit default
 * @param {typeof fs} [options.fs]
 * @returns {{
 *   home: string,
 *   authoritativeHome: boolean,
 *   boundary: string|null,
 *   note: string,
 *   canonicalHome: string|null,
 *   canonicalBoundary: string|null,
 *   canonicalRepoRoot: string|null,
 *   containment: object|null
 * }}
 */
function resolveT2Home(options = {}) {
  const willLaunch = Boolean(options.willLaunch)
  const repoRoot = path.resolve(options.repoRoot || '.')
  const boundary = perfHomesBoundary(repoRoot)

  if (willLaunch) {
    const prepared = prepareAuthoritativeIsolatedHome({
      home: options.homeArg,
      repoRoot,
      realHomedir: options.realHomedir,
      fs: options.fs
    })
    return {
      home: prepared.home,
      authoritativeHome: true,
      boundary: prepared.boundary,
      note: 'authoritative isolated HOME under worktree/perf-homes (realpath-bound)',
      canonicalHome: prepared.canonicalHome,
      canonicalBoundary: prepared.canonicalBoundary,
      canonicalRepoRoot: prepared.canonicalRepoRoot,
      containment: prepared
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
    note: 'non-authoritative dry/unit HOME (DI allowed); runtime path verification required for authoritative claims',
    canonicalHome: null,
    canonicalBoundary: null,
    canonicalRepoRoot: null,
    containment: null
  }
}

/**
 * After main-inspector attach and before deterministic replay: prove the child
 * sees the expected isolated HOME and exact sibling userData path (lexical +
 * canonical realpaths).
 *
 * @param {object} mainInspector — attachMainInspectorSession result ({ post })
 * @param {object} expected
 * @param {string} expected.home
 * @param {string} expected.userDataPath
 * @param {string} expected.homeRealpath
 * @param {string} expected.userDataRealpath
 * @returns {Promise<{
 *   ok: true,
 *   expectedHome: string,
 *   observedHome: string,
 *   expectedUserDataPath: string,
 *   observedUserDataPath: string,
 *   expectedHomeRealpath: string,
 *   observedHomeRealpath: string,
 *   expectedUserDataRealpath: string,
 *   observedUserDataRealpath: string,
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
  const expectedHomeRealpath = path.resolve(String(expected.homeRealpath || ''))
  const expectedUserDataRealpath = path.resolve(String(expected.userDataRealpath || ''))
  if (!expectedHome || !expectedUserDataPath) {
    throw new Error('Refuse replay: expectedHome and expectedUserDataPath required')
  }
  if (!expectedHomeRealpath || !expectedUserDataRealpath) {
    throw new Error(
      'Refuse replay: expectedHomeRealpath and expectedUserDataRealpath required (blocker G)'
    )
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
  if (
    typeof value.home !== 'string' ||
    typeof value.userData !== 'string' ||
    typeof value.homeRealpath !== 'string' ||
    typeof value.userDataRealpath !== 'string'
  ) {
    throw new Error(
      'Refuse replay: isolated HOME/userData inspector values must include home, userData, homeRealpath, userDataRealpath strings'
    )
  }

  const observedHome = path.resolve(value.home)
  const observedUserDataPath = path.resolve(value.userData)
  const observedHomeRealpath = path.resolve(value.homeRealpath)
  const observedUserDataRealpath = path.resolve(value.userDataRealpath)

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
  if (observedHomeRealpath !== expectedHomeRealpath) {
    throw new Error(
      `Refuse replay: HOME realpath mismatch (expected ${expectedHomeRealpath}, observed ${observedHomeRealpath})`
    )
  }
  if (observedUserDataRealpath !== expectedUserDataRealpath) {
    throw new Error(
      `Refuse replay: userData realpath mismatch (expected ${expectedUserDataRealpath}, observed ${observedUserDataRealpath})`
    )
  }

  return {
    ok: true,
    expectedHome,
    observedHome,
    expectedUserDataPath,
    observedUserDataPath,
    expectedHomeRealpath,
    observedHomeRealpath,
    expectedUserDataRealpath,
    observedUserDataRealpath,
    expression: ISOLATED_HOME_USERDATA_PROBE_EXPRESSION
  }
}

module.exports = {
  PERF_HOMES_DIRNAME,
  ISOLATED_HOME_USERDATA_PROBE_EXPRESSION,
  perfHomesBoundary,
  pathPrefixes,
  isPathEqualOrBeneath,
  assertExistingComponentIsRealDirectory,
  assertDirectoryChain,
  assertAuthoritativeIsolatedHome,
  assertFilesystemIsolatedHomeContainment,
  prepareAuthoritativeIsolatedHome,
  resolveT2Home,
  verifyIsolatedHomeAndUserDataViaMainInspector
}
