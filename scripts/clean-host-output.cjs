#!/usr/bin/env node

/**
 * Clear only the generated standalone Host output before TypeScript emits it.
 *
 * Keeping this exact output root clean prevents a removed runtime dependency
 * from remaining in `out/host` and being mistaken for a Node Host capability.
 */

const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')

function hostOutputDirectory(repoRoot = REPO_ROOT) {
  const root = path.resolve(repoRoot)
  const outRoot = path.resolve(root, 'out')
  const output = path.resolve(outRoot, 'host')
  if (
    path.relative(root, output) !== path.join('out', 'host') ||
    path.dirname(output) !== outRoot
  ) {
    throw new Error(`Refusing to clear a non-Host output path: ${output}`)
  }
  return { outRoot, output }
}

function assertDirectoryIsNotSymlink(directory, label) {
  if (!fs.existsSync(directory)) return
  if (fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error(`Refusing to clear Host output through a symbolic-link ${label}: ${directory}`)
  }
}

function cleanHostOutput(repoRoot = REPO_ROOT) {
  const { outRoot, output } = hostOutputDirectory(repoRoot)
  assertDirectoryIsNotSymlink(outRoot, 'parent')
  assertDirectoryIsNotSymlink(output, 'directory')
  fs.rmSync(output, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  return output
}

if (require.main === module) {
  console.log(`cleared generated Host output: ${cleanHostOutput()}`)
}

module.exports = { cleanHostOutput, hostOutputDirectory }
