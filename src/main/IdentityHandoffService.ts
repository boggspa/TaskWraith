import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { open as openFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { spawn } from 'node:child_process'
import {
  BETA_DESKTOP_APP_ID,
  type AppDistributionIdentity,
  RELEASE_DESKTOP_APP_ID
} from './AppDistributionIdentity'

export const IDENTITY_HANDOFF_SCHEMA_VERSION = 1
export const IDENTITY_HANDOFF_ID = 'taskwraith-1.9.9-to-0.1.0-v1'
export const IDENTITY_HANDOFF_SOURCE_VERSION = '1.9.9'
export const IDENTITY_HANDOFF_TARGET_VERSION = '0.1.0'
export const IDENTITY_HANDOFF_STATE_DIR = 'identity-handoff-v1'

const MAX_HANDOFF_ERROR_LENGTH = 1_000
const MAX_HANDOFF_INSTRUCTIONS_LENGTH = 2_000
const EXPECTED_ARTIFACT_KEYS = [
  'darwin-universal',
  'win32-x64',
  'win32-arm64',
  'linux-x64'
] as const

const EXPECTED_ARTIFACT_CONTRACT = {
  'darwin-universal': {
    platform: 'darwin',
    arch: 'universal',
    fileName: 'TaskWraith-0.1.0-universal-mac.dmg',
    launchKind: 'dmg'
  },
  'win32-x64': {
    platform: 'win32',
    arch: 'x64',
    fileName: 'TaskWraith-0.1.0-win-x64-setup.exe',
    launchKind: 'nsis'
  },
  'win32-arm64': {
    platform: 'win32',
    arch: 'arm64',
    fileName: 'TaskWraith-0.1.0-win-arm64-setup.exe',
    launchKind: 'nsis'
  },
  'linux-x64': {
    platform: 'linux',
    arch: 'x64',
    fileName: 'TaskWraith-0.1.0.AppImage',
    launchKind: 'appimage'
  }
} as const

export type IdentityHandoffArtifactKey = (typeof EXPECTED_ARTIFACT_KEYS)[number]
export type IdentityHandoffLaunchKind = 'dmg' | 'nsis' | 'appimage'

export interface IdentityHandoffArtifact {
  platform: 'darwin' | 'win32' | 'linux'
  arch: 'universal' | 'x64' | 'arm64'
  fileName: string
  url: string
  size: number
  sha256: string
  launchKind: IdentityHandoffLaunchKind
  instructions: string
}

export interface IdentityHandoffManifest {
  schemaVersion: 1
  handoffId: string
  prepared: boolean
  sourceCommit: string | null
  source: {
    distributionIdentity: 'beta'
    appId: string
    version: string
    updateFeedChannel: 'latest'
  }
  target: {
    distributionIdentity: 'release'
    appId: string
    version: string
    updateFeedChannel: 'release'
  }
  supportUrl: string
  artifacts: Partial<Record<IdentityHandoffArtifactKey, IdentityHandoffArtifact>>
}

export type IdentityHandoffPhase =
  | 'inactive'
  | 'ready'
  | 'downloading'
  | 'downloaded'
  | 'awaiting-target'
  | 'complete'
  | 'error'
  | 'blocked'

export interface IdentityHandoffSnapshot {
  active: boolean
  phase: IdentityHandoffPhase
  handoffId: string
  sourceVersion: string
  targetVersion: string
  targetAppId: string
  targetUpdateFeedChannel: 'release'
  supportUrl: string
  evidencePath: string
  artifactFileName?: string
  instructions?: string
  downloadedBytes?: number
  totalBytes?: number
  percent?: number
  resumeAvailable?: boolean
  attempts?: number
  startedAt?: string
  launchedAt?: string
  completedAt?: string
  errorMessage?: string
  errorCode?: string
  manifestSha256?: string
  artifactSha256?: string
}

interface PersistentHandoffState {
  schemaVersion: 1
  handoffId: string
  phase: 'ready' | 'downloading' | 'downloaded' | 'awaiting-target' | 'complete' | 'error'
  sourceVersion: string
  targetVersion: string
  artifactKey: IdentityHandoffArtifactKey
  artifactFileName: string
  manifestSha256: string
  artifactSha256: string
  downloadedBytes: number
  attempts: number
  startedAt: string
  updatedAt: string
  launchedAt?: string
  completedAt?: string
  lastError?: string
  lastErrorCode?: string
}

export interface IdentityHandoffFetchResponse {
  ok: boolean
  status: number
  url: string
  headers: { get(name: string): string | null }
  body: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>
    }
  } | null
}

export type IdentityHandoffFetcher = (
  url: string,
  init?: { headers?: Record<string, string> }
) => Promise<IdentityHandoffFetchResponse>

export interface IdentityHandoffLaunchResult {
  ok: boolean
  error?: string
}

export interface IdentityHandoffServiceOptions {
  manifest: unknown
  currentVersion: string
  currentDistribution: AppDistributionIdentity
  userDataPath: string
  platform?: string
  arch?: string
  fetcher: IdentityHandoffFetcher
  launchInstaller?: (
    filePath: string,
    artifact: IdentityHandoffArtifact
  ) => IdentityHandoffLaunchResult
  quit?: () => void
  now?: () => Date
  log?: (line: string) => void
}

type Listener = (snapshot: IdentityHandoffSnapshot) => void

export class IdentityHandoffService {
  private readonly manifest?: IdentityHandoffManifest
  private readonly manifestSha256?: string
  private readonly manifestError?: string
  private readonly currentVersion: string
  private readonly currentDistribution: AppDistributionIdentity
  private readonly stateDir: string
  private readonly statePath: string
  private readonly platform: string
  private readonly arch: string
  private readonly fetcher: IdentityHandoffFetcher
  private readonly launchInstaller: (
    filePath: string,
    artifact: IdentityHandoffArtifact
  ) => IdentityHandoffLaunchResult
  private readonly quit: () => void
  private readonly now: () => Date
  private readonly log: (line: string) => void
  private readonly listeners = new Set<Listener>()
  private state?: PersistentHandoffState
  private stateReadError?: string
  private phase: IdentityHandoffPhase = 'inactive'
  private errorMessage?: string
  private errorCode?: string
  private artifact?: IdentityHandoffArtifact
  private artifactKey?: IdentityHandoffArtifactKey
  private inFlight?: Promise<IdentityHandoffSnapshot>
  private verifiedArtifact?: { path: string; size: number; mtimeMs: number }

  constructor(options: IdentityHandoffServiceOptions) {
    const validated = validateIdentityHandoffManifest(options.manifest)
    if (validated.ok) {
      this.manifest = validated.value
      this.manifestSha256 = sha256Json(validated.value)
    } else {
      this.manifestError = validated.error
    }
    this.currentVersion = options.currentVersion.trim()
    this.currentDistribution = options.currentDistribution
    this.stateDir = join(options.userDataPath, IDENTITY_HANDOFF_STATE_DIR)
    this.statePath = join(this.stateDir, 'state.json')
    this.platform = options.platform || process.platform
    this.arch = options.arch || process.arch
    this.fetcher = options.fetcher
    this.launchInstaller = options.launchInstaller || launchIdentityHandoffInstaller
    this.quit = options.quit || (() => undefined)
    this.now = options.now || (() => new Date())
    this.log = options.log || (() => undefined)
    this.initialize()
  }

  snapshot(): IdentityHandoffSnapshot {
    const manifest = this.manifest
    const state = this.state
    const artifact = this.artifact
    const totalBytes = artifact?.size
    const downloadedBytes = state?.downloadedBytes
    return {
      active: !new Set<IdentityHandoffPhase>(['inactive', 'complete']).has(this.phase),
      phase: this.phase,
      handoffId: manifest?.handoffId || IDENTITY_HANDOFF_ID,
      sourceVersion: manifest?.source.version || IDENTITY_HANDOFF_SOURCE_VERSION,
      targetVersion: manifest?.target.version || IDENTITY_HANDOFF_TARGET_VERSION,
      targetAppId: manifest?.target.appId || RELEASE_DESKTOP_APP_ID,
      targetUpdateFeedChannel: 'release',
      supportUrl:
        manifest?.supportUrl || 'https://github.com/boggspa/TaskWraith/releases/tag/v0.1.0',
      evidencePath: this.statePath,
      ...(artifact
        ? { artifactFileName: artifact.fileName, instructions: artifact.instructions }
        : {}),
      ...(downloadedBytes !== undefined ? { downloadedBytes } : {}),
      ...(totalBytes !== undefined ? { totalBytes } : {}),
      ...(downloadedBytes !== undefined && totalBytes
        ? { percent: Math.max(0, Math.min(100, (downloadedBytes / totalBytes) * 100)) }
        : {}),
      ...(state && this.partialSize() > 0 && this.partialSize() < (artifact?.size || 0)
        ? { resumeAvailable: true }
        : {}),
      ...(state ? { attempts: state.attempts, startedAt: state.startedAt } : {}),
      ...(state?.launchedAt ? { launchedAt: state.launchedAt } : {}),
      ...(state?.completedAt ? { completedAt: state.completedAt } : {}),
      ...(this.errorMessage ? { errorMessage: this.errorMessage } : {}),
      ...(this.errorCode ? { errorCode: this.errorCode } : {}),
      ...(state?.manifestSha256 ? { manifestSha256: state.manifestSha256 } : {}),
      ...(state?.artifactSha256 ? { artifactSha256: state.artifactSha256 } : {})
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Download or resume the exact hash-pinned public-identity installer. */
  download(): Promise<IdentityHandoffSnapshot> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.performDownload()
      .catch((error) => {
        this.fail('download-failed', boundedError(error))
        return this.snapshot()
      })
      .finally(() => {
        this.inFlight = undefined
      })
    return this.inFlight
  }

  /**
   * Re-check an interrupted/error state. This intentionally resolves to the
   * same bounded download path; there is no mutable remote manifest to refresh.
   */
  retry(): Promise<IdentityHandoffSnapshot> {
    return this.download()
  }

  /** Launch the already-verified installer, persist evidence, then quit beta. */
  launch(): boolean {
    if (!this.manifest || !this.artifact || !this.state || this.phase !== 'downloaded') {
      this.fail(
        'installer-not-ready',
        'The Release installer is not verified yet. Download or verify it before continuing.'
      )
      return false
    }
    const finalPath = this.finalArtifactPath()
    if (!this.verifiedArtifactMatches(finalPath)) {
      this.fail(
        'installer-needs-verification',
        'The downloaded installer must be verified again before it can be opened.'
      )
      return false
    }

    const launchedAt = this.nowIso()
    this.state = {
      ...this.state,
      phase: 'awaiting-target',
      launchedAt,
      updatedAt: launchedAt,
      lastError: undefined,
      lastErrorCode: undefined
    }
    this.writeState()
    this.phase = 'awaiting-target'
    this.publish()

    const result = this.launchInstaller(finalPath, this.artifact)
    if (!result.ok) {
      this.fail('installer-launch-failed', result.error || 'The Release installer could not open.')
      return false
    }

    // Let the platform receive the launch request before the beta process
    // exits. The durable awaiting-target state is already on disk, so a crash
    // anywhere after this point resumes as a repair/retry journey.
    setTimeout(() => this.quit(), 250).unref?.()
    return true
  }

  private initialize(): void {
    this.state = this.readState()

    if (this.stateReadError && (this.isSourceIdentity() || this.isTargetIdentity())) {
      this.block('state-unreadable', this.stateReadError)
      return
    }

    if (this.isTargetIdentity()) {
      if (
        this.state?.handoffId === IDENTITY_HANDOFF_ID &&
        this.state.phase === 'awaiting-target' &&
        typeof this.state.launchedAt === 'string' &&
        isIsoTimestamp(this.state.launchedAt)
      ) {
        const completedAt = this.nowIso()
        this.state = {
          ...this.state,
          phase: 'complete',
          completedAt,
          updatedAt: completedAt,
          lastError: undefined,
          lastErrorCode: undefined
        }
        this.ensureStateDir()
        this.writeState()
        this.cleanupArtifacts()
        this.phase = 'complete'
        return
      }
      if (this.state?.phase === 'complete') {
        this.phase = 'complete'
      } else if (this.state) {
        this.block(
          'target-transition-unproven',
          'TaskWraith Release found an incomplete beta handoff receipt without installer-launch evidence. Use the support route before repairing it.'
        )
      } else {
        this.phase = 'inactive'
      }
      return
    }

    if (
      !this.currentDistribution.valid &&
      this.currentVersion === IDENTITY_HANDOFF_SOURCE_VERSION
    ) {
      this.block(
        'invalid-source-identity',
        this.currentDistribution.reason || 'The beta application identity is invalid.'
      )
      return
    }

    if (!this.isSourceIdentity()) {
      if (this.state && this.state.phase !== 'complete') {
        this.block(
          'unsupported-current-identity',
          'This handoff was started by another TaskWraith identity. Use the support route before changing this installation.'
        )
      } else {
        this.phase = 'inactive'
      }
      return
    }

    if (!this.manifest) {
      this.block(
        'invalid-payload',
        this.manifestError || 'The identity handoff payload is invalid.'
      )
      return
    }
    if (!this.manifest.prepared) {
      this.block(
        'payload-not-prepared',
        'This 1.9.9 build does not contain the frozen 0.1.0 installer inventory. Use the support route instead of attempting a downgrade.'
      )
      return
    }

    const selected = selectIdentityHandoffArtifact(this.manifest, this.platform, this.arch)
    if (!selected) {
      this.block(
        'unsupported-platform',
        `No frozen Release installer exists for ${this.platform}-${this.arch}.`
      )
      return
    }
    this.artifactKey = selected.key
    this.artifact = selected.artifact

    if (!this.state || !isPersistentStateForManifest(this.state, this.manifest, selected.key)) {
      this.phase = 'ready'
      return
    }
    if (this.state.phase === 'complete') {
      this.phase = 'complete'
      return
    }

    // A process died while downloading or after opening the installer. Keep
    // its partial/final bytes, but require the next user action to hash them
    // again before the installer can be launched.
    if (this.state.phase === 'downloading') {
      this.state = {
        ...this.state,
        phase: 'error',
        updatedAt: this.nowIso(),
        lastError: 'The previous download was interrupted. Resume it to continue.',
        lastErrorCode: 'download-interrupted'
      }
      this.writeState()
    }
    this.phase = this.state.phase === 'error' ? 'error' : 'ready'
    this.errorMessage = this.state.lastError
    this.errorCode = this.state.lastErrorCode
  }

  private async performDownload(): Promise<IdentityHandoffSnapshot> {
    if (!this.manifest || !this.artifact || !this.artifactKey || !this.isSourceIdentity()) {
      this.fail(
        'handoff-unavailable',
        'The public-identity handoff is not available in this build.'
      )
      return this.snapshot()
    }
    this.ensureStateDir()

    const finalPath = this.finalArtifactPath()
    assertRegularFileOrMissing(finalPath)
    if (await verifyFile(finalPath, this.artifact)) {
      this.verifiedArtifact = fileFingerprint(finalPath)
      this.markDownloaded()
      return this.snapshot()
    }
    rmSync(finalPath, { force: true })

    const partialPath = this.partialArtifactPath()
    assertRegularFileOrMissing(partialPath)
    let offset = safeFileSize(partialPath)
    if (offset > this.artifact.size) {
      rmSync(partialPath, { force: true })
      offset = 0
    }
    if (offset === this.artifact.size) {
      if (await verifyFile(partialPath, this.artifact)) {
        renameSync(partialPath, finalPath)
        this.verifiedArtifact = fileFingerprint(finalPath)
        this.markDownloaded()
        return this.snapshot()
      }
      rmSync(partialPath, { force: true })
      offset = 0
    }

    const now = this.nowIso()
    const attempts = (this.state?.attempts || 0) + 1
    this.state = {
      schemaVersion: 1,
      handoffId: this.manifest.handoffId,
      phase: 'downloading',
      sourceVersion: this.manifest.source.version,
      targetVersion: this.manifest.target.version,
      artifactKey: this.artifactKey,
      artifactFileName: this.artifact.fileName,
      manifestSha256: this.manifestSha256!,
      artifactSha256: this.artifact.sha256,
      downloadedBytes: offset,
      attempts,
      startedAt: this.state?.startedAt || now,
      updatedAt: now
    }
    this.phase = 'downloading'
    this.errorMessage = undefined
    this.errorCode = undefined
    this.writeState()
    this.publish()

    try {
      const response = await this.fetcher(this.artifact.url, {
        ...(offset > 0 ? { headers: { Range: `bytes=${offset}-` } } : {})
      })
      assertSecureResponseUrl(response.url || this.artifact.url)
      if (!response.ok) {
        throw new Error(`Release installer download returned HTTP ${response.status}.`)
      }
      if (!response.body) throw new Error('Release installer download returned no body.')

      if (offset > 0 && response.status !== 206) {
        rmSync(partialPath, { force: true })
        offset = 0
        this.state = { ...this.state, downloadedBytes: 0, updatedAt: this.nowIso() }
        this.writeState()
      } else if (response.status === 206) {
        assertContentRange(response.headers.get('content-range'), offset, this.artifact.size)
      }

      const hash = createHash('sha256')
      if (offset > 0) {
        for await (const chunk of createReadStream(partialPath)) hash.update(chunk)
      }
      const handle = await openFile(partialPath, offset > 0 ? 'a' : 'w')
      let downloaded = offset
      try {
        const reader = response.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (!value || value.byteLength === 0) continue
          downloaded += value.byteLength
          if (downloaded > this.artifact.size) {
            throw new Error('Release installer exceeded its frozen size.')
          }
          hash.update(value)
          await handle.write(value)
          this.state = {
            ...this.state!,
            downloadedBytes: downloaded,
            updatedAt: this.nowIso()
          }
          this.publish()
        }
        await handle.sync()
      } finally {
        await handle.close()
      }

      if (downloaded !== this.artifact.size) {
        throw new Error(
          `Release installer is incomplete (${downloaded}/${this.artifact.size} bytes).`
        )
      }
      const digest = hash.digest('hex')
      if (digest !== this.artifact.sha256) {
        rmSync(partialPath, { force: true })
        throw new Error('Release installer integrity check failed.')
      }
      renameSync(partialPath, finalPath)
      this.verifiedArtifact = fileFingerprint(finalPath)
      this.markDownloaded()
    } catch (error) {
      this.fail('download-failed', boundedError(error))
    }
    return this.snapshot()
  }

  private markDownloaded(): void {
    if (!this.manifest || !this.artifact || !this.artifactKey) return
    const now = this.nowIso()
    this.state = {
      schemaVersion: 1,
      handoffId: this.manifest.handoffId,
      phase: 'downloaded',
      sourceVersion: this.manifest.source.version,
      targetVersion: this.manifest.target.version,
      artifactKey: this.artifactKey,
      artifactFileName: this.artifact.fileName,
      manifestSha256: this.manifestSha256!,
      artifactSha256: this.artifact.sha256,
      downloadedBytes: this.artifact.size,
      attempts: this.state?.attempts || 1,
      startedAt: this.state?.startedAt || now,
      updatedAt: now
    }
    this.phase = 'downloaded'
    this.errorMessage = undefined
    this.errorCode = undefined
    this.writeState()
    this.publish()
  }

  private fail(code: string, message: string): void {
    this.phase = 'error'
    this.errorCode = code
    this.errorMessage = boundedText(message, MAX_HANDOFF_ERROR_LENGTH)
    if (this.state) {
      this.state = {
        ...this.state,
        phase: 'error',
        downloadedBytes: this.partialSize(),
        updatedAt: this.nowIso(),
        lastError: this.errorMessage,
        lastErrorCode: code
      }
      this.writeState()
    }
    this.log(`[IdentityHandoff] ${code}: ${this.errorMessage}`)
    this.publish()
  }

  private block(code: string, message: string): void {
    this.phase = 'blocked'
    this.errorCode = code
    this.errorMessage = boundedText(message, MAX_HANDOFF_ERROR_LENGTH)
  }

  private publish(): void {
    const snapshot = this.snapshot()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        this.log(`[IdentityHandoff] listener failed: ${boundedError(error)}`)
      }
    }
  }

  private isSourceIdentity(): boolean {
    return (
      this.currentDistribution.series === 'beta' &&
      this.currentDistribution.appId === BETA_DESKTOP_APP_ID &&
      this.currentVersion === IDENTITY_HANDOFF_SOURCE_VERSION
    )
  }

  private isTargetIdentity(): boolean {
    return (
      this.currentDistribution.series === 'release' &&
      this.currentDistribution.appId === RELEASE_DESKTOP_APP_ID &&
      compareVersions(this.currentVersion, IDENTITY_HANDOFF_TARGET_VERSION) >= 0
    )
  }

  private ensureStateDir(): void {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    chmodSync(this.stateDir, 0o700)
  }

  private readState(): PersistentHandoffState | undefined {
    try {
      assertRegularFileOrMissing(this.statePath)
      if (!existsSync(this.statePath)) return undefined
      const value = JSON.parse(readFileSync(this.statePath, 'utf8'))
      if (isPersistentHandoffState(value)) return value
      this.stateReadError =
        'The identity handoff receipt is malformed. Use the support route before retrying.'
      return undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined
      this.stateReadError = `The identity handoff receipt is unreadable: ${boundedError(error)}`
      this.log(`[IdentityHandoff] ${this.stateReadError}`)
      return undefined
    }
  }

  private writeState(): void {
    if (!this.state) return
    this.ensureStateDir()
    const temporaryPath = `${this.statePath}.tmp-${process.pid}-${randomUUID()}`
    writeFileSync(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx'
    })
    const fd = openSync(temporaryPath, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporaryPath, this.statePath)
    fsyncDirectory(this.stateDir)
  }

  private finalArtifactPath(): string {
    if (!this.artifact) return join(this.stateDir, 'unavailable')
    return join(this.stateDir, this.artifact.fileName)
  }

  private partialArtifactPath(): string {
    return `${this.finalArtifactPath()}.partial`
  }

  private partialSize(): number {
    return safeFileSize(this.partialArtifactPath())
  }

  private verifiedArtifactMatches(filePath: string): boolean {
    if (!this.verifiedArtifact || this.verifiedArtifact.path !== filePath) return false
    try {
      const current = fileFingerprint(filePath)
      return (
        current.size === this.verifiedArtifact.size &&
        current.mtimeMs === this.verifiedArtifact.mtimeMs
      )
    } catch {
      return false
    }
  }

  private cleanupArtifacts(): void {
    if (!this.state) return
    const fileName = safeArtifactFileName(this.state.artifactFileName)
    if (!fileName) return
    rmSync(join(this.stateDir, fileName), { force: true })
    rmSync(join(this.stateDir, `${fileName}.partial`), { force: true })
  }

  private nowIso(): string {
    return this.now().toISOString()
  }
}

export function validateIdentityHandoffManifest(
  value: unknown
): { ok: true; value: IdentityHandoffManifest } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: 'Identity handoff manifest must be an object.' }
  if (value.schemaVersion !== IDENTITY_HANDOFF_SCHEMA_VERSION) {
    return { ok: false, error: 'Identity handoff schema version is unsupported.' }
  }
  if (value.handoffId !== IDENTITY_HANDOFF_ID) {
    return { ok: false, error: 'Identity handoff id is not the frozen v1 route.' }
  }
  if (typeof value.prepared !== 'boolean') {
    return { ok: false, error: 'Identity handoff prepared flag is invalid.' }
  }
  if (
    (value.prepared && !isGitCommit(value.sourceCommit)) ||
    (!value.prepared && value.sourceCommit !== null)
  ) {
    return { ok: false, error: 'Identity handoff source commit is invalid.' }
  }
  if (!isRecord(value.source) || !isRecord(value.target)) {
    return { ok: false, error: 'Identity handoff source/target declarations are invalid.' }
  }
  if (
    value.source.distributionIdentity !== 'beta' ||
    value.source.appId !== BETA_DESKTOP_APP_ID ||
    value.source.version !== IDENTITY_HANDOFF_SOURCE_VERSION ||
    value.source.updateFeedChannel !== 'latest'
  ) {
    return { ok: false, error: 'Identity handoff source declaration drifted.' }
  }
  if (
    value.target.distributionIdentity !== 'release' ||
    value.target.appId !== RELEASE_DESKTOP_APP_ID ||
    value.target.version !== IDENTITY_HANDOFF_TARGET_VERSION ||
    value.target.updateFeedChannel !== 'release'
  ) {
    return { ok: false, error: 'Identity handoff target declaration drifted.' }
  }
  if (!isHttpsUrl(value.supportUrl)) {
    return { ok: false, error: 'Identity handoff support URL must be HTTPS.' }
  }
  if (!isRecord(value.artifacts)) {
    return { ok: false, error: 'Identity handoff artifacts must be an object.' }
  }
  const artifactKeys = Object.keys(value.artifacts)
  if (!value.prepared && artifactKeys.length > 0) {
    return { ok: false, error: 'An unprepared identity handoff cannot carry artifacts.' }
  }
  if (value.prepared) {
    const unexpected = artifactKeys.filter(
      (key) => !EXPECTED_ARTIFACT_KEYS.includes(key as IdentityHandoffArtifactKey)
    )
    const missing = EXPECTED_ARTIFACT_KEYS.filter((key) => !(key in value.artifacts))
    if (unexpected.length > 0 || missing.length > 0) {
      return { ok: false, error: 'Prepared identity handoff artifact inventory is incomplete.' }
    }
  }

  const artifacts: Partial<Record<IdentityHandoffArtifactKey, IdentityHandoffArtifact>> = {}
  for (const key of EXPECTED_ARTIFACT_KEYS) {
    const raw = value.artifacts[key]
    if (raw === undefined) continue
    const parsed = validateArtifact(key, raw)
    if (!parsed.ok) return parsed
    artifacts[key] = parsed.value
  }
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      handoffId: IDENTITY_HANDOFF_ID,
      prepared: value.prepared,
      sourceCommit: value.sourceCommit,
      source: {
        distributionIdentity: 'beta',
        appId: BETA_DESKTOP_APP_ID,
        version: IDENTITY_HANDOFF_SOURCE_VERSION,
        updateFeedChannel: 'latest'
      },
      target: {
        distributionIdentity: 'release',
        appId: RELEASE_DESKTOP_APP_ID,
        version: IDENTITY_HANDOFF_TARGET_VERSION,
        updateFeedChannel: 'release'
      },
      supportUrl: value.supportUrl,
      artifacts
    }
  }
}

export function selectIdentityHandoffArtifact(
  manifest: IdentityHandoffManifest,
  platform: string,
  arch: string
): { key: IdentityHandoffArtifactKey; artifact: IdentityHandoffArtifact } | undefined {
  const key = (
    platform === 'darwin' ? 'darwin-universal' : `${platform}-${arch}`
  ) as IdentityHandoffArtifactKey
  const artifact = manifest.artifacts[key]
  return artifact ? { key, artifact } : undefined
}

export function launchIdentityHandoffInstaller(
  filePath: string,
  artifact: IdentityHandoffArtifact
): IdentityHandoffLaunchResult {
  try {
    if (artifact.launchKind === 'appimage') chmodSync(filePath, 0o700)
    const command = artifact.launchKind === 'dmg' ? '/usr/bin/open' : filePath
    const args = artifact.launchKind === 'dmg' ? [filePath] : []
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      shell: false
    })
    child.on('error', () => undefined)
    child.unref()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: boundedError(error) }
  }
}

function validateArtifact(
  key: IdentityHandoffArtifactKey,
  value: unknown
): { ok: true; value: IdentityHandoffArtifact } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: `Identity handoff artifact ${key} is invalid.` }
  const contract = EXPECTED_ARTIFACT_CONTRACT[key]
  const fileName = safeArtifactFileName(value.fileName)
  const instructions = boundedText(value.instructions, MAX_HANDOFF_INSTRUCTIONS_LENGTH)
  if (
    value.platform !== contract.platform ||
    value.arch !== contract.arch ||
    !fileName ||
    value.fileName !== fileName ||
    fileName !== contract.fileName ||
    !isHttpsUrl(value.url) ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !instructions
  ) {
    return { ok: false, error: `Identity handoff artifact ${key} failed validation.` }
  }
  if (value.launchKind !== contract.launchKind) {
    return { ok: false, error: `Identity handoff artifact ${key} has the wrong launch kind.` }
  }
  const url = new URL(value.url)
  if (
    url.hostname !== 'github.com' ||
    !url.pathname.startsWith('/boggspa/TaskWraith/releases/download/') ||
    url.pathname.split('/').length !== 7 ||
    basename(url.pathname) !== fileName
  ) {
    return { ok: false, error: `Identity handoff artifact ${key} has an untrusted URL.` }
  }
  return {
    ok: true,
    value: {
      platform: value.platform as IdentityHandoffArtifact['platform'],
      arch: value.arch as IdentityHandoffArtifact['arch'],
      fileName,
      url: value.url,
      size: value.size,
      sha256: value.sha256,
      launchKind: value.launchKind as IdentityHandoffLaunchKind,
      instructions
    }
  }
}

function isPersistentHandoffState(value: unknown): value is PersistentHandoffState {
  if (!isRecord(value)) return false
  return (
    value.schemaVersion === 1 &&
    value.handoffId === IDENTITY_HANDOFF_ID &&
    new Set(['ready', 'downloading', 'downloaded', 'awaiting-target', 'complete', 'error']).has(
      String(value.phase)
    ) &&
    value.sourceVersion === IDENTITY_HANDOFF_SOURCE_VERSION &&
    value.targetVersion === IDENTITY_HANDOFF_TARGET_VERSION &&
    EXPECTED_ARTIFACT_KEYS.includes(value.artifactKey as IdentityHandoffArtifactKey) &&
    Boolean(safeArtifactFileName(value.artifactFileName)) &&
    Number.isSafeInteger(value.downloadedBytes) &&
    Number(value.downloadedBytes) >= 0 &&
    Number.isSafeInteger(value.attempts) &&
    Number(value.attempts) >= 0 &&
    isIsoTimestamp(value.startedAt) &&
    isIsoTimestamp(value.updatedAt) &&
    (value.launchedAt === undefined || isIsoTimestamp(value.launchedAt)) &&
    (value.completedAt === undefined || isIsoTimestamp(value.completedAt)) &&
    (value.lastError === undefined || typeof value.lastError === 'string') &&
    (value.lastErrorCode === undefined || typeof value.lastErrorCode === 'string') &&
    typeof value.manifestSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.manifestSha256) &&
    typeof value.artifactSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.artifactSha256)
  )
}

function isPersistentStateForManifest(
  state: PersistentHandoffState,
  manifest: IdentityHandoffManifest,
  artifactKey: IdentityHandoffArtifactKey
): boolean {
  const artifact = manifest.artifacts[artifactKey]
  return Boolean(
    artifact &&
    state.handoffId === manifest.handoffId &&
    state.sourceVersion === manifest.source.version &&
    state.targetVersion === manifest.target.version &&
    state.artifactKey === artifactKey &&
    state.artifactFileName === artifact.fileName &&
    state.manifestSha256 === sha256Json(manifest) &&
    state.artifactSha256 === artifact.sha256
  )
}

async function verifyFile(filePath: string, artifact: IdentityHandoffArtifact): Promise<boolean> {
  assertRegularFileOrMissing(filePath)
  if (!existsSync(filePath) || safeFileSize(filePath) !== artifact.size) return false
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex') === artifact.sha256
}

function assertRegularFileOrMissing(filePath: string): void {
  try {
    const stat = lstatSync(filePath)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('Identity handoff artifact path is not a regular file.')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return
    throw error
  }
}

function fileFingerprint(filePath: string): { path: string; size: number; mtimeMs: number } {
  const stat = statSync(filePath)
  return { path: filePath, size: stat.size, mtimeMs: stat.mtimeMs }
}

function safeFileSize(filePath: string): number {
  try {
    const stat = lstatSync(filePath)
    return stat.isFile() && !stat.isSymbolicLink() ? stat.size : 0
  } catch {
    return 0
  }
}

function safeArtifactFileName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed !== basename(trimmed) || /[\\/\0]/.test(trimmed)) return undefined
  return trimmed
}

function assertSecureResponseUrl(value: string): void {
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new Error('Release installer redirected outside HTTPS.')
}

function assertContentRange(value: string | null, offset: number, total: number): void {
  const match = value?.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i)
  if (!match || Number(match[1]) !== offset || Number(match[3]) !== total) {
    throw new Error('Release installer resume response did not match the frozen artifact.')
  }
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}

function isGitCommit(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value)
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 20 &&
    value.length <= 40 &&
    Number.isFinite(Date.parse(value))
  )
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  if (
    a.some((part) => !Number.isSafeInteger(part)) ||
    b.some((part) => !Number.isSafeInteger(part))
  ) {
    return -1
  }
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0)
    if (delta !== 0) return delta > 0 ? 1 : -1
  }
  return 0
}

function boundedText(value: unknown, limit: number): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, limit)
}

function boundedError(error: unknown): string {
  return boundedText(
    error instanceof Error ? error.message : String(error),
    MAX_HANDOFF_ERROR_LENGTH
  )
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function fsyncDirectory(directoryPath: string): void {
  let fd: number | undefined
  try {
    fd = openSync(directoryPath, 'r')
    fsyncSync(fd)
  } catch {
    // Windows and some network filesystems do not permit opening a directory
    // handle. The file itself was already fsynced before its atomic rename.
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
