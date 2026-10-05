'use strict'

/**
 * Removal of a temporary directory this process made with `mkdtemp`, and of
 * nothing else.
 *
 * A recursive removal of a computed path once took most of a user's
 * temporary, cache and system folders with it. So the only directory removed
 * here is one directly in the temporary folder, named by the prefix it was
 * made with and something after it, given as the plain path `mkdtemp`
 * returned. Anything else, the temporary folder itself included, is refused
 * with an error and left alone.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/**
 * @param {string} dir the path `mkdtemp(path.join(os.tmpdir(), prefix))` returned
 * @param {string} prefix the prefix it was made with
 * @param {{ rm?: (dir: string, options: object) => void }} [options] the removal; `fs.rmSync` when omitted
 */
function removeOwnTempDir(dir, prefix, options = {}) {
  if (
    typeof prefix !== 'string' ||
    prefix === '' ||
    prefix.includes('..') ||
    /[\\/]/.test(prefix)
  ) {
    throw new Error(`refusing a prefix that names no single folder: ${JSON.stringify(prefix)}`)
  }
  const root = os.tmpdir()
  const plain = typeof dir === 'string' && path.isAbsolute(dir) && path.resolve(dir) === dir
  const name = plain ? path.basename(dir) : ''
  if (
    !plain ||
    dir === root ||
    path.dirname(dir) !== root ||
    !name.startsWith(prefix) ||
    name.length === prefix.length
  ) {
    throw new Error(`refusing to remove ${dir}: not a temporary directory this process made`)
  }
  const rm = options.rm || fs.rmSync
  rm(dir, { recursive: true, force: true })
}

module.exports = { removeOwnTempDir }
