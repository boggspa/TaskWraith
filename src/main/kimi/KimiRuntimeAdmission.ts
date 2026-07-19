import { execFile } from 'child_process'
import { createHash } from 'crypto'
import type { BigIntStats } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { KIMI_ACP_PRODUCTION_POSTURE_VERSION } from '../../shared/kimiAcpPosture'
import embeddedKimiRuntimeQualifications from './KimiRuntimeQualifications.generated.json'

export const KIMI_RUNTIME_QUALIFICATION_SCOPE = 'acp-synthetic-cwd-gateway-v1' as const
export const KIMI_RUNTIME_ATTESTATION_SOURCE = 'credentialed-live-containment-canary' as const
export const KIMI_UNATTESTED_DEVELOPMENT_SOURCE = 'unattested-development' as const

declare const admittedKimiBinaryPathBrand: unique symbol

/** A realpath is branded only after exact qualification and a post-probe
 * identity check. Launch callers must additionally call `assertReadyForSpawn`
 * immediately before process creation. */
export type AdmittedKimiBinaryPath = string & {
  readonly [admittedKimiBinaryPathBrand]: true
}

export interface KimiRuntimeQualification {
  binarySha256: string
  platform: NodeJS.Platform
  arch: string
  scope: typeof KIMI_RUNTIME_QUALIFICATION_SCOPE
  version: string
  capabilityFingerprint: string
  postureVersion: typeof KIMI_ACP_PRODUCTION_POSTURE_VERSION
  attestationSource: typeof KIMI_RUNTIME_ATTESTATION_SOURCE
}

/**
 * Build-generated runtime projection of the reviewed release manifest.
 *
 * It is intentionally empty until a concrete Kimi binary tuple has completed
 * the credentialed containment lane. Packaged builds do not read an environment
 * manifest or accept an environment-provided tuple at runtime.
 */
export const EMBEDDED_KIMI_RUNTIME_QUALIFICATIONS: readonly KimiRuntimeQualification[] =
  Object.freeze(
    embeddedKimiRuntimeQualifications.map((qualification) => Object.freeze(qualification))
  ) as readonly KimiRuntimeQualification[]

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/
const BINARY_STAT_FIELDS = [
  'dev',
  'ino',
  'mode',
  'nlink',
  'uid',
  'gid',
  'rdev',
  'size',
  'blksize',
  'blocks',
  'mtimeNs',
  'ctimeNs'
] as const
const PROBE_TIMEOUT_MS = 15_000
const PROBE_MAX_BUFFER_BYTES = 1024 * 1024

export type KimiBinaryStatIdentity = Record<(typeof BINARY_STAT_FIELDS)[number], string>

export interface KimiBinaryIdentity {
  realPath: string
  sha256: string
  stat: KimiBinaryStatIdentity
}

export interface KimiProbeCapture {
  args: readonly string[]
  stdout: string
  stderr: string
  code: number | null
  signal: NodeJS.Signals | null
  error: string | null
}

export interface KimiInventorySurfaces {
  version: KimiProbeCapture
  help: KimiProbeCapture
  acpHelp: KimiProbeCapture
}

export interface KimiCapabilityProjection {
  schemaVersion: 1
  provider: 'kimi'
  version: string
  topLevel: { flags: string[]; commands: string[] }
  transport: {
    probed: true
    command: 'acp'
    flags: string[]
    commands: string[]
  }
}

export type KimiRuntimeAdmissionBlockReason =
  | 'missing_binary_path'
  | 'invalid_qualification_roster'
  | 'binary_identity_failed'
  | 'unknown_binary'
  | 'probe_failed'
  | 'capability_mismatch'
  | 'binary_identity_changed'

export interface BlockedKimiRuntimeAdmission {
  admitted: false
  reason: KimiRuntimeAdmissionBlockReason
  message: string
  identity?: KimiBinaryIdentity
}

export interface AdmittedKimiRuntime {
  admitted: true
  binaryPath: AdmittedKimiBinaryPath
  identity: KimiBinaryIdentity
  qualification: KimiRuntimeQualification | null
  attestationSource:
    | typeof KIMI_RUNTIME_ATTESTATION_SOURCE
    | typeof KIMI_UNATTESTED_DEVELOPMENT_SOURCE
  mode: 'reviewed' | 'unattested-development'
  capability: KimiCapabilityProjection
  /** Re-hash and re-stat the original source immediately before spawn. */
  assertReadyForSpawn: () => Promise<AdmittedKimiBinaryPath>
}

export type KimiRuntimeAdmissionDecision = BlockedKimiRuntimeAdmission | AdmittedKimiRuntime

export interface KimiRuntimeAdmissionInput {
  binaryPath: string
  isPackaged: boolean
  environment?: NodeJS.ProcessEnv
}

interface KimiRuntimeAdmissionDependencies {
  platform?: NodeJS.Platform
  arch?: string
  captureIdentity?: (sourcePath: string) => Promise<KimiBinaryIdentity>
  probeSurfaces?: (binaryPath: string) => Promise<KimiInventorySurfaces>
}

function statSnapshot(stat: BigIntStats): KimiBinaryStatIdentity {
  const record = stat as unknown as Record<string, unknown>
  return Object.fromEntries(
    BINARY_STAT_FIELDS.map((field) => [field, String(record[field] ?? '')])
  ) as KimiBinaryStatIdentity
}

function sameStatIdentity(left: KimiBinaryStatIdentity, right: KimiBinaryStatIdentity): boolean {
  return BINARY_STAT_FIELDS.every((field) => left[field] === right[field])
}

export function sameKimiBinaryIdentity(
  left: KimiBinaryIdentity | null | undefined,
  right: KimiBinaryIdentity | null | undefined
): boolean {
  return Boolean(
    left &&
    right &&
    left.realPath === right.realPath &&
    left.sha256 === right.sha256 &&
    sameStatIdentity(left.stat, right.stat)
  )
}

/**
 * Hash an already-open descriptor and bind it to bigint fstat metadata. The
 * source symlink and resolved path are re-checked after hashing so replacing a
 * path cannot silently swap the bytes represented by the digest.
 */
export async function captureKimiBinaryIdentity(sourcePath: string): Promise<KimiBinaryIdentity> {
  const realPathBefore = await fs.realpath(sourcePath)
  const handle = await fs.open(realPathBefore, 'r')
  try {
    const statBefore = await handle.stat({ bigint: true })
    if (!statBefore.isFile()) throw new Error('resolved Kimi executable is not a regular file')
    if (statBefore.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('resolved Kimi executable is too large to hash safely')
    }

    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    const expectedBytes = Number(statBefore.size)
    let position = 0
    while (position < expectedBytes) {
      const length = Math.min(buffer.length, expectedBytes - position)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      if (bytesRead <= 0) throw new Error('Kimi executable ended while it was being hashed')
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }

    const statAfter = await handle.stat({ bigint: true })
    const pathStatAfter = await fs.stat(realPathBefore, { bigint: true })
    const realPathAfter = await fs.realpath(sourcePath)
    const before = statSnapshot(statBefore)
    const after = statSnapshot(statAfter)
    const pathAfter = statSnapshot(pathStatAfter)
    if (
      realPathAfter !== realPathBefore ||
      !statAfter.isFile() ||
      !pathStatAfter.isFile() ||
      !sameStatIdentity(before, after) ||
      !sameStatIdentity(after, pathAfter)
    ) {
      throw new Error('Kimi executable identity changed while it was being hashed')
    }
    return {
      realPath: realPathBefore,
      sha256: `sha256:${hash.digest('hex')}`,
      stat: after
    }
  } finally {
    await handle.close()
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, stableValue(record[key])])
    )
  }
  return value
}

function sha256Json(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex')}`
}

function extractLongFlags(text: string): string[] {
  const flags = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('-')) continue
    for (const match of trimmed.matchAll(/--[a-z][a-z0-9-]*/g)) flags.add(match[0])
  }
  return [...flags].sort()
}

function extractCommands(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^Commands:\s*$/.test(line.trim()))
  if (start < 0) return []
  const commands = new Set<string>()
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim()) break
    const match = line.match(/^\s{2,4}([a-z][a-z0-9-]*)\b/)
    if (match && /\s{2,}\S/.test(line.slice(match[0].length))) commands.add(match[1])
  }
  return [...commands].sort()
}

function parseVersion(text: string): string | null {
  const match = text.trim().match(/\bv?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)
  return match ? match[0].replace(/^v/, '') : null
}

function probeText(capture: KimiProbeCapture): string {
  return capture.stdout || capture.stderr
}

export function projectKimiCapability(
  version: string,
  surfaces: KimiInventorySurfaces
): KimiCapabilityProjection {
  const topLevelHelp = probeText(surfaces.help)
  const transportHelp = probeText(surfaces.acpHelp)
  return {
    schemaVersion: 1,
    provider: 'kimi',
    version,
    topLevel: {
      flags: extractLongFlags(topLevelHelp),
      commands: extractCommands(topLevelHelp)
    },
    transport: {
      probed: true,
      command: 'acp',
      flags: extractLongFlags(transportHelp),
      commands: extractCommands(transportHelp)
    }
  }
}

export function fingerprintKimiCapability(projection: KimiCapabilityProjection): string {
  return sha256Json(projection)
}

const PROBE_ENV_ALLOWLIST = [
  'PATH',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT'
] as const

function scrubbedProbeEnvironment(root: string, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of PROBE_ENV_ALLOWLIST) {
    if (typeof source[key] === 'string') env[key] = source[key]
  }
  const home = join(root, 'home')
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: join(root, 'tmp'),
    TMP: join(root, 'tmp'),
    TEMP: join(root, 'tmp'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'),
    XDG_RUNTIME_DIR: join(root, 'xdg-runtime'),
    APPDATA: join(root, 'appdata'),
    LOCALAPPDATA: join(root, 'local-appdata'),
    KIMI_CODE_HOME: join(root, 'kimi-code'),
    FORCE_COLOR: '0',
    NO_COLOR: '1'
  }
}

function executeBoundedProbe(
  binaryPath: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxBuffer: number
): Promise<KimiProbeCapture> {
  return new Promise((resolve) => {
    execFile(
      binaryPath,
      [...args],
      { cwd, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        const codeValue = (error as NodeJS.ErrnoException | null)?.code
        resolve({
          args,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          code: error ? (typeof codeValue === 'number' ? codeValue : null) : 0,
          signal:
            error && typeof (error as { signal?: unknown }).signal === 'string'
              ? ((error as { signal: NodeJS.Signals }).signal ?? null)
              : null,
          error: error ? error.message : null
        })
      }
    )
  })
}

async function runProbeInFreshRoot(
  binaryPath: string,
  args: readonly string[],
  options: { sourceEnvironment: NodeJS.ProcessEnv; timeoutMs: number; maxBuffer: number }
): Promise<KimiProbeCapture> {
  const root = await fs.mkdtemp(join(tmpdir(), 'taskwraith-kimi-admission-'))
  const env = scrubbedProbeEnvironment(root, options.sourceEnvironment)
  const directories = new Set([
    join(root, 'workspace'),
    ...Object.values(env).filter(
      (value): value is string => typeof value === 'string' && value.startsWith(root)
    )
  ])
  try {
    await Promise.all(
      [...directories].map((directory) => fs.mkdir(directory, { recursive: true, mode: 0o700 }))
    )
    return await executeBoundedProbe(
      binaryPath,
      args,
      join(root, 'workspace'),
      env,
      options.timeoutMs,
      options.maxBuffer
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

/** Run only inert inventory surfaces. Every command gets a distinct empty home
 * and cwd; no Kimi credential, user config, workspace, or arbitrary secret is
 * inherited. */
export async function runBoundedKimiInventoryProbes(
  binaryPath: string,
  options: {
    sourceEnvironment?: NodeJS.ProcessEnv
    timeoutMs?: number
    maxBuffer?: number
  } = {}
): Promise<KimiInventorySurfaces> {
  const probeOptions = {
    sourceEnvironment: options.sourceEnvironment ?? process.env,
    timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? PROBE_MAX_BUFFER_BYTES
  }
  const version = await runProbeInFreshRoot(binaryPath, ['--version'], probeOptions)
  const help = await runProbeInFreshRoot(binaryPath, ['--help'], probeOptions)
  const acpHelp = await runProbeInFreshRoot(binaryPath, ['acp', '--help'], probeOptions)
  return { version, help, acpHelp }
}

function qualificationErrors(value: unknown, index: number): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [`qualification[${index}] is not an object`]
  }
  const item = value as Record<string, unknown>
  const errors: string[] = []
  if (typeof item.binarySha256 !== 'string' || !SHA256_PATTERN.test(item.binarySha256)) {
    errors.push(`qualification[${index}].binarySha256 is not an exact sha256 digest`)
  }
  if (typeof item.platform !== 'string' || !item.platform.trim()) {
    errors.push(`qualification[${index}].platform is missing`)
  }
  if (typeof item.arch !== 'string' || !item.arch.trim()) {
    errors.push(`qualification[${index}].arch is missing`)
  }
  if (item.scope !== KIMI_RUNTIME_QUALIFICATION_SCOPE) {
    errors.push(`qualification[${index}].scope is not ${KIMI_RUNTIME_QUALIFICATION_SCOPE}`)
  }
  if (typeof item.version !== 'string' || !item.version.trim()) {
    errors.push(`qualification[${index}].version is missing`)
  }
  if (
    typeof item.capabilityFingerprint !== 'string' ||
    !SHA256_PATTERN.test(item.capabilityFingerprint)
  ) {
    errors.push(`qualification[${index}].capabilityFingerprint is not an exact sha256 digest`)
  }
  if (item.postureVersion !== KIMI_ACP_PRODUCTION_POSTURE_VERSION) {
    errors.push(`qualification[${index}].postureVersion is not the production posture`)
  }
  if (item.attestationSource !== KIMI_RUNTIME_ATTESTATION_SOURCE) {
    errors.push(`qualification[${index}].attestationSource is not the reviewed live canary`)
  }
  return errors
}

function validateQualificationRoster(value: unknown): {
  qualifications: readonly KimiRuntimeQualification[]
  errors: string[]
} {
  if (!Array.isArray(value))
    return { qualifications: [], errors: ['qualification roster is not an array'] }
  const errors = value.flatMap(qualificationErrors)
  const qualifications = errors.length === 0 ? (value as KimiRuntimeQualification[]) : []
  const seen = new Set<string>()
  for (const [index, item] of qualifications.entries()) {
    const key = JSON.stringify(stableValue(item))
    if (seen.has(key)) errors.push(`qualification[${index}] duplicates an earlier exact tuple`)
    seen.add(key)
  }
  return { qualifications: errors.length === 0 ? qualifications : [], errors }
}

function identityCacheKey(identity: KimiBinaryIdentity, mode: string): string {
  return [
    mode,
    identity.realPath,
    identity.sha256,
    ...BINARY_STAT_FIELDS.map((field) => identity.stat[field])
  ].join('\u0000')
}

function probesSucceeded(surfaces: KimiInventorySurfaces): boolean {
  return [surfaces.version, surfaces.help, surfaces.acpHelp].every(
    (capture) => capture.code === 0 && !capture.signal && !capture.error
  )
}

export class KimiRuntimeAdmissionGate {
  private readonly qualifications: readonly KimiRuntimeQualification[]
  private readonly rosterErrors: string[]
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly captureIdentity: (sourcePath: string) => Promise<KimiBinaryIdentity>
  private readonly probeSurfaces: (binaryPath: string) => Promise<KimiInventorySurfaces>
  private readonly flights = new Map<string, Promise<KimiRuntimeAdmissionDecision>>()

  constructor(
    qualifications: unknown = EMBEDDED_KIMI_RUNTIME_QUALIFICATIONS,
    dependencies: KimiRuntimeAdmissionDependencies = {}
  ) {
    const validated = validateQualificationRoster(qualifications)
    this.qualifications = validated.qualifications
    this.rosterErrors = validated.errors
    this.platform = dependencies.platform ?? process.platform
    this.arch = dependencies.arch ?? process.arch
    this.captureIdentity = dependencies.captureIdentity ?? captureKimiBinaryIdentity
    this.probeSurfaces =
      dependencies.probeSurfaces ?? ((binaryPath) => runBoundedKimiInventoryProbes(binaryPath))
  }

  clearCache(): void {
    this.flights.clear()
  }

  async admit(input: KimiRuntimeAdmissionInput): Promise<KimiRuntimeAdmissionDecision> {
    const sourcePath = String(input.binaryPath || '').trim()
    if (!sourcePath) {
      return {
        admitted: false,
        reason: 'missing_binary_path',
        message: 'Kimi runtime admission requires an explicit binary path.'
      }
    }
    if (this.rosterErrors.length > 0) {
      return {
        admitted: false,
        reason: 'invalid_qualification_roster',
        message: `Embedded Kimi qualification roster is invalid: ${this.rosterErrors.join('; ')}`
      }
    }

    let identity: KimiBinaryIdentity
    try {
      identity = await this.captureIdentity(sourcePath)
    } catch (error) {
      return {
        admitted: false,
        reason: 'binary_identity_failed',
        message: `Kimi binary identity capture failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }

    const binaryCandidates = this.qualifications.filter(
      (candidate) =>
        candidate.binarySha256 === identity.sha256 &&
        candidate.platform === this.platform &&
        candidate.arch === this.arch &&
        candidate.scope === KIMI_RUNTIME_QUALIFICATION_SCOPE &&
        candidate.postureVersion === KIMI_ACP_PRODUCTION_POSTURE_VERSION
    )
    // Un-gated: any installed Kimi binary that passes the STRUCTURAL checks in
    // qualify() below (stable identity, successful bounded probes, a parseable
    // version, and the ACP-only transport posture) is admitted — contained at
    // runtime by the independently-built authenticated HTTP gateway + native
    // deny-wall, which apply regardless of admission. We no longer require an
    // exact per-build reviewed FINGERPRINT: that was brittle (Kimi auto-updates
    // broke the SHA match and silently disabled Kimi) and no end user can mint
    // one. When a matching reviewed roster tuple DOES exist the run is still
    // marked 'reviewed'; otherwise it proceeds in 'unattested-development' mode.
    const allowUnattestedDevelopment = true
    if (binaryCandidates.length === 0 && !allowUnattestedDevelopment) {
      return {
        admitted: false,
        reason: 'unknown_binary',
        message: 'Kimi binary SHA/platform/architecture is not in the embedded reviewed roster.',
        identity
      }
    }

    const mode = binaryCandidates.length > 0 ? 'reviewed' : 'unattested-development'
    const key = identityCacheKey(identity, mode)
    const existing = this.flights.get(key)
    if (existing) return existing
    const flight = this.qualify(sourcePath, identity, binaryCandidates, mode)
    this.flights.set(key, flight)
    const decision = await flight
    if (!decision.admitted) this.flights.delete(key)
    return decision
  }

  private async qualify(
    sourcePath: string,
    identity: KimiBinaryIdentity,
    candidates: readonly KimiRuntimeQualification[],
    mode: 'reviewed' | 'unattested-development'
  ): Promise<KimiRuntimeAdmissionDecision> {
    let surfaces: KimiInventorySurfaces | null = null
    let probeError: unknown = null
    try {
      surfaces = await this.probeSurfaces(identity.realPath)
    } catch (error) {
      probeError = error
    }

    let postProbeIdentity: KimiBinaryIdentity
    try {
      postProbeIdentity = await this.captureIdentity(sourcePath)
    } catch (error) {
      return {
        admitted: false,
        reason: 'binary_identity_changed',
        message: `Kimi binary identity could not be revalidated after probes: ${error instanceof Error ? error.message : String(error)}`,
        identity
      }
    }
    if (!sameKimiBinaryIdentity(identity, postProbeIdentity)) {
      return {
        admitted: false,
        reason: 'binary_identity_changed',
        message: 'Kimi binary identity changed during bounded inventory probes.',
        identity
      }
    }
    if (probeError || !surfaces || !probesSucceeded(surfaces)) {
      return {
        admitted: false,
        reason: 'probe_failed',
        message: `Kimi bounded inventory probes failed${probeError ? `: ${probeError instanceof Error ? probeError.message : String(probeError)}` : '.'}`,
        identity
      }
    }

    const version = parseVersion(probeText(surfaces.version))
    if (!version) {
      return {
        admitted: false,
        reason: 'capability_mismatch',
        message: 'Kimi --version output did not contain a supported semantic version.',
        identity
      }
    }
    const capability = projectKimiCapability(version, surfaces)
    if (
      !capability.topLevel.commands.includes('acp') ||
      capability.topLevel.flags.includes('--wire')
    ) {
      return {
        admitted: false,
        reason: 'capability_mismatch',
        message: 'Kimi inventory does not advertise the qualified ACP-only transport posture.',
        identity
      }
    }
    const capabilityFingerprint = fingerprintKimiCapability(capability)
    const qualification = candidates.find(
      (candidate) =>
        candidate.version === version && candidate.capabilityFingerprint === capabilityFingerprint
    )
    if (mode === 'reviewed' && !qualification) {
      return {
        admitted: false,
        reason: 'capability_mismatch',
        message: 'Kimi version/capability projection does not match its reviewed binary tuple.',
        identity
      }
    }

    const binaryPath = identity.realPath as AdmittedKimiBinaryPath
    return {
      admitted: true,
      binaryPath,
      identity,
      qualification: qualification ?? null,
      attestationSource: qualification
        ? KIMI_RUNTIME_ATTESTATION_SOURCE
        : KIMI_UNATTESTED_DEVELOPMENT_SOURCE,
      mode,
      capability,
      assertReadyForSpawn: async () => {
        const current = await this.captureIdentity(sourcePath)
        if (!sameKimiBinaryIdentity(identity, current)) {
          throw new Error('Kimi binary identity changed after runtime admission.')
        }
        return binaryPath
      }
    }
  }
}

export const kimiRuntimeAdmission = new KimiRuntimeAdmissionGate()

export function admitKimiRuntime(
  input: KimiRuntimeAdmissionInput
): Promise<KimiRuntimeAdmissionDecision> {
  return kimiRuntimeAdmission.admit(input)
}

const RELEASE_MANIFEST_REQUIRED_STRING_FIELDS = [
  'binarySha256',
  'platform',
  'arch',
  'scope',
  'version',
  'capabilityFingerprint',
  'postureVersion',
  'attestationSource',
  'distribution',
  'harnessNodeVersion',
  'authentication',
  'backendBaseUrl',
  'modelAlias',
  'model'
] as const

/** Project the richer release-canary manifest into the exact immutable tuple
 * that may be shipped. Malformed/partial entries fail instead of being skipped. */
export function projectKimiRuntimeQualificationsFromManifest(manifest: unknown): {
  qualifications: KimiRuntimeQualification[]
  errors: string[]
} {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { qualifications: [], errors: ['release manifest is not an object'] }
  }
  const record = manifest as Record<string, unknown>
  if (record.schemaVersion !== 1) {
    return { qualifications: [], errors: ['release manifest schemaVersion must be 1'] }
  }
  const providers = record.providers
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
    return { qualifications: [], errors: ['release manifest providers is not an object'] }
  }
  const entries = (providers as Record<string, unknown>).kimi
  if (!Array.isArray(entries)) {
    return { qualifications: [], errors: ['release manifest providers.kimi is not an array'] }
  }

  const errors: string[] = []
  const qualifications: KimiRuntimeQualification[] = []
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`providers.kimi[${index}] is not an object`)
      return
    }
    const item = entry as Record<string, unknown>
    for (const field of RELEASE_MANIFEST_REQUIRED_STRING_FIELDS) {
      if (typeof item[field] !== 'string' || !String(item[field]).trim()) {
        errors.push(`providers.kimi[${index}].${field} is missing`)
      }
    }
    const projected = {
      binarySha256: item.binarySha256,
      platform: item.platform,
      arch: item.arch,
      scope: item.scope,
      version: item.version,
      capabilityFingerprint: item.capabilityFingerprint,
      postureVersion: item.postureVersion,
      attestationSource: item.attestationSource
    }
    const projectedErrors = qualificationErrors(projected, index)
    errors.push(...projectedErrors.map((error) => `providers.kimi ${error}`))
    if (projectedErrors.length === 0) {
      qualifications.push(projected as KimiRuntimeQualification)
    }
  })
  if (errors.length > 0) return { qualifications: [], errors }
  const validated = validateQualificationRoster(qualifications)
  return { qualifications: [...validated.qualifications], errors: validated.errors }
}

function canonicalQualificationRoster(roster: readonly KimiRuntimeQualification[]): string {
  return JSON.stringify(
    [...roster]
      .map((entry) => stableValue(entry))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  )
}

export function verifyEmbeddedKimiRuntimeQualificationProjection(
  manifest: unknown,
  embedded: unknown = EMBEDDED_KIMI_RUNTIME_QUALIFICATIONS
): { ok: boolean; errors: string[] } {
  const projected = projectKimiRuntimeQualificationsFromManifest(manifest)
  const validatedEmbedded = validateQualificationRoster(embedded)
  const errors = [...projected.errors, ...validatedEmbedded.errors]
  if (
    errors.length === 0 &&
    canonicalQualificationRoster(projected.qualifications) !==
      canonicalQualificationRoster(validatedEmbedded.qualifications)
  ) {
    errors.push('embedded Kimi runtime qualifications do not exactly match the release manifest')
  }
  return { ok: errors.length === 0, errors }
}
