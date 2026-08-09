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

// Invoke the JS entrypoint directly so the macOS DMG build can preload the
// narrow window/background fix without leaking NODE_OPTIONS into packager
// subprocesses. The preload is inert unless dmg-builder writes DMG settings.
const electronBuilderCli = require.resolve('electron-builder/out/cli/cli')
const dmgWindowPreload = path.join(repoRoot, 'scripts', 'patch-electron-builder-dmg-window.cjs')
const child = spawn(
  process.execPath,
  ['--require', dmgWindowPreload, electronBuilderCli, ...args],
  {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit'
  }
)

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
