// ============================================================================
// DEV-ONLY CONTAINMENT CANARY — NOT A RUNTIME GATE. DO NOT WIRE INTO LAUNCH.
//
// The live spawn path (runCursorProvider in index.ts) deliberately does NOT
// consult this module: exact-SHA admission proved brittle because provider
// auto-updates changed the binary and silently disabled Cursor. Production
// containment is the contained argv itself (buildContainedCursorArgv —
// `--sandbox enabled` hard-pinned, read-only `--mode` for read-only seats).
// This module and its minted roster exist to power the DEV-only
// CursorStartupContainment live canary — the per-upgrade tripwire that
// re-proves the sandbox posture against a real binary — and to keep the
// canary-derived qualification data (`cursor-native-sandbox-readonly-v1`).
// Re-wiring it into the launch path would resurrect the auto-update
// bricking; read the "no per-build fingerprint gate" comment at the
// runCursorProvider spawn site before touching this.
// ============================================================================
import { execFile } from 'child_process'
import { createHash } from 'crypto'
import type { BigIntStats } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CURSOR_STARTUP_CONTAINMENT_POSTURE_VERSION } from '../../shared/cursorStartupPosture'
import embeddedCursorRuntimeQualifications from './CursorRuntimeQualifications.generated.json'

export const CURSOR_RUNTIME_QUALIFICATION_SCOPE = 'cursor-native-sandbox-readonly-v1' as const
export const CURSOR_RUNTIME_ATTESTATION_SOURCE = 'credentialed-live-containment-canary' as const
export const CURSOR_UNATTESTED_DEVELOPMENT_SOURCE = 'unattested-development' as const

declare const admittedCursorBinaryPathBrand: unique symbol

/** A realpath is branded only after exact qualification and a post-probe
 * identity check. Launch callers must additionally call `assertReadyForSpawn`
 * immediately before process creation. Cursor has no admitted spawn path in this
 * build (managed runs are still fail-closed); the brand exists so a future
 * launcher cannot invent an admitted path without going through the gate. */
export type AdmittedCursorBinaryPath = string & {
  readonly [admittedCursorBinaryPathBrand]: true
}

export interface CursorRuntimeQualification {
  binarySha256: string
  platform: NodeJS.Platform
  arch: string
  scope: typeof CURSOR_RUNTIME_QUALIFICATION_SCOPE
  version: string
  capabilityFingerprint: string
  postureVersion: typeof CURSOR_STARTUP_CONTAINMENT_POSTURE_VERSION
  attestationSource: typeof CURSOR_RUNTIME_ATTESTATION_SOURCE
}

/**
 * Build-generated runtime projection of the reviewed release manifest,
 * written by `generate:cursor-runtime-qualifications` from a credentialed
 * live-canary pass (classifier-gated; the USER runs the mint). Packaged
 * builds do not read an environment manifest or accept an
 * environment-provided tuple at runtime. If the roster is empty, `admit()`
 * returns `unknown_binary` for every binary — the fail-closed default. The
 * roster gates only the dev canary, never the live spawn path (see the
 * header above).
 */
export const EMBEDDED_CURSOR_RUNTIME_QUALIFICATIONS: readonly CursorRuntimeQualification[] =
  Object.freeze(
    embeddedCursorRuntimeQualifications.map((qualification) => Object.freeze(qualification))
  ) as readonly CursorRuntimeQualification[]

/**
 * Synchronous coarse predicate: is any exact-build Cursor tuple embedded at all?
 *
 * This never authorizes a spawn on its own (the exact binary is only verified
 * by the async `admit()` probe/recheck). Its one-time consumer, the
 * `cursorManagedRunAdmission()` coarse gate, was deleted as un-wired re-wire
 * bait; the predicate remains for the dev canary and roster tooling only.
 */
export function cursorRuntimeQualificationsPresent(
  roster: readonly CursorRuntimeQualification[] = EMBEDDED_CURSOR_RUNTIME_QUALIFICATIONS
): boolean {
  return roster.length > 0
}

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

export type CursorBinaryStatIdentity = Record<(typeof BINARY_STAT_FIELDS)[number], string>

export interface CursorBinaryIdentity {
  realPath: string
  sha256: string
  stat: CursorBinaryStatIdentity
}

export interface CursorProbeCapture {
  args: readonly string[]
  stdout: string
  stderr: string
  code: number | null
  signal: NodeJS.Signals | null
  error: string | null
}

export interface CursorInventorySurfaces {
  version: CursorProbeCapture
  help: CursorProbeCapture
}

export interface CursorCapabilityProjection {
  schemaVersion: 1
  provider: 'cursor'
  version: string
  topLevel: { flags: string[]; commands: string[] }
  /** Cursor has no separate transport subcommand (Kimi's `acp`). The absence is
   * pinned into the fingerprint so a build that grows one re-qualifies. */
  transport: {
    probed: false
  }
}

export type CursorRuntimeAdmissionBlockReason =
  | 'missing_binary_path'
  | 'invalid_qualification_roster'
  | 'binary_identity_failed'
  | 'unknown_binary'
  | 'probe_failed'
  | 'capability_mismatch'
  | 'binary_identity_changed'

export interface BlockedCursorRuntimeAdmission {
  admitted: false
  reason: CursorRuntimeAdmissionBlockReason
  message: string
  identity?: CursorBinaryIdentity
}

export interface AdmittedCursorRuntime {
  admitted: true
  binaryPath: AdmittedCursorBinaryPath
  identity: CursorBinaryIdentity
  qualification: CursorRuntimeQualification | null
  attestationSource:
    | typeof CURSOR_RUNTIME_ATTESTATION_SOURCE
    | typeof CURSOR_UNATTESTED_DEVELOPMENT_SOURCE
  mode: 'reviewed' | 'unattested-development'
  capability: CursorCapabilityProjection
  /** Re-hash and re-stat the original source immediately before spawn. */
  assertReadyForSpawn: () => Promise<AdmittedCursorBinaryPath>
}

export type CursorRuntimeAdmissionDecision = BlockedCursorRuntimeAdmission | AdmittedCursorRuntime

export interface CursorRuntimeAdmissionInput {
  binaryPath: string
  isPackaged: boolean
  environment?: NodeJS.ProcessEnv
}

interface CursorRuntimeAdmissionDependencies {
  platform?: NodeJS.Platform
  arch?: string
  captureIdentity?: (sourcePath: string) => Promise<CursorBinaryIdentity>
  probeSurfaces?: (binaryPath: string) => Promise<CursorInventorySurfaces>
}

function statSnapshot(stat: BigIntStats): CursorBinaryStatIdentity {
  const record = stat as unknown as Record<string, unknown>
  return Object.fromEntries(
    BINARY_STAT_FIELDS.map((field) => [field, String(record[field] ?? '')])
  ) as CursorBinaryStatIdentity
}

function sameStatIdentity(left: CursorBinaryStatIdentity, right: CursorBinaryStatIdentity): boolean {
  return BINARY_STAT_FIELDS.every((field) => left[field] === right[field])
}

export function sameCursorBinaryIdentity(
  left: CursorBinaryIdentity | null | undefined,
  right: CursorBinaryIdentity | null | undefined
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
export async function captureCursorBinaryIdentity(
  sourcePath: string
): Promise<CursorBinaryIdentity> {
  const realPathBefore = await fs.realpath(sourcePath)
  const handle = await fs.open(realPathBefore, 'r')
  try {
    const statBefore = await handle.stat({ bigint: true })
    if (!statBefore.isFile()) throw new Error('resolved cursor-agent executable is not a regular file')
    if (statBefore.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('resolved cursor-agent executable is too large to hash safely')
    }

    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    const expectedBytes = Number(statBefore.size)
    let position = 0
    while (position < expectedBytes) {
      const length = Math.min(buffer.length, expectedBytes - position)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      if (bytesRead <= 0) throw new Error('cursor-agent executable ended while it was being hashed')
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
      throw new Error('cursor-agent executable identity changed while it was being hashed')
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

function probeText(capture: CursorProbeCapture): string {
  return capture.stdout || capture.stderr
}

export function projectCursorCapability(
  version: string,
  surfaces: CursorInventorySurfaces
): CursorCapabilityProjection {
  const topLevelHelp = probeText(surfaces.help)
  return {
    schemaVersion: 1,
    provider: 'cursor',
    version,
    topLevel: {
      flags: extractLongFlags(topLevelHelp),
      commands: extractCommands(topLevelHelp)
    },
    transport: {
      probed: false
    }
  }
}

export function fingerprintCursorCapability(projection: CursorCapabilityProjection): string {
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
  // Cursor resolves its config from CURSOR_CONFIG_DIR/CURSOR_DATA_DIR (and HOME).
  // Point all three at pristine temp roots so an inert --version/--help probe
  // never reads the user's ~/.cursor (mcp.json, cli.json, skills, plugins) and
  // never inherits CURSOR_API_KEY/CURSOR_AUTH_TOKEN (never in the allowlist).
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
    CURSOR_CONFIG_DIR: join(root, 'cursor-config'),
    CURSOR_DATA_DIR: join(root, 'cursor-data'),
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
): Promise<CursorProbeCapture> {
  return new Promise((resolve) => {
    // Node ≥20 rejects .cmd/.bat without shell (CVE-2024-27980 → EINVAL). Official
    // Windows installers often expose cursor-agent as a .cmd wrapper. Inventory
    // probes only pass fixed allowlisted args (--version / --help), never freeform
    // user input, so shell:true is acceptable on this narrow path.
    const windowsBatch =
      process.platform === 'win32' && /\.(cmd|bat)$/i.test(binaryPath)
    execFile(
      binaryPath,
      [...args],
      {
        cwd,
        env,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer,
        killSignal: 'SIGKILL',
        ...(windowsBatch ? { shell: true } : {})
      },
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
): Promise<CursorProbeCapture> {
  const root = await fs.mkdtemp(join(tmpdir(), 'taskwraith-cursor-admission-'))
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

/** Run only inert inventory surfaces (`--version`, `--help`). Every command gets
 * a distinct empty home and cwd; no Cursor credential, user config, workspace,
 * or arbitrary secret is inherited. Cursor has no ACP transport subcommand, so
 * there is no third probe. */
export async function runBoundedCursorInventoryProbes(
  binaryPath: string,
  options: {
    sourceEnvironment?: NodeJS.ProcessEnv
    timeoutMs?: number
    maxBuffer?: number
  } = {}
): Promise<CursorInventorySurfaces> {
  const probeOptions = {
    sourceEnvironment: options.sourceEnvironment ?? process.env,
    timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? PROBE_MAX_BUFFER_BYTES
  }
  const version = await runProbeInFreshRoot(binaryPath, ['--version'], probeOptions)
  const help = await runProbeInFreshRoot(binaryPath, ['--help'], probeOptions)
  return { version, help }
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
  if (item.scope !== CURSOR_RUNTIME_QUALIFICATION_SCOPE) {
    errors.push(`qualification[${index}].scope is not ${CURSOR_RUNTIME_QUALIFICATION_SCOPE}`)
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
  if (item.postureVersion !== CURSOR_STARTUP_CONTAINMENT_POSTURE_VERSION) {
    errors.push(`qualification[${index}].postureVersion is not the production posture`)
  }
  if (item.attestationSource !== CURSOR_RUNTIME_ATTESTATION_SOURCE) {
    errors.push(`qualification[${index}].attestationSource is not the reviewed live canary`)
  }
  return errors
}

function validateQualificationRoster(value: unknown): {
  qualifications: readonly CursorRuntimeQualification[]
  errors: string[]
} {
  if (!Array.isArray(value))
    return { qualifications: [], errors: ['qualification roster is not an array'] }
  const errors = value.flatMap(qualificationErrors)
  const qualifications = errors.length === 0 ? (value as CursorRuntimeQualification[]) : []
  const seen = new Set<string>()
  for (const [index, item] of qualifications.entries()) {
    const key = JSON.stringify(stableValue(item))
    if (seen.has(key)) errors.push(`qualification[${index}] duplicates an earlier exact tuple`)
    seen.add(key)
  }
  return { qualifications: errors.length === 0 ? qualifications : [], errors }
}

function identityCacheKey(identity: CursorBinaryIdentity, mode: string): string {
  return [
    mode,
    identity.realPath,
    identity.sha256,
    ...BINARY_STAT_FIELDS.map((field) => identity.stat[field])
  ].join('\u0000')
}

function probesSucceeded(surfaces: CursorInventorySurfaces): boolean {
  return [surfaces.version, surfaces.help].every(
    (capture) => capture.code === 0 && !capture.signal && !capture.error
  )
}

export class CursorRuntimeAdmissionGate {
  private readonly qualifications: readonly CursorRuntimeQualification[]
  private readonly rosterErrors: string[]
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly captureIdentity: (sourcePath: string) => Promise<CursorBinaryIdentity>
  private readonly probeSurfaces: (binaryPath: string) => Promise<CursorInventorySurfaces>
  private readonly flights = new Map<string, Promise<CursorRuntimeAdmissionDecision>>()

  constructor(
    qualifications: unknown = EMBEDDED_CURSOR_RUNTIME_QUALIFICATIONS,
    dependencies: CursorRuntimeAdmissionDependencies = {}
  ) {
    const validated = validateQualificationRoster(qualifications)
    this.qualifications = validated.qualifications
    this.rosterErrors = validated.errors
    this.platform = dependencies.platform ?? process.platform
    this.arch = dependencies.arch ?? process.arch
    this.captureIdentity = dependencies.captureIdentity ?? captureCursorBinaryIdentity
    this.probeSurfaces =
      dependencies.probeSurfaces ?? ((binaryPath) => runBoundedCursorInventoryProbes(binaryPath))
  }

  clearCache(): void {
    this.flights.clear()
  }

  async admit(input: CursorRuntimeAdmissionInput): Promise<CursorRuntimeAdmissionDecision> {
    const sourcePath = String(input.binaryPath || '').trim()
    if (!sourcePath) {
      return {
        admitted: false,
        reason: 'missing_binary_path',
        message: 'Cursor runtime admission requires an explicit binary path.'
      }
    }
    if (this.rosterErrors.length > 0) {
      return {
        admitted: false,
        reason: 'invalid_qualification_roster',
        message: `Embedded Cursor qualification roster is invalid: ${this.rosterErrors.join('; ')}`
      }
    }

    let identity: CursorBinaryIdentity
    try {
      identity = await this.captureIdentity(sourcePath)
    } catch (error) {
      return {
        admitted: false,
        reason: 'binary_identity_failed',
        message: `Cursor binary identity capture failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }

    const binaryCandidates = this.qualifications.filter(
      (candidate) =>
        candidate.binarySha256 === identity.sha256 &&
        candidate.platform === this.platform &&
        candidate.arch === this.arch &&
        candidate.scope === CURSOR_RUNTIME_QUALIFICATION_SCOPE &&
        candidate.postureVersion === CURSOR_STARTUP_CONTAINMENT_POSTURE_VERSION
    )
    const allowUnattestedDevelopment =
      !input.isPackaged && input.environment?.TASKWRAITH_ALLOW_UNATTESTED_CURSOR_DEV === '1'
    if (binaryCandidates.length === 0 && !allowUnattestedDevelopment) {
      return {
        admitted: false,
        reason: 'unknown_binary',
        message: 'Cursor binary SHA/platform/architecture is not in the embedded reviewed roster.',
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
    identity: CursorBinaryIdentity,
    candidates: readonly CursorRuntimeQualification[],
    mode: 'reviewed' | 'unattested-development'
  ): Promise<CursorRuntimeAdmissionDecision> {
    let surfaces: CursorInventorySurfaces | null = null
    let probeError: unknown = null
    try {
      surfaces = await this.probeSurfaces(identity.realPath)
    } catch (error) {
      probeError = error
    }

    let postProbeIdentity: CursorBinaryIdentity
    try {
      postProbeIdentity = await this.captureIdentity(sourcePath)
    } catch (error) {
      return {
        admitted: false,
        reason: 'binary_identity_changed',
        message: `Cursor binary identity could not be revalidated after probes: ${error instanceof Error ? error.message : String(error)}`,
        identity
      }
    }
    if (!sameCursorBinaryIdentity(identity, postProbeIdentity)) {
      return {
        admitted: false,
        reason: 'binary_identity_changed',
        message: 'Cursor binary identity changed during bounded inventory probes.',
        identity
      }
    }
    if (probeError || !surfaces || !probesSucceeded(surfaces)) {
      return {
        admitted: false,
        reason: 'probe_failed',
        message: `Cursor bounded inventory probes failed${probeError ? `: ${probeError instanceof Error ? probeError.message : String(probeError)}` : '.'}`,
        identity
      }
    }

    const version = parseVersion(probeText(surfaces.version))
    if (!version) {
      return {
        admitted: false,
        reason: 'capability_mismatch',
        message: 'Cursor --version output did not contain a supported version.',
        identity
      }
    }
    const capability = projectCursorCapability(version, surfaces)
    // The containment posture depends on the native OS sandbox backstop
    // (`--sandbox`) and headless print mode (`--print`), and on Cursor still
    // being the MCP-managing agent (`mcp`). A build that drops any of these is
    // not the qualified startup-containment surface and must re-qualify.
    if (
      !capability.topLevel.flags.includes('--sandbox') ||
      !capability.topLevel.flags.includes('--print') ||
      !capability.topLevel.commands.includes('mcp')
    ) {
      return {
        admitted: false,
        reason: 'capability_mismatch',
        message: 'Cursor inventory does not advertise the qualified startup-containment surface.',
        identity
      }
    }
    const capabilityFingerprint = fingerprintCursorCapability(capability)
    const qualification = candidates.find(
      (candidate) =>
        candidate.version === version && candidate.capabilityFingerprint === capabilityFingerprint
    )
    if (mode === 'reviewed' && !qualification) {
      return {
        admitted: false,
        reason: 'capability_mismatch',
        message: 'Cursor version/capability projection does not match its reviewed binary tuple.',
        identity
      }
    }

    const binaryPath = identity.realPath as AdmittedCursorBinaryPath
    return {
      admitted: true,
      binaryPath,
      identity,
      qualification: qualification ?? null,
      attestationSource: qualification
        ? CURSOR_RUNTIME_ATTESTATION_SOURCE
        : CURSOR_UNATTESTED_DEVELOPMENT_SOURCE,
      mode,
      capability,
      assertReadyForSpawn: async () => {
        const current = await this.captureIdentity(sourcePath)
        if (!sameCursorBinaryIdentity(identity, current)) {
          throw new Error('Cursor binary identity changed after runtime admission.')
        }
        return binaryPath
      }
    }
  }
}

export const cursorRuntimeAdmission = new CursorRuntimeAdmissionGate()

export function admitCursorRuntime(
  input: CursorRuntimeAdmissionInput
): Promise<CursorRuntimeAdmissionDecision> {
  return cursorRuntimeAdmission.admit(input)
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
 * that may be shipped. Malformed/partial entries fail instead of being skipped.
 *
 * The 14-field release row mirrors Kimi's for reviewer parity: the extra six
 * commissioning fields (distribution, harnessNodeVersion, authentication,
 * backendBaseUrl, modelAlias, model) stay release evidence and are stripped
 * before shipping. A future Cursor mint decides those values; only the eight
 * runtime fields ever reach a packaged build. */
export function projectCursorRuntimeQualificationsFromManifest(manifest: unknown): {
  qualifications: CursorRuntimeQualification[]
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
  const entries = (providers as Record<string, unknown>).cursor
  if (!Array.isArray(entries)) {
    return { qualifications: [], errors: ['release manifest providers.cursor is not an array'] }
  }

  const errors: string[] = []
  const qualifications: CursorRuntimeQualification[] = []
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`providers.cursor[${index}] is not an object`)
      return
    }
    const item = entry as Record<string, unknown>
    for (const field of RELEASE_MANIFEST_REQUIRED_STRING_FIELDS) {
      if (typeof item[field] !== 'string' || !String(item[field]).trim()) {
        errors.push(`providers.cursor[${index}].${field} is missing`)
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
    errors.push(...projectedErrors.map((error) => `providers.cursor ${error}`))
    if (projectedErrors.length === 0) {
      qualifications.push(projected as CursorRuntimeQualification)
    }
  })
  if (errors.length > 0) return { qualifications: [], errors }
  const validated = validateQualificationRoster(qualifications)
  return { qualifications: [...validated.qualifications], errors: validated.errors }
}

function canonicalQualificationRoster(roster: readonly CursorRuntimeQualification[]): string {
  return JSON.stringify(
    [...roster]
      .map((entry) => stableValue(entry))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  )
}

export function verifyEmbeddedCursorRuntimeQualificationProjection(
  manifest: unknown,
  embedded: unknown = EMBEDDED_CURSOR_RUNTIME_QUALIFICATIONS
): { ok: boolean; errors: string[] } {
  const projected = projectCursorRuntimeQualificationsFromManifest(manifest)
  const validatedEmbedded = validateQualificationRoster(embedded)
  const errors = [...projected.errors, ...validatedEmbedded.errors]
  if (
    errors.length === 0 &&
    canonicalQualificationRoster(projected.qualifications) !==
      canonicalQualificationRoster(validatedEmbedded.qualifications)
  ) {
    errors.push('embedded Cursor runtime qualifications do not exactly match the release manifest')
  }
  return { ok: errors.length === 0, errors }
}
