#!/usr/bin/env node

/**
 * release-distribution.cjs — canonical release distribution identity resolution.
 *
 * One frozen source root can serve more than one release identity. The final
 * beta (1.9.9) and the public debut (0.1.0) are cut from the same commit:
 * package.json / package-lock.json / the top dated CHANGELOG.md section stay
 * on the root version, while the debut's application version, app id and
 * update feed come from the debut builder config's extraMetadata (resolved
 * through its declared `extends`). This helper is the single place that maps
 * a distribution name onto that metadata, so validators, note preparers,
 * feed scripts and the build wrapper read one descriptor instead of
 * restating version numbers.
 *
 * The root epoch is declared explicitly in package.json
 * (`taskwraithRelease.distribution`, `beta` today, `release` after the
 * 0.1.x handoff) — never inferred from version numbers, so the public line
 * reaching 1.0 later cannot regress the legacy channel defaults.
 *
 * Distributions:
 *   - beta    The legacy line. Release version is package.json's version and
 *             electron-builder.yml carries the beta identity (feed `latest`).
 *             Default; every historical caller behaves exactly as before.
 *   - debut   The one-way 1.9.9 -> 0.1.0 identity handoff. Release version is
 *             electron-builder.debut.yml's extraMetadata.version (0.1.0);
 *             the root lockfile invariant still pins package-lock.json to
 *             package.json, not to the debut version. The frozen handoff
 *             contract (resources/identity-handoff.json) must pin
 *             source.version to the root package.json version and
 *             target.version to the resolved debut version, so a debut cut
 *             from the wrong source or with an altered target is refused.
 *             Debut targets must be stable — a prerelease cannot ship on the
 *             release feed.
 *   - release Post-handoff normal releases. Version is package.json's version
 *             and electron-builder.release.yml carries the release identity
 *             (feed `release`). Once 0.1.x lives at the root, debut.yml is
 *             retired.
 *
 * The effective builder config merges `extends` chains with the same
 * semantics as electron-builder's own config loader (deepAssign from
 * builder-util-runtime: deep merge, child wins, `undefined` never overrides,
 * arrays concatenated and deduplicated), verified against the real
 * implementation in release-distribution.test.ts. publish may be a one-element
 * array — Sol's release/debut configs use that shape so a child config cannot
 * inherit fields from a parent's publish object; exactly one provider entry is
 * enforced here and the effective array is preserved on the returned config.
 *
 * Nothing here writes; every function is a synchronous read of the repo root.
 */

const fs = require('node:fs')
const path = require('node:path')
const yaml = require('js-yaml')

const DEFAULT_REPO_ROOT = path.join(__dirname, '..')
const ROOT_BUILDER_CONFIG = 'electron-builder.yml'
const RELEASE_BUILDER_CONFIG = 'electron-builder.release.yml'
const DEBUT_BUILDER_CONFIG = 'electron-builder.debut.yml'
const DISTRIBUTIONS = ['beta', 'release', 'debut']
const ROOT_DISTRIBUTIONS = ['beta', 'release']
const MAX_EXTENDS_DEPTH = 4
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const HANDOFF_CONTRACT_FILE = path.join('resources', 'identity-handoff.json')

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function isMergeableObject(value) {
  // Mirrors builder-util-runtime isObject: arrays are not mergeable objects.
  if (Array.isArray(value)) return false
  return typeof value === 'object' && value !== null
}

function mergeBuilderValue(target, value) {
  // Mirrors deepAssign assignKey: undefined never overrides; two mergeable
  // objects merge deeply; two arrays concatenate with deduplication;
  // anything else is replaced by the child value.
  if (value === undefined) return target
  if (!isMergeableObject(target) || !isMergeableObject(value)) {
    if (Array.isArray(target) && Array.isArray(value)) {
      return Array.from(new Set(target.concat(value)))
    }
    return value
  }
  const result = { ...target }
  for (const key of Object.getOwnPropertyNames(value)) {
    result[key] = mergeBuilderValue(result[key], value[key])
  }
  return result
}

/**
 * Load a builder config and resolve its declared `extends` chain (bounded,
 * cycle-checked). Configs in this repo live at the root, so `extends` is
 * resolved relative to repoRoot. Returns the identity projection plus the
 * effective merged `config` document for consumers that need other fields
 * (publish provider/url, generateUpdatesFilesForAllChannels, ...).
 */
function loadBuilderIdentity(repoRoot, configFile, visited = new Set()) {
  if (visited.has(configFile)) {
    throw new Error(`builder identity extends cycle: ${[...visited, configFile].join(' -> ')}`)
  }
  if (visited.size >= MAX_EXTENDS_DEPTH) {
    throw new Error(
      `builder identity extends chain exceeds ${MAX_EXTENDS_DEPTH} configs at ${configFile}`
    )
  }
  visited.add(configFile)

  const absolute = path.join(repoRoot, configFile)
  let document
  try {
    document = yaml.load(fs.readFileSync(absolute, 'utf8'))
  } catch (error) {
    throw new Error(
      `could not read builder identity ${configFile}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`builder identity ${configFile} is not a mapping`)
  }

  let config = document
  if (typeof document.extends === 'string' && document.extends.trim()) {
    const baseFile = document.extends.trim().replace(/^\.\//, '')
    const base = loadBuilderIdentity(repoRoot, baseFile, visited)
    config = mergeBuilderValue(base.config, document)
  }

  const extra = config.extraMetadata || {}
  const publishList = Array.isArray(config.publish)
    ? config.publish
    : isMergeableObject(config.publish)
      ? [config.publish]
      : []
  if (publishList.length > 1) {
    throw new Error(
      `${configFile} effective publish declares ${publishList.length} providers; exactly one is supported for a release identity`
    )
  }
  const publish = publishList[0] || {}
  return {
    configFile,
    config,
    appId: typeof config.appId === 'string' ? config.appId : null,
    distributionIdentity:
      typeof extra.taskwraithDistributionIdentity === 'string'
        ? extra.taskwraithDistributionIdentity
        : null,
    updateFeedChannel:
      typeof extra.taskwraithUpdateFeedChannel === 'string'
        ? extra.taskwraithUpdateFeedChannel
        : null,
    version: typeof extra.version === 'string' ? extra.version : null,
    publishChannel: typeof publish.channel === 'string' ? publish.channel : null
  }
}

/**
 * The debut is the one-way 1.9.9 -> 0.1.0 identity handoff, frozen in the
 * tracked contract template. Refuse to resolve a debut whose source is not
 * the contract's pinned source version or whose debut config drifts from the
 * contract's pinned target version. Regular template/CI verification at any
 * other root version is unaffected: only the debut path reads the contract.
 */
function assertFrozenDebutContract(repoRoot, configFile, sourceVersion, targetVersion) {
  let contract = null
  try {
    contract = readJson(path.join(repoRoot, HANDOFF_CONTRACT_FILE))
  } catch {
    contract = null
  }
  const errors = []
  if (!contract || typeof contract !== 'object' || contract.schemaVersion !== 1) {
    errors.push(
      `debut distribution requires the tracked identity-handoff contract at ${HANDOFF_CONTRACT_FILE}`
    )
  } else {
    if (contract.prepared !== false) {
      errors.push(`${HANDOFF_CONTRACT_FILE} must be the unprepared contract template`)
    }
    if (contract.source?.version !== sourceVersion) {
      errors.push(
        `debut source drift: package.json is ${sourceVersion} but the frozen handoff contract pins source ${String(contract.source?.version)}`
      )
    }
    if (contract.target?.version !== targetVersion) {
      errors.push(
        `debut target drift: ${configFile} declares ${targetVersion} but the frozen handoff contract pins target ${String(contract.target?.version)}`
      )
    }
  }
  if (errors.length > 0) throw new Error(errors.join('; '))
}

function resolveReleaseDistribution({ repoRoot = DEFAULT_REPO_ROOT, distribution } = {}) {
  const packageJson = readJson(path.join(repoRoot, 'package.json'))
  const sourceVersion = packageJson.version
  if (typeof sourceVersion !== 'string' || !VERSION_PATTERN.test(sourceVersion)) {
    throw new Error(`package.json has an invalid release version: ${String(sourceVersion)}`)
  }

  const declared = packageJson.taskwraithRelease?.distribution
  if (declared !== undefined && !ROOT_DISTRIBUTIONS.includes(declared)) {
    throw new Error(
      `package.json taskwraithRelease.distribution must be ${ROOT_DISTRIBUTIONS.join(' or ')}; got ${String(declared)}`
    )
  }
  const requested = distribution ?? declared ?? 'beta'
  const name = String(requested).trim().toLowerCase()
  if (!DISTRIBUTIONS.includes(name)) {
    throw new Error(
      `unsupported release distribution ${String(requested)}; expected one of ${DISTRIBUTIONS.join(', ')}`
    )
  }

  let configFile
  let identity
  let version
  if (name === 'debut') {
    configFile = DEBUT_BUILDER_CONFIG
    if (!fs.existsSync(path.join(repoRoot, configFile))) {
      throw new Error(
        `--distribution debut requires ${DEBUT_BUILDER_CONFIG}; use --distribution release for post-handoff releases`
      )
    }
    identity = loadBuilderIdentity(repoRoot, configFile)
    if (!identity.version) {
      throw new Error(`${DEBUT_BUILDER_CONFIG} extraMetadata.version is missing`)
    }
    version = identity.version
    // A prerelease debut fails on its own contract before the frozen
    // source/target pins are even consulted.
    if (VERSION_PATTERN.test(version) && version.split('-', 2)[1]) {
      throw new Error(
        `debut distribution requires a stable target version; ${version} is a prerelease`
      )
    }
    assertFrozenDebutContract(repoRoot, configFile, sourceVersion, version)
  } else {
    configFile = name === 'release' ? RELEASE_BUILDER_CONFIG : ROOT_BUILDER_CONFIG
    if (name === 'release' && !fs.existsSync(path.join(repoRoot, configFile))) {
      throw new Error(
        `--distribution release requires ${RELEASE_BUILDER_CONFIG} (the post-handoff release identity)`
      )
    }
    identity = loadBuilderIdentity(repoRoot, configFile)
    version = sourceVersion
    // Root distributions take their version from package.json; a builder
    // config that pins a different one is drift, not a second source of truth.
    if (identity.version && identity.version !== sourceVersion) {
      throw new Error(
        `${configFile} pins extraMetadata.version ${identity.version}, which does not match package.json ${sourceVersion}`
      )
    }
  }
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`${configFile} declares an invalid release version: ${String(version)}`)
  }

  const prerelease = Boolean(version.split('-', 2)[1])
  if (name === 'debut' && prerelease) {
    throw new Error(
      `debut distribution requires a stable target version; ${version} is a prerelease`
    )
  }

  return {
    distribution: name,
    version,
    sourceVersion,
    appId: identity.appId,
    distributionIdentity: identity.distributionIdentity,
    updateFeedChannel: identity.updateFeedChannel,
    publishChannel: identity.publishChannel,
    config: identity.config,
    prerelease,
    feedChannel: prerelease
      ? 'beta'
      : identity.updateFeedChannel || (name === 'beta' ? 'latest' : 'release'),
    builderConfig: configFile
  }
}

/**
 * Pure updater feed channel for a release version; performs no file reads.
 * An explicit override always wins; prereleases stay on `beta` (the only
 * authorized prerelease channel); stable releases take the identity's
 * declared channel when supplied, else the distribution's epoch default
 * (`latest` for beta, `release` for release/debut). Callers that know the
 * root's declared distribution should pass it explicitly; the generic
 * default stays `beta` so legacy call sites behave exactly as before.
 */
function resolveUpdateFeedChannel(
  version,
  { distribution = 'beta', channelOverride, updateFeedChannel } = {}
) {
  const name = String(distribution ?? 'beta')
    .trim()
    .toLowerCase()
  if (!DISTRIBUTIONS.includes(name)) {
    throw new Error(
      `unsupported release distribution ${String(distribution)}; expected one of ${DISTRIBUTIONS.join(', ')}`
    )
  }
  if (channelOverride) return channelOverride
  if (String(version).includes('-')) return 'beta'
  if (updateFeedChannel) return updateFeedChannel
  return name === 'beta' ? 'latest' : 'release'
}

/**
 * Find an exact "## X.Y.Z [- YYYY-MM-DD]" release heading anywhere in the
 * changelog. Unlike firstChangelogRelease in verify-release-tag.cjs this is
 * not limited to the top section: the debut section (0.1.0) intentionally
 * sits below the frozen root release (1.9.9).
 */
function findChangelogRelease(changelogText, version) {
  const escaped = String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = String(changelogText).match(
    new RegExp(`^##\\s+\\[?${escaped}\\]?(?:\\s+-\\s+(\\d{4}-\\d{2}-\\d{2}))?\\s*$`, 'm')
  )
  return match ? { version: String(version), date: match[1] } : null
}

module.exports = {
  DEBUT_BUILDER_CONFIG,
  DEFAULT_REPO_ROOT,
  DISTRIBUTIONS,
  HANDOFF_CONTRACT_FILE,
  MAX_EXTENDS_DEPTH,
  RELEASE_BUILDER_CONFIG,
  ROOT_BUILDER_CONFIG,
  findChangelogRelease,
  loadBuilderIdentity,
  resolveReleaseDistribution,
  resolveUpdateFeedChannel
}
