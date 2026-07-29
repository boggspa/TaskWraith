#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

function expectedChannel(version) {
  return String(version).includes('-') ? 'beta' : 'latest'
}

function cleanArtifactName(value) {
  if (!value || typeof value !== 'string') return undefined
  const trimmed = value
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .split(/[?#]/)[0]
  if (!trimmed) return undefined
  return trimmed.split('/').filter(Boolean).pop() || trimmed
}

function classifyMacArtifact(name) {
  const cleanName = cleanArtifactName(name)?.toLowerCase()
  if (!cleanName) return 'unknown'
  if (/\buniversal\b|[-_.]universal[-_.]/i.test(cleanName)) return 'universal'
  if (/\barm64\b|[-_.]arm64[-_.]/i.test(cleanName)) return 'arm64'
  if (/\bx64\b|\bx86_64\b|[-_.](?:x64|x86_64)[-_.]/i.test(cleanName)) return 'x64'
  if (/(?:^|[-_.])mac\.zip$/i.test(cleanName)) return 'universal'
  return 'unknown'
}

function parseFeedScalar(value) {
  if (!value || typeof value !== 'string') return undefined
  return value.trim().replace(/^['"]|['"]$/g, '')
}

function extractArtifactEntries(feedText) {
  const entries = []
  const add = (source, rawValue, metadata = {}) => {
    const name = cleanArtifactName(rawValue)
    if (!name || !/\.(?:zip|dmg)$/i.test(name)) return
    entries.push({
      source,
      name,
      arch: classifyMacArtifact(name),
      sha512: parseFeedScalar(metadata.sha512),
      size: metadata.size !== undefined ? Number(metadata.size) : undefined
    })
  }

  const topLevelPath = feedText.match(/(?:^|\n)path:\s*([^\n]+)/)?.[1]
  const topLevelSha512 = feedText.match(/(?:^|\n)sha512:\s*([^\n]+)/)?.[1]
  add('path', topLevelPath, { sha512: topLevelSha512 })

  const lines = feedText.split(/\r?\n/)
  let currentFile = null
  const flushCurrentFile = () => {
    if (!currentFile) return
    add('file', currentFile.url || currentFile.path, currentFile)
    currentFile = null
  }
  for (const line of lines) {
    const entryMatch = line.match(/^\s*-\s*(url|path):\s*(.+)$/)
    if (entryMatch) {
      flushCurrentFile()
      currentFile = { [entryMatch[1]]: entryMatch[2] }
      continue
    }
    if (!currentFile) continue
    const nestedMatch = line.match(/^\s+(url|path|sha512|size):\s*(.+)$/)
    if (nestedMatch) {
      currentFile[nestedMatch[1]] = nestedMatch[2]
    } else if (/^\S/.test(line)) {
      flushCurrentFile()
    }
  }
  flushCurrentFile()
  return entries
}

function validateMacUpdateFeedText(feedText, options = {}) {
  const fileName = options.fileName || 'mac update feed'
  const expectedVersion = options.expectedVersion
  const version = parseFeedScalar(feedText.match(/(?:^|\n)version:\s*([^\n]+)/)?.[1])
  const entries = extractArtifactEntries(feedText)
  const errors = []
  const topLevel = entries.find((entry) => entry.source === 'path')
  const fileEntries = entries.filter((entry) => entry.source === 'file')
  const contractVersion = expectedVersion || version
  const expectedZip = contractVersion
    ? `TaskWraith-${contractVersion}-universal-mac.zip`
    : undefined
  const expectedDmg = contractVersion
    ? `TaskWraith-${contractVersion}-universal-mac.dmg`
    : undefined
  const topLevelPathCount = (feedText.match(/(?:^|\n)path:\s*[^\n]+/g) || []).length
  const topLevelSha512Count = (feedText.match(/(?:^|\n)sha512:\s*[^\n]+/g) || []).length

  if (
    expectedVersion &&
    path.basename(fileName) !== `${expectedChannel(expectedVersion)}-mac.yml`
  ) {
    errors.push(
      `${fileName}: feed filename does not match ${expectedChannel(expectedVersion)} channel.`
    )
  }
  if (!version) {
    errors.push(`${fileName}: missing version.`)
  } else if (expectedVersion && version !== expectedVersion) {
    errors.push(`${fileName}: feed version ${version} does not match package ${expectedVersion}.`)
  }
  if (!topLevel) {
    errors.push(`${fileName}: missing top-level mac updater path.`)
  } else if (!topLevel.name.toLowerCase().endsWith('.zip')) {
    errors.push(`${fileName}: top-level updater path must point to a zip artifact.`)
  }
  if (topLevelPathCount > 1) {
    errors.push(`${fileName}: top-level updater path must appear exactly once.`)
  }
  if (topLevelSha512Count > 1) {
    errors.push(`${fileName}: top-level updater sha512 must appear exactly once.`)
  }

  if (contractVersion) {
    for (const expectedName of [expectedZip, expectedDmg]) {
      const matches = fileEntries.filter((entry) => entry.name === expectedName)
      if (matches.length === 0) {
        errors.push(`${fileName}: files list is missing exact artifact ${expectedName}.`)
      } else if (matches.length > 1) {
        errors.push(
          `${fileName}: files list contains duplicate entries for ${expectedName}; expected exactly one.`
        )
      }
    }
    if (topLevel && topLevel.name !== expectedZip) {
      errors.push(`${fileName}: top-level updater path must be exact artifact ${expectedZip}.`)
    }
    const zipEntries = fileEntries.filter((entry) => entry.name === expectedZip)
    if (
      topLevel &&
      zipEntries.length === 1 &&
      topLevel.sha512 &&
      zipEntries[0].sha512 &&
      topLevel.sha512 !== zipEntries[0].sha512
    ) {
      errors.push(`${fileName}: top-level sha512 must match the exact ZIP files entry.`)
    }
  }

  for (const entry of entries) {
    if (
      contractVersion &&
      !new Set([
        `TaskWraith-${contractVersion}-universal-mac.zip`,
        `TaskWraith-${contractVersion}-universal-mac.dmg`
      ]).has(entry.name)
    ) {
      errors.push(`${fileName}: unexpected package artifact ${entry.name}.`)
    }
    if (entry.arch !== 'universal') {
      errors.push(
        `${fileName}: ${entry.name} is ${entry.arch}; shared mac feeds must publish universal artifacts.`
      )
    }
    if (!entry.sha512) {
      errors.push(`${fileName}: ${entry.name} is missing sha512 metadata.`)
    }
    if (entry.source === 'file' && (!Number.isFinite(entry.size) || entry.size <= 0)) {
      errors.push(`${fileName}: ${entry.name} is missing positive size metadata.`)
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    artifacts: entries,
    version
  }
}

function validateFeedArtifactMetadata(feedPath, artifacts) {
  const errors = []
  const feedName = path.basename(feedPath)
  const baseDir = path.dirname(feedPath)
  for (const artifact of artifacts) {
    const artifactPath = path.join(baseDir, artifact.name)
    if (!fs.existsSync(artifactPath)) {
      errors.push(`${feedName}: missing referenced artifact ${artifact.name}.`)
      continue
    }
    const stat = fs.statSync(artifactPath)
    if (Number.isFinite(artifact.size) && artifact.size > 0 && stat.size !== artifact.size) {
      errors.push(
        `${feedName}: ${artifact.name} size mismatch: feed=${artifact.size}, actual=${stat.size}.`
      )
    }
    if (artifact.sha512) {
      const actualSha512 = crypto
        .createHash('sha512')
        .update(fs.readFileSync(artifactPath))
        .digest('base64')
      if (actualSha512 !== artifact.sha512) {
        errors.push(`${feedName}: ${artifact.name} sha512 mismatch.`)
      }
    }
  }
  return errors
}

function validateMacUpdateFeedFile(filePath, expectedVersion) {
  const text = fs.readFileSync(filePath, 'utf8')
  const result = validateMacUpdateFeedText(text, {
    fileName: path.basename(filePath),
    expectedVersion
  })
  const metadataErrors = validateFeedArtifactMetadata(filePath, result.artifacts)
  return {
    ...result,
    ok: result.ok && metadataErrors.length === 0,
    errors: [...result.errors, ...metadataErrors]
  }
}

function validateMacReleaseDirectory(distDir, version) {
  const names = fs.existsSync(distDir)
    ? fs
        .readdirSync(distDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
    : []
  const errors = []
  for (const required of [
    `TaskWraith-${version}-universal-mac.dmg`,
    `TaskWraith-${version}-universal-mac.zip`,
    `TaskWraith-${version}-universal-mac.zip.blockmap`,
    `${expectedChannel(version)}-mac.yml`
  ]) {
    if (!names.includes(required)) {
      errors.push(`${path.basename(distDir)}: missing exact macOS release artifact ${required}.`)
    }
  }
  const forbiddenDmgBlockmaps = names.filter((name) => /\.dmg\.blockmap$/i.test(name))
  for (const name of forbiddenDmgBlockmaps) {
    errors.push(`${path.basename(distDir)}: stale pre-staple DMG blockmap must not ship: ${name}.`)
  }
  const expectedZipBlockmap = `TaskWraith-${version}-universal-mac.zip.blockmap`
  for (const name of names.filter((candidate) => candidate.endsWith('.blockmap'))) {
    if (name !== expectedZipBlockmap && !/\.dmg\.blockmap$/i.test(name)) {
      errors.push(`${path.basename(distDir)}: unexpected macOS release blockmap ${name}.`)
    }
  }
  return errors
}

function resolveFeedFiles(targets, version) {
  const resolved = []
  for (const target of targets) {
    const absolute = path.resolve(target)
    if (!fs.existsSync(absolute)) continue
    const stat = fs.statSync(absolute)
    if (stat.isDirectory()) {
      const feedNames = version
        ? [`${expectedChannel(version)}-mac.yml`]
        : ['latest-mac.yml', 'beta-mac.yml']
      for (const feedName of feedNames) {
        const candidate = path.join(absolute, feedName)
        if (fs.existsSync(candidate)) resolved.push(candidate)
      }
    } else {
      resolved.push(absolute)
    }
  }
  return resolved
}

function runCli(argv = process.argv.slice(2)) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
  )
  const version = packageJson.version
  const targets = argv.length > 0 ? argv : ['dist']
  const files = resolveFeedFiles(targets, version)
  const directoryErrors = targets.flatMap((target) => {
    const absolute = path.resolve(target)
    return fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()
      ? validateMacReleaseDirectory(absolute, version)
      : []
  })
  if (files.length === 0) {
    console.error(
      `[validate-mac-update-feed] No mac update feed found. Checked: ${targets.join(', ')}`
    )
    return 1
  }

  let failed = directoryErrors.length > 0
  for (const error of directoryErrors) {
    console.error(`[validate-mac-update-feed] ${error}`)
  }
  for (const file of files) {
    const result = validateMacUpdateFeedFile(file, version)
    if (result.ok) {
      console.log(
        `[validate-mac-update-feed] ${path.basename(file)} ok (${result.artifacts
          .map((artifact) => `${artifact.name}:${artifact.arch}`)
          .join(', ')})`
      )
      continue
    }
    failed = true
    for (const error of result.errors) {
      console.error(`[validate-mac-update-feed] ${error}`)
    }
  }
  return failed ? 1 : 0
}

if (require.main === module) {
  process.exitCode = runCli()
}

module.exports = {
  classifyMacArtifact,
  expectedChannel,
  extractArtifactEntries,
  resolveFeedFiles,
  runCli,
  validateFeedArtifactMetadata,
  validateMacReleaseDirectory,
  validateMacUpdateFeedFile,
  validateMacUpdateFeedText
}
