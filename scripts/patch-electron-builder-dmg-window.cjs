#!/usr/bin/env node

// electron-builder 26.15.x derives a DMG window's bounds from its background
// image even when dmg.window is explicit. TaskWraith deliberately uses a
// background larger than the opening window as resize bleed, so preload this
// module in the electron-builder process and correct the generated dmgbuild
// settings before they are written.

const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const yaml = require('js-yaml')

const repoRoot = path.join(__dirname, '..')
const defaultConfigPath = path.join(repoRoot, 'electron-builder.yml')
const patchMarker = Symbol.for('taskwraith.dmgWindowWritePatch')

function readConfiguredDmgWindow(configPath = defaultConfigPath) {
  const config = yaml.load(fs.readFileSync(configPath, 'utf8'))
  const window = config?.dmg?.window
  if (!window || !Number.isFinite(window.width) || !Number.isFinite(window.height)) {
    return null
  }
  return window
}

function rewriteDmgSettings(data, window) {
  const isBuffer = Buffer.isBuffer(data)
  if (typeof data !== 'string' && !isBuffer) return data

  let settings
  try {
    settings = JSON.parse(isBuffer ? data.toString('utf8') : data)
  } catch {
    return data
  }

  if (
    !settings ||
    typeof settings.title !== 'string' ||
    typeof settings.background !== 'string' ||
    !Array.isArray(settings.contents)
  ) {
    return data
  }

  const width = window.width
  const height = window.height
  settings.window = {
    position: {
      x: Number.isFinite(window.x) ? window.x : 400,
      y: Number.isFinite(window.y) ? window.y : Math.round((1440 - height) / 2)
    },
    size: { width, height }
  }

  const rewritten = JSON.stringify(settings, null, 2)
  return isBuffer ? Buffer.from(rewritten) : rewritten
}

function installDmgWindowPatch(configPath = defaultConfigPath) {
  const window = readConfiguredDmgWindow(configPath)
  if (!window) return false

  const dmgUtilPath = require.resolve('dmg-builder/out/dmgUtil')
  const requireFromDmgBuilder = createRequire(dmgUtilPath)
  const fsExtra = requireFromDmgBuilder('fs-extra')
  if (fsExtra.writeFile[patchMarker]) return true

  const originalWriteFile = fsExtra.writeFile
  function writeFileWithConfiguredDmgWindow(file, data, ...args) {
    const rewritten =
      path.extname(String(file)) === '.json' ? rewriteDmgSettings(data, window) : data
    if (rewritten !== data) {
      process.stderr.write(
        `[taskwraith-dmg-window] opening frame ${window.width}x${window.height}\n`
      )
    }
    return originalWriteFile.call(this, file, rewritten, ...args)
  }
  writeFileWithConfiguredDmgWindow[patchMarker] = true
  fsExtra.writeFile = writeFileWithConfiguredDmgWindow
  return true
}

installDmgWindowPatch()

module.exports = {
  installDmgWindowPatch,
  readConfiguredDmgWindow,
  rewriteDmgSettings
}
