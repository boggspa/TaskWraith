'use strict'

/**
 * Derive the exact unpackaged TaskWraith Dev userData path for a unique
 * TASKWRAITH_INSTANCE_ID. Mirrors src/shared/taskWraithControlPaths.node.ts
 * and InstanceLaunchPosture.sanitizeDevInstanceId (slice 0..16).
 *
 * Never returns production or shared "TaskWraith Dev" (no instance suffix).
 */

const path = require('path')
const os = require('os')

const PRODUCTION_APP_NAMES = Object.freeze(['TaskWraith', 'taskwraith'])
const SHARED_DEV_APP_NAME = 'TaskWraith Dev'

/**
 * Sanitize ambient TASKWRAITH_INSTANCE_ID the same way unpackaged Electron does.
 * @param {string|null|undefined} value
 * @returns {string}
 */
function sanitizeDevInstanceId(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 16)
}

/**
 * @param {object} options
 * @param {string} options.instanceId — raw or already-sanitized id
 * @param {string} [options.platform]
 * @param {string} [options.home]
 * @param {NodeJS.ProcessEnv|object} [options.env]
 * @returns {{
 *   rawInstanceId: string,
 *   sanitizedInstanceId: string,
 *   appName: string,
 *   userDataPath: string,
 *   productionUserDataPath: string,
 *   sharedDevUserDataPath: string,
 *   isPackagedProfile: false
 * }}
 */
function resolveUnpackagedDevUserDataPath(options) {
  const rawInstanceId = options && options.instanceId != null ? String(options.instanceId) : ''
  const sanitizedInstanceId = sanitizeDevInstanceId(rawInstanceId)
  if (!sanitizedInstanceId) {
    throw new Error(
      'TASKWRAITH_INSTANCE_ID sanitizes to empty; refuse shared TaskWraith Dev profile'
    )
  }
  if (sanitizedInstanceId === 'verify') {
    throw new Error('Refuse instanceId that sanitizes to "verify" (shared QA collision)')
  }

  const platform = options.platform || process.platform
  const home = options.home || os.homedir()
  const env = options.env || {}

  const appName = `TaskWraith Dev ${sanitizedInstanceId}`
  const productionName = PRODUCTION_APP_NAMES[0]
  let appDataRoot
  if (platform === 'darwin') {
    appDataRoot = path.join(home, 'Library', 'Application Support')
  } else if (platform === 'win32') {
    const appData = String(env.APPDATA || '').trim()
    appDataRoot = appData || path.join(home, 'AppData', 'Roaming')
  } else {
    const configHome = String(env.XDG_CONFIG_HOME || '').trim()
    appDataRoot = configHome || path.join(home, '.config')
  }

  const userDataPath = path.join(appDataRoot, appName)
  const productionUserDataPath = path.join(appDataRoot, productionName)
  const sharedDevUserDataPath = path.join(appDataRoot, SHARED_DEV_APP_NAME)

  assertNotLiveOrSharedUserData(userDataPath, {
    productionUserDataPath,
    sharedDevUserDataPath,
    sanitizedInstanceId
  })

  return {
    rawInstanceId,
    sanitizedInstanceId,
    appName,
    userDataPath,
    productionUserDataPath,
    sharedDevUserDataPath,
    isPackagedProfile: false
  }
}

/**
 * @param {string} userDataPath
 * @param {object} anchors
 * @param {string} anchors.productionUserDataPath
 * @param {string} anchors.sharedDevUserDataPath
 * @param {string} anchors.sanitizedInstanceId
 */
function assertNotLiveOrSharedUserData(userDataPath, anchors) {
  const resolved = path.resolve(userDataPath)
  const production = path.resolve(anchors.productionUserDataPath)
  const shared = path.resolve(anchors.sharedDevUserDataPath)

  if (resolved === production || resolved.startsWith(`${production}${path.sep}`)) {
    throw new Error(`Refusing production userData path: ${resolved}`)
  }
  if (resolved === shared || resolved.startsWith(`${shared}${path.sep}`)) {
    throw new Error(
      `Refusing shared "${SHARED_DEV_APP_NAME}" userData path: ${resolved}. Require unique instance suffix.`
    )
  }

  const base = path.basename(resolved)
  if (base === SHARED_DEV_APP_NAME || PRODUCTION_APP_NAMES.includes(base)) {
    throw new Error(`Refusing live/shared app profile basename: ${base}`)
  }
  const expected = `TaskWraith Dev ${anchors.sanitizedInstanceId}`
  if (base !== expected) {
    throw new Error(
      `userData basename must be exactly "${expected}" (got "${base}") — refuse ambiguous profiles`
    )
  }
}

/**
 * True when path is the exact sibling instance profile (not production / shared).
 * @param {string} userDataPath
 * @param {string} sanitizedInstanceId
 * @param {object} [options]
 */
function isExactDevInstanceUserDataPath(userDataPath, sanitizedInstanceId, options = {}) {
  try {
    const resolved = resolveUnpackagedDevUserDataPath({
      instanceId: sanitizedInstanceId,
      platform: options.platform,
      home: options.home,
      env: options.env
    })
    return path.resolve(userDataPath) === path.resolve(resolved.userDataPath)
  } catch {
    return false
  }
}

module.exports = {
  sanitizeDevInstanceId,
  resolveUnpackagedDevUserDataPath,
  assertNotLiveOrSharedUserData,
  isExactDevInstanceUserDataPath,
  SHARED_DEV_APP_NAME,
  PRODUCTION_APP_NAMES
}
