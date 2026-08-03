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
    .replace(/^\/+/, '')
    .replace(/\\/g, '/')
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
  const entries = [...new Set(asarApi.listPackage(asarPath).map(normalizeArchivePath))].sort()
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
      return Buffer.from(asarApi.extractFile(asarPath, normalized))
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

function renderNotices({ app, electron, nodeRuntime, packages, summary }) {
  const chunks = [
    'TASKWRAITH THIRD-PARTY NOTICES',
    '',
    'This file is generated from the dependency manifests and legal files in the exact packaged app.asar payload. A package without retained legal text or an explicit version-pinned coverage mapping fails packaging.',
    '',
    `TaskWraith ${app.version} is licensed separately under ${app.license}; see ${NOTICE_FILES.app}.`,
    `Packaged dependency instances: ${summary.packageInstanceCount}`,
    `Unique dependency identities: ${summary.packageIdentityCount}`,
    `Reviewed coverage mappings: ${summary.reviewedOverrideCount}`,
    `Recorded upstream attribution limitations: ${summary.upstreamLimitationCount}`,
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
  const summary = {
    packageIdentityCount: packages.length,
    packageInstanceCount: instances.length,
    reviewedOverrideCount,
    upstreamLimitationCount
  }
  const noticeText = renderNotices({ app, electron, nodeRuntime, packages, summary })
  const outputHashes = {
    appLicenseSha256: sha256(appLicenseBytes),
    chromiumNoticesSha256: sha256(chromiumBytes),
    thirdPartyNoticesSha256: sha256(noticeText)
  }
  const inventory = {
    schemaVersion: NOTICE_SCHEMA_VERSION,
    source: 'exact-packaged-app-asar',
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
  validatePackagedNotices(resourcesDir)
  return inventory
}

function validatePackagedNotices(resourcesDir) {
  const inventoryPath = path.join(resourcesDir, NOTICE_FILES.inventory)
  if (!fs.existsSync(inventoryPath)) {
    throw new Error(`Packaged third-party notice inventory is missing: ${inventoryPath}`)
  }
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'))
  if (
    inventory?.schemaVersion !== NOTICE_SCHEMA_VERSION ||
    inventory?.source !== 'exact-packaged-app-asar'
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
  return inventory
}

module.exports = {
  NOTICE_FILES,
  NOTICE_SCHEMA_VERSION,
  collectPackagedDependencies,
  generateThirdPartyNotices,
  groupPackageInstances,
  packageRootForManifest,
  validatePackagedNotices
}
