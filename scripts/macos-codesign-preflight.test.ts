import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  validCodeSigningIdentities,
  validateCodeSigningIdentityOutput
}: {
  validCodeSigningIdentities: (output: string) => Array<{
    fingerprint: string
    name: string
  }>
  validateCodeSigningIdentityOutput: (output: string, selectedIdentity?: string) => string | null
} = require('./macos-codesign-preflight.cjs')

describe('macOS code-signing identity preflight', () => {
  it('accepts a concrete valid code-signing identity', () => {
    const output = `
  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Developer ID Application: Example (TEAMID)"
     1 valid identities found
`
    expect(validCodeSigningIdentities(output)).toEqual([
      {
        fingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        name: 'Developer ID Application: Example (TEAMID)'
      }
    ])
    expect(
      validateCodeSigningIdentityOutput(output, 'Developer ID Application: Example (TEAMID)')
    ).toBeNull()
    expect(
      validateCodeSigningIdentityOutput(output, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    ).toBeNull()
    expect(validateCodeSigningIdentityOutput(output, 'Missing Identity')).toContain('CSC_NAME')
  })

  it('rejects the successful no-identity output from security', () => {
    expect(validateCodeSigningIdentityOutput('     0 valid identities found\n')).toContain(
      'no valid code-signing identity'
    )
  })
})
