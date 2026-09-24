#!/usr/bin/env node

/**
 * Clear only the generated standalone-TUI output before TypeScript emits it.
 *
 * The TUI compile includes its transitive Node modules. Without this cleanup,
 * a previous build can leave stale `out/tui/main/**` files behind after a
 * dependency moves out of Electron main, and electron-builder would package
 * that obsolete payload as an extra resource.
 */

const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')

function tuiOutputDirectory(repoRoot = REPO_ROOT) {
  const root = path.resolve(repoRoot)
  const outRoot = path.resolve(root, 'out')
  const output = path.resolve(outRoot, 'tui')
  const expectedRelative = path.join('out', 'tui')

  if (path.relative(root, output) !== expectedRelative || path.dirname(output) !== outRoot) {
    throw new Error(`Refusing to clear a non-TUI output path: ${output}`)
  }
  return { outRoot, output }
}

function assertDirectoryIsNotSymlink(directory, label) {
  if (!fs.existsSync(directory)) return
  if (fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error(`Refusing to clear TUI output through a symbolic-link ${label}: ${directory}`)
  }
}

function cleanTuiOutput(repoRoot = REPO_ROOT) {
  const { outRoot, output } = tuiOutputDirectory(repoRoot)
  assertDirectoryIsNotSymlink(outRoot, 'parent')
  assertDirectoryIsNotSymlink(output, 'directory')
  fs.rmSync(output, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  return output
}

if (require.main === module) {
  console.log(`cleared generated TUI output: ${cleanTuiOutput()}`)
}

module.exports = { cleanTuiOutput, tuiOutputDirectory }
