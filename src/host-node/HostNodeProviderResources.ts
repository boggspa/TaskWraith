/**
 * Node-safe provider resource composition for the pure-Node Host.
 *
 * Adapted from src/main/host/HostProductionSetupAdapter.ts (normalizeProviderStatus
 * at 269-307, offersFor at 360-395, flowFor at 423-427) and
 * src/main/providers/CliProviderRuntime.ts (resolveCliProviderBinary at 486-573,
 * getCliProviderStatus at 669-739). Desktop reuse is a named follow-up.
 *
 * This module resolves runtime state (binary presence, auth state, version)
 * for each live provider and normalizes it into the Host setup projections.
 * It MUST NOT import from src/main/** or src/renderer/**.
 */

import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import { accessSync, constants, lstatSync, realpathSync } from 'node:fs'

import { hostProviderAuthFlows, hostProviderCatalogEntry } from '../host-shared/HostProviderCatalog'
import type {
  HostProviderAuthFlowProjection,
  HostProviderAuthStatusProjection,
  HostProviderStatusProjection
} from '../shared/hostSetupProtocol'

export interface HostNodeResolvedBinary {
  readonly binaryPath: string | null
  readonly source: 'runtime_profile' | 'settings' | 'path' | 'common' | 'missing'
  readonly error?: string
}

export interface HostNodeProviderRuntimeStatus {
  readonly providerId: string
  readonly available: boolean
  readonly binaryAvailable: boolean
  readonly authState: 'authenticated' | 'unauthenticated' | 'unknown'
  readonly version?: string
  readonly detail?: string
}

export interface HostNodeProviderResourcePort {
  resolveBinary(): Promise<HostNodeResolvedBinary>
  getAuthState(): Promise<'authenticated' | 'unauthenticated' | 'unknown'>
  getVersion(): Promise<string | null>
}

const BINARY_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  codex: ['codex'],
  claude: ['claude'],
  kimi: ['kimi'],
  cursor: ['cursor-agent'],
  grok: ['grok'],
  ollama: ['ollama'],
  pi: ['pi'],
  mistral: ['vibe', 'vibe-acp'],
  muse: ['muse']
}

function fileExists(candidate: string): boolean {
  try {
    const stat = lstatSync(candidate)
    if (!stat.isFile() && !stat.isSymbolicLink()) return false
    const resolved = realpathSync(candidate)
    accessSync(resolved, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function cliBinaryNameCandidates(providerId: string): readonly string[] {
  return BINARY_CANDIDATES[providerId] ?? [providerId]
}

function getCliSearchDirs(): readonly string[] {
  const path = process.env.PATH ?? ''
  return path.split(delimiter).filter(Boolean)
}

function commonBinaryDirs(providerId: string): readonly string[] {
  const home = homedir()
  const dirs = [
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ]
  if (providerId === 'grok') dirs.unshift(join(home, '.grok', 'bin'))
  if (providerId === 'kimi') dirs.unshift(join(home, '.kimi-code', 'bin'))
  return dirs
}

/** Resolve a provider binary without any AppStore fallback. */
export function resolveHostNodeProviderBinary(providerId: string): HostNodeResolvedBinary {
  const candidates = cliBinaryNameCandidates(providerId)
  const seen = new Set<string>()
  for (const dir of [...getCliSearchDirs(), ...commonBinaryDirs(providerId)]) {
    for (const name of candidates) {
      const candidate = join(dir, name)
      if (!candidate || seen.has(candidate)) continue
      seen.add(candidate)
      if (fileExists(candidate)) {
        return {
          binaryPath: candidate,
          source: getCliSearchDirs().includes(dir) ? 'path' : 'common'
        }
      }
    }
  }
  return {
    binaryPath: null,
    source: 'missing',
    error: `${providerId} CLI was not found on PATH or common local install locations.`
  }
}

/** Normalize a runtime status into the Host status projection shape. */
export function normalizeHostNodeProviderStatus(
  providerId: string,
  status: HostNodeProviderRuntimeStatus
): HostProviderStatusProjection {
  const entry = hostProviderCatalogEntry(providerId)
  const label = entry?.displayProvider ?? providerId
  if (!status.binaryAvailable) {
    return { providerId, status: 'unavailable', label, detail: 'Provider binary is unavailable.' }
  }
  if (status.authState === 'unauthenticated') {
    return { providerId, status: 'auth_required', label, detail: 'Provider sign-in is required.' }
  }
  if (status.available && status.authState === 'authenticated') {
    return { providerId, status: 'ready', label }
  }
  return { providerId, status: 'degraded', label, detail: 'Provider status is degraded.' }
}

/** Auth status projection for one provider. */
export function hostNodeProviderAuthStatus(
  providerId: string,
  status: HostNodeProviderRuntimeStatus
): HostProviderAuthStatusProjection {
  return {
    providerId,
    state:
      status.authState === 'authenticated'
        ? 'authenticated'
        : status.authState === 'unauthenticated'
          ? 'unauthenticated'
          : 'unknown'
  }
}

/** Auth flows for one provider, gated by runtime availability. */
export function hostNodeProviderAuthFlows(
  providerId: string,
  status: HostNodeProviderRuntimeStatus
): readonly HostProviderAuthFlowProjection[] {
  if (!status.binaryAvailable || status.authState !== 'unauthenticated') return []
  return hostProviderAuthFlows(providerId)
}

/** Per-provider resource port backed by local CLI discovery. */
export function createHostNodeProviderResourcePort(
  providerId: string
): HostNodeProviderResourcePort {
  return {
    async resolveBinary() {
      return resolveHostNodeProviderBinary(providerId)
    },
    async getAuthState() {
      // Node Host does not have a safe auth probe for most providers; the
      // default is unknown. Provider adapters override with exact auth checks.
      return 'unknown'
    },
    async getVersion() {
      return null
    }
  }
}
