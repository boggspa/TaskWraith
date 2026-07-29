const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function validateNodeRuntimeLicense(runtimeDir) {
  const errors = []
  const licensePath = path.join(runtimeDir, 'LICENSE')
  const metadataPath = path.join(runtimeDir, 'NODE.json')
  if (!fs.existsSync(licensePath) || !fs.statSync(licensePath).isFile()) {
    errors.push(`missing Node distribution LICENSE: ${licensePath}`)
    return errors
  }
  if (!fs.existsSync(metadataPath) || !fs.statSync(metadataPath).isFile()) {
    errors.push(`missing Node runtime license metadata: ${metadataPath}`)
    return errors
  }

  const text = fs.readFileSync(licensePath, 'utf8')
  if (
    Buffer.byteLength(text, 'utf8') < 1_000 ||
    !/Node\.js is licensed for use as follows:/i.test(text) ||
    !/Permission is hereby granted, free of charge/i.test(text)
  ) {
    errors.push(`Node distribution LICENSE is invalid or truncated: ${licensePath}`)
  }

  let metadata
  try {
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
  } catch (error) {
    errors.push(
      `Node runtime metadata is invalid JSON: ${metadataPath} (${
        error instanceof Error ? error.message : String(error)
      })`
    )
    return errors
  }

  if (metadata.license !== 'LICENSE') {
    errors.push(`${metadataPath} must bind license to LICENSE`)
  }
  if (
    !/^https:\/\/nodejs\.org\/dist\/v\d+\.\d+\.\d+\/[^#]+#LICENSE$/.test(metadata.licenseSource)
  ) {
    errors.push(`${metadataPath} has an invalid official licenseSource`)
  } else if (metadata.licenseSource !== `${metadata.source}#LICENSE`) {
    errors.push(`${metadataPath} licenseSource does not match its verified archive source`)
  }
  if (!/^[a-f0-9]{64}$/.test(metadata.licenseSha256 || '')) {
    errors.push(`${metadataPath} has an invalid licenseSha256`)
  } else {
    const actual = sha256File(licensePath)
    if (actual !== metadata.licenseSha256) {
      errors.push(
        `${metadataPath} licenseSha256 mismatch: expected ${metadata.licenseSha256}, got ${actual}`
      )
    }
  }
  return errors
}

function assertNodeRuntimeLicense(runtimeDir) {
  const errors = validateNodeRuntimeLicense(runtimeDir)
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }
}

module.exports = {
  assertNodeRuntimeLicense,
  sha256File,
  validateNodeRuntimeLicense
}
