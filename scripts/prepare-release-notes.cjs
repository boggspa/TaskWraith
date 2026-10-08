#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const { resolveReleaseDistribution } = require('./release-distribution.cjs')

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractReleaseNotes(changelogText, version) {
  const lines = String(changelogText).split(/\r?\n/)
  const heading = new RegExp(
    `^##\\s+\\[?${escapeRegExp(version)}\\]?(?:\\s+-\\s+\\d{4}-\\d{2}-\\d{2})?\\s*$`
  )
  const start = lines.findIndex((line) => heading.test(line))
  if (start < 0) {
    throw new Error(`CHANGELOG.md has no release section for ${version}`)
  }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index
      break
    }
  }
  const body = lines
    .slice(start + 1, end)
    .join('\n')
    .trim()
  if (!body) {
    throw new Error(`CHANGELOG.md release section for ${version} is empty`)
  }
  return `${body}\n`
}

function parseDistribution(argv) {
  const option = argv.find((arg) => arg.startsWith('--distribution='))
  return option ? option.slice('--distribution='.length) : undefined
}

function runCli(argv = process.argv.slice(2), repoRoot = process.cwd()) {
  const requestedDistribution = parseDistribution(argv)
  const positional = argv.filter((arg) => !arg.startsWith('--'))
  const resolved = resolveReleaseDistribution({
    repoRoot,
    ...(requestedDistribution ? { distribution: requestedDistribution } : {})
  })
  const version = positional[0] || resolved.version
  const outputPath = path.resolve(repoRoot, positional[1] || `dist/RELEASE_NOTES-${version}.md`)
  if (version !== resolved.version) {
    throw new Error(
      `Requested release notes ${version} do not match ${resolved.distribution} distribution version ${resolved.version}`
    )
  }
  const notes = extractReleaseNotes(
    fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8'),
    version
  )
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, notes)
  console.log(`[prepare-release-notes] wrote ${path.relative(repoRoot, outputPath)}`)
  return 0
}

if (require.main === module) {
  try {
    process.exitCode = runCli()
  } catch (error) {
    console.error(
      `[prepare-release-notes] ${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 1
  }
}

module.exports = {
  extractReleaseNotes,
  runCli
}
