#!/usr/bin/env node

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { resolveReleaseDistribution } = require('./release-distribution.cjs')

const repoRoot = path.join(__dirname, '..')
const cleanupRoots = ['dist', 'dist-debug', 'dist-debut'].map((dir) => path.join(repoRoot, dir))

function resolveBuilderArgs(args, root = repoRoot) {
  // A debug/debut invocation already declares its identity. Property overrides
  // such as -c.mac.notarize=true do not select a configuration file.
  const configIndex = args.findIndex(
    (arg) =>
      arg === '--config' || arg === '-c' || arg.startsWith('--config=') || arg.startsWith('-c=')
  )
  if (configIndex !== -1) {
    const option = args[configIndex]
    const config = option.includes('=')
      ? option.slice(option.indexOf('=') + 1)
      : args[configIndex + 1]
    if (!config || config.startsWith('-')) throw new Error('A builder config path is required.')
    if (path.resolve(root, config) === path.join(root, 'electron-builder.debut.yml')) {
      resolveReleaseDistribution({ repoRoot: root, distribution: 'debut' })
    }
    return [...args]
  }
  const { builderConfig } = resolveReleaseDistribution({ repoRoot: root })
  return [...args, '--config', builderConfig]
}

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

function runCli(args = process.argv.slice(2)) {
  const builderArgs = resolveBuilderArgs(args)
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
    ['--require', dmgWindowPreload, electronBuilderCli, ...builderArgs],
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
}

if (require.main === module) runCli()

module.exports = { resolveBuilderArgs }
