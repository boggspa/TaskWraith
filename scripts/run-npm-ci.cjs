#!/usr/bin/env node

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.join(__dirname, '..')
const nodeModulesRoot = path.join(repoRoot, 'node_modules')

function removeDsStoreFiles(root, depth = 0) {
  if (depth > 2) return
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
  removeDsStoreFiles(nodeModulesRoot)
}

cleanup()
const timer = setInterval(cleanup, 50)
timer.unref()

const binary = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const child = spawn(binary, ['ci'], {
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
  console.error(`[run-npm-ci] failed to start npm ci: ${error.message}`)
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
