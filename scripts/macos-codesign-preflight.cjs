function validCodeSigningIdentities(output) {
  const identities = []
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = /^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"([^"]+)"\s*$/.exec(line)
    if (!match) continue
    identities.push({ fingerprint: match[1].toUpperCase(), name: match[2] })
  }
  return identities
}

function validateCodeSigningIdentityOutput(output, selectedIdentity) {
  const identities = validCodeSigningIdentities(output)
  if (identities.length === 0) {
    return 'security find-identity reported no valid code-signing identity'
  }
  const selected = String(selectedIdentity || '').trim()
  const developerIdName = `Developer ID Application: ${selected}`
  if (
    selected &&
    !identities.some(
      (identity) =>
        identity.fingerprint.toLowerCase() === selected.toLowerCase() ||
        identity.name === selected ||
        identity.name === developerIdName
    )
  ) {
    return `CSC_NAME does not select any valid code-signing identity`
  }
  return null
}

module.exports = {
  validCodeSigningIdentities,
  validateCodeSigningIdentityOutput
}
