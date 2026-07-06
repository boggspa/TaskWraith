#!/usr/bin/env node

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.join(__dirname, '..')
const args = process.argv.slice(2)
const cleanupRoots = [path.join(repoRoot, 'dist'), path.join(repoRoot, 'dist-debug')]

function removeDsStoreFiles(root, depth = 0) {
  if (depth > 3) return
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch (error) {
    if (error && ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return
    throw error
  }

  for (const entry of entries) {
    const absolute = path.join(root, entry.name)
    if (entry.name === '.DS_Store') {
      try {
        fs.rmSync(absolute, { force: true })
      } catch (error) {
        if (!error || !['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error
      }
    } else if (entry.isDirectory()) {
      removeDsStoreFiles(absolute, depth + 1)
    }
  }
}

function cleanup() {
  for (const root of cleanupRoots) removeDsStoreFiles(root)
}

cleanup()
const timer = setInterval(cleanup, 75)
timer.unref()

const binaryName = process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'
const localBinary = path.join(repoRoot, 'node_modules', '.bin', binaryName)
const binary = fs.existsSync(localBinary) ? localBinary : binaryName
const child = spawn(binary, args, {
  cwd: repoRoot,
  env: process.env,
  stdio: 'inherit'
})

function stopCleanup() {
  clearInterval(timer)
  cleanup()
}

child.on('error', (error) => {
  stopCleanup()
  console.error(`[run-electron-builder] failed to start electron-builder: ${error.message}`)
  process.exit(2)
})

child.on('exit', (code, signal) => {
  stopCleanup()
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal)
  })
}
