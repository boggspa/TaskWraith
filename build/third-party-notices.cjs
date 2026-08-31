const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const NOTICE_SCHEMA_VERSION = 1
const NOTICE_FILES = Object.freeze({
  app: 'TASKWRAITH-LICENSE.txt',
  chromium: 'LICENSES.chromium.html',
  inventory: 'THIRD-PARTY-NOTICES.json',
  thirdParty: 'THIRD-PARTY-NOTICES.txt'
})
const LEGAL_FILE_NAME = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i
const MAX_LEGAL_FILE_BYTES = 2 * 1024 * 1024
const EMULATOR_GAME_ID = 'homebrew-demo'
const EMULATOR_ROOT = path.posix.join('emulator', EMULATOR_GAME_ID)
const EMULATOR_STATE_PACKAGE_PATH = 'emulator-package.json'
const EMULATOR_STATE_WINDOW = Object.freeze({
  source: 'system_ram',
  startAddress: 0xc100,
  byteLength: 13
})
const EMULATOR_STATE_FIELDS = Object.freeze([
  Object.freeze({ key: 'x', address: 6, encoding: 'u8', unit: 'px' }),
  Object.freeze({ key: 'y', address: 7, encoding: 'u8', unit: 'px' }),
  Object.freeze({ key: 'input', address: 8, encoding: 'u8', unit: 'mask' }),
  Object.freeze({ key: 'frame-counter', address: 9, encoding: 'u32le', unit: 'frames' })
])
const EMULATOR_ASSET_MIME_TYPES = Object.freeze({
  'index.html': 'text/html',
  'style.css': 'text/css',
  'bootstrap.mjs': 'application/javascript',
  'twgb.mjs': 'application/javascript',
  'twgb.wasm': 'application/wasm'
})
const EMULATOR_COMPONENT_IDS = Object.freeze([
  'taskwraith-twemu-host',
  'sameboy-libretro',
  'libretro-common',
  'emscripten-runtime',
  'taskwraith-fixture'
])
const EMULATOR_LICENSE_COMPONENT_IDS = new Set(EMULATOR_COMPONENT_IDS.slice(1))
const EMULATOR_LICENSE_PATHS = Object.freeze({
  'sameboy-libretro': 'LICENSES/SameBoy-libretro-MIT.txt',
  'libretro-common': 'LICENSES/Libretro-common-MIT.txt',
  'emscripten-runtime': 'LICENSES/Emscripten-MIT-AND-NCSA.txt',
  'taskwraith-fixture': 'LICENSES/TaskWraith-fixture-MIT.txt'
})
const EMULATOR_LICENSE_SPDX = Object.freeze({
  'sameboy-libretro': 'MIT',
  'libretro-common': 'MIT',
  'emscripten-runtime': 'MIT OR NCSA',
  'taskwraith-fixture': 'MIT'
})
const EMULATOR_COMPONENT_ARTIFACTS = Object.freeze({
  'taskwraith-twemu-host': Object.freeze(['twgb.wasm']),
  'sameboy-libretro': Object.freeze(['twgb.wasm']),
  'libretro-common': Object.freeze(['twgb.wasm']),
  'emscripten-runtime': Object.freeze(['twgb.mjs', 'twgb.wasm']),
  'taskwraith-fixture': Object.freeze(['twgb.wasm'])
})
const EMULATOR_SOURCE_RECEIPT = Object.freeze({
  commit: 'e57e122dc282f87420e52f506092967b6717fc2a',
  path: 'scripts/emulator/build-receipt.json',
  sha256: 'ba354d0732ca21431122754a701f027a96a2453ef0a8b30b0ab5ca8c2ba47df3'
})
const EMULATOR_PACKAGED_FILES = Object.freeze([
  'index.html',
  'style.css',
  'bootstrap.mjs',
  'twgb.mjs',
  'twgb.wasm',
  'manifest.json',
  EMULATOR_STATE_PACKAGE_PATH,
  'component-provenance.json',
  ...Object.values(EMULATOR_LICENSE_PATHS)
])
const SHA256_HEX = /^[a-f0-9]{64}$/

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function readUtf8(bytes, label) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes)
  if (bytes.length === 0) throw new Error(`${label} is empty.`)
  if (bytes.length > MAX_LEGAL_FILE_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_LEGAL_FILE_BYTES}-byte legal-file limit.`)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/g, '\n')
  } catch (error) {
    throw new Error(
      `${label} is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function normalizeArchivePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
}

function safePackageRelativePath(value, label) {
  const raw = String(value || '').replace(/\\/g, '/')
  const normalized = path.posix.normalize(raw)
  if (
    !raw.trim() ||
    path.posix.isAbsolute(raw) ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error(`${label} names an unsafe package file: ${String(value)}`)
  }
  return normalized
}

function packageRootForManifest(manifestPath) {
  const parts = normalizeArchivePath(manifestPath).split('/')
  if (parts[parts.length - 1] !== 'package.json') return null
  const nodeModulesIndex = parts.lastIndexOf('node_modules')
  if (nodeModulesIndex < 0) return null
  const tail = parts.slice(nodeModulesIndex + 1)
  const isPlainPackage = tail.length === 2 && !tail[0].startsWith('@')
  const isScopedPackage = tail.length === 3 && tail[0].startsWith('@')
  return isPlainPackage || isScopedPackage ? parts.slice(0, -1).join('/') : null
}

function requirePackageString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Packaged dependency has no ${label}.`)
  }
  return value.trim()
}

function normalizeLicense(packageJson) {
  if (typeof packageJson.license === 'string' && packageJson.license.trim()) {
    return packageJson.license.trim()
  }
  if (
    packageJson.license &&
    typeof packageJson.license === 'object' &&
    typeof packageJson.license.type === 'string' &&
    packageJson.license.type.trim()
  ) {
    return packageJson.license.type.trim()
  }
  if (Array.isArray(packageJson.licenses)) {
    const values = packageJson.licenses
      .map((item) => (typeof item === 'string' ? item : item?.type))
      .filter((item) => typeof item === 'string' && item.trim())
      .map((item) => item.trim())
    if (values.length > 0) return values.join(' OR ')
  }
  throw new Error(
    `Packaged dependency ${String(packageJson.name || 'unknown')}@${String(packageJson.version || 'unknown')} has no declared license.`
  )
}

function normalizeAuthor(author) {
  if (typeof author === 'string') return author.trim() || null
  if (!author || typeof author !== 'object') return null
  const name = typeof author.name === 'string' ? author.name.trim() : ''
  const email = typeof author.email === 'string' ? author.email.trim() : ''
  return name ? `${name}${email ? ` <${email}>` : ''}` : null
}

function normalizeRepository(repository) {
  if (typeof repository === 'string') return repository.trim() || null
  if (!repository || typeof repository !== 'object') return null
  return typeof repository.url === 'string' ? repository.url.trim() || null : null
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(readUtf8(bytes, label))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is invalid JSON: ${error.message}`)
    throw error
  }
}

function archiveReader(asarPath, asarApi) {
  // ASAR's Windows implementation can expose backslash-separated entry names
  // while extractFile still expects that native spelling. Keep a normalized
  // lookup for all policy checks, but retain the exact archive entry for reads.
  const rawByNormalized = new Map()
  for (const rawEntry of asarApi.listPackage(asarPath)) {
    const normalized = normalizeArchivePath(rawEntry)
    if (!rawByNormalized.has(normalized)) rawByNormalized.set(normalized, rawEntry)
  }
  const entries = [...rawByNormalized.keys()].sort()
  const entrySet = new Set(entries)
  return {
    entries,
    has(entry) {
      return entrySet.has(normalizeArchivePath(entry))
    },
    read(entry) {
      const normalized = normalizeArchivePath(entry)
      if (!entrySet.has(normalized)) {
        throw new Error(`Packaged file is missing from app.asar: ${normalized}`)
      }
      const rawEntry = rawByNormalized.get(normalized)
      // @electron/asar treats a leading slash as a host filesystem path. Trying
      // that spelling first mutates its cached archive header while it walks
      // outside the archive, which can add synthetic `..`/empty entries and
      // later break the universal ASAR merge. Archive-root separators are
      // presentation syntax, not part of the extractFile lookup.
      const candidates = [
        typeof rawEntry === 'string' ? rawEntry.replace(/^[/\\]+/, '') : null,
        normalized,
        normalized.split('/').join(path.sep)
      ].filter((candidate, index, list) => candidate && list.indexOf(candidate) === index)
      let lastError
      for (const candidate of candidates) {
        try {
          return Buffer.from(asarApi.extractFile(asarPath, candidate))
        } catch (error) {
          lastError = error
        }
      }
      throw lastError || new Error(`Packaged file cannot be read from app.asar: ${normalized}`)
    }
  }
}

function collectPackagedDependencies(reader) {
  const packages = []
  for (const manifestPath of reader.entries) {
    const root = packageRootForManifest(manifestPath)
    if (!root) continue
    const packageJson = parseJson(reader.read(manifestPath), manifestPath)
    const name = requirePackageString(packageJson.name, 'package name')
    const version = requirePackageString(packageJson.version, `${name} version`)
    const legalFiles = reader.entries.filter(
      (entry) =>
        path.posix.dirname(entry) === root && LEGAL_FILE_NAME.test(path.posix.basename(entry))
    )
    const namedLicense = /^SEE LICENSE IN (.+)$/i.exec(normalizeLicense(packageJson))
    if (namedLicense) {
      const relative = safePackageRelativePath(
        namedLicense[1],
        `${name}@${version} declared license`
      )
      const declaredPath = path.posix.join(root, relative)
      if (reader.has(declaredPath)) {
        legalFiles.push(declaredPath)
      } else if (legalFiles.length === 0) {
        throw new Error(`${name}@${version} declares ${relative}, but it is absent from app.asar.`)
      }
    }
    packages.push({
      author: normalizeAuthor(packageJson.author),
      identity: `${name}@${version}`,
      legalFiles: [...new Set(legalFiles)].sort(),
      license: normalizeLicense(packageJson),
      manifestPath,
      name,
      repository: normalizeRepository(packageJson.repository),
      root,
      version
    })
  }
  if (packages.length === 0) {
    throw new Error('app.asar contains no packaged production dependency manifests.')
  }
  return packages
}

function groupPackageInstances(packages) {
  const groups = new Map()
  for (const item of packages) {
    const existing = groups.get(item.identity)
    if (!existing) {
      groups.set(item.identity, { ...item, instances: [item] })
      continue
    }
    if (existing.license !== item.license) {
      throw new Error(
        `${item.identity} has inconsistent declared licenses (${existing.license} and ${item.license}).`
      )
    }
    existing.instances.push(item)
  }
  return groups
}

function safeRepoRelativePath(repoRoot, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('License override has no bundled file path.')
  }
  const absolute = path.resolve(repoRoot, relativePath)
  const allowedRoot = path.resolve(repoRoot, 'build', 'third-party-license-texts')
  if (absolute !== allowedRoot && !absolute.startsWith(`${allowedRoot}${path.sep}`)) {
    throw new Error(`License override escapes build/third-party-license-texts: ${relativePath}`)
  }
  return absolute
}

function loadOverrides(repoRoot, overridePath) {
  const absolute = path.resolve(
    repoRoot,
    overridePath || path.join('build', 'third-party-license-overrides.json')
  )
  const parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'))
  if (parsed?.schemaVersion !== 1 || !parsed.packages || typeof parsed.packages !== 'object') {
    throw new Error('Third-party license overrides must use schemaVersion 1 and a packages object.')
  }
  return parsed.packages
}

function verifyExpectedHash(bytes, expectedSha256, label) {
  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error(`${label} has no valid expectedSha256.`)
  }
  const actual = sha256(bytes)
  if (actual !== expectedSha256) {
    throw new Error(`${label} SHA-256 mismatch: expected ${expectedSha256}, got ${actual}.`)
  }
  return actual
}

function readPackageRelativeFile(reader, group, relativePath) {
  const normalized = safePackageRelativePath(relativePath, `${group.identity} override`)
  const candidates = group.instances
    .map((instance) => path.posix.join(instance.root, normalized))
    .filter((entry) => reader.has(entry))
  if (candidates.length === 0) {
    throw new Error(`${group.identity} does not package ${normalized}.`)
  }
  const unique = new Map()
  for (const entry of candidates) {
    const bytes = reader.read(entry)
    unique.set(sha256(bytes), { bytes, entry })
  }
  if (unique.size !== 1) {
    throw new Error(`${group.identity} packages different contents for ${normalized}.`)
  }
  return [...unique.values()][0]
}

function resolveOverrideSource({ identity, override, reader, groups, repoRoot }) {
  if (!override || typeof override !== 'object') {
    throw new Error(`${identity} has a malformed license override.`)
  }
  const reason = requirePackageString(override.reason, `${identity} override reason`)
  const source = requirePackageString(override.source, `${identity} override source`)
  let bytes
  let packagedPath = null
  if (override.kind === 'package-file') {
    const sourcePackage = groups.get(override.sourcePackage)
    if (!sourcePackage) {
      throw new Error(
        `${identity} maps to ${String(override.sourcePackage)}, which is absent from app.asar.`
      )
    }
    const resolved = readPackageRelativeFile(reader, sourcePackage, override.file)
    bytes = resolved.bytes
    packagedPath = resolved.entry
  } else if (override.kind === 'bundled-file') {
    const absolute = safeRepoRelativePath(repoRoot, override.file)
    bytes = fs.readFileSync(absolute)
  } else {
    throw new Error(`${identity} has unsupported license override kind ${String(override.kind)}.`)
  }
  const contentSha256 = verifyExpectedHash(bytes, override.expectedSha256, `${identity} override`)
  return {
    contentSha256,
    kind: override.kind,
    packagedPath,
    reason,
    source,
    text: readUtf8(bytes, `${identity} override`),
    upstreamLimitation:
      typeof override.upstreamLimitation === 'string' && override.upstreamLimitation.trim()
        ? override.upstreamLimitation.trim()
        : null
  }
}

function localLegalSources(reader, group) {
  const sources = new Map()
  for (const instance of group.instances) {
    for (const entry of instance.legalFiles) {
      const bytes = reader.read(entry)
      const contentSha256 = sha256(bytes)
      if (!sources.has(contentSha256)) {
        sources.set(contentSha256, {
          contentSha256,
          kind: 'packaged-file',
          packagedPath: entry,
          reason: 'Legal text retained in the packaged dependency.',
          source: entry,
          text: readUtf8(bytes, entry),
          upstreamLimitation: null
        })
      }
    }
  }
  return [...sources.values()].sort((a, b) => a.source.localeCompare(b.source))
}

function renderSource(source) {
  const lines = [`Source: ${source.source}`, `SHA-256: ${source.contentSha256}`]
  if (source.reason) lines.push(`Coverage: ${source.reason}`)
  if (source.upstreamLimitation) lines.push(`Upstream limitation: ${source.upstreamLimitation}`)
  lines.push('', source.text.trimEnd())
  return lines.join('\n')
}

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
  return value
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`)
  }
  return value
}

function safeEmulatorFilePath(value, label) {
  const relative = requirePackageString(value, label).replace(/\\/g, '/')
  const normalized = path.posix.normalize(relative)
  if (
    relative !== normalized ||
    path.posix.isAbsolute(relative) ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error(`${label} is not a safe emulator-relative file path.`)
  }
  return normalized
}

function readEmulatorFile(root, relativePath, label) {
  const safePath = safeEmulatorFilePath(relativePath, label)
  const absolute = path.resolve(root, safePath)
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} escapes the packaged emulator root.`)
  }
  let stat
  try {
    stat = fs.lstatSync(absolute)
  } catch {
    throw new Error(`${label} is missing from packaged emulator resources.`)
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular packaged emulator file.`)
  }
  return { bytes: fs.readFileSync(absolute), path: safePath }
}

function collectEmulatorFiles(current, prefix = '') {
  const files = []
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const relative = prefix ? path.posix.join(prefix, entry.name) : entry.name
    const absolute = path.join(current, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`Packaged emulator payload contains a symbolic link: ${relative}`)
    }
    if (entry.isDirectory()) {
      files.push(...collectEmulatorFiles(absolute, relative))
      continue
    }
    if (!entry.isFile()) {
      throw new Error(`Packaged emulator payload has an unsupported entry: ${relative}`)
    }
    files.push(relative)
  }
  return files.sort()
}

function assertExactEmulatorFileLayout(root) {
  const actual = collectEmulatorFiles(root)
  const expected = [...EMULATOR_PACKAGED_FILES].sort()
  if (actual.length !== expected.length || actual.some((file, index) => file !== expected[index])) {
    throw new Error('Packaged emulator payload has missing or unexpected files.')
  }
}

function readPinnedEmulatorSourceReceipt(repoRoot) {
  const root = path.resolve(repoRoot)
  const sourcePath = path.resolve(root, EMULATOR_SOURCE_RECEIPT.path)
  if (sourcePath !== root && !sourcePath.startsWith(`${root}${path.sep}`)) {
    throw new Error('Emulator source receipt escapes the repository root.')
  }
  if (!fs.existsSync(sourcePath) || !fs.lstatSync(sourcePath).isFile()) {
    throw new Error(`Emulator source receipt is missing: ${sourcePath}`)
  }
  const bytes = fs.readFileSync(sourcePath)
  verifyExpectedHash(bytes, EMULATOR_SOURCE_RECEIPT.sha256, 'Committed emulator source receipt')
  return parseJson(bytes, 'Committed emulator source receipt')
}

function exactStringArray(value, expected, label) {
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw new Error(`${label} has an invalid artifact list.`)
  }
  const actual = [...value].sort()
  const wanted = [...expected].sort()
  if (actual.some((entry, index) => entry !== wanted[index])) {
    throw new Error(`${label} has an invalid artifact list.`)
  }
  return actual
}

function requireExactRecordKeys(value, expectedKeys, label) {
  const record = requireRecord(value, label)
  const actual = Object.keys(record).sort()
  const expected = [...expectedKeys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has an unexpected shape.`)
  }
  return record
}

function canonicalEmulatorStateAdapter(adapter) {
  return JSON.stringify({
    schemaVersion: adapter.schemaVersion,
    adapterId: adapter.adapterId,
    adapterRevision: adapter.adapterRevision,
    coreId: adapter.coreId,
    romSha256: adapter.romSha256,
    memoryBytes: adapter.memoryBytes,
    stateWindow: {
      source: adapter.stateWindow.source,
      startAddress: adapter.stateWindow.startAddress,
      byteLength: adapter.stateWindow.byteLength
    },
    fields: adapter.fields.map((field) => ({
      key: field.key,
      kind: field.kind,
      read: {
        address: field.read.address,
        encoding: field.read.encoding
      },
      unit: field.unit
    }))
  })
}

function assertEmulatorStatePackage({ assetsByPath, bundle, receipt, root }) {
  const declared = requireExactRecordKeys(
    bundle.statePackage,
    [
      'path',
      'sha256',
      'byteLength',
      'schemaVersion',
      'coreSha256',
      'runtimeWasmSha256',
      'romSha256',
      'stateAdapterSchemaSha256'
    ],
    'Emulator provenance state package'
  )
  const file = verifyEmulatorFile(root, declared, 'Emulator provenance state package')
  if (file.path !== EMULATOR_STATE_PACKAGE_PATH) {
    throw new Error('Emulator provenance state package has an unexpected path.')
  }
  const descriptor = requireExactRecordKeys(
    parseJson(file.bytes, 'Emulator state package descriptor'),
    [
      'schemaVersion',
      'gameId',
      'coreId',
      'coreSha256',
      'runtimeWasmSha256',
      'romSha256',
      'stateAdapter'
    ],
    'Emulator state package descriptor'
  )
  const shippedCore = requireRecord(receipt?.pins?.shippedCore, 'Committed SameBoy core receipt')
  const coreObject = requireRecord(shippedCore.object, 'Committed SameBoy core object receipt')
  const fixture = requireRecord(receipt?.source?.fixture, 'Committed fixture receipt')
  const fixtureRom = requireRecord(fixture.rom, 'Committed fixture ROM receipt')
  const wasm = assetsByPath.get('twgb.wasm')
  if (
    !wasm ||
    descriptor.schemaVersion !== 2 ||
    descriptor.gameId !== EMULATOR_GAME_ID ||
    descriptor.coreId !== 'sameboy-libretro' ||
    descriptor.coreSha256 !== coreObject.sha256 ||
    descriptor.runtimeWasmSha256 !== wasm.sha256 ||
    descriptor.romSha256 !== fixtureRom.sha256
  ) {
    throw new Error(
      'Emulator state package descriptor does not match the reviewed package binding.'
    )
  }
  const adapter = requireExactRecordKeys(
    descriptor.stateAdapter,
    [
      'schemaVersion',
      'adapterId',
      'adapterRevision',
      'schemaSha256',
      'coreId',
      'romSha256',
      'memoryBytes',
      'stateWindow',
      'fields'
    ],
    'Emulator state adapter descriptor'
  )
  const stateWindow = requireExactRecordKeys(
    adapter.stateWindow,
    ['source', 'startAddress', 'byteLength'],
    'Emulator state adapter window'
  )
  if (
    adapter.schemaVersion !== 2 ||
    adapter.adapterId !== 'twgb-state-window' ||
    adapter.adapterRevision !== 'v1' ||
    adapter.coreId !== descriptor.coreId ||
    adapter.romSha256 !== descriptor.romSha256 ||
    adapter.memoryBytes !== EMULATOR_STATE_WINDOW.byteLength ||
    stateWindow.source !== EMULATOR_STATE_WINDOW.source ||
    stateWindow.startAddress !== EMULATOR_STATE_WINDOW.startAddress ||
    stateWindow.byteLength !== EMULATOR_STATE_WINDOW.byteLength ||
    !Array.isArray(adapter.fields) ||
    adapter.fields.length !== EMULATOR_STATE_FIELDS.length
  ) {
    throw new Error('Emulator state package descriptor has an unexpected state adapter.')
  }
  for (const [index, expected] of EMULATOR_STATE_FIELDS.entries()) {
    const field = requireExactRecordKeys(
      adapter.fields[index],
      ['key', 'kind', 'read', 'unit'],
      `Emulator state adapter field ${index}`
    )
    const read = requireExactRecordKeys(
      field.read,
      ['address', 'encoding'],
      `Emulator state adapter field ${index} read`
    )
    if (
      field.key !== expected.key ||
      field.kind !== 'integer' ||
      field.unit !== expected.unit ||
      read.address !== expected.address ||
      read.encoding !== expected.encoding
    ) {
      throw new Error(`Emulator state adapter field ${index} does not match the TWGB ABI.`)
    }
  }
  if (!SHA256_HEX.test(String(adapter.schemaSha256 || ''))) {
    throw new Error('Emulator state adapter descriptor has no valid schema SHA-256.')
  }
  const calculatedSchemaSha256 = sha256(Buffer.from(canonicalEmulatorStateAdapter(adapter), 'utf8'))
  if (adapter.schemaSha256 !== calculatedSchemaSha256) {
    throw new Error('Emulator state adapter descriptor schema SHA-256 does not match.')
  }
  if (
    declared.schemaVersion !== descriptor.schemaVersion ||
    declared.coreSha256 !== descriptor.coreSha256 ||
    declared.runtimeWasmSha256 !== descriptor.runtimeWasmSha256 ||
    declared.romSha256 !== descriptor.romSha256 ||
    declared.stateAdapterSchemaSha256 !== adapter.schemaSha256
  ) {
    throw new Error('Emulator provenance state package does not bind its descriptor.')
  }
  return {
    byteLength: file.byteLength,
    path: file.path,
    sha256: file.sha256,
    schemaVersion: descriptor.schemaVersion,
    coreSha256: descriptor.coreSha256,
    runtimeWasmSha256: descriptor.runtimeWasmSha256,
    romSha256: descriptor.romSha256,
    stateAdapterSchemaSha256: adapter.schemaSha256
  }
}

function assertEmulatorSourceReceiptBinding({
  componentById,
  provenance,
  repoRoot,
  validationSameBoy
}) {
  const sourceReceipt = requireRecord(provenance.sourceReceipt, 'Emulator source receipt')
  if (
    sourceReceipt.commit !== EMULATOR_SOURCE_RECEIPT.commit ||
    sourceReceipt.path !== EMULATOR_SOURCE_RECEIPT.path ||
    sourceReceipt.sha256 !== EMULATOR_SOURCE_RECEIPT.sha256
  ) {
    throw new Error('Emulator component provenance is not bound to the committed source receipt.')
  }
  const receipt = readPinnedEmulatorSourceReceipt(repoRoot)
  const shippedCore = requireRecord(receipt?.pins?.shippedCore, 'Committed SameBoy core receipt')
  const coreObject = requireRecord(shippedCore.object, 'Committed SameBoy core object receipt')
  const emscripten = requireRecord(receipt?.pins?.emscripten, 'Committed Emscripten receipt')
  const fixture = requireRecord(receipt?.source?.fixture, 'Committed fixture receipt')
  const fixtureFiles = requireRecord(fixture.files, 'Committed fixture source receipt')
  const host = requireRecord(receipt?.source?.host, 'Committed host receipt')
  const validationOnly = requireRecord(
    receipt?.validationOnly?.sameboy,
    'Committed validation-only receipt'
  )

  const hostSource = requireRecord(
    componentById.get('taskwraith-twemu-host').source,
    'Host provenance'
  )
  const expectedHostPath = path.posix.join(
    path.posix.dirname(EMULATOR_SOURCE_RECEIPT.path),
    host.path
  )
  if (hostSource.path !== expectedHostPath || hostSource.sha256 !== host.sha256) {
    throw new Error('Emulator host provenance does not match the committed source receipt.')
  }
  const sameBoySource = requireRecord(
    componentById.get('sameboy-libretro').source,
    'SameBoy provenance'
  )
  for (const key of ['repository', 'ref', 'commit', 'version']) {
    if (sameBoySource[key] !== shippedCore[key]) {
      throw new Error(`SameBoy provenance ${key} does not match the committed source receipt.`)
    }
  }
  if (sameBoySource.coreObjectSha256 !== coreObject.sha256) {
    throw new Error('SameBoy provenance core object does not match the committed source receipt.')
  }
  const libretroSource = requireRecord(
    componentById.get('libretro-common').source,
    'libretro-common provenance'
  )
  if (
    libretroSource.vendoredWithSameBoyCommit !== shippedCore.commit ||
    libretroSource.path !== 'libretro/libretro-common/include/libretro.h' ||
    libretroSource.copyright !== 'The RetroArch team (2010-2020)'
  ) {
    throw new Error('libretro-common provenance does not match the committed SameBoy receipt.')
  }
  const emscriptenSource = requireRecord(
    componentById.get('emscripten-runtime').source,
    'Emscripten provenance'
  )
  for (const key of ['version', 'emsdkCommit', 'emscriptenSourceCommit']) {
    if (emscriptenSource[key] !== emscripten[key]) {
      throw new Error(`Emscripten provenance ${key} does not match the committed source receipt.`)
    }
  }
  if (emscriptenSource.repository !== 'https://github.com/emscripten-core/emscripten.git') {
    throw new Error('Emscripten provenance has an unexpected repository.')
  }
  const fixtureSource = requireRecord(
    componentById.get('taskwraith-fixture').source,
    'Fixture provenance'
  )
  if (
    fixtureSource.mainAsmSha256 !== fixtureFiles['src/main.asm'] ||
    fixtureSource.hardwareIncludeSha256 !== fixtureFiles['src/hardware.inc'] ||
    fixtureSource.romSha256 !== fixture?.rom?.sha256 ||
    fixtureSource.romByteLength !== fixture?.rom?.byteLength
  ) {
    throw new Error('Fixture provenance does not match the committed source receipt.')
  }
  for (const key of ['repository', 'commit', 'version', 'purpose']) {
    if (validationSameBoy[key] !== validationOnly[key]) {
      throw new Error(`Validation-only SameBoy ${key} does not match the committed source receipt.`)
    }
  }
  return receipt
}

function verifyEmulatorFile(root, value, label) {
  const declared = requireRecord(value, label)
  const expectedSha256 = declared.sha256
  if (typeof expectedSha256 !== 'string' || !SHA256_HEX.test(expectedSha256)) {
    throw new Error(`${label} has no valid SHA-256.`)
  }
  const expectedByteLength = requirePositiveInteger(declared.byteLength, `${label} byte length`)
  const file = readEmulatorFile(root, declared.path, label)
  if (file.bytes.byteLength !== expectedByteLength) {
    throw new Error(`${label} byte length mismatch.`)
  }
  verifyExpectedHash(file.bytes, expectedSha256, label)
  return { ...file, byteLength: expectedByteLength, sha256: expectedSha256 }
}

function requireExactEmulatorIds(components) {
  if (!Array.isArray(components) || components.length !== EMULATOR_COMPONENT_IDS.length) {
    throw new Error('Emulator component provenance has an unexpected component count.')
  }
  const byId = new Map()
  for (const value of components) {
    const component = requireRecord(value, 'Emulator component')
    const id = requirePackageString(component.id, 'Emulator component id')
    if (byId.has(id)) throw new Error(`Emulator component provenance duplicates ${id}.`)
    byId.set(id, component)
  }
  for (const id of EMULATOR_COMPONENT_IDS) {
    if (!byId.has(id)) throw new Error(`Emulator component provenance omits ${id}.`)
  }
  return byId
}

function readEmulatorNotice(resourcesDir, repoRoot = path.resolve(__dirname, '..')) {
  const root = path.join(resourcesDir, ...EMULATOR_ROOT.split('/'))
  let rootStat
  try {
    rootStat = fs.lstatSync(root)
  } catch {
    throw new Error(`Packaged emulator root is missing: ${root}`)
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Packaged emulator root is missing: ${root}`)
  }
  assertExactEmulatorFileLayout(root)
  const manifestFile = readEmulatorFile(root, 'manifest.json', 'Emulator runtime manifest')
  const manifest = parseJson(manifestFile.bytes, 'Emulator runtime manifest')
  if (
    manifest?.schemaVersion !== 1 ||
    manifest?.gameId !== EMULATOR_GAME_ID ||
    manifest?.entryPath !== 'index.html' ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length !== Object.keys(EMULATOR_ASSET_MIME_TYPES).length
  ) {
    throw new Error('Packaged emulator runtime manifest has an unsupported shape.')
  }
  const assetsByPath = new Map()
  for (const value of manifest.assets) {
    const asset = requireRecord(value, 'Emulator runtime asset')
    const assetPath = safeEmulatorFilePath(asset.path, 'Emulator runtime asset path')
    const expectedMimeType = EMULATOR_ASSET_MIME_TYPES[assetPath]
    if (!expectedMimeType || asset.mimeType !== expectedMimeType || assetsByPath.has(assetPath)) {
      throw new Error(`Packaged emulator runtime manifest has an invalid asset ${assetPath}.`)
    }
    assetsByPath.set(assetPath, verifyEmulatorFile(root, asset, `Emulator asset ${assetPath}`))
  }
  for (const assetPath of Object.keys(EMULATOR_ASSET_MIME_TYPES)) {
    if (!assetsByPath.has(assetPath)) {
      throw new Error(`Packaged emulator runtime manifest omits ${assetPath}.`)
    }
  }

  const provenanceFile = readEmulatorFile(
    root,
    'component-provenance.json',
    'Emulator component provenance'
  )
  const provenance = parseJson(provenanceFile.bytes, 'Emulator component provenance')
  const bundle = requireRecord(provenance?.bundle, 'Emulator component bundle')
  const runtimeManifest = verifyEmulatorFile(
    root,
    bundle.runtimeManifest,
    'Emulator provenance runtime manifest'
  )
  if (
    provenance?.schemaVersion !== 1 ||
    bundle.gameId !== EMULATOR_GAME_ID ||
    runtimeManifest.path !== 'manifest.json' ||
    runtimeManifest.sha256 !== sha256(manifestFile.bytes) ||
    runtimeManifest.byteLength !== manifestFile.bytes.byteLength
  ) {
    throw new Error('Emulator component provenance does not bind the runtime manifest.')
  }
  if (!Array.isArray(bundle.artifacts) || bundle.artifacts.length !== 2) {
    throw new Error('Emulator component provenance has an invalid artifact list.')
  }
  const artifactPaths = new Set()
  for (const artifact of bundle.artifacts) {
    const verified = verifyEmulatorFile(root, artifact, 'Emulator provenance artifact')
    const manifestAsset = assetsByPath.get(verified.path)
    if (
      !manifestAsset ||
      manifestAsset.sha256 !== verified.sha256 ||
      artifactPaths.has(verified.path)
    ) {
      throw new Error(`Emulator component provenance has an invalid artifact ${verified.path}.`)
    }
    artifactPaths.add(verified.path)
  }
  if (!artifactPaths.has('twgb.mjs') || !artifactPaths.has('twgb.wasm')) {
    throw new Error('Emulator component provenance omits a shipped Emscripten artifact.')
  }

  const sourceReceipt = requireRecord(provenance?.sourceReceipt, 'Emulator source receipt')
  if (
    !/^[a-f0-9]{40}$/.test(String(sourceReceipt.commit || '')) ||
    !SHA256_HEX.test(String(sourceReceipt.sha256 || '')) ||
    typeof sourceReceipt.path !== 'string'
  ) {
    throw new Error('Emulator component provenance has an invalid source receipt.')
  }
  const componentById = requireExactEmulatorIds(provenance.components)
  const components = []
  for (const id of EMULATOR_COMPONENT_IDS) {
    const component = componentById.get(id)
    if (!component || !component.source || typeof component.source !== 'object') {
      throw new Error(`Emulator component provenance has no source for ${id}.`)
    }
    const embeddedArtifacts = exactStringArray(
      component.embeddedArtifacts,
      EMULATOR_COMPONENT_ARTIFACTS[id],
      `Emulator ${id}`
    )
    for (const artifactPath of embeddedArtifacts) {
      if (!assetsByPath.has(artifactPath)) {
        throw new Error(`Emulator ${id} references an unverified artifact ${artifactPath}.`)
      }
    }
    if (!EMULATOR_LICENSE_COMPONENT_IDS.has(id)) {
      if (component.license !== 'Apache-2.0') {
        throw new Error(`Emulator component provenance has an invalid app license for ${id}.`)
      }
      components.push({ id, license: null, source: component.source })
      continue
    }
    const license = requireRecord(component.license, `Emulator ${id} license`)
    const licenseFile = verifyEmulatorFile(root, license, `Emulator ${id} license`)
    if (licenseFile.path !== EMULATOR_LICENSE_PATHS[id]) {
      throw new Error(`Emulator ${id} has an unexpected packaged license path.`)
    }
    const spdx = requirePackageString(license.spdx, `Emulator ${id} SPDX license`)
    if (spdx !== EMULATOR_LICENSE_SPDX[id]) {
      throw new Error(`Emulator ${id} has an unexpected SPDX license.`)
    }
    components.push({
      id,
      license: {
        byteLength: licenseFile.byteLength,
        path: licenseFile.path,
        sha256: licenseFile.sha256,
        spdx,
        text: readUtf8(licenseFile.bytes, `Emulator ${id} license`)
      },
      source: component.source
    })
  }
  const validationOnly = requireRecord(
    provenance?.validationOnly,
    'Emulator validation-only record'
  )
  const validationSameBoy = requireRecord(
    validationOnly.sameboy,
    'Emulator validation-only SameBoy'
  )
  if (
    !/^[a-f0-9]{40}$/.test(String(validationSameBoy.commit || '')) ||
    typeof validationSameBoy.version !== 'string' ||
    typeof validationSameBoy.purpose !== 'string'
  ) {
    throw new Error('Emulator component provenance has an invalid validation-only SameBoy record.')
  }
  const receipt = assertEmulatorSourceReceiptBinding({
    componentById,
    provenance,
    repoRoot,
    validationSameBoy
  })
  const statePackage = assertEmulatorStatePackage({ assetsByPath, bundle, receipt, root })
  return {
    assets: [...assetsByPath.entries()]
      .map(([assetPath, asset]) => ({
        byteLength: asset.byteLength,
        mimeType: EMULATOR_ASSET_MIME_TYPES[assetPath],
        path: assetPath,
        sha256: asset.sha256
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    components,
    gameId: EMULATOR_GAME_ID,
    manifest: {
      byteLength: manifestFile.bytes.byteLength,
      path: 'manifest.json',
      sha256: sha256(manifestFile.bytes)
    },
    statePackage,
    provenance: {
      byteLength: provenanceFile.bytes.byteLength,
      path: 'component-provenance.json',
      sha256: sha256(provenanceFile.bytes),
      sourceReceipt,
      validationOnly
    },
    root: EMULATOR_ROOT
  }
}

function emulatorInventoryRecord(emulator) {
  return {
    assets: emulator.assets,
    components: emulator.components.map((component) => ({
      id: component.id,
      license: component.license
        ? {
            byteLength: component.license.byteLength,
            path: component.license.path,
            sha256: component.license.sha256,
            spdx: component.license.spdx
          }
        : null,
      source: component.source
    })),
    gameId: emulator.gameId,
    manifest: emulator.manifest,
    statePackage: emulator.statePackage,
    provenance: emulator.provenance,
    root: emulator.root
  }
}

function renderNotices({ app, electron, emulator, nodeRuntime, packages, summary }) {
  const chunks = [
    'TASKWRAITH THIRD-PARTY NOTICES',
    '',
    'This file is generated from the dependency manifests and legal files in the exact packaged app.asar payload plus verified packaged runtime resources. A package or shipped emulator component without retained legal text and pinned hashes fails packaging.',
    '',
    `TaskWraith ${app.version} is licensed separately under ${app.license}; see ${NOTICE_FILES.app}.`,
    `Packaged dependency instances: ${summary.packageInstanceCount}`,
    `Unique dependency identities: ${summary.packageIdentityCount}`,
    `Reviewed coverage mappings: ${summary.reviewedOverrideCount}`,
    `Recorded upstream attribution limitations: ${summary.upstreamLimitationCount}`,
    `Packaged emulator components: ${emulator.components.length}`,
    '',
    'Chromium and Chromium-derived component notices are retained separately in LICENSES.chromium.html.',
    '',
    '='.repeat(79),
    `Electron ${electron.version}`,
    `Declared license: ${electron.license}`,
    renderSource(electron.source),
    '',
    '='.repeat(79),
    `Node.js standalone TUI runtime ${nodeRuntime.version}`,
    `Packaged targets: ${nodeRuntime.targets.join(', ')}`,
    renderSource(nodeRuntime.source)
  ]

  chunks.push(
    '',
    '='.repeat(79),
    `Emulator bundle ${emulator.gameId}`,
    `Runtime manifest: ${emulator.root}/${emulator.manifest.path}`,
    `Runtime manifest SHA-256: ${emulator.manifest.sha256}`,
    `Disk-only state package: ${emulator.root}/${emulator.statePackage.path}`,
    `State package SHA-256: ${emulator.statePackage.sha256}`,
    `Component provenance: ${emulator.root}/${emulator.provenance.path}`,
    `Source receipt: ${emulator.provenance.sourceReceipt.path}@${emulator.provenance.sourceReceipt.commit}`
  )
  for (const component of emulator.components) {
    if (!component.license) continue
    chunks.push(
      '',
      '-'.repeat(79),
      component.id,
      `Declared license: ${component.license.spdx}`,
      renderSource({
        contentSha256: component.license.sha256,
        kind: 'packaged-emulator-license',
        packagedPath: `${emulator.root}/${component.license.path}`,
        reason: 'Exact license text retained beside the packaged fixed emulator bundle.',
        source: `${emulator.root}/${component.license.path}`,
        text: component.license.text,
        upstreamLimitation: null
      })
    )
  }

  for (const item of packages) {
    chunks.push(
      '',
      '='.repeat(79),
      `${item.name} ${item.version}`,
      `Declared license: ${item.license}`
    )
    if (item.author) chunks.push(`Upstream author metadata: ${item.author}`)
    if (item.repository) chunks.push(`Repository: ${item.repository}`)
    for (const source of item.sources) chunks.push(renderSource(source))
  }
  return `${chunks.join('\n')}\n`
}

function readRuntimeNotice(resourcesDir) {
  const runtimeRoot = path.join(resourcesDir, 'tui-runtime')
  const metadataPath = path.join(runtimeRoot, 'RUNTIME.json')
  if (!fs.existsSync(metadataPath))
    throw new Error(`Packaged runtime metadata is missing: ${metadataPath}`)
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
  const version = requirePackageString(metadata.nodeVersion, 'Node runtime version')
  if (!Array.isArray(metadata.targets) || metadata.targets.length === 0) {
    throw new Error('Packaged Node runtime metadata has no targets.')
  }
  const notices = new Map()
  const targets = []
  for (const target of metadata.targets) {
    const dirName = requirePackageString(target.dirName, 'Node runtime target dirName')
    const licenseName = requirePackageString(target.license, `${dirName} Node license file`)
    const licensePath = path.join(runtimeRoot, dirName, licenseName)
    const bytes = fs.readFileSync(licensePath)
    const contentSha256 = verifyExpectedHash(
      bytes,
      target.licenseSha256,
      `${dirName} Node runtime license`
    )
    notices.set(contentSha256, {
      bytes,
      contentSha256,
      source: requirePackageString(target.licenseSource, `${dirName} Node license source`)
    })
    targets.push(dirName)
  }
  if (notices.size !== 1) {
    throw new Error('Packaged Node runtime targets do not carry identical license notices.')
  }
  const notice = [...notices.values()][0]
  return {
    source: {
      contentSha256: notice.contentSha256,
      kind: 'packaged-runtime-file',
      packagedPath: `tui-runtime/*/${metadata.targets[0].license}`,
      reason: 'Verified against each packaged Node runtime target metadata record.',
      source: notice.source,
      text: readUtf8(notice.bytes, 'Node runtime license'),
      upstreamLimitation: null
    },
    targets: targets.sort(),
    version
  }
}

function writeFile(outputPath, contents) {
  fs.writeFileSync(outputPath, contents)
  if (!fs.statSync(outputPath).isFile() || fs.statSync(outputPath).size === 0) {
    throw new Error(`Generated legal notice is empty: ${outputPath}`)
  }
}

function generateThirdPartyNotices({
  resourcesDir,
  repoRoot = path.resolve(__dirname, '..'),
  overridePath,
  asarApi = require('@electron/asar'),
  electronVersion
} = {}) {
  if (!resourcesDir || !fs.statSync(resourcesDir).isDirectory()) {
    throw new Error(`Electron resources directory is missing: ${String(resourcesDir)}`)
  }
  const asarPath = path.join(resourcesDir, 'app.asar')
  if (!fs.existsSync(asarPath)) throw new Error(`Packaged app.asar is missing: ${asarPath}`)
  const reader = archiveReader(asarPath, asarApi)
  const appPackage = parseJson(reader.read('package.json'), 'packaged package.json')
  const app = {
    license: normalizeLicense(appPackage),
    name: requirePackageString(appPackage.name, 'app package name'),
    version: requirePackageString(appPackage.version, 'app version')
  }
  const appLicenseBytes = reader.read('LICENSE')
  readUtf8(appLicenseBytes, 'TaskWraith LICENSE')

  const instances = collectPackagedDependencies(reader)
  const groups = groupPackageInstances(instances)
  const overrides = loadOverrides(repoRoot, overridePath)
  const packages = []
  const missing = []
  let reviewedOverrideCount = 0
  let upstreamLimitationCount = 0
  for (const group of [...groups.values()].sort((a, b) => a.identity.localeCompare(b.identity))) {
    let sources = localLegalSources(reader, group)
    const override = overrides[group.identity]
    if (sources.length > 0 && override) {
      throw new Error(
        `${group.identity} now packages legal text; remove its obsolete reviewed override.`
      )
    }
    if (sources.length === 0) {
      if (!override) {
        missing.push(group.identity)
        continue
      }
      const source = resolveOverrideSource({
        identity: group.identity,
        override,
        reader,
        groups,
        repoRoot
      })
      sources = [source]
      reviewedOverrideCount += 1
      if (source.upstreamLimitation) upstreamLimitationCount += 1
    }
    packages.push({
      author: group.author,
      identity: group.identity,
      instanceCount: group.instances.length,
      license: group.license,
      name: group.name,
      repository: group.repository,
      sources,
      version: group.version
    })
  }
  if (missing.length > 0) {
    throw new Error(
      `Packaged dependencies lack legal text or a reviewed version-pinned mapping:\n- ${missing.join('\n- ')}`
    )
  }

  const electronRoot = path.join(repoRoot, 'node_modules', 'electron')
  const electronPackage = JSON.parse(
    fs.readFileSync(path.join(electronRoot, 'package.json'), 'utf8')
  )
  const resolvedElectronVersion = requirePackageString(electronPackage.version, 'Electron version')
  if (electronVersion && String(electronVersion).replace(/^v/, '') !== resolvedElectronVersion) {
    throw new Error(
      `Packaged Electron ${String(electronVersion)} does not match notice source ${resolvedElectronVersion}.`
    )
  }
  const electronLicenseBytes = fs.readFileSync(path.join(electronRoot, 'dist', 'LICENSE'))
  const chromiumBytes = fs.readFileSync(path.join(electronRoot, 'dist', NOTICE_FILES.chromium))
  const electron = {
    license: normalizeLicense(electronPackage),
    source: {
      contentSha256: sha256(electronLicenseBytes),
      kind: 'electron-distribution-file',
      packagedPath: NOTICE_FILES.thirdParty,
      reason: 'Copied from the Electron distribution used by electron-builder.',
      source: `electron@${resolvedElectronVersion}/dist/LICENSE`,
      text: readUtf8(electronLicenseBytes, 'Electron LICENSE'),
      upstreamLimitation: null
    },
    version: resolvedElectronVersion
  }
  const nodeRuntime = readRuntimeNotice(resourcesDir)
  const emulator = readEmulatorNotice(resourcesDir, repoRoot)
  const summary = {
    packageIdentityCount: packages.length,
    packageInstanceCount: instances.length,
    reviewedOverrideCount,
    upstreamLimitationCount
  }
  const noticeText = renderNotices({ app, electron, emulator, nodeRuntime, packages, summary })
  const outputHashes = {
    appLicenseSha256: sha256(appLicenseBytes),
    chromiumNoticesSha256: sha256(chromiumBytes),
    thirdPartyNoticesSha256: sha256(noticeText)
  }
  const inventory = {
    schemaVersion: NOTICE_SCHEMA_VERSION,
    source: 'exact-packaged-app-asar',
    sourceScope: 'exact-packaged-app-asar-and-resources',
    app: { ...app, noticeFile: NOTICE_FILES.app, sha256: outputHashes.appLicenseSha256 },
    summary,
    packages: packages.map((item) => ({
      author: item.author,
      identity: item.identity,
      instanceCount: item.instanceCount,
      license: item.license,
      name: item.name,
      repository: item.repository,
      sources: item.sources.map((source) => ({
        contentSha256: source.contentSha256,
        kind: source.kind,
        packagedPath: source.packagedPath,
        reason: source.reason,
        source: source.source,
        upstreamLimitation: source.upstreamLimitation
      })),
      version: item.version
    })),
    runtimes: {
      electron: {
        license: electron.license,
        licenseSha256: electron.source.contentSha256,
        version: electron.version
      },
      node: {
        licenseSha256: nodeRuntime.source.contentSha256,
        targets: nodeRuntime.targets,
        version: nodeRuntime.version
      }
    },
    emulator: emulatorInventoryRecord(emulator),
    files: {
      appLicense: NOTICE_FILES.app,
      chromiumNotices: NOTICE_FILES.chromium,
      chromiumNoticesSha256: outputHashes.chromiumNoticesSha256,
      thirdPartyNotices: NOTICE_FILES.thirdParty,
      thirdPartyNoticesSha256: outputHashes.thirdPartyNoticesSha256
    }
  }

  writeFile(path.join(resourcesDir, NOTICE_FILES.app), appLicenseBytes)
  writeFile(path.join(resourcesDir, NOTICE_FILES.chromium), chromiumBytes)
  writeFile(path.join(resourcesDir, NOTICE_FILES.thirdParty), noticeText)
  writeFile(
    path.join(resourcesDir, NOTICE_FILES.inventory),
    `${JSON.stringify(inventory, null, 2)}\n`
  )
  validatePackagedNotices(resourcesDir, { repoRoot })
  return inventory
}

function validatePackagedNotices(resourcesDir, { repoRoot = path.resolve(__dirname, '..') } = {}) {
  const inventoryPath = path.join(resourcesDir, NOTICE_FILES.inventory)
  if (!fs.existsSync(inventoryPath)) {
    throw new Error(`Packaged third-party notice inventory is missing: ${inventoryPath}`)
  }
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'))
  if (
    inventory?.schemaVersion !== NOTICE_SCHEMA_VERSION ||
    inventory?.source !== 'exact-packaged-app-asar' ||
    inventory?.sourceScope !== 'exact-packaged-app-asar-and-resources'
  ) {
    throw new Error('Packaged third-party notice inventory has an unsupported schema or source.')
  }
  const checks = [
    [NOTICE_FILES.app, inventory.app?.sha256],
    [NOTICE_FILES.thirdParty, inventory.files?.thirdPartyNoticesSha256],
    [NOTICE_FILES.chromium, inventory.files?.chromiumNoticesSha256]
  ]
  for (const [fileName, expected] of checks) {
    const filePath = path.join(resourcesDir, fileName)
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`Packaged legal notice is missing: ${filePath}`)
    }
    verifyExpectedHash(fs.readFileSync(filePath), expected, `Packaged ${fileName}`)
  }
  if (
    !Number.isInteger(inventory.summary?.packageInstanceCount) ||
    inventory.summary.packageInstanceCount < 1
  ) {
    throw new Error('Packaged third-party notice inventory records no dependency instances.')
  }
  const emulator = readEmulatorNotice(resourcesDir, repoRoot)
  if (JSON.stringify(inventory.emulator) !== JSON.stringify(emulatorInventoryRecord(emulator))) {
    throw new Error('Packaged third-party notice inventory does not match emulator resources.')
  }
  return inventory
}

module.exports = {
  NOTICE_FILES,
  NOTICE_SCHEMA_VERSION,
  canonicalEmulatorStateAdapter,
  collectPackagedDependencies,
  emulatorInventoryRecord,
  generateThirdPartyNotices,
  groupPackageInstances,
  packageRootForManifest,
  readEmulatorNotice,
  validatePackagedNotices
}
