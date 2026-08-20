#!/usr/bin/env node

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function sha512Base64(filePath) {
  return crypto.createHash('sha512').update(fs.readFileSync(filePath)).digest('base64')
}

function checkedRunner(command, args, label) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 20 * 60 * 1000
  })
  if (result.error) {
    throw new Error(`${label} failed to spawn: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(
      `${label} exited ${result.status}${detail ? `:\n${detail.slice(0, 4000)}` : ''}`
    )
  }
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function runWithBoundedRetry(action, { maxAttempts = 4, wait = sleepSync } = {}) {
  let lastError
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return action()
    } catch (error) {
      lastError = error
      if (attempt < maxAttempts) {
        wait(1000 * 2 ** (attempt - 1))
      }
    }
  }
  throw lastError
}

function rewriteMacUpdateFeed(feedPath, version, zipPath, dmgPath) {
  const previous = fs.readFileSync(feedPath, 'utf8')
  const releaseDate =
    previous.match(/(?:^|\n)releaseDate:\s*['"]?([^'"\n]+)['"]?/)?.[1] || new Date().toISOString()
  const artifacts = [zipPath, dmgPath].map((artifactPath) => ({
    name: path.basename(artifactPath),
    sha512: sha512Base64(artifactPath),
    size: fs.statSync(artifactPath).size
  }))
  const [zip, dmg] = artifacts
  const feed = [
    `version: ${version}`,
    'files:',
    `  - url: ${zip.name}`,
    `    sha512: ${zip.sha512}`,
    `    size: ${zip.size}`,
    `  - url: ${dmg.name}`,
    `    sha512: ${dmg.sha512}`,
    `    size: ${dmg.size}`,
    `path: ${zip.name}`,
    `sha512: ${zip.sha512}`,
    `releaseDate: '${releaseDate}'`,
    ''
  ].join('\n')
  fs.writeFileSync(feedPath, feed)
  return { zip, dmg }
}

function finalizeMacReleaseArtifacts({
  distDir,
  version,
  appleId,
  applePassword,
  teamId,
  keychainProfile,
  channel: channelOverride,
  notarize = true,
  run = checkedRunner,
  retryWait = sleepSync
}) {
  const dmgPath = path.join(distDir, `TaskWraith-${version}-universal-mac.dmg`)
  const zipPath = path.join(distDir, `TaskWraith-${version}-universal-mac.zip`)
  const zipBlockmapPath = `${zipPath}.blockmap`
  const channel = channelOverride || (version.includes('-') ? 'beta' : 'latest')
  const feedPath = path.join(distDir, `${channel}-mac.yml`)
  for (const required of [dmgPath, zipPath, zipBlockmapPath, feedPath]) {
    if (!fs.existsSync(required) || !fs.statSync(required).isFile()) {
      throw new Error(`Missing exact macOS release artifact: ${required}`)
    }
  }

  if (notarize) {
    const hasAppleIdCredentials = [appleId, applePassword, teamId].every((value) =>
      String(value || '').trim()
    )
    const profile = String(keychainProfile || '').trim()
    if (!hasAppleIdCredentials && !profile) {
      throw new Error(
        'Provide the complete APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID credential set or APPLE_KEYCHAIN_PROFILE to notarize the exact release DMG'
      )
    }
    const credentialArgs = hasAppleIdCredentials
      ? ['--apple-id', appleId, '--password', applePassword, '--team-id', teamId]
      : ['--keychain-profile', profile]
    run(
      '/usr/bin/xcrun',
      ['notarytool', 'submit', dmgPath, ...credentialArgs, '--wait'],
      'notarize exact release DMG'
    )
    runWithBoundedRetry(
      () => run('/usr/bin/xcrun', ['stapler', 'staple', dmgPath], 'staple exact release DMG'),
      { wait: retryWait }
    )
    run('/usr/bin/xcrun', ['stapler', 'validate', dmgPath], 'validate stapled release DMG')
  }

  const removedBlockmaps = fs
    .readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.dmg\.blockmap$/i.test(entry.name))
    .map((entry) => path.join(distDir, entry.name))
  for (const staleBlockmap of removedBlockmaps) {
    fs.rmSync(staleBlockmap)
  }
  const metadata = rewriteMacUpdateFeed(feedPath, version, zipPath, dmgPath)
  return {
    dmgPath,
    feedPath,
    metadata,
    removedBlockmaps,
    zipBlockmapPath,
    zipPath
  }
}

function runCli(argv = process.argv.slice(2), repoRoot = process.cwd()) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const parsed = parseCliArgs(argv)
  const notarize = !parsed.skipNotarization
  const distArg = parsed.targets[0] || 'dist'
  const result = finalizeMacReleaseArtifacts({
    distDir: path.resolve(repoRoot, distArg),
    version: parsed.version || packageJson.version,
    channel: parsed.channel,
    appleId: process.env.APPLE_ID,
    applePassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
    keychainProfile: process.env.APPLE_KEYCHAIN_PROFILE,
    notarize
  })
  console.log(
    `[finalize-mac-release-artifacts] ${notarize ? 'notarized and stapled DMG; ' : ''}removed ${
      result.removedBlockmaps.length
    } stale DMG blockmap(s); refreshed ${path.basename(result.feedPath)}`
  )
  return 0
}

function parseCliArgs(argv) {
  const options = { targets: [], skipNotarization: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--skip-notarization') {
      options.skipNotarization = true
      continue
    }
    if (arg === '--version' || arg === '--channel') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`)
      options[arg.slice(2)] = value
      index += 1
      continue
    }
    options.targets.push(arg)
  }
  if (options.targets.length > 1) throw new Error('Only one dist directory may be provided.')
  return options
}

if (require.main === module) {
  try {
    process.exitCode = runCli()
  } catch (error) {
    console.error(
      `[finalize-mac-release-artifacts] ${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 1
  }
}

module.exports = {
  finalizeMacReleaseArtifacts,
  parseCliArgs,
  rewriteMacUpdateFeed,
  runWithBoundedRetry,
  runCli,
  sha512Base64
}
