'use strict'

const fs = require('node:fs')
const { createHash } = require('node:crypto')
const {
  attributeMainGapProfile,
  normalizeMainLoopGapSnapshot
} = require('./mainGapProfileAttribution.cjs')

/** Reads actual capture bytes; runtime must provide measured monotonic anchors/exemptions. */
function collectM5X2Artifacts({ windows, profilePath, artifactPath, fsApi = fs }) {
  const fail = (reason) => ({ qualified: false, reason })
  let bytes, profile
  try {
    bytes = fsApi.readFileSync(profilePath)
    profile = JSON.parse(bytes.toString('utf8'))
  } catch {
    return fail('cpu_profile_unreadable')
  }
  const profileSha256 = createHash('sha256').update(bytes).digest('hex')
  const rows = (Array.isArray(windows) ? windows : []).map((row) => {
    const receipt = row.mainWindow
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
    nonExemptOwnerGaps: a.nonExemptOwnerGaps,
    ownerAbsenceProven: a.ownerAbsenceProven,
    gapCoverage,
    profileSha256: row.profileSha256,
    gapArtifactSha256: row.gapArtifactSha256
  }
}

module.exports = { collectM5X2Artifacts, x6EvidenceFromAttribution }
