'use strict'

const fs = require('node:fs')
const { createHash } = require('node:crypto')
const { calibrateMainProfile } = require('./mainProfileCalibration.cjs')
const { resolveMainProfileSources } = require('./mainProfileSourceMap.cjs')
const { attributeMainIntervalProfile } = require('./mainIntervalProfileAttribution.cjs')
const path = require('node:path')

function retainFrozenSourceBinding(binding, expected, artifactRoot, fsApi = fs) {
  if (
    !binding ||
    !Buffer.isBuffer(binding.buildReceiptBytes) ||
    typeof binding.trustedBuildReceiptSha256 !== 'string' ||
    createHash('sha256').update(binding.buildReceiptBytes).digest('hex') !==
      binding.trustedBuildReceiptSha256
  )
    return { qualified: false, reason: 'trusted_build_receipt_absent_or_mismatched' }
  try {
    const receipt = JSON.parse(binding.buildReceiptBytes.toString('utf8'))
    if (
      receipt.gitSha !== expected.gitSha ||
      binding.build.commitSha !== expected.gitSha ||
      receipt.buildId !== expected.buildId ||
      receipt.outputManifestSha256 !== expected.outputManifestSha256 ||
      !/^[a-f0-9]{64}$/.test(expected.outputManifestSha256 || '') ||
      receipt.captureManifestSha256 !== binding.trustedCaptureManifestSha256 ||
      !Buffer.isBuffer(binding.captureManifest) ||
      createHash('sha256').update(binding.captureManifest).digest('hex') !==
        receipt.captureManifestSha256
    )
      return { qualified: false, reason: 'frozen_build_capture_identity_mismatch' }
    if (
      !Array.isArray(receipt.outputs) ||
      !Array.isArray(binding.artifacts) ||
      binding.artifacts.some(
        (artifact) =>
          !receipt.outputs.some((output) => output.sha256 === artifact.bundleSha256) ||
          !receipt.outputs.some((output) => output.sha256 === artifact.mapSha256)
      )
    )
      return { qualified: false, reason: 'frozen_output_bytes_not_in_receipt' }
    fsApi.writeFileSync(
      path.join(artifactRoot, 'x2-frozen-build-receipt.json'),
      binding.buildReceiptBytes
    )
    for (const artifact of binding.artifacts) {
      if (!Buffer.isBuffer(artifact.bundleBytes) || !Buffer.isBuffer(artifact.mapBytes))
        return { qualified: false, reason: 'frozen_artifact_bytes_absent' }
      fsApi.writeFileSync(
        path.join(artifactRoot, `x2-bundle-${artifact.bundleSha256}.js`),
        artifact.bundleBytes
      )
      fsApi.writeFileSync(
        path.join(artifactRoot, `x2-map-${artifact.mapSha256}.json`),
        artifact.mapBytes
      )
    }
    for (const source of binding.sources || [])
      fsApi.writeFileSync(path.join(artifactRoot, `x2-source-${source.sha256}.txt`), source.bytes)
    fsApi.writeFileSync(
      path.join(artifactRoot, 'x2-frozen-capture-manifest.json'),
      binding.captureManifest
    )
    fsApi.writeFileSync(
      path.join(artifactRoot, 'x2-trusted-digests.json'),
      JSON.stringify(
        {
          buildReceiptSha256: binding.trustedBuildReceiptSha256,
          captureManifestSha256: binding.trustedCaptureManifestSha256,
          expected
        },
        null,
        2
      ) + '\n'
    )
    return { qualified: true, binding }
  } catch {
    return { qualified: false, reason: 'frozen_receipt_invalid' }
  }
}
const {
  attributeMainGapProfile,
  normalizeMainLoopGapSnapshot
} = require('./mainGapProfileAttribution.cjs')

/** Reads actual capture bytes; runtime must provide measured monotonic anchors/exemptions. */
function collectM5X2Artifacts({
  windows,
  profilePath,
  artifactPath,
  fsApi = fs,
  calibrationMarkers = [],
  calibrationFailures = [],
  calibrationArtifactPath,
  sourceBinding
}) {
  const fail = (reason) => ({ qualified: false, reason })
  let bytes, profile
  try {
    bytes = fsApi.readFileSync(profilePath)
    profile = JSON.parse(bytes.toString('utf8'))
  } catch {
    return fail('cpu_profile_unreadable')
  }
  const profileSha256 = createHash('sha256').update(bytes).digest('hex')
  const rawProfile = profile
  const calibration = calibrateMainProfile(profile, calibrationMarkers)
  if (calibrationArtifactPath)
    fsApi.writeFileSync(
      calibrationArtifactPath,
      JSON.stringify({ profileSha256, calibration, failures: calibrationFailures }, null, 2) + '\n'
    )
  let sourceProvenance = null
  let sourceFailure = null
  if (sourceBinding) {
    try {
      const mappingProfile = {
        ...profile,
        nodes: profile.nodes.map((node) => {
          const marker = calibrationMarkers.find(
            (entry) =>
              entry.tag === node.callFrame?.functionName &&
              node.callFrame?.url === `taskwraith-calibration-${entry.tag}.js`
          )
          return marker &&
            createHash('sha256').update(marker.source).digest('hex') === marker.sourceSha256
            ? { ...node, callFrame: { ...node.callFrame, url: '' } }
            : node
        })
      }
      const resolved = resolveMainProfileSources({ ...sourceBinding, profile: mappingProfile })
      profile = resolved.profile
      sourceProvenance = resolved.sourceProvenance
      fsApi.writeFileSync(artifactPath + '.mapped-profile.json', JSON.stringify(profile) + '\n')
      fsApi.writeFileSync(
        artifactPath + '.source-provenance.json',
        JSON.stringify(sourceProvenance, null, 2) + '\n'
      )
    } catch {
      sourceFailure = 'frozen_source_mapping_refused'
    }
  } else sourceFailure = 'frozen_source_mapping_absent'
  const rows = (Array.isArray(windows) ? windows : []).map((row) => {
    const receipt = row.mainWindow
    if (!receipt?.clock)
      return { repetition: row.repetition, ...fail('legacy_clock_diagnostic_only') }
    if (receipt?.clock) {
      const windowMarkers = calibrationMarkers.filter((marker) => marker.windowId === receipt.id)
      const windowCalibration = calibrateMainProfile(rawProfile, windowMarkers)
      const marker = windowMarkers[0]
      if (
        receipt.clock.clockId !== 'node.performance.now' ||
        receipt.clock.provenance !== 'node-performance-now' ||
        receipt.clock.identity !== marker?.identity
      )
        return { repetition: row.repetition, ...fail('measured_clock_identity_mismatch') }
      if (!windowCalibration.qualified || calibrationFailures.length)
        return { repetition: row.repetition, ...fail('profile_calibration_unqualified') }
      if (sourceFailure) return { repetition: row.repetition, ...fail(sourceFailure) }
      if (receipt.exemptions?.complete !== true || !Array.isArray(receipt.exemptions.entries))
        return { repetition: row.repetition, ...fail('timestamped_exemption_evidence_absent') }
      try {
        const attribution = attributeMainIntervalProfile({
          window: {
            id: receipt.id,
            clockId: receipt.clock.clockId,
            startMs: receipt.startedAtMs,
            endMs: receipt.endedAtMs,
            durationMs: receipt.endedAtMs - receipt.startedAtMs
          },
          clock: { ...receipt.clock, pid: marker.pid, timeOrigin: marker.timeOrigin },
          calibration: windowCalibration,
          profile,
          sourceProvenance,
          gapSnapshot: receipt.loopGaps,
          exemptions: receipt.exemptions
        })
        return {
          repetition: row.repetition,
          qualified: attribution.attributionEligible === true && attribution.censored === false,
          exact: false,
          profileSha256,
          gapArtifactSha256: createHash('sha256')
            .update(JSON.stringify(receipt.loopGaps))
            .digest('hex'),
          attribution,
          calibration: windowCalibration,
          markerExclusions: windowCalibration.markerExclusions,
          reason: attribution.censored ? 'interval_attribution_censored' : null
        }
      } catch {
        return { repetition: row.repetition, ...fail('interval_attribution_refused') }
      }
    }
    if (!receipt || receipt.clockKind !== 'monotonic' || !receipt.clockId || !receipt.profileAnchor)
      return { repetition: row.repetition, ...fail('measured_monotonic_anchor_absent') }
    if (
      !receipt.exemptions ||
      receipt.exemptions.complete !== true ||
      !Array.isArray(receipt.exemptions.entries)
    )
      return { repetition: row.repetition, ...fail('timestamped_exemption_evidence_absent') }
    try {
      const window = {
        id: receipt.id,
        clockId: receipt.clockId,
        startMs: receipt.startedAtMs,
        endMs: receipt.endedAtMs,
        durationMs: receipt.endedAtMs - receipt.startedAtMs
      }
      const gaps = normalizeMainLoopGapSnapshot(receipt.loopGaps, {
        windowId: window.id,
        clockId: window.clockId,
        clockKind: receipt.clockKind
      })
      const attribution = attributeMainGapProfile({
        window,
        profile,
        anchor: receipt.profileAnchor,
        gaps,
        exemptions: receipt.exemptions.entries
      })
      if (
        attribution.attributionEligible !== true ||
        attribution.censored !== false ||
        receipt.frameProvenance?.complete !== true ||
        receipt.ownerClassification?.complete !== true
      )
        return {
          repetition: row.repetition,
          ...fail('owner_classification_or_source_provenance_incomplete'),
          attribution
        }
      return {
        repetition: row.repetition,
        qualified: true,
        profileSha256,
        gapArtifactSha256: createHash('sha256').update(JSON.stringify(gaps)).digest('hex'),
        anchor: receipt.profileAnchor,
        gaps,
        attribution,
        exemptions: receipt.exemptions.entries
      }
    } catch {
      return { repetition: row.repetition, ...fail('gap_profile_binding_refused') }
    }
  })
  const result = {
    schemaVersion: 1,
    qualified: rows.length > 0 && rows.every((row) => row.qualified),
    profilePath,
    profileSha256,
    calibration,
    sourceProvenance,
    sourceFailure,
    windows: rows
  }
  for (const row of rows) row.x6 = x6EvidenceFromAttribution(row)
  fsApi.writeFileSync(artifactPath, JSON.stringify(result, null, 2) + '\n')
  return result
}

/** Serialize the reviewed collector's actual interval evidence for X6. No missing interval is filled. */
function x6EvidenceFromAttribution(row) {
  if (
    row?.qualified !== true ||
    row.attribution?.attributionEligible !== true ||
    row.attribution?.censored !== false
  )
    return null
  const a = row.attribution
  if (a.exact === false && a.intervals) {
    return {
      windowId: a.window.id,
      startedAtMs: a.window.startMs,
      endedAtMs: a.window.endMs,
      clockId: a.window.clockId,
      complete: a.coverage.complete,
      attributionEligible: a.attributionEligible,
      censored: a.censored,
      exact: false,
      listedOwnerMsBounds: a.listedOwnerMsBounds,
      blockedMsBounds: a.blockedMsBounds,
      ownerAbsenceProven: a.ownerAbsenceProven,
      unresolvedAttribution: a.unresolvedAttribution,
      intervals: a.intervals,
      coverage: a.coverage,
      owners: require('./mainGapProfileAttribution.cjs')
        .RULES.filter((rule) => rule[1] === 'owner')
        .map((rule) => rule[0]),
      calibration: a.calibration,
      sourceProvenance: a.sourceProvenance,
      recordedGapEntries: a.recordedGapEntries,
      samplingLimitations: a.samplingLimitations,
      profileSha256: row.profileSha256,
      gapArtifactSha256: row.gapArtifactSha256
    }
  }
  const gapCoverage = a.gaps.map((gap, gapIndex) => {
    const entries = a.evidence.filter((entry) => entry.gapIndex === gapIndex)
    const cuts = [
      ...new Set([
        gap.expectedFireMs,
        gap.observedFireMs,
        ...entries.flatMap((entry) => [entry.startMs, entry.endMs])
      ])
    ].sort((left, right) => left - right)
    const frames = []
    for (let index = 1; index < cuts.length; index++) {
      const start = cuts[index - 1],
        end = cuts[index]
      const covering = entries.filter((entry) => entry.startMs <= start && entry.endMs >= end)
      const owner =
        covering.find((entry) => entry.kind === 'owner' && !entry.exemptionReasons.length) ||
        covering.find((entry) => entry.kind === 'owner')
      if (!owner)
        return {
          startedAtMs: gap.expectedFireMs,
          endedAtMs: gap.observedFireMs,
          complete: false,
          frames
        }
      frames.push({
        startedAtMs: start,
        endedAtMs: end,
        owner: owner.owner,
        classification: owner.exemptionReasons.length ? 'exempt' : 'listed',
        exemptionReasons: owner.exemptionReasons,
        frameSources: owner.frameSources
      })
    }
    return {
      startedAtMs: gap.expectedFireMs,
      endedAtMs: gap.observedFireMs,
      complete: true,
      frames
    }
  })
  return {
    windowId: a.window.id,
    startedAtMs: a.window.startMs,
    endedAtMs: a.window.endMs,
    clockId: a.window.clockId,
    complete: a.coverage.complete,
    attributionEligible: a.attributionEligible,
    censored: a.censored,
    gapAttributed: true,
    overflow: 0,
    owners: require('./mainGapProfileAttribution.cjs')
      .RULES.filter((rule) => rule[1] === 'owner')
      .map((rule) => rule[0]),
    listedOwnerMs: a.nonExemptOwnerMs,
    listedOwnerMsBounds: { lower: a.nonExemptOwnerMs, upper: a.nonExemptOwnerMs },
    nonExemptOwnerGaps: a.nonExemptOwnerGaps,
    ownerAbsenceProven: a.ownerAbsenceProven,
    gapCoverage,
    profileSha256: row.profileSha256,
    gapArtifactSha256: row.gapArtifactSha256
  }
}

module.exports = { collectM5X2Artifacts, x6EvidenceFromAttribution, retainFrozenSourceBinding }
