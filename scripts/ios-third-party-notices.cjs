#!/usr/bin/env node

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..')
const MANIFEST_RELATIVE_PATH = 'ios/TaskWraithKit/ThirdPartyLicenses/manifest.json'
const PACKAGE_RESOLVED_RELATIVE_PATHS = [
  'ios/TaskWraithKit/Package.resolved',
  'ios/TaskWraithApp/TaskWraith.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved'
]
const APP_LICENSE_RELATIVE_PATH = 'LICENSE'
const APP_LICENSE_OUTPUT_RELATIVE_PATH =
  'ios/TaskWraithKit/Sources/TaskWraithUI/Resources/TASKWRAITH-LICENSE.txt'
const THIRD_PARTY_OUTPUT_RELATIVE_PATH =
  'ios/TaskWraithKit/Sources/TaskWraithUI/Resources/THIRD-PARTY-NOTICES.txt'
const LICENSE_SOURCE_ROOT = 'ios/TaskWraithKit/ThirdPartyLicenses'

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function normalizePins(resolved, sourceLabel) {
  if (resolved?.version !== 3 || !Array.isArray(resolved?.pins)) {
    throw new Error(sourceLabel + ' must be a Swift Package.resolved v3 file')
  }

  const pins = resolved.pins.map((pin) => {
    const identity = String(pin?.identity ?? '').trim()
    const kind = String(pin?.kind ?? '').trim()
    const location = String(pin?.location ?? '').trim()
    const version = String(pin?.state?.version ?? '').trim()
    const revision = String(pin?.state?.revision ?? '').trim()
    if (!identity || !kind || !location || !version || !revision) {
      throw new Error(sourceLabel + ' contains an incomplete Swift package pin')
    }
    return { identity, kind, location, version, revision }
  })

  pins.sort((a, b) => a.identity.localeCompare(b.identity))
  const duplicate = pins.find(
    (pin, index) => index > 0 && pin.identity === pins[index - 1].identity
  )
  if (duplicate) throw new Error(sourceLabel + ' contains duplicate pin ' + duplicate.identity)
  return pins
}

function resolveContainedPath(repoRoot, relativePath, allowedRoot) {
  if (typeof relativePath !== 'string' || !relativePath.trim() || path.isAbsolute(relativePath)) {
    throw new Error('Notice source path must be a non-empty repository-relative path')
  }
  const resolved = path.resolve(repoRoot, relativePath)
  const root = path.resolve(repoRoot, allowedRoot)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('Notice source escapes ' + allowedRoot + ': ' + relativePath)
  }
  return resolved
}

function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest?.packages)) {
    throw new Error('iOS third-party license manifest must use schemaVersion 1')
  }
  const identities = new Set()
  for (const pkg of manifest.packages) {
    for (const field of ['identity', 'kind', 'location', 'version', 'revision']) {
      if (typeof pkg?.[field] !== 'string' || !pkg[field].trim()) {
        throw new Error('iOS third-party license package is missing ' + field)
      }
    }
    if (identities.has(pkg.identity)) {
      throw new Error('Duplicate iOS third-party license package ' + pkg.identity)
    }
    identities.add(pkg.identity)
    if (!Array.isArray(pkg.notices) || pkg.notices.length === 0) {
      throw new Error(pkg.identity + ' has no preserved notice sources')
    }
    for (const notice of pkg.notices) {
      if (
        typeof notice?.label !== 'string' ||
        !notice.label.trim() ||
        typeof notice?.path !== 'string' ||
        !notice.path.trim() ||
        !/^[a-f0-9]{64}$/.test(notice?.sha256 ?? '')
      ) {
        throw new Error(pkg.identity + ' has an invalid notice mapping')
      }
      if (
        notice.extractFromHeading !== undefined &&
        (typeof notice.extractFromHeading !== 'string' || !notice.extractFromHeading.trim())
      ) {
        throw new Error(pkg.identity + ' has an invalid extractFromHeading mapping')
      }
    }
  }
}

function extractNoticeText(source, notice, packageIdentity) {
  const normalized = source.toString('utf8').replace(/\r\n/g, '\n')
  if (!notice.extractFromHeading) return normalized.trimEnd() + '\n'
  const offset = normalized.indexOf(notice.extractFromHeading)
  if (offset < 0) {
    throw new Error(
      packageIdentity + ' notice source is missing heading ' + notice.extractFromHeading
    )
  }
  return normalized.slice(offset).trimEnd() + '\n'
}

function buildExpectedOutputs(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT
  const manifest = readJson(path.join(repoRoot, MANIFEST_RELATIVE_PATH))
  validateManifest(manifest)

  const resolvedPins = PACKAGE_RESOLVED_RELATIVE_PATHS.map((relativePath) =>
    normalizePins(readJson(path.join(repoRoot, relativePath)), relativePath)
  )
  const canonicalPins = JSON.stringify(resolvedPins[0])
  for (let index = 1; index < resolvedPins.length; index += 1) {
    if (JSON.stringify(resolvedPins[index]) !== canonicalPins) {
      throw new Error(
        PACKAGE_RESOLVED_RELATIVE_PATHS[index] +
          ' does not match ' +
          PACKAGE_RESOLVED_RELATIVE_PATHS[0]
      )
    }
  }

  const expectedPins = manifest.packages
    .map(({ identity, kind, location, version, revision }) => ({
      identity,
      kind,
      location,
      version,
      revision
    }))
    .sort((a, b) => a.identity.localeCompare(b.identity))
  if (JSON.stringify(resolvedPins[0]) !== JSON.stringify(expectedPins)) {
    const resolvedIdentities = resolvedPins[0].map((pin) => pin.identity).join(', ') || '<none>'
    const mappedIdentities = expectedPins.map((pin) => pin.identity).join(', ') || '<none>'
    throw new Error(
      'Swift package graph is not fully mapped to notices (resolved: ' +
        resolvedIdentities +
        '; mapped: ' +
        mappedIdentities +
        ')'
    )
  }

  const sections = []
  let noticeSourceCount = 0
  for (const pkg of [...manifest.packages].sort((a, b) => a.identity.localeCompare(b.identity))) {
    const packageHeader = [
      pkg.displayName ?? pkg.identity,
      'Swift package identity: ' + pkg.identity,
      'Version: ' + pkg.version,
      'Revision: ' + pkg.revision,
      'Source: ' + pkg.location
    ]
    const notices = []
    for (const notice of pkg.notices) {
      const sourcePath = resolveContainedPath(repoRoot, notice.path, LICENSE_SOURCE_ROOT)
      const source = fs.readFileSync(sourcePath)
      const actualHash = sha256(source)
      if (actualHash !== notice.sha256) {
        throw new Error(
          pkg.identity +
            ' notice source hash mismatch for ' +
            notice.path +
            ': expected ' +
            notice.sha256 +
            ', got ' +
            actualHash
        )
      }
      noticeSourceCount += 1
      notices.push(
        [
          'Notice: ' + notice.label,
          'Preserved source: ' + notice.path,
          'Source SHA-256: ' + notice.sha256,
          '-'.repeat(79),
          extractNoticeText(source, notice, pkg.identity).trimEnd()
        ].join('\n')
      )
    }
    sections.push(packageHeader.concat(notices).join('\n\n'))
  }

  const thirdPartyNotice = [
    'TaskWraith iOS Third-Party Notices',
    '',
    'This file is generated deterministically from both checked-in Swift',
    'Package.resolved graphs. Every resolved package identity must have an exact,',
    'revision-pinned notice mapping before CI or the iOS archive workflow can pass.',
    '',
    'Resolved Swift package identities: ' + expectedPins.length,
    'Preserved upstream notice sources: ' + noticeSourceCount,
    '',
    '='.repeat(79),
    sections.join('\n\n' + '='.repeat(79) + '\n\n'),
    ''
  ].join('\n')

  return {
    appLicense: fs.readFileSync(path.join(repoRoot, APP_LICENSE_RELATIVE_PATH)),
    thirdPartyNotice: Buffer.from(thirdPartyNotice, 'utf8'),
    packageCount: expectedPins.length,
    noticeSourceCount
  }
}

function writeIosNotices(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT
  const expected = buildExpectedOutputs({ repoRoot })
  fs.writeFileSync(path.join(repoRoot, APP_LICENSE_OUTPUT_RELATIVE_PATH), expected.appLicense)
  fs.writeFileSync(path.join(repoRoot, THIRD_PARTY_OUTPUT_RELATIVE_PATH), expected.thirdPartyNotice)
  return expected
}

function verifyIosNotices(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT
  const expected = buildExpectedOutputs({ repoRoot })
  const outputs = [
    [APP_LICENSE_OUTPUT_RELATIVE_PATH, expected.appLicense],
    [THIRD_PARTY_OUTPUT_RELATIVE_PATH, expected.thirdPartyNotice]
  ]
  for (const [relativePath, expectedBytes] of outputs) {
    const outputPath = path.join(repoRoot, relativePath)
    if (!fs.existsSync(outputPath)) {
      throw new Error(relativePath + ' is missing; run npm run generate:ios-third-party-notices')
    }
    const actualBytes = fs.readFileSync(outputPath)
    if (!actualBytes.equals(expectedBytes)) {
      throw new Error(relativePath + ' is stale; run npm run generate:ios-third-party-notices')
    }
  }
  return expected
}

function main() {
  const write = process.argv.slice(2).includes('--write')
  const result = write ? writeIosNotices() : verifyIosNotices()
  console.log(
    (write ? 'Generated' : 'Verified') +
      ' iOS notices for ' +
      result.packageCount +
      ' resolved Swift packages and ' +
      result.noticeSourceCount +
      ' preserved upstream sources.'
  )
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error('iOS third-party notice verification failed:')
    console.error('- ' + (error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  }
}

module.exports = {
  APP_LICENSE_OUTPUT_RELATIVE_PATH,
  MANIFEST_RELATIVE_PATH,
  PACKAGE_RESOLVED_RELATIVE_PATHS,
  THIRD_PARTY_OUTPUT_RELATIVE_PATH,
  buildExpectedOutputs,
  normalizePins,
  verifyIosNotices,
  writeIosNotices
}
