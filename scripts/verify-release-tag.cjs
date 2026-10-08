#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const { extractReleaseNotes } = require('./prepare-release-notes.cjs')
const { findChangelogRelease, resolveReleaseDistribution } = require('./release-distribution.cjs')

const DEFAULT_REPO_ROOT = path.join(__dirname, '..')
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function normalizeTag(value) {
  return String(value || '')
    .trim()
    .replace(/^refs\/tags\//, '')
}

function firstChangelogRelease(changelogText) {
  const match = String(changelogText).match(
    /^##\s+\[?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?(?:\s+-\s+(\d{4}-\d{2}-\d{2}))?\s*$/m
  )
  return match ? { version: match[1], date: match[2] } : null
}

function validateReleaseMetadata({
  tag,
  packageJson,
  packageLock,
  changelogText,
  distribution = 'beta',
  debutVersion = null
}) {
  const errors = []
  const rootVersion = packageJson?.version
  if (typeof rootVersion !== 'string' || !VERSION_PATTERN.test(rootVersion)) {
    errors.push(`package.json has an invalid release version: ${String(rootVersion)}`)
    return errors
  }

  // The frozen source root serves every distribution cut from it: the lockfile
  // always tracks package.json, never the debut target version.
  if (packageLock?.version !== rootVersion) {
    errors.push(
      `package-lock.json version ${String(packageLock?.version)} does not match package.json ${rootVersion}`
    )
  }
  if (packageLock?.packages?.['']?.version !== rootVersion) {
    errors.push(
      `package-lock.json root package version ${String(
        packageLock?.packages?.['']?.version
      )} does not match package.json ${rootVersion}`
    )
  }

  const isDebut = distribution === 'debut'
  const version = isDebut ? debutVersion : rootVersion
  if (isDebut && (typeof version !== 'string' || !VERSION_PATTERN.test(version))) {
    errors.push(
      'debut distribution could not resolve a stable target version from electron-builder.debut.yml'
    )
    return errors
  }
  const normalizedTag = normalizeTag(tag)

  const expectedTag = `v${version}`
  if (!normalizedTag) {
    errors.push('release tag is missing (pass vX.Y.Z or set GITHUB_REF_NAME)')
  } else if (normalizedTag !== expectedTag) {
    errors.push(`release tag ${normalizedTag} does not match package.json version ${expectedTag}`)
  }

  const prerelease = version.split('-', 2)[1]
  if (prerelease && prerelease.split('.')[0].toLowerCase() !== 'beta') {
    errors.push(
      `unsupported prerelease channel ${prerelease.split('.')[0]}; TaskWraith release feeds support beta only`
    )
  }
  if (isDebut && prerelease) {
    errors.push(`debut distribution requires a stable target version; ${version} is a prerelease`)
  }

  if (!prerelease) {
    const changelogRelease = firstChangelogRelease(changelogText)
    if (!changelogRelease) {
      errors.push('CHANGELOG.md has no release heading in "## X.Y.Z - YYYY-MM-DD" form')
    } else {
      // For the debut the top section stays the frozen root release; the
      // debut section is validated separately below.
      const expectedChangelogVersion = isDebut ? rootVersion : version
      if (changelogRelease.version !== expectedChangelogVersion) {
        errors.push(
          `top CHANGELOG.md release ${changelogRelease.version} does not match package.json ${expectedChangelogVersion}`
        )
      }
      if (!changelogRelease.date) {
        errors.push(`stable CHANGELOG.md release ${changelogRelease.version} is missing a date`)
      }
    }
  }

  if (isDebut) {
    const debutRelease = findChangelogRelease(changelogText, version)
    if (!debutRelease) {
      errors.push(`CHANGELOG.md has no release section for debut ${version}`)
    } else if (!debutRelease.date) {
      errors.push(`debut CHANGELOG.md release ${version} is missing a date`)
    }
  }
  try {
    extractReleaseNotes(changelogText, version)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  return errors
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function resolveTag(argv, env) {
  const explicit = argv.find((arg) => !arg.startsWith('--'))
  const option = argv.find((arg) => arg.startsWith('--tag='))
  return normalizeTag(
    explicit || option?.slice('--tag='.length) || env.GITHUB_REF_NAME || env.GITHUB_REF
  )
}

function parseDistribution(argv) {
  const option = argv.find((arg) => arg.startsWith('--distribution='))
  return option ? option.slice('--distribution='.length) : undefined
}

function runCli(argv = process.argv.slice(2), env = process.env, repoRoot = DEFAULT_REPO_ROOT) {
  let packageJson
  let packageLock
  let changelogText
  try {
    packageJson = readJson(path.join(repoRoot, 'package.json'))
    packageLock = readJson(path.join(repoRoot, 'package-lock.json'))
    changelogText = fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8')
  } catch (error) {
    console.error(
      `[verify-release-tag] could not read release metadata: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return 1
  }

  const requestedDistribution = parseDistribution(argv)
  let distribution = 'beta'
  let debutVersion = null
  try {
    const resolved = resolveReleaseDistribution({
      repoRoot,
      ...(requestedDistribution ? { distribution: requestedDistribution } : {})
    })
    distribution = resolved.distribution
    if (distribution === 'debut') debutVersion = resolved.version
  } catch (error) {
    console.error(`[verify-release-tag] ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  const tag = resolveTag(argv, env)
  const errors = validateReleaseMetadata({
    tag,
    packageJson,
    packageLock,
    changelogText,
    distribution,
    debutVersion
  })
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`[verify-release-tag] ${error}`)
    }
    return 1
  }

  console.log(
    `[verify-release-tag] ${tag} matches ${distribution} distribution metadata (package.json, package-lock.json, and CHANGELOG.md)`
  )
  return 0
}

if (require.main === module) {
  process.exitCode = runCli()
}

module.exports = {
  firstChangelogRelease,
  normalizeTag,
  resolveTag,
  runCli,
  validateReleaseMetadata
}
