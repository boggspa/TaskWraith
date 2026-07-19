#!/usr/bin/env node

// Verify (or deliberately regenerate) the checked-in runtime projection of the
// richer provider-canary manifest for Cursor. Packaged code receives only the
// exact binary identity/capability/posture tuple; API backend, auth, harness,
// distribution, and other liveness-only commissioning fields remain release
// evidence and are never embedded into the runtime roster.
//
// Mirrors verify-kimi-runtime-qualification-projection.cjs. Cursor's roster
// ships empty (fail-closed): with providers.cursor === [] the projection is []
// and the checked-in generated.json is [], so this verifier passes while no
// managed Cursor run is admissible.

const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.join(__dirname, '..')
const DEFAULT_MANIFEST = path.join(__dirname, 'provider-containment-fingerprints.json')
const DEFAULT_EMBEDDED = path.join(
  REPO_ROOT,
  'src',
  'main',
  'cursor',
  'CursorRuntimeQualifications.generated.json'
)
const RUNTIME_SOURCE = path.join(REPO_ROOT, 'src', 'main', 'cursor', 'CursorRuntimeAdmission.ts')
const BUILDER_CONFIG = path.join(REPO_ROOT, 'electron-builder.yml')

const CURSOR_SCOPE = 'cursor-native-sandbox-readonly-v1'
const CURSOR_POSTURE = 'cursor-native-sandbox-readonly-v1'
const CURSOR_ATTESTATION_SOURCE = 'credentialed-live-containment-canary'
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/
const RELEASE_REQUIRED_STRING_FIELDS = Object.freeze([
  'binarySha256',
  'platform',
  'arch',
  'scope',
  'version',
  'capabilityFingerprint',
  'postureVersion',
  'attestationSource',
  'distribution',
  'harnessNodeVersion',
  'authentication',
  'backendBaseUrl',
  'modelAlias',
  'model'
])
const RUNTIME_FIELDS = Object.freeze([
  'binarySha256',
  'platform',
  'arch',
  'scope',
  'version',
  'capabilityFingerprint',
  'postureVersion',
  'attestationSource'
])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])])
    )
  }
  return value
}

function canonicalRoster(value) {
  return JSON.stringify(
    [...value]
      .map((entry) => stableValue(entry))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  )
}

function projectCursorRuntimeQualifications(manifest) {
  const errors = []
  if (!isRecord(manifest)) {
    return { qualifications: [], errors: ['release manifest is not an object'] }
  }
  if (manifest.schemaVersion !== 1) {
    errors.push('release manifest schemaVersion must be exactly 1')
  }
  if (!isRecord(manifest.providers)) {
    errors.push('release manifest providers must be an object')
    return { qualifications: [], errors }
  }
  const entries = manifest.providers.cursor
  if (!Array.isArray(entries)) {
    errors.push('release manifest providers.cursor must be an array')
    return { qualifications: [], errors }
  }

  const qualifications = []
  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry)) {
      errors.push(`providers.cursor[${index}] must be an object`)
      continue
    }
    for (const field of RELEASE_REQUIRED_STRING_FIELDS) {
      if (typeof entry[field] !== 'string' || entry[field].trim().length === 0) {
        errors.push(`providers.cursor[${index}].${field} must be a non-empty string`)
      }
    }
    if (!SHA256_PATTERN.test(String(entry.binarySha256 || ''))) {
      errors.push(`providers.cursor[${index}].binarySha256 must be an exact sha256 digest`)
    }
    if (!SHA256_PATTERN.test(String(entry.capabilityFingerprint || ''))) {
      errors.push(`providers.cursor[${index}].capabilityFingerprint must be an exact sha256 digest`)
    }
    if (entry.scope !== CURSOR_SCOPE) {
      errors.push(`providers.cursor[${index}].scope must be exactly ${CURSOR_SCOPE}`)
    }
    if (entry.postureVersion !== CURSOR_POSTURE) {
      errors.push(`providers.cursor[${index}].postureVersion must be exactly ${CURSOR_POSTURE}`)
    }
    if (entry.attestationSource !== CURSOR_ATTESTATION_SOURCE) {
      errors.push(
        `providers.cursor[${index}].attestationSource must be exactly ${CURSOR_ATTESTATION_SOURCE}`
      )
    }
    qualifications.push(Object.fromEntries(RUNTIME_FIELDS.map((field) => [field, entry[field]])))
  }
  if (errors.length > 0) return { qualifications: [], errors }

  const seen = new Set()
  for (const [index, qualification] of qualifications.entries()) {
    const key = JSON.stringify(stableValue(qualification))
    if (seen.has(key)) errors.push(`providers.cursor[${index}] duplicates a runtime tuple`)
    seen.add(key)
  }
  return {
    qualifications:
      errors.length === 0
        ? qualifications.sort((left, right) =>
            JSON.stringify(stableValue(left)).localeCompare(JSON.stringify(stableValue(right)))
          )
        : [],
    errors
  }
}

function validateEmbeddedRoster(embedded) {
  const errors = []
  if (!Array.isArray(embedded)) return ['embedded Cursor runtime roster must be an array']
  for (const [index, item] of embedded.entries()) {
    if (!isRecord(item)) {
      errors.push(`embedded qualification[${index}] must be an object`)
      continue
    }
    const keys = Object.keys(item).sort()
    const expected = [...RUNTIME_FIELDS].sort()
    if (
      keys.length !== expected.length ||
      keys.some((key, keyIndex) => key !== expected[keyIndex])
    ) {
      errors.push(
        `embedded qualification[${index}] must contain only the exact runtime projection fields`
      )
      continue
    }
    if (!SHA256_PATTERN.test(String(item.binarySha256 || ''))) {
      errors.push(`embedded qualification[${index}].binarySha256 is invalid`)
    }
    if (!SHA256_PATTERN.test(String(item.capabilityFingerprint || ''))) {
      errors.push(`embedded qualification[${index}].capabilityFingerprint is invalid`)
    }
    if (item.scope !== CURSOR_SCOPE) {
      errors.push(`embedded qualification[${index}].scope is not the production scope`)
    }
    if (item.postureVersion !== CURSOR_POSTURE) {
      errors.push(`embedded qualification[${index}].postureVersion is not the production posture`)
    }
    if (item.attestationSource !== CURSOR_ATTESTATION_SOURCE) {
      errors.push(`embedded qualification[${index}].attestationSource is not reviewed provenance`)
    }
  }
  if (
    errors.length === 0 &&
    new Set(embedded.map((item) => JSON.stringify(stableValue(item)))).size !== embedded.length
  ) {
    errors.push('embedded Cursor runtime roster contains duplicate tuples')
  }
  return errors
}

function verifyProjection(manifest, embedded, sourceText = '', builderText = '') {
  const projected = projectCursorRuntimeQualifications(manifest)
  const errors = [...projected.errors, ...validateEmbeddedRoster(embedded)]
  if (
    errors.length === 0 &&
    canonicalRoster(projected.qualifications) !== canonicalRoster(embedded)
  ) {
    errors.push('embedded Cursor runtime qualifications do not exactly match the release manifest')
  }
  if (sourceText && !sourceText.includes("from './CursorRuntimeQualifications.generated.json'")) {
    errors.push('CursorRuntimeAdmission does not consume the checked-in generated projection')
  }
  if (builderText && !builderText.includes("- '!scripts/**'")) {
    errors.push('electron-builder must exclude release-only scripts from the packaged app')
  }
  return { ok: errors.length === 0, errors, qualifications: projected.qualifications }
}

function parseArgs(argv) {
  const options = {
    manifest: DEFAULT_MANIFEST,
    embedded: DEFAULT_EMBEDDED,
    write: false
  }
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--write') {
      if (seen.has('write')) throw new Error('--write may be provided only once')
      seen.add('write')
      options.write = true
      continue
    }
    const match = arg.match(/^--(manifest|embedded)(?:=(.*))?$/)
    if (!match) throw new Error(`Unknown option: ${arg}`)
    const key = match[1]
    if (seen.has(key)) throw new Error(`--${key} may be provided only once`)
    seen.add(key)
    const value = match[2] === undefined ? argv[++index] : match[2]
    if (!value || value.startsWith('--')) throw new Error(`--${key} requires a value`)
    options[key] = path.resolve(REPO_ROOT, value)
  }
  return options
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`Could not read ${label}: ${error.message}`)
  }
}

function writeProjection(filePath, qualifications) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, `${JSON.stringify(qualifications, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporaryPath, filePath)
}

function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
    const manifest = readJson(options.manifest, 'provider qualification manifest')
    const projected = projectCursorRuntimeQualifications(manifest)
    if (projected.errors.length > 0) {
      throw new Error(projected.errors.join('; '))
    }
    if (options.write) writeProjection(options.embedded, projected.qualifications)
    const embedded = readJson(options.embedded, 'embedded Cursor runtime projection')
    const result = verifyProjection(
      manifest,
      embedded,
      fs.readFileSync(RUNTIME_SOURCE, 'utf8'),
      fs.readFileSync(BUILDER_CONFIG, 'utf8')
    )
    if (!result.ok) throw new Error(result.errors.join('; '))
    process.stdout.write(
      `[cursor-runtime-projection] verified ${result.qualifications.length} exact runtime qualification(s)\n`
    )
    return 0
  } catch (error) {
    process.stderr.write(`[cursor-runtime-projection] ${error.message}\n`)
    return 1
  }
}

if (require.main === module) process.exitCode = main()

module.exports = {
  CURSOR_ATTESTATION_SOURCE,
  CURSOR_POSTURE,
  CURSOR_SCOPE,
  parseArgs,
  projectCursorRuntimeQualifications,
  RUNTIME_FIELDS,
  validateEmbeddedRoster,
  verifyProjection
}
