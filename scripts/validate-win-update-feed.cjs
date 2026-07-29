#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const WINDOWS_ARCHES = ['x64', 'arm64']

function expectedChannel(version) {
  return String(version).includes('-') ? 'beta' : 'latest'
}

function feedNamesForVersion(version) {
  const channels = version ? [expectedChannel(version)] : ['latest', 'beta']
  return WINDOWS_ARCHES.flatMap((arch) => channels.map((channel) => `${channel}-win-${arch}.yml`))
}

function cleanArtifactName(value) {
  if (!value || typeof value !== 'string') return undefined
  const trimmed = value.trim().replace(/^['"]|['"]$/g, '').split(/[?#]/)[0]
  if (!trimmed) return undefined
  return trimmed.split('/').filter(Boolean).pop() || trimmed
}

function classifyWindowsArtifact(name) {
  const cleanName = cleanArtifactName(name)?.toLowerCase()
  if (!cleanName) return 'unknown'
  if (/\barm64\b|[-_.]arm64[-_.]/i.test(cleanName)) return 'arm64'
  if (/\bx64\b|\bx86_64\b|[-_.](?:x64|x86_64)[-_.]/i.test(cleanName)) return 'x64'
  return 'unknown'
}

function expectedArchFromFeedName(fileName) {
  const lower = fileName.toLowerCase()
  if (/(?:^|[-_.])arm64\.ya?ml$|[-_.]arm64[-_.]/.test(lower)) return 'arm64'
  if (/(?:^|[-_.])x64\.ya?ml$|[-_.](?:x64|x86_64)[-_.]/.test(lower)) return 'x64'
  return undefined
}

function parseFeedScalar(value) {
  if (!value || typeof value !== 'string') return undefined
  return value.trim().replace(/^['"]|['"]$/g, '')
}

function extractArtifactEntries(feedText) {
  const entries = []
  const seen = new Set()
  const add = (source, rawValue, metadata = {}) => {
    const name = cleanArtifactName(rawValue)
    if (!name || !/\.exe$/i.test(name)) return
    const key = `${source}:${name}`
    if (seen.has(key)) return
    seen.add(key)
    entries.push({
      source,
      name,
      arch: classifyWindowsArtifact(name),
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

function validateWindowsUpdateFeedText(feedText, options = {}) {
  const fileName = options.fileName || 'windows update feed'
  const expectedArch = options.expectedArch || expectedArchFromFeedName(fileName)
  const expectedVersion = options.expectedVersion
  const version = parseFeedScalar(feedText.match(/(?:^|\n)version:\s*([^\n]+)/)?.[1])
  const entries = extractArtifactEntries(feedText)
  const errors = []
  const topLevel = entries.find((entry) => entry.source === 'path')

  if (
    expectedVersion &&
    path.basename(fileName) !==
      `${expectedChannel(expectedVersion)}-win-${expectedArch || 'unknown'}.yml`
  ) {
    errors.push(
      `${fileName}: feed filename does not match ${expectedChannel(expectedVersion)} channel and ${expectedArch || 'unknown'} architecture.`
    )
  }
  if (!version) {
    errors.push(`${fileName}: missing version.`)
  } else if (expectedVersion && version !== expectedVersion) {
    errors.push(`${fileName}: feed version ${version} does not match package ${expectedVersion}.`)
  }
  if (!expectedArch) {
    errors.push(`${fileName}: feed name must include x64 or arm64.`)
  }
  if (!topLevel) {
    errors.push(`${fileName}: missing top-level Windows updater path.`)
  } else if (!topLevel.name.toLowerCase().endsWith('.exe')) {
    errors.push(`${fileName}: top-level updater path must point to a setup exe artifact.`)
  }

  for (const entry of entries) {
    const expectedArtifact =
      expectedVersion && expectedArch
        ? `TaskWraith-${expectedVersion}-win-${expectedArch}-setup.exe`
        : undefined
    if (expectedArtifact && entry.name !== expectedArtifact) {
      errors.push(
        `${fileName}: unexpected package artifact ${entry.name}; expected ${expectedArtifact}.`
      )
    }
    if (entry.arch === 'unknown') {
      errors.push(`${fileName}: ${entry.name} has unknown Windows artifact architecture.`)
    } else if (expectedArch && entry.arch !== expectedArch) {
      errors.push(
        `${fileName}: ${entry.name} is ${entry.arch}; expected ${expectedArch} for this feed.`
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

function validateWindowsUpdateFeedFile(filePath, expectedVersion) {
  const text = fs.readFileSync(filePath, 'utf8')
  const result = validateWindowsUpdateFeedText(text, {
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
      const actualSha512 = crypto.createHash('sha512').update(fs.readFileSync(artifactPath)).digest('base64')
      if (actualSha512 !== artifact.sha512) {
        errors.push(`${feedName}: ${artifact.name} sha512 mismatch.`)
      }
    }
  }
  return errors
}

function validateWindowsReleaseDirectory(distDir, version) {
  const errors = []
  const installerNames = safeReadDir(distDir)
    .filter((entry) => entry.isFile() && /\.exe$/i.test(entry.name) && /setup/i.test(entry.name))
    .map((entry) => entry.name)

  for (const arch of WINDOWS_ARCHES) {
    if (version) {
      const feedName = `${expectedChannel(version)}-win-${arch}.yml`
      if (!fs.existsSync(path.join(distDir, feedName))) {
        errors.push(`${path.basename(distDir)}: missing Windows update feed ${feedName}.`)
      }
    }
    const expectedInstaller = version ? `TaskWraith-${version}-win-${arch}-setup.exe` : undefined
    const installer = expectedInstaller
      ? installerNames.find((name) => name === expectedInstaller)
      : installerNames.find((name) => classifyWindowsArtifact(name) === arch)
    if (!installer) {
      errors.push(
        `${path.basename(distDir)}: missing Windows ${arch} setup installer${
          expectedInstaller ? ` ${expectedInstaller}` : ''
        }.`
      )
      continue
    }
    const blockMapPath = path.join(distDir, `${installer}.blockmap`)
    if (!fs.existsSync(blockMapPath)) {
      errors.push(`${path.basename(distDir)}: missing blockmap for ${installer}.`)
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
      for (const feedName of feedNamesForVersion(version)) {
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
      ? validateWindowsReleaseDirectory(absolute, version)
      : []
  })
  if (files.length === 0) {
    console.error(
      `[validate-win-update-feed] No Windows update feed found. Checked: ${targets.join(', ')}`
    )
    return 1
  }

  let failed = directoryErrors.length > 0
  for (const error of directoryErrors) {
    console.error(`[validate-win-update-feed] ${error}`)
  }
  for (const file of files) {
    const result = validateWindowsUpdateFeedFile(file, version)
    if (result.ok) {
      console.log(
        `[validate-win-update-feed] ${path.basename(file)} ok (${result.artifacts
          .map((artifact) => `${artifact.name}:${artifact.arch}`)
          .join(', ')})`
      )
      continue
    }
    failed = true
    for (const error of result.errors) {
      console.error(`[validate-win-update-feed] ${error}`)
    }
  }
  return failed ? 1 : 0
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
  classifyWindowsArtifact,
  expectedChannel,
  extractArtifactEntries,
  resolveFeedFiles,
  runCli,
  validateWindowsReleaseDirectory,
  validateFeedArtifactMetadata,
  validateWindowsUpdateFeedFile,
  validateWindowsUpdateFeedText
}
