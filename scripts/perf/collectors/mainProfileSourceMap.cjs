'use strict'
const { createHash } = require('node:crypto')
const { TraceMap, originalPositionFor, GREATEST_LOWER_BOUND } = require('@jridgewell/trace-mapping')

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const refuse = (message) => {
  throw new Error('Profile source provenance refused: ' + message)
}

/** All byte inputs are captured artifacts, never reopened mutable paths.
 * Manifest must originate from the frozen build receipt. Each emitted artifact
 * supplies its exact profile URL; URL suffix guessing is forbidden.
 * Original functionName is retained: a map name is recorded separately and is
 * not substituted for a runtime function without further owner validation.
 */
function canonical(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !/[\\:]/.test(value) &&
    value.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
  )
}
function positionWithin(text, line, column) {
  const lines = text.split(/\r?\n/)
  return (
    Number.isSafeInteger(line) &&
    Number.isSafeInteger(column) &&
    line >= 0 &&
    column >= 0 &&
    line < lines.length &&
    column < lines[line].length
  )
}
function resolveMainProfileSources({
  profile,
  build,
  artifacts,
  sources,
  captureManifest,
  trustedCaptureManifestSha256,
  limits = {}
}) {
  const maxNodes = limits.maxNodes ?? 100000
  const maxBytes = limits.maxBytes ?? 64 * 1024 * 1024
  if (
    !Number.isSafeInteger(maxNodes) ||
    maxNodes < 1 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1
  )
    refuse('bounds')
  if (
    !build ||
    !/^[a-f0-9]{40}$/.test(build.commitSha) ||
    !/^[a-f0-9]{64}$/.test(build.sourceManifestSha256)
  )
    refuse('build identity')
  if (
    !Array.isArray(sources) ||
    !Array.isArray(artifacts) ||
    !Array.isArray(profile?.nodes) ||
    profile.nodes.length > maxNodes
  )
    refuse('input shape')
  // trusted digest comes from the independently retained frozen-build receipt,
  // not a value calculated from this adapter's supplied artifact tuples.
  if (
    !Buffer.isBuffer(captureManifest) ||
    captureManifest.length > maxBytes ||
    !/^[a-f0-9]{64}$/.test(trustedCaptureManifestSha256) ||
    digest(captureManifest) !== trustedCaptureManifestSha256
  )
    refuse('capture manifest custody/digest')
  let captured
  try {
    captured = JSON.parse(captureManifest.toString('utf8'))
  } catch {
    refuse('capture manifest format')
  }
  if (
    captured.schemaVersion !== 1 ||
    captured.commitSha !== build.commitSha ||
    captured.sourceManifestSha256 !== build.sourceManifestSha256 ||
    !Array.isArray(captured.artifacts) ||
    captured.artifacts.length !== artifacts.length
  )
    refuse('capture manifest build')
  let bytes = 0
  const sourceByPath = new Map()
  const manifest = []
  for (const source of sources) {
    if (!source || !canonical(source.path) || sourceByPath.has(source.path)) refuse('source path')
    if (
      source.tracked !== true ||
      !Buffer.isBuffer(source.bytes) ||
      digest(source.bytes) !== source.sha256
    )
      refuse('frozen source identity')
    bytes += source.bytes.length
    sourceByPath.set(source.path, source)
    manifest.push([source.path, source.sha256])
  }
  manifest.sort((a, b) => a[0].localeCompare(b[0]))
  if (digest(Buffer.from(JSON.stringify(manifest))) !== build.sourceManifestSha256)
    refuse('source manifest mismatch')
  const maps = new Map()
  for (const artifact of artifacts) {
    const tuple = captured.artifacts.find((row) => row.profileUrl === artifact.profileUrl)
    if (
      !tuple ||
      !canonical(artifact.emittedFile) ||
      tuple.emittedFile !== artifact.emittedFile ||
      tuple.bundleSha256 !== artifact.bundleSha256 ||
      tuple.mapSha256 !== artifact.mapSha256 ||
      JSON.stringify(tuple.sourcePaths) !== JSON.stringify(artifact.sourcePaths)
    )
      refuse('capture artifact tuple')
    if (
      typeof artifact.profileUrl !== 'string' ||
      !artifact.profileUrl ||
      maps.has(artifact.profileUrl) ||
      artifact.buildCommitSha !== build.commitSha
    )
      refuse('artifact identity')
    if (
      !Buffer.isBuffer(artifact.bundleBytes) ||
      !Buffer.isBuffer(artifact.mapBytes) ||
      digest(artifact.bundleBytes) !== artifact.bundleSha256 ||
      digest(artifact.mapBytes) !== artifact.mapSha256
    )
      refuse('artifact digest')
    bytes += artifact.bundleBytes.length + artifact.mapBytes.length
    if (bytes > maxBytes) refuse('byte overflow')
    let raw
    try {
      raw = JSON.parse(artifact.mapBytes.toString('utf8'))
    } catch {
      refuse('invalid map')
    }
    if (
      raw.version !== 3 ||
      (raw.file !== undefined && raw.file !== artifact.emittedFile) ||
      raw.sourceRoot ||
      !Array.isArray(raw.sources) ||
      !Array.isArray(raw.sourcesContent) ||
      raw.sources.length !== raw.sourcesContent.length ||
      raw.sources.length > maxNodes
    )
      refuse('map identity/content')
    const links = new Map()
    for (let i = 0; i < raw.sources.length; i++) {
      const mapSource = raw.sources[i]
      const path = artifact.sourcePaths?.[mapSource]
      if (!canonical(path)) refuse('source path')
      const source = sourceByPath.get(path)
      if (
        !source ||
        typeof raw.sourcesContent[i] !== 'string' ||
        !Buffer.from(raw.sourcesContent[i]).equals(source.bytes) ||
        links.has(mapSource)
      )
        refuse('sourcesContent mismatch or missing frozen source')
      links.set(mapSource, source)
    }
    let map
    try {
      map = new TraceMap(raw)
    } catch {
      refuse('invalid mappings')
    }
    maps.set(artifact.profileUrl, { artifact, links, map })
  }
  if (bytes > maxBytes) refuse('byte overflow')
  const evidence = []
  const nodes = profile.nodes.map((node) => {
    const frame = node.callFrame
    if (!frame || typeof frame.url !== 'string') refuse('frame')
    const entry = maps.get(frame.url)
    if (!entry) {
      if (frame.url && !frame.url.startsWith('node:') && !frame.url.startsWith('native '))
        refuse('unregistered frame artifact')
      return { ...node, callFrame: { ...frame } }
    }
    if (
      !Number.isSafeInteger(frame.lineNumber) ||
      frame.lineNumber < 0 ||
      !Number.isSafeInteger(frame.columnNumber) ||
      frame.columnNumber < 0
    )
      refuse('generated position')
    if (
      !positionWithin(
        entry.artifact.bundleBytes.toString('utf8'),
        frame.lineNumber,
        frame.columnNumber
      )
    )
      refuse('generated position bounds')
    const position = originalPositionFor(entry.map, {
      line: frame.lineNumber + 1,
      column: frame.columnNumber,
      bias: GREATEST_LOWER_BOUND
    })
    const source = entry.links.get(position.source)
    if (!source || position.line === null || position.column === null) refuse('unmapped frame')
    if (!positionWithin(source.bytes.toString('utf8'), position.line - 1, position.column))
      refuse('original position bounds')
    const resolved = {
      ...frame,
      url: 'frozen-source:///' + source.path,
      lineNumber: position.line - 1,
      columnNumber: position.column
    }
    evidence.push({
      nodeId: node.id,
      originalFrame: { ...frame },
      resolvedFrame: { ...resolved },
      mappedName: position.name,
      buildCommitSha: build.commitSha,
      captureManifestSha256: trustedCaptureManifestSha256,
      sourceManifestSha256: build.sourceManifestSha256,
      sourcePath: source.path,
      sourceSha256: source.sha256,
      bundleSha256: entry.artifact.bundleSha256,
      mapSha256: entry.artifact.mapSha256,
      profileUrl: entry.artifact.profileUrl
    })
    return { ...node, callFrame: resolved }
  })
  return {
    profile: { ...profile, nodes },
    sourceProvenance: {
      schemaVersion: 1,
      buildCommitSha: build.commitSha,
      sourceManifestSha256: build.sourceManifestSha256,
      evidence,
      complete: true
    }
  }
}
module.exports = { resolveMainProfileSources }
