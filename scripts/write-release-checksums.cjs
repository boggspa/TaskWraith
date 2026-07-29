#!/usr/bin/env node

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function writeReleaseChecksums(outputPath, assetPaths) {
  const resolvedOutput = path.resolve(outputPath)
  const seenNames = new Set()
  const lines = []
  for (const assetPath of assetPaths) {
    const resolvedAsset = path.resolve(assetPath)
    if (resolvedAsset === resolvedOutput) {
      throw new Error('Checksum manifest must not include itself')
    }
    if (!fs.existsSync(resolvedAsset) || !fs.statSync(resolvedAsset).isFile()) {
      throw new Error(`Release checksum asset is missing or not a file: ${assetPath}`)
    }
    const name = path.basename(resolvedAsset)
    if (seenNames.has(name)) {
      throw new Error(`Duplicate release checksum asset name: ${name}`)
    }
    seenNames.add(name)
    lines.push(`${sha256File(resolvedAsset)}  ${name}`)
  }
  if (lines.length === 0) {
    throw new Error('No release assets were provided for checksumming')
  }
  lines.sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true })
  fs.writeFileSync(resolvedOutput, `${lines.join('\n')}\n`)
  return lines
}

function runCli(argv = process.argv.slice(2)) {
  if (argv.length < 2) {
    console.error('Usage: node scripts/write-release-checksums.cjs SHA256SUMS-VERSION.txt ASSET...')
    return 1
  }
  try {
    const lines = writeReleaseChecksums(argv[0], argv.slice(1))
    console.log(`[write-release-checksums] wrote ${lines.length} checksum(s) to ${argv[0]}`)
    return 0
  } catch (error) {
    console.error(
      `[write-release-checksums] ${error instanceof Error ? error.message : String(error)}`
    )
    return 1
  }
}

if (require.main === module) {
  process.exitCode = runCli()
}

module.exports = {
  runCli,
  sha256File,
  writeReleaseChecksums
}
