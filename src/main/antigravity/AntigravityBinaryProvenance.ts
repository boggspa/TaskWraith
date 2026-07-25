// Publisher check for the resolved `agy` executable.
//
// `resolveAgyCliBinary` finds a file NAMED agy on PATH or in common install
// roots. That is not the same claim as "this is Google's agy". A binary planted
// earlier on PATH would receive the user's prompts and run inside the workspace
// under `--mode accept-edits`, so the distinction is a supply-chain concern in
// its own right, independent of any terms question.
//
// This inspects the file's signature; it never EXECUTES it. That matters because
// `getAntigravityProviderStatus` documents that it never starts agy, opens a
// browser, or touches a keyring — running `agy --version` for a version string
// would break that invariant, so no version is collected here.
//
// Reports rather than blocks. Only macOS can be checked, so a hard gate would
// make the provider unusable on Linux and Windows, and a legitimate wrapper
// script or self-built binary would be locked out with a confusing error. The
// state is surfaced to the user instead; treat `mismatch` as the signal worth
// acting on.

import { spawn } from 'child_process'

/** Google LLC's Apple Developer Team ID, from the signed release of agy 1.1.7. */
export const GOOGLE_DEVELOPER_TEAM_ID = 'EQHXZ8M8AV'

export type AgyProvenanceState =
  /** Signed by Google LLC's Developer ID. */
  | 'verified'
  /** Not checkable here (non-macOS, or codesign unavailable). Not a failure. */
  | 'unverified'
  /** Checked and NOT Google's: unsigned, ad-hoc, or another team. */
  | 'mismatch'

export interface AgyBinaryProvenance {
  readonly state: AgyProvenanceState
  readonly teamId: string | null
  /** Leaf signing authority, e.g. "Developer ID Application: Google LLC (…)". */
  readonly authority: string | null
  /** Short human-readable reason, present for unverified/mismatch. */
  readonly detail?: string
}

export interface AgyBinaryProvenanceDependencies {
  readonly platform?: NodeJS.Platform
  readonly inspect?: (binaryPath: string) => Promise<{ output: string; code: number | null }>
  readonly timeoutMs?: number
}

const CODESIGN_TIMEOUT_MS = 4_000

/** `codesign -dv` writes its report to stderr, so both streams are collected. */
function inspectSignature(
  binaryPath: string,
  timeoutMs: number
): Promise<{ output: string; code: number | null }> {
  return new Promise((resolve) => {
    let output = ''
    let settled = false
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ output, code })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('codesign', ['-dv', '--verbose=2', binaryPath], { shell: false })
    } catch {
      resolve({ output: '', code: null })
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(null)
    }, timeoutMs)
    timer.unref?.()
    const append = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
      if (output.length > 16_000) output = output.slice(-16_000)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code))
  })
}

export function parseAgyCodesignOutput(output: string, code: number | null): AgyBinaryProvenance {
  // A non-zero exit means unsigned or unreadable. codesign says "code object is
  // not signed at all" — a definite negative on a platform that can check, so
  // it is a mismatch rather than merely unverified.
  if (code !== 0) {
    return {
      state: 'mismatch',
      teamId: null,
      authority: null,
      detail: /not signed/i.test(output)
        ? 'The resolved agy executable is not code-signed.'
        : 'The resolved agy executable could not be verified by codesign.'
    }
  }
  const rawTeamId = output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || null
  // codesign prints the literal "not set" for binaries with no team (Apple's own
  // system binaries do this), which must not be echoed into the warning as if it
  // were an identifier — "signed by team not set" reads as a bug.
  const teamId = rawTeamId && !/^not set$/i.test(rawTeamId) ? rawTeamId : null
  const authority = output.match(/^Authority=(.+)$/m)?.[1]?.trim() || null
  if (teamId === GOOGLE_DEVELOPER_TEAM_ID) {
    return { state: 'verified', teamId, authority }
  }
  return {
    state: 'mismatch',
    teamId,
    authority,
    detail: teamId
      ? `The resolved agy executable is signed by team ${teamId}, not Google (${GOOGLE_DEVELOPER_TEAM_ID}).`
      : 'The resolved agy executable has no Apple Team Identifier.'
  }
}

export async function verifyAgyBinaryProvenance(
  binaryPath: string | null | undefined,
  deps: AgyBinaryProvenanceDependencies = {}
): Promise<AgyBinaryProvenance> {
  const path = typeof binaryPath === 'string' ? binaryPath.trim() : ''
  if (!path) {
    return {
      state: 'unverified',
      teamId: null,
      authority: null,
      detail: 'No agy executable resolved.'
    }
  }
  const platform = deps.platform ?? process.platform
  if (platform !== 'darwin') {
    return {
      state: 'unverified',
      teamId: null,
      authority: null,
      detail: 'Publisher verification is only available on macOS.'
    }
  }
  try {
    const { output, code } = await (
      deps.inspect ??
      ((target: string) => inspectSignature(target, deps.timeoutMs ?? CODESIGN_TIMEOUT_MS))
    )(path)
    // A timeout or a missing codesign tool yields no output at all; that is a
    // failure to check, not evidence against the binary.
    if (!output.trim()) {
      return {
        state: 'unverified',
        teamId: null,
        authority: null,
        detail: 'codesign produced no output for the resolved agy executable.'
      }
    }
    return parseAgyCodesignOutput(output, code)
  } catch {
    return {
      state: 'unverified',
      teamId: null,
      authority: null,
      detail: 'Publisher verification could not be completed.'
    }
  }
}
