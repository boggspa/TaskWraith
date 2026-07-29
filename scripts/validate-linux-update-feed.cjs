#!/usr/bin/env node

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function parseFeedScalar(value) {
  if (!value || typeof value !== 'string') return undefined
  return value.trim().replace(/^['"]|['"]$/g, '')
}

function cleanArtifactName(value) {
  const scalar = parseFeedScalar(value)
  if (!scalar) return undefined
  const withoutQuery = scalar.split(/[?#]/)[0]
  return withoutQuery.split('/').filter(Boolean).pop() || withoutQuery
}

function expectedChannel(version) {
  return String(version).includes('-') ? 'beta' : 'latest'
}

function extractArtifactEntries(feedText) {
  const entries = []
  const seen = new Set()
  const add = (source, rawValue, metadata = {}) => {
    const name = cleanArtifactName(rawValue)
    if (!name || !/\.AppImage$/i.test(name)) return
    const key = `${source}:${name}`
    if (seen.has(key)) return
    seen.add(key)
    entries.push({
      source,
      name,
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

function validateLinuxUpdateFeedText(feedText, options = {}) {
  const fileName = options.fileName || 'Linux update feed'
  const expectedVersion = options.expectedVersion
  const version = parseFeedScalar(feedText.match(/(?:^|\n)version:\s*([^\n]+)/)?.[1])
  const entries = extractArtifactEntries(feedText)
  const errors = []
  const topLevel = entries.find((entry) => entry.source === 'path')

  if (
    expectedVersion &&
    path.basename(fileName) !== `${expectedChannel(expectedVersion)}-linux.yml`
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
    errors.push(`${fileName}: missing top-level Linux updater path.`)
  }
  for (const entry of entries) {
    const expectedArtifact = expectedVersion ? `TaskWraith-${expectedVersion}.AppImage` : undefined
    if (expectedArtifact && entry.name !== expectedArtifact) {
      errors.push(
        `${fileName}: unexpected package artifact ${entry.name}; expected ${expectedArtifact}.`
      )
    }
    if (!entry.sha512) {
      errors.push(`${fileName}: ${entry.name} is missing sha512 metadata.`)
    }
    if (entry.source === 'file' && (!Number.isFinite(entry.size) || entry.size <= 0)) {
      errors.push(`${fileName}: ${entry.name} is missing positive size metadata.`)
    }
  }

  return { ok: errors.length === 0, errors, artifacts: entries, version }
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

function validateLinuxUpdateFeedFile(filePath, expectedVersion) {
  const result = validateLinuxUpdateFeedText(fs.readFileSync(filePath, 'utf8'), {
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

function validateLinuxReleaseDirectory(distDir, version) {
  const names = safeReadDir(distDir)
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
  const errors = []
  if (!names.some((name) => name === `TaskWraith-${version}.AppImage`)) {
    errors.push(`${path.basename(distDir)}: missing TaskWraith-${version}.AppImage.`)
  }
  if (!names.includes(`taskwraith_${version}_amd64.deb`)) {
    errors.push(
      `${path.basename(distDir)}: missing exact taskwraith_${version}_amd64.deb artifact.`
    )
  }
  return errors
}

function resolveFeedFiles(targets, version) {
  const channel = expectedChannel(version)
  const files = []
  for (const target of targets) {
    const absolute = path.resolve(target)
    if (!fs.existsSync(absolute)) continue
    if (fs.statSync(absolute).isFile()) {
      files.push(absolute)
      continue
    }
    for (const entry of safeReadDir(absolute)) {
      if (
        entry.isFile() &&
        new RegExp(`^${channel}-linux(?:-[^.]+)?\\.ya?ml$`, 'i').test(entry.name)
      ) {
        files.push(path.join(absolute, entry.name))
      }
    }
  }
  return files
}

function readPackageVersion(repoRoot) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  if (!packageJson.version || typeof packageJson.version !== 'string') {
    throw new Error('package.json version is missing.')
  }
  return packageJson.version
}

function runCli(argv = process.argv.slice(2), repoRoot = path.join(__dirname, '..')) {
  const version = readPackageVersion(repoRoot)
  const targets = argv.length > 0 ? argv : [path.join(repoRoot, 'dist')]
  const files = resolveFeedFiles(targets, version)
  const errors = targets.flatMap((target) => {
    const absolute = path.resolve(target)
    return fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()
      ? validateLinuxReleaseDirectory(absolute, version)
      : []
  })

  if (files.length === 0) {
    errors.push(
      `No ${expectedChannel(version)} Linux update feed found. Checked: ${targets.join(', ')}`
    )
  }
  for (const file of files) {
    const result = validateLinuxUpdateFeedFile(file, version)
    if (result.ok) {
      console.log(
        `[validate-linux-update-feed] ${path.basename(file)} ok (${result.artifacts
          .map((artifact) => artifact.name)
          .join(', ')})`
      )
    } else {
      errors.push(...result.errors)
    }
  }

  for (const error of errors) {
    console.error(`[validate-linux-update-feed] ${error}`)
  }
  return errors.length > 0 ? 1 : 0
}

function safeReadDir(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return []
  }
}

if (require.main === module) {
  process.exitCode = runCli()
}

module.exports = {
  expectedChannel,
  extractArtifactEntries,
  resolveFeedFiles,
  runCli,
  validateFeedArtifactMetadata,
  validateLinuxReleaseDirectory,
  validateLinuxUpdateFeedFile,
  validateLinuxUpdateFeedText
}
