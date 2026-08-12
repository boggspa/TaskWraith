/**
 * Muse admission / inventory probe helpers (pi-shaped).
 *
 * Future ProviderConfiguration wiring:
 *   configured = binary resolvable AND credential present
 *   includeWhenUnknown: false
 *
 * This module stays Electron-light via DI. It is not an admission/containment
 * proof for a live turn — same doctrine as CursorCliProbe / GrokCliProbe.
 */

import type { MuseBinaryResolution, MuseCredentialEvidence } from './MuseTypes'

export interface MuseProbeBinary {
  binaryPath: string | null
  source?: string
  error?: string
}

export interface MuseProbeCaptureResult {
  stdout: string
  stderr: string
  code: number | null
  error?: string
  timedOut?: boolean
}

export interface MuseProbeDeps {
  resolveBinary: () => Promise<MuseProbeBinary>
  /** Optional: read auth.json text (seat-local or user path). Never log it. */
  readAuthJsonText?: () => Promise<string | null>
  /** Optional: parent/process env lookup for META_API_KEY presence only. */
  readMetaApiKeyEnv?: () => string | null | undefined
  /** Optional: TaskWraith-owned key store / injected credential. */
  hasInjectedCredential?: () => boolean | Promise<boolean>
  capture?: (command: string, args: string[]) => Promise<MuseProbeCaptureResult>
}

export interface MuseProbeFindings {
  probedAt: string
  binaryPath: string | null
  binarySource: string | null
  binaryResolvable: boolean
  version: string | null
  versionRaw: string
  credential: MuseCredentialEvidence
  credentialPresent: boolean
  /** Pi-shaped picker gate: both signals required. */
  configured: boolean
  topLevelFlags: string[]
  subcommands: string[]
  errors: string[]
}

/** Env Muse launcher/seat cares about for credential presence. */
export const MUSE_META_API_KEY_ENV = 'META_API_KEY'

/**
 * Extract Muse Code version, e.g.
 * "Muse Code 0.1.0 (0.1.0-R708.1)" → "0.1.0-R708.1" or "0.1.0".
 */
export function parseMuseVersion(raw: string): string | null {
  if (!raw) return null
  const paren = raw.match(/\(([0-9A-Za-z.+-]+)\)/)
  if (paren) return paren[1]
  const semver = raw.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)
  return semver ? semver[1] : null
}

/**
 * Pure auth.json credential presence check.
 *
 * Muse owns two supported shapes under `providers.meta`:
 * - API key: `{ api_key }` (written by `muse auth set --api-key-stdin`)
 * - Meta account: `{ mechanism: "oauth", access_token, ... }` (written by
 *   `muse login`)
 *
 * Returns only mechanism/length evidence — never the secret.
 */
export function parseMuseAuthJsonCredential(
  raw: string | null | undefined
): MuseCredentialEvidence {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { present: false, source: 'none', credentialKind: null, apiKeyLength: null }
  }
  try {
    const parsed = JSON.parse(raw) as {
      providers?: {
        meta?: { api_key?: unknown; mechanism?: unknown; access_token?: unknown }
      }
    }
    const meta = parsed?.providers?.meta
    const key = meta?.api_key
    if (typeof key === 'string' && key.trim().length > 0) {
      return {
        present: true,
        source: 'auth-json-meta',
        credentialKind: 'api-key',
        apiKeyLength: key.trim().length
      }
    }
    if (
      meta?.mechanism === 'oauth' &&
      typeof meta.access_token === 'string' &&
      meta.access_token.trim().length > 0
    ) {
      return {
        present: true,
        source: 'auth-json-meta',
        credentialKind: 'oauth',
        apiKeyLength: null
      }
    }
  } catch {
    return { present: false, source: 'none', credentialKind: null, apiKeyLength: null }
  }
  return { present: false, source: 'none', credentialKind: null, apiKeyLength: null }
}

export function museCredentialFromEnv(value: string | null | undefined): MuseCredentialEvidence {
  if (typeof value === 'string' && value.trim().length > 0) {
    return {
      present: true,
      source: 'meta-api-key-env',
      credentialKind: 'api-key',
      apiKeyLength: value.trim().length
    }
  }
  return { present: false, source: 'none', credentialKind: null, apiKeyLength: null }
}

function extractFlags(text: string): string[] {
  const flags = new Set<string>()
  for (const line of (text || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('-')) continue
    for (const m of trimmed.matchAll(/--[a-z][a-z0-9-]*/g)) flags.add(m[0])
  }
  return [...flags].sort()
}

function extractSubcommands(text: string): string[] {
  const lines = (text || '').split(/\r?\n/)
  const start = lines.findIndex((line) => /^Commands:\s*$/.test(line.trim()))
  if (start === -1) return []
  const out: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) break
    const match = line.match(/^\s{2,}([a-z][a-z0-9-]*)\s{2,}\S/)
    if (match) out.push(match[1])
  }
  return out
}

export function parseMuseHelp(raw: string): { flags: string[]; subcommands: string[] } {
  return { flags: extractFlags(raw), subcommands: extractSubcommands(raw) }
}

/** Binary resolvable helper for the future pi-shaped picker probe. */
export async function isMuseBinaryResolvable(deps: MuseProbeDeps): Promise<boolean> {
  const resolved = await deps.resolveBinary()
  return Boolean(resolved.binaryPath)
}

/**
 * Credential present helper: injected key, auth.json meta api_key, or META_API_KEY.
 * Prefer seat-local auth for runs; this probe only answers "can the seat admit?".
 */
export async function isMuseCredentialPresent(deps: MuseProbeDeps): Promise<boolean> {
  const evidence = await resolveMuseCredentialEvidence(deps)
  return evidence.present
}

export async function resolveMuseCredentialEvidence(
  deps: MuseProbeDeps
): Promise<MuseCredentialEvidence> {
  if (deps.hasInjectedCredential) {
    const injected = await deps.hasInjectedCredential()
    if (injected) {
      return { present: true, source: 'injected', credentialKind: 'api-key', apiKeyLength: null }
    }
  }

  if (deps.readAuthJsonText) {
    const text = await deps.readAuthJsonText()
    const fromFile = parseMuseAuthJsonCredential(text)
    if (fromFile.present) return fromFile
  }

  if (deps.readMetaApiKeyEnv) {
    const fromEnv = museCredentialFromEnv(deps.readMetaApiKeyEnv())
    if (fromEnv.present) return fromEnv
  }

  return { present: false, source: 'none', credentialKind: null, apiKeyLength: null }
}

/**
 * Pi-shaped admission: binary resolvable AND credential present.
 * Unresolved / missing either signal → not configured (fail closed).
 */
export async function isMuseConfiguredForAdmission(deps: MuseProbeDeps): Promise<boolean> {
  const [binary, credential] = await Promise.all([
    isMuseBinaryResolvable(deps),
    isMuseCredentialPresent(deps)
  ])
  return binary && credential
}

export async function resolveMuseBinary(deps: MuseProbeDeps): Promise<MuseBinaryResolution> {
  const resolved = await deps.resolveBinary()
  return {
    binaryPath: resolved.binaryPath,
    source: resolved.source,
    error: resolved.error
  }
}

/**
 * Inventory probe (version/help). Optional — not required for the admission
 * boolean helpers above. Never runs a prompt / never mutates homes.
 */
export async function probeMuseCli(deps: MuseProbeDeps): Promise<MuseProbeFindings> {
  const errors: string[] = []
  const credential = await resolveMuseCredentialEvidence(deps)
  const findings: MuseProbeFindings = {
    probedAt: new Date().toISOString(),
    binaryPath: null,
    binarySource: null,
    binaryResolvable: false,
    version: null,
    versionRaw: '',
    credential,
    credentialPresent: credential.present,
    configured: false,
    topLevelFlags: [],
    subcommands: [],
    errors
  }

  const resolved = await deps.resolveBinary()
  findings.binaryPath = resolved.binaryPath
  findings.binarySource = resolved.source ?? null
  findings.binaryResolvable = Boolean(resolved.binaryPath)
  if (!resolved.binaryPath) {
    errors.push(resolved.error || 'Muse binary was not found.')
    findings.configured = false
    return findings
  }

  findings.configured = findings.binaryResolvable && findings.credentialPresent

  if (!deps.capture) {
    return findings
  }

  const bin = resolved.binaryPath
  const versionRes = await deps.capture(bin, ['--version'])
  findings.versionRaw = (versionRes.stdout || versionRes.stderr || '').trim()
  findings.version = parseMuseVersion(findings.versionRaw)
  if (versionRes.error) errors.push(`version probe failed: ${versionRes.error}`)

  const helpRes = await deps.capture(bin, ['--help'])
  const help = parseMuseHelp(helpRes.stdout || helpRes.stderr || '')
  findings.topLevelFlags = help.flags
  findings.subcommands = help.subcommands
  if (helpRes.error) errors.push(`help probe failed: ${helpRes.error}`)

  return findings
}
