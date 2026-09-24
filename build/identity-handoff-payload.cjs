const fs = require('node:fs')
const path = require('node:path')
const { validateManifest } = require('../scripts/identity-handoff-manifest.cjs')

const HANDOFF_SOURCE_VERSION = '1.9.9'
const PAYLOAD_FILE_NAME = 'identity-handoff.json'

/**
 * Install the prepared handoff payload only in the final beta package.
 *
 * The public 0.1.0 artifact must not contain a manifest that pins the hash of
 * that same artifact (a self-referential digest has no stable value). Keeping
 * the payload outside app.asar also lets beta and Release be built from the
 * same source commit: afterPack copies it into 1.9.9 and removes it everywhere
 * else.
 */
function installIdentityHandoffPayload({
  resourcesDir,
  distributionIdentity,
  version,
  payloadPath,
  expectedBaseUrl,
  expectedSourceCommit
}) {
  const destination = path.join(resourcesDir, PAYLOAD_FILE_NAME)
  fs.rmSync(destination, { force: true })

  if (distributionIdentity !== 'beta' || version !== HANDOFF_SOURCE_VERSION) {
    return { installed: false, destination }
  }

  const source = payloadPath ? path.resolve(payloadPath) : undefined
  if (!source) {
    throw new Error(
      'The final beta requires TASKWRAITH_IDENTITY_HANDOFF_PAYLOAD pointing at the prepared external payload.'
    )
  }
  if (!expectedSourceCommit || !/^[a-f0-9]{40,64}$/.test(expectedSourceCommit)) {
    throw new Error(
      'The final beta requires TASKWRAITH_IDENTITY_HANDOFF_SOURCE_COMMIT from the verified build wrapper.'
    )
  }
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error(`The final beta is missing its identity handoff payload: ${source}`)
  }
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(source, 'utf8'))
  } catch (error) {
    throw new Error(
      `The final beta identity handoff payload is unreadable: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const errors = validateManifest(manifest, { requirePrepared: true, expectedBaseUrl })
  if (manifest.sourceCommit !== expectedSourceCommit) {
    errors.push(
      `payload sourceCommit ${String(manifest.sourceCommit)} does not match verified build commit ${expectedSourceCommit}`
    )
  }
  if (errors.length > 0) {
    throw new Error(`The final beta identity handoff payload is not frozen:\n${errors.join('\n')}`)
  }

  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)
  fs.chmodSync(destination, 0o644)
  return { installed: true, source, destination }
}

function distributionMetadataFromPackager(context) {
  const metadata = context?.packager?.config?.extraMetadata || {}
  const distributionIdentity = String(metadata.taskwraithDistributionIdentity || '').trim()
  const version = String(context?.packager?.appInfo?.version || metadata.version || '').trim()
  if (!distributionIdentity || !version) {
    throw new Error('Packager did not expose distribution identity/version metadata.')
  }
  return { distributionIdentity, version }
}

module.exports = {
  HANDOFF_SOURCE_VERSION,
  PAYLOAD_FILE_NAME,
  distributionMetadataFromPackager,
  installIdentityHandoffPayload
}
