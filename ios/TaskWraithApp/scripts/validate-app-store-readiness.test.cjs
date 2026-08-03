const assert = require('node:assert/strict')
const test = require('node:test')

const {
  DEFAULT_MANIFEST,
  loadManifest,
  validateManifest
} = require('./validate-app-store-readiness.cjs')

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

test('the checked-in readiness manifest matches its repository anchors', () => {
  const manifest = loadManifest(DEFAULT_MANIFEST)
  assert.deepEqual(validateManifest(manifest), [])
})

test('source-anchor drift fails explicitly', () => {
  const manifest = clone(loadManifest(DEFAULT_MANIFEST))
  manifest.technicalEvidence[0].anchors[0].requiredText = ['missing-release-anchor']
  assert.match(validateManifest(manifest).join('\n'), /anchor drifted/)
})

test('credentials are names only and never values', () => {
  const manifest = clone(loadManifest(DEFAULT_MANIFEST))
  manifest.credentialInputs[0].value = 'not-allowed'
  assert.match(validateManifest(manifest).join('\n'), /must not contain a value/)
})

test('external gates need evidence before completion', () => {
  const manifest = clone(loadManifest(DEFAULT_MANIFEST))
  manifest.humanGates[0].status = 'complete'
  assert.match(
    validateManifest(manifest).join('\n'),
    /needs evidenceRefs before it can be complete/
  )
})

test('ready status fails while external evidence remains open', () => {
  const manifest = clone(loadManifest(DEFAULT_MANIFEST))
  manifest.overallStatus = 'ready-for-user-submission'
  assert.match(validateManifest(manifest).join('\n'), /evidence gates remain open/)
})

test('the contract permits evidence-backed progression to user submission', () => {
  const manifest = clone(loadManifest(DEFAULT_MANIFEST))
  for (const gate of manifest.humanGates) {
    gate.status = 'complete'
    gate.evidenceRefs = ['external-evidence://' + gate.id]
  }
  for (const recording of manifest.requiredRecordings) {
    recording.status = 'recorded'
    recording.evidenceRefs = ['external-evidence://' + recording.id]
  }
  for (const step of manifest.submissionSteps) {
    step.status = 'complete'
    step.evidenceRefs = ['external-evidence://' + step.id]
  }
  manifest.overallStatus = 'ready-for-user-submission'
  assert.deepEqual(validateManifest(manifest), [])
})
