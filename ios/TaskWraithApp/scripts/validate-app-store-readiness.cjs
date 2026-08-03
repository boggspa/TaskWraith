#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '../../..')
const DEFAULT_MANIFEST = path.join(REPO_ROOT, 'ios/TaskWraithApp/AppStoreSubmissionReadiness.json')

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function hasEvidenceRefs(value) {
  return (
    Array.isArray(value?.evidenceRefs) &&
    value.evidenceRefs.length > 0 &&
    value.evidenceRefs.every(isNonEmptyString)
  )
}

function duplicateIds(items) {
  const seen = new Set()
  const duplicates = new Set()
  for (const item of items) {
    if (!isNonEmptyString(item?.id)) continue
    if (seen.has(item.id)) duplicates.add(item.id)
    seen.add(item.id)
  }
  return [...duplicates]
}

function validateManifest(manifest, options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT
  const readFile = options.readFile ?? ((filePath) => fs.readFileSync(filePath, 'utf8'))
  const errors = []

  if (manifest?.schemaVersion !== 1) errors.push('schemaVersion must be 1')
  if (manifest?.releaseTarget !== '1.9.3') {
    errors.push('releaseTarget must be 1.9.3')
  }
  if (
    !['not-ready-for-submission', 'ready-for-user-submission'].includes(manifest?.overallStatus)
  ) {
    errors.push('overallStatus is invalid')
  }

  const technicalEvidence = Array.isArray(manifest?.technicalEvidence)
    ? manifest.technicalEvidence
    : []
  const humanGates = Array.isArray(manifest?.humanGates) ? manifest.humanGates : []
  const recordings = Array.isArray(manifest?.requiredRecordings) ? manifest.requiredRecordings : []
  const credentials = Array.isArray(manifest?.credentialInputs) ? manifest.credentialInputs : []
  const steps = Array.isArray(manifest?.submissionSteps) ? manifest.submissionSteps : []

  if (technicalEvidence.length < 8) {
    errors.push('technicalEvidence must contain at least 8 checks')
  }
  if (humanGates.length < 7) {
    errors.push('humanGates must contain at least 7 gates')
  }
  if (recordings.length !== 2) {
    errors.push('requiredRecordings must contain Desktop and Remote evidence')
  }
  if (credentials.length !== 4) {
    errors.push('credentialInputs must name exactly 4 operator inputs')
  }
  if (steps.length < 6) {
    errors.push('submissionSteps must contain the user-controlled sequence')
  }

  for (const group of [technicalEvidence, humanGates, recordings, steps]) {
    for (const id of duplicateIds(group)) errors.push('duplicate id: ' + id)
  }

  for (const evidence of technicalEvidence) {
    if (!isNonEmptyString(evidence?.id)) {
      errors.push('technical evidence entry is missing id')
    }
    if (evidence?.status !== 'verified-in-repo') {
      errors.push((evidence?.id ?? 'technical evidence') + ' must use verified-in-repo status')
    }
    if (!isNonEmptyString(evidence?.claim)) {
      errors.push((evidence?.id ?? 'evidence') + ' is missing claim')
    }
    if (!Array.isArray(evidence?.anchors) || evidence.anchors.length === 0) {
      errors.push((evidence?.id ?? 'evidence') + ' must contain source anchors')
      continue
    }

    for (const anchor of evidence.anchors) {
      if (!isNonEmptyString(anchor?.path)) {
        errors.push(evidence.id + ' has an anchor without a path')
        continue
      }
      const normalized = path.normalize(anchor.path)
      if (
        path.isAbsolute(anchor.path) ||
        normalized === '..' ||
        normalized.startsWith('..' + path.sep)
      ) {
        errors.push(evidence.id + ' anchor escapes the repository: ' + anchor.path)
        continue
      }
      if (!Array.isArray(anchor.requiredText) || anchor.requiredText.length === 0) {
        errors.push(evidence.id + ' anchor has no requiredText: ' + anchor.path)
        continue
      }

      let source
      try {
        source = readFile(path.join(repoRoot, normalized))
      } catch {
        errors.push(evidence.id + ' anchor is unreadable: ' + anchor.path)
        continue
      }
      for (const expected of anchor.requiredText) {
        if (!isNonEmptyString(expected) || !source.includes(expected)) {
          errors.push(
            evidence.id +
              ' anchor drifted: ' +
              anchor.path +
              ' is missing ' +
              JSON.stringify(expected)
          )
        }
      }
    }
  }

  const requiredGateIds = new Set([
    'external-human-cryptography-review',
    'app-privacy-questionnaire',
    'export-compliance-questionnaire',
    'public-metadata-and-urls',
    'desktop-and-remote-recordings',
    'signed-archive-and-ipa',
    'upload-processing-and-submit'
  ])
  for (const gate of humanGates) {
    requiredGateIds.delete(gate?.id)
    if (!['required', 'complete'].includes(gate?.status)) {
      errors.push((gate?.id ?? 'human gate') + ' has invalid status')
    }
    if (gate?.blocking !== true) {
      errors.push((gate?.id ?? 'human gate') + ' must be classified as blocking')
    }
    if (!isNonEmptyString(gate?.evidenceRequired)) {
      errors.push((gate?.id ?? 'human gate') + ' is missing evidenceRequired')
    }
    if (gate?.status === 'complete' && !hasEvidenceRefs(gate)) {
      errors.push((gate?.id ?? 'human gate') + ' needs evidenceRefs before it can be complete')
    }
  }
  for (const id of requiredGateIds) {
    errors.push('missing required human gate: ' + id)
  }

  const recordingIds = new Set(recordings.map((recording) => recording?.id))
  for (const id of ['desktop-pairing-and-control', 'remote-demo-and-paired-action']) {
    if (!recordingIds.has(id)) errors.push('missing required recording: ' + id)
  }
  for (const recording of recordings) {
    if (!['not-recorded', 'recorded'].includes(recording?.status)) {
      errors.push((recording?.id ?? 'recording') + ' has invalid status')
    }
    if (
      !isNonEmptyString(recording?.artifact) ||
      !Array.isArray(recording?.acceptance) ||
      recording.acceptance.length === 0
    ) {
      errors.push((recording?.id ?? 'recording') + ' is missing artifact or acceptance criteria')
    }
    if (recording?.status === 'recorded' && !hasEvidenceRefs(recording)) {
      errors.push((recording?.id ?? 'recording') + ' needs evidenceRefs before it can be recorded')
    }
  }

  const expectedCredentialNames = [
    'TASKWRAITH_APPLE_TEAM_ID',
    'ASC_API_KEY_ID',
    'ASC_API_ISSUER_ID',
    'ASC_API_KEY_PATH'
  ]
  if (credentials.map((item) => item?.envName).join('\n') !== expectedCredentialNames.join('\n')) {
    errors.push(
      'credentialInputs must contain only the expected environment variable names in order'
    )
  }
  for (const credential of credentials) {
    if (Object.hasOwn(credential ?? {}, 'value')) {
      errors.push((credential?.envName ?? 'credential') + ' must not contain a value')
    }
  }

  for (const step of steps) {
    if (step?.userControlled !== true) {
      errors.push((step?.id ?? 'submission step') + ' must be user-controlled')
    }
    if (!['not-run', 'complete'].includes(step?.status)) {
      errors.push((step?.id ?? 'submission step') + ' has invalid status')
    }
    if (step?.status === 'complete' && !hasEvidenceRefs(step)) {
      errors.push((step?.id ?? 'submission step') + ' needs evidenceRefs before it can be complete')
    }
  }

  const allGatesComplete = humanGates.every((gate) => gate.status === 'complete')
  const allRecordingsComplete = recordings.every((recording) => recording.status === 'recorded')
  const allStepsComplete = steps.every((step) => step.status === 'complete')
  const completionEvidencePresent = allGatesComplete && allRecordingsComplete && allStepsComplete

  if (manifest?.overallStatus === 'ready-for-user-submission' && !completionEvidencePresent) {
    errors.push(
      'overallStatus cannot be ready-for-user-submission while evidence gates remain open'
    )
  }
  if (manifest?.overallStatus === 'not-ready-for-submission' && completionEvidencePresent) {
    errors.push('overallStatus is stale: every evidence gate is complete')
  }

  return errors
}

function loadManifest(manifestPath = DEFAULT_MANIFEST) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
}

function main() {
  const manifestPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_MANIFEST
  const manifest = loadManifest(manifestPath)
  const errors = validateManifest(manifest)
  if (errors.length > 0) {
    console.error('iOS App Store readiness validation failed:')
    for (const error of errors) console.error('- ' + error)
    process.exitCode = 1
    return
  }
  console.log(
    'iOS App Store readiness manifest is coherent: ' +
      manifest.technicalEvidence.length +
      ' repository checks; ' +
      manifest.humanGates.filter((gate) => gate.status !== 'complete').length +
      ' human gates open; ' +
      manifest.requiredRecordings.filter((recording) => recording.status !== 'recorded').length +
      ' recordings outstanding.'
  )
}

if (require.main === module) main()

module.exports = {
  DEFAULT_MANIFEST,
  loadManifest,
  validateManifest
}
