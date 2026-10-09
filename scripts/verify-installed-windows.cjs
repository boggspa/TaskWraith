#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const asar = require('@electron/asar')
const yaml = require('js-yaml')
const { resolveReleaseDistribution } = require('./release-distribution.cjs')

function verifyInstalledWindows({ installDir, expected, productVersion }) {
  if (![expected.version, `${expected.version}.0`].includes(String(productVersion).trim())) {
    throw new Error(`Installed executable version is not ${expected.version}.`)
  }
  const resources = path.join(installDir, 'resources')
  const pkg = JSON.parse(asar.extractFile(path.join(resources, 'app.asar'), 'package.json'))
  for (const [field, value] of Object.entries({
    version: expected.version,
    taskwraithAppId: expected.appId,
    taskwraithDistributionIdentity: expected.distributionIdentity,
    taskwraithUpdateFeedChannel: expected.updateFeedChannel
  })) {
    if (pkg[field] !== value) throw new Error(`Installed ${field} does not match the target.`)
  }
  const feed = yaml.load(fs.readFileSync(path.join(resources, 'app-update.yml'), 'utf8'))
  const configured = Array.isArray(expected.config.publish)
    ? expected.config.publish[0]
    : expected.config.publish
  for (const field of ['provider', 'owner', 'repo', 'url', 'channel']) {
    if (configured[field] !== undefined && feed?.[field] !== configured[field]) {
      throw new Error(`Installed update feed ${field} does not match the target.`)
    }
  }
  return {
    version: pkg.version,
    appId: pkg.taskwraithAppId,
    distribution: pkg.taskwraithDistributionIdentity,
    feed: pkg.taskwraithUpdateFeedChannel
  }
}

function main([installDir, installer, productVersion] = process.argv.slice(2)) {
  if (!installDir || !installer || !productVersion) {
    throw new Error('Pass the installed directory, exact installer filename and PE ProductVersion.')
  }
  const match = /^TaskWraith-(.+)-win-(?:x64|arm64)-setup\.exe$/.exec(path.basename(installer))
  if (!match) throw new Error('Unexpected Windows installer filename.')
  const source = resolveReleaseDistribution()
  const expected =
    match[1] === source.version ? source : resolveReleaseDistribution({ distribution: 'debut' })
  if (expected.version !== match[1])
    throw new Error('Installer is outside the frozen source identities.')
  console.log(JSON.stringify(verifyInstalledWindows({ installDir, expected, productVersion })))
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(`[installed-windows] ${error.message}`)
    process.exitCode = 1
  }
}

module.exports = { verifyInstalledWindows }
