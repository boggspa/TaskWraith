'use strict'

/**
 * Repo provenance for perf reports: git HEAD + dirty-tree fingerprint.
 * authoritativeBaseline is true only on a clean isolated worktree.
 *
 * git answers for whichever checkout it finds walking up from the tree. A tree
 * that is not that checkout's root, such as a frozen export kept in an ignored
 * folder of the checkout it came from, would be given the enclosing checkout's
 * commit, changes and worktree, which say nothing about the tree's own bytes.
 * Such a tree is described as one git cannot vouch for: commit unknown, and
 * dirty, since nothing says it is clean. Whoever froze it knows its commit and
 * declares it.
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

/**
 * @param {string} repoRoot
 */
function detectGitSha(repoRoot) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8'
    }).trim()
  } catch {
    return 'unknown'
  }
}

/**
 * @param {string} repoRoot
 * @returns {string[]}
 */
function detectDirtyPaths(repoRoot) {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    })
    return out
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => {
        // XY PATH or XY ORIG -> PATH
        const body = line.slice(3)
        if (body.includes(' -> ')) return body.split(' -> ').pop()
        return body
      })
      .filter(Boolean)
      .sort()
  } catch {
    return ['__git_status_unavailable__']
  }
}

/**
 * @param {string[]} dirtyPaths
 */
function dirtyTreeFingerprint(dirtyPaths) {
  return crypto.createHash('sha256').update(JSON.stringify(dirtyPaths)).digest('hex')
}

/** Stands in for the changed paths of a tree git has no checkout for. */
const NOT_A_GIT_CHECKOUT = '__not_a_git_checkout__'

/**
 * Whether git, walking up from repoRoot, finds a checkout whose root is some
 * other directory. Outside any checkout it finds none, and git's own failures
 * describe that tree as before.
 * @param {string} repoRoot
 * @param {{ realpath?: (target: string) => string }} [options] how links are resolved; the file system's own when omitted
 */
function liesInsideAnotherCheckout(repoRoot, options = {}) {
  let checkoutRoot
  try {
    checkoutRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return false
  }
  // git prints the root with every link resolved; repoRoot may be reached
  // through one, as macOS's /var and /tmp are.
  const realpath = options.realpath || ((target) => fs.realpathSync.native(target))
  try {
    return realpath(checkoutRoot) !== realpath(repoRoot)
  } catch {
    // Nothing then says the checkout git found is this tree's own, so it is
    // not taken to be: the tree gets no commit and is not called clean.
    return true
  }
}

/**
 * Best-effort: true when cwd is a linked worktree (not the main checkout).
 * @param {string} repoRoot
 */
function detectIsolatedWorktree(repoRoot) {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: repoRoot,
      encoding: 'utf8'
    }).trim()
    const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: repoRoot,
      encoding: 'utf8'
    }).trim()
    const commonAbs = path.resolve(repoRoot, common)
    const gitAbs = path.resolve(repoRoot, gitDir)
    if (commonAbs !== gitAbs) return true
    // Fan-out / TaskWraith worktrees often live outside the main Documents tree.
    // This is a guess from the path, not git's word: a checkout of its own
    // (not a linked worktree) counts as isolated when its path runs through a
    // folder named worktrees, or holds .taskwraith-worktrees anywhere, and
    // the same checkout elsewhere does not. The main checkout would pass too,
    // were it kept in such a folder. Linked worktrees, the app's and the
    // fan-out's, are caught by the git check above. Kept as it was and pinned
    // by repoProvenance.test.ts until someone decides to drop it.
    const resolved = path.resolve(repoRoot).split(path.sep).join('/')
    if (resolved.includes('.taskwraith-worktrees') || resolved.includes('/worktrees/')) {
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.repoRoot]
 * @param {boolean} [options.forceIsolated]
 */
function collectRepoProvenance(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd())
  const ownCheckout = !liesInsideAnotherCheckout(repoRoot)
  const gitSha = ownCheckout ? detectGitSha(repoRoot) : 'unknown'
  const dirtyPaths = ownCheckout ? detectDirtyPaths(repoRoot) : [NOT_A_GIT_CHECKOUT]
  const dirty = dirtyPaths.length > 0
  const isolatedWorktree =
    typeof options.forceIsolated === 'boolean'
      ? options.forceIsolated
      : ownCheckout && detectIsolatedWorktree(repoRoot)
  const fingerprint = dirtyTreeFingerprint(dirtyPaths)
  const authoritativeBaseline = !dirty && isolatedWorktree
  return {
    gitSha,
    dirty,
    dirtyPaths,
    dirtyTreeFingerprint: fingerprint,
    isolatedWorktree,
    authoritativeBaseline,
    repoRoot
  }
}

/**
 * @param {string} repoRoot
 */
function detectAppVersion(repoRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
    return String(pkg.version || 'unknown')
  } catch {
    return 'unknown'
  }
}

module.exports = {
  NOT_A_GIT_CHECKOUT,
  detectGitSha,
  detectDirtyPaths,
  dirtyTreeFingerprint,
  detectIsolatedWorktree,
  liesInsideAnotherCheckout,
  collectRepoProvenance,
  detectAppVersion
}
