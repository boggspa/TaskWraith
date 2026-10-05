import { isAbsolute } from 'node:path'
import { readGrokCliSignInState, type GrokCliSignInState } from './GrokCliSignInState'

export const GROK_USAGE_BINARY_OVERRIDE_ENV = 'TASKWRAITH_GROK_USAGE_BINARY_OVERRIDE'

interface GrokUsageBinaryLike {
  binaryPath: string | null
}

export interface GrokUsageProbeBinaryResolution {
  binaryPath: string | null
  source: 'override' | 'invalid_override' | 'discovered' | 'missing' | 'signed_out'
}

/**
 * The binary the `/usage` probe may launch, or null when it must launch none.
 *
 * A CLI that reports it is signed out resolves to null: its interactive TUI
 * would start a browser sign-in on launch (see GrokCliSignInState), so the
 * probe answers with its no-data snapshot instead. Only that explicit answer
 * withholds the binary; when the CLI cannot say, the probe runs as before.
 */
export async function resolveGrokUsageProbeBinary(options: {
  env: Readonly<Record<string, string | undefined>>
  resolveDefault: () => Promise<GrokUsageBinaryLike>
  /** Injected in tests; production asks the CLI itself. */
  readSignInState?: (binaryPath: string) => Promise<GrokCliSignInState>
}): Promise<GrokUsageProbeBinaryResolution> {
  const resolved = await resolveCandidate(options)
  if (!resolved.binaryPath) return resolved

  const readSignInState =
    options.readSignInState ??
    ((binaryPath: string) => readGrokCliSignInState({ binaryPath, env: options.env }))
  if ((await readSignInState(resolved.binaryPath)) === 'signed_out') {
    return { binaryPath: null, source: 'signed_out' }
  }
  return resolved
}

async function resolveCandidate(options: {
  env: Readonly<Record<string, string | undefined>>
  resolveDefault: () => Promise<GrokUsageBinaryLike>
}): Promise<GrokUsageProbeBinaryResolution> {
  const configured = options.env[GROK_USAGE_BINARY_OVERRIDE_ENV]
  if (configured !== undefined) {
    const binaryPath = configured.trim()
    if (!binaryPath || !isAbsolute(binaryPath)) {
      return { binaryPath: null, source: 'invalid_override' }
    }
    return { binaryPath, source: 'override' }
  }

  const resolved = await options.resolveDefault()
  return {
    binaryPath: resolved.binaryPath,
    source: resolved.binaryPath ? 'discovered' : 'missing'
  }
}
