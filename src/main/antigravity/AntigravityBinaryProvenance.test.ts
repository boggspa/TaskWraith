import { describe, expect, it, vi } from 'vitest'
import {
  GOOGLE_DEVELOPER_TEAM_ID,
  parseAgyCodesignOutput,
  verifyAgyBinaryProvenance
} from './AntigravityBinaryProvenance'

// Verbatim shape of `codesign -dv --verbose=2` against the signed agy 1.1.7.
const GOOGLE_SIGNED_OUTPUT = [
  'Executable=/Users/test/.local/bin/agy',
  'Identifier=cli',
  'Format=Mach-O universal (x86_64 arm64)',
  'Signature size=8990',
  'Authority=Developer ID Application: Google LLC (EQHXZ8M8AV)',
  'Authority=Developer ID Certification Authority',
  'Authority=Apple Root CA',
  'TeamIdentifier=EQHXZ8M8AV'
].join('\n')

describe('parseAgyCodesignOutput', () => {
  it('verifies Google’s Developer ID', () => {
    expect(parseAgyCodesignOutput(GOOGLE_SIGNED_OUTPUT, 0)).toEqual({
      state: 'verified',
      teamId: GOOGLE_DEVELOPER_TEAM_ID,
      authority: 'Developer ID Application: Google LLC (EQHXZ8M8AV)'
    })
  })

  // The PATH-hijack case: a real signature belonging to someone else. This is
  // the one state worth acting on, so it must never read as merely unverified.
  it('reports a different team as a mismatch and names it', () => {
    const result = parseAgyCodesignOutput(
      GOOGLE_SIGNED_OUTPUT.replace(/EQHXZ8M8AV/g, 'ABCDE12345'),
      0
    )
    expect(result.state).toBe('mismatch')
    expect(result.teamId).toBe('ABCDE12345')
    expect(result.detail).toContain('ABCDE12345')
    expect(result.detail).toContain(GOOGLE_DEVELOPER_TEAM_ID)
  })

  it('reports an unsigned binary as a mismatch, not unverified', () => {
    const result = parseAgyCodesignOutput('code object is not signed at all', 1)
    expect(result.state).toBe('mismatch')
    expect(result.detail).toMatch(/not code-signed/i)
  })

  it('reports a signature with no team identifier as a mismatch', () => {
    const result = parseAgyCodesignOutput('Identifier=cli\nAuthority=(unsigned)', 0)
    expect(result.state).toBe('mismatch')
    expect(result.teamId).toBeNull()
  })

  // codesign prints the literal "not set" for binaries with no team (Apple's own
  // system binaries do). Echoing it produced "signed by team not set, not
  // Google" — caught by running this against /bin/ls, not by reading the code.
  it('does not echo codesign’s literal "not set" as a team identifier', () => {
    const result = parseAgyCodesignOutput(
      'Identifier=ls\nAuthority=Software Signing\nTeamIdentifier=not set',
      0
    )
    expect(result.state).toBe('mismatch')
    expect(result.teamId).toBeNull()
    expect(result.detail).not.toMatch(/not set/)
    expect(result.detail).toMatch(/no Apple Team Identifier/i)
  })
})

describe('verifyAgyBinaryProvenance', () => {
  it('verifies a Google-signed binary on macOS', async () => {
    const inspect = vi.fn(async () => ({ output: GOOGLE_SIGNED_OUTPUT, code: 0 }))
    await expect(
      verifyAgyBinaryProvenance('/Users/test/.local/bin/agy', { platform: 'darwin', inspect })
    ).resolves.toMatchObject({ state: 'verified', teamId: GOOGLE_DEVELOPER_TEAM_ID })
    expect(inspect).toHaveBeenCalledWith('/Users/test/.local/bin/agy')
  })

  // Not-checkable must never be reported as evidence against the binary, or
  // every Linux and Windows install would show a false publisher warning.
  it('is unverified off macOS without inspecting anything', async () => {
    const inspect = vi.fn()
    for (const platform of ['linux', 'win32'] as const) {
      const result = await verifyAgyBinaryProvenance('/usr/local/bin/agy', { platform, inspect })
      expect(result.state).toBe('unverified')
      expect(result.detail).toMatch(/only available on macOS/i)
    }
    expect(inspect).not.toHaveBeenCalled()
  })

  it('is unverified when codesign yields nothing (missing tool or timeout)', async () => {
    await expect(
      verifyAgyBinaryProvenance('/Users/test/.local/bin/agy', {
        platform: 'darwin',
        inspect: async () => ({ output: '   ', code: null })
      })
    ).resolves.toMatchObject({ state: 'unverified' })
  })

  it('is unverified when inspection throws', async () => {
    await expect(
      verifyAgyBinaryProvenance('/Users/test/.local/bin/agy', {
        platform: 'darwin',
        inspect: async () => Promise.reject(new Error('spawn EPERM'))
      })
    ).resolves.toMatchObject({ state: 'unverified' })
  })

  it.each([null, undefined, '   '])('is unverified with no resolved binary (%j)', async (path) => {
    const inspect = vi.fn()
    await expect(
      verifyAgyBinaryProvenance(path, { platform: 'darwin', inspect })
    ).resolves.toMatchObject({ state: 'unverified' })
    expect(inspect).not.toHaveBeenCalled()
  })
})
