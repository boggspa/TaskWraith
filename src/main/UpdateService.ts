import {
  autoUpdater,
  type UpdateCheckResult,
  type UpdateInfo,
  type ProgressInfo
} from 'electron-updater'
import type {
  ProductUpdateChannel,
  ProductUpdateReleaseNoteInfo,
  ProductUpdateReleaseNotes
} from './store/types'
import {
  evaluateUpdateArchitectureCompatibility,
  windowsUpdateChannelForHost,
  type UpdateArchitectureCompatibility
} from './UpdateArchitecture'
import type { IdentityHandoffService, IdentityHandoffSnapshot } from './IdentityHandoffService'

/**
 * UpdateService — Phase G2 wrapper around `electron-updater`.
 *
 * Bridges the `updateChannel` user setting (debug / stable / nightly)
 * to electron-updater's channel concept, and exposes a small event
 * surface the renderer can subscribe to via IPC.
 *
 * Default OFF. The service does nothing until `configure()` is called
 * with a non-null channel. The IPC handler in `index.ts` only enables
 * it when:
 *   - The app is packaged (`app.isPackaged`)
 *   - `TASKWRAITH_AUTO_UPDATE` env is unset OR set to `'on'`
 *     (the negative path: `TASKWRAITH_AUTO_UPDATE=off` forces it
 *     disabled even in production builds — useful for staging)
 *
 * This lets dev runs (`npm run dev` → not packaged) and tests skip
 * the auto-update behavior entirely without per-environment
 * conditionals scattered everywhere.
 *
 * Channel mapping:
 *   debug   → no auto-updates (treated as disabled)
 *   stable  → `latest` channel (default electron-updater behavior)
 *   nightly → `beta` channel (electron-builder writes a beta
 *             manifest when version contains a pre-release tag)
 *
 * Failure model:
 *   - All electron-updater errors are caught and emitted as
 *     `update-error` events; nothing throws into the caller.
 *   - When disabled, every method is a no-op that returns a stub.
 */

export interface UpdateServiceEvents {
  'update-status-changed': (status: UpdateStatus) => void
  'update-available': (info: UpdateInfo) => void
  'update-not-available': () => void
  'update-error': (message: string) => void
  'update-download-progress': (progress: ProgressInfo) => void
  'update-downloaded': (info: UpdateInfo) => void
}

/** Background poll interval when auto-update is enabled (packaged builds). */
export const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000

export type UpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateStateSnapshot {
  status: UpdateStatus
  enabled: boolean
  channel: ProductUpdateChannel
  latestVersion?: string
  releaseName?: string
  releaseDate?: string
  releaseNotes?: ProductUpdateReleaseNotes
  releasePageUrl?: string
  updateArchitecture?: UpdateArchitectureCompatibility
  downloadProgress?: ProgressInfo
  errorMessage?: string
  /** When the last manual or automatic check was attempted. ISO. */
  lastCheckedAt?: string
  /** A user requested restart once the app has no live work. */
  restartPending?: boolean
  /**
   * Present only for the explicit 1.9.9 → 0.1.0 app-identity bridge. The
   * ordinary updater never compares those versions; the signed beta build
   * carries a hash-pinned installer inventory instead.
   */
  identityHandoff?: IdentityHandoffSnapshot
}

type Listener = (snapshot: UpdateStateSnapshot) => void

export interface AutoUpdateEnableInput {
  autoUpdateEnabled?: boolean
  isPackaged: boolean
  envOverride?: string
}

export function resolveAutoUpdateServiceEnabled(input: AutoUpdateEnableInput): boolean {
  if (input.autoUpdateEnabled === false) return false
  if (input.envOverride === 'off') return false
  if (input.envOverride === 'on') return true
  return input.isPackaged
}

export class UpdateService {
  private channel: ProductUpdateChannel = 'debug'
  private status: UpdateStatus = 'disabled'
  private latestVersion: string | undefined
  private releaseName: string | undefined
  private releaseDate: string | undefined
  private releaseNotes: ProductUpdateReleaseNotes | undefined
  private releasePageUrl: string | undefined
  private updateArchitecture: UpdateArchitectureCompatibility | undefined
  private downloadProgress: ProgressInfo | undefined
  private errorMessage: string | undefined
  private lastCheckedAt: string | undefined
  private restartPending = false
  private listeners = new Set<Listener>()
  private wired = false
  private periodicCheckTimer: ReturnType<typeof setInterval> | null = null
  private log: (line: string) => void
  private hostPlatform: string
  private hostArch: string
  private stableUpdateChannel: 'latest' | 'release'
  private identityHandoff?: Pick<
    IdentityHandoffService,
    'snapshot' | 'subscribe' | 'download' | 'retry' | 'launch'
  >
  private identityHandoffActive = false

  constructor(
    options: {
      log?: (line: string) => void
      platform?: string
      arch?: string
      stableUpdateChannel?: 'latest' | 'release'
      identityHandoff?: Pick<
        IdentityHandoffService,
        'snapshot' | 'subscribe' | 'download' | 'retry' | 'launch'
      >
    } = {}
  ) {
    this.log = options.log ?? (() => {})
    this.hostPlatform = options.platform || process.platform
    this.hostArch = options.arch || process.arch
    this.stableUpdateChannel = options.stableUpdateChannel || 'latest'
    this.identityHandoff = options.identityHandoff
    this.identityHandoff?.subscribe((snapshot) => {
      if (!this.identityHandoffActive) return
      this.applyIdentityHandoffSnapshot(snapshot)
      this.publish()
    })
  }

  /**
   * Configure the service for a given channel + enable/disable state.
   * Called on app startup (after settings load) and whenever the user
   * changes the channel in Settings. Re-calls are idempotent — the
   * underlying autoUpdater is configured once + reconfigured on
   * channel changes.
   *
   * `enabled=false` puts the service in `disabled` status. The user
   * can still inspect the snapshot but no checks will run.
   */
  configure(args: { channel: ProductUpdateChannel; enabled: boolean }): void {
    const configuredChannel =
      this.stableUpdateChannel === 'release' && args.channel === 'nightly' ? 'stable' : args.channel
    this.channel = configuredChannel
    const identityHandoff = this.identityHandoff?.snapshot()
    // The final beta's handoff is an explicit, user-triggered product journey,
    // not a background update check. Keep it visible even when automatic
    // checks are disabled; it never downloads or opens anything until the user
    // acts. Debug builds remain outside the distributed handoff.
    if (configuredChannel !== 'debug' && identityHandoff?.active) {
      this.identityHandoffActive = true
      autoUpdater.autoDownload = false
      autoUpdater.autoInstallOnAppQuit = false
      this.stopPeriodicChecks()
      this.applyIdentityHandoffSnapshot(identityHandoff)
      this.publish()
      return
    }
    this.identityHandoffActive = false
    if (!args.enabled || configuredChannel === 'debug') {
      this.status = 'disabled'
      autoUpdater.autoDownload = false
      autoUpdater.autoInstallOnAppQuit = false
      this.downloadProgress = undefined
      this.errorMessage = undefined
      this.restartPending = false
      this.clearReleaseMetadata()
      this.stopPeriodicChecks()
      this.publish()
      return
    }
    if (!this.wired) {
      this.wireAutoUpdater()
      this.wired = true
    }
    // electron-updater channels: macOS keeps the standard latest/beta
    // manifests. Windows uses arch-specific feeds because separate x64
    // and arm64 NSIS installers cannot safely share one latest.yml.
    autoUpdater.channel =
      this.hostPlatform === 'win32'
        ? windowsUpdateChannelForHost(configuredChannel, this.hostArch, this.stableUpdateChannel)
        : configuredChannel === 'nightly'
          ? 'beta'
          : this.stableUpdateChannel
    // The enabled preference permits automatic *checks*, not background
    // downloads. Once an update is found, the user must explicitly choose to
    // download it from the masthead or Settings; this also prevents a routine
    // app quit from installing an update the user has not requested.
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    this.status = 'idle'
    this.downloadProgress = undefined
    this.errorMessage = undefined
    this.restartPending = false
    this.clearReleaseMetadata()
    this.startPeriodicChecks()
    this.publish()
  }

  /** Trigger a check immediately. Surfaces result via events. */
  async checkForUpdates(): Promise<UpdateCheckResult | null> {
    if (this.identityHandoffActive && this.identityHandoff) {
      this.lastCheckedAt = new Date().toISOString()
      const phase = this.identityHandoff.snapshot().phase
      if (phase === 'error') await this.identityHandoff.retry()
      return null
    }
    if (this.status === 'disabled') {
      return null
    }
    this.status = 'checking'
    this.lastCheckedAt = new Date().toISOString()
    this.errorMessage = undefined
    this.downloadProgress = undefined
    this.clearReleaseMetadata()
    this.publish()
    try {
      const result = await autoUpdater.checkForUpdates()
      // The actual status transition (available / not-available) is
      // driven by the autoUpdater event listeners below; this method
      // returns the raw result for callers that want it.
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.handleError(message)
      return null
    }
  }

  /** Start downloading the staged update. Only valid when status is
   * `'available'`. */
  async downloadUpdate(): Promise<void> {
    if (this.identityHandoffActive && this.identityHandoff) {
      await this.identityHandoff.download()
      return
    }
    if (this.status !== 'available') return
    if (this.updateArchitecture && !this.updateArchitecture.compatible) return
    this.status = 'downloading'
    this.publish()
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      this.handleError(err instanceof Error ? err.message : String(err))
    }
  }

  /** Mark the downloaded update to install on quit. Doesn't quit the
   * app — the renderer should prompt the user, and the user's quit
   * action triggers the install. */
  installOnQuit(): void {
    if (this.identityHandoffActive) return
    if (this.status !== 'downloaded') return
    autoUpdater.autoInstallOnAppQuit = true
  }

  /** Immediate install + restart. The renderer should confirm with the
   * user before invoking this. */
  quitAndInstall(): boolean {
    if (this.identityHandoffActive && this.identityHandoff) {
      return this.identityHandoff.launch()
    }
    if (this.status !== 'downloaded') return false
    autoUpdater.autoRunAppAfterInstall = true
    try {
      autoUpdater.quitAndInstall(false, true)
      return this.status === 'downloaded'
    } catch (err) {
      this.handleError(err instanceof Error ? err.message : String(err))
      return false
    }
  }

  /** Reflect that a user-requested update will restart once live work ends. */
  setRestartPending(pending: boolean): void {
    const next = pending && this.status === 'downloaded'
    if (this.restartPending === next) return
    this.restartPending = next
    this.publish()
  }

  snapshot(): UpdateStateSnapshot {
    return {
      status: this.status,
      enabled: this.status !== 'disabled',
      channel: this.channel,
      latestVersion: this.latestVersion,
      releaseName: this.releaseName,
      releaseDate: this.releaseDate,
      releaseNotes: this.releaseNotes,
      releasePageUrl: this.releasePageUrl,
      updateArchitecture: this.updateArchitecture,
      downloadProgress: this.downloadProgress,
      errorMessage: this.errorMessage,
      lastCheckedAt: this.lastCheckedAt,
      restartPending: this.restartPending,
      ...(this.identityHandoffActive && this.identityHandoff
        ? { identityHandoff: this.identityHandoff.snapshot() }
        : {})
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private wireAutoUpdater(): void {
    autoUpdater.logger = {
      info: (msg) => this.log(`[autoUpdater] info: ${msg}`),
      warn: (msg) => this.log(`[autoUpdater] warn: ${msg}`),
      error: (msg) => this.log(`[autoUpdater] error: ${msg}`),
      debug: () => undefined
    }
    autoUpdater.on('checking-for-update', () => {
      if (this.status === 'disabled') return
      this.status = 'checking'
      this.publish()
    })
    autoUpdater.on('update-available', (info) => {
      if (this.status === 'disabled') return
      const compatibility = this.applyUpdateInfo(info)
      if (!compatibility.compatible) {
        this.handleError(compatibility.reason || 'Incompatible update artifact.')
        return
      }
      this.status = 'available'
      this.publish()
    })
    autoUpdater.on('update-not-available', () => {
      if (this.status === 'disabled') return
      this.status = 'not-available'
      this.clearReleaseMetadata()
      this.publish()
    })
    autoUpdater.on('error', (err) => {
      if (this.status === 'disabled') return
      this.handleError(err instanceof Error ? err.message : String(err))
    })
    autoUpdater.on('download-progress', (progress) => {
      if (this.status === 'disabled') return
      this.status = 'downloading'
      this.downloadProgress = progress
      this.publish()
    })
    autoUpdater.on('update-downloaded', (info) => {
      if (this.status === 'disabled') return
      const compatibility = this.applyUpdateInfo(info)
      if (!compatibility.compatible) {
        this.downloadProgress = undefined
        this.handleError(compatibility.reason || 'Incompatible update artifact.')
        return
      }
      this.status = 'downloaded'
      this.downloadProgress = undefined
      this.publish()
    })
  }

  private applyUpdateInfo(info: UpdateInfo): UpdateArchitectureCompatibility {
    this.latestVersion = info.version
    this.releaseName = info.releaseName || undefined
    this.releaseDate = info.releaseDate || undefined
    this.releaseNotes = normalizeReleaseNotes(info.releaseNotes)
    this.releasePageUrl = info.version
      ? `https://github.com/boggspa/TaskWraith/releases/tag/v${info.version}`
      : undefined
    this.updateArchitecture = evaluateUpdateArchitectureCompatibility(info, {
      platform: this.hostPlatform,
      arch: this.hostArch
    })
    return this.updateArchitecture
  }

  private applyIdentityHandoffSnapshot(snapshot: IdentityHandoffSnapshot): void {
    this.latestVersion = snapshot.targetVersion
    this.releaseName = 'TaskWraith Release'
    this.releaseDate = undefined
    this.releaseNotes =
      'Move this beta installation to the public TaskWraith Release identity. Your existing TaskWraith profile stays in place; the installer and target identity are verified before the beta app exits.'
    this.releasePageUrl = snapshot.supportUrl
    this.updateArchitecture = undefined
    this.downloadProgress =
      snapshot.phase === 'downloading' && snapshot.totalBytes !== undefined
        ? {
            bytesPerSecond: 0,
            delta: 0,
            percent: snapshot.percent || 0,
            transferred: snapshot.downloadedBytes || 0,
            total: snapshot.totalBytes
          }
        : undefined
    this.errorMessage = snapshot.errorMessage
    this.restartPending = false
    switch (snapshot.phase) {
      case 'ready':
        this.status = 'available'
        break
      case 'downloading':
        this.status = 'downloading'
        break
      case 'downloaded':
      case 'awaiting-target':
        this.status = 'downloaded'
        break
      case 'error':
      case 'blocked':
        this.status = 'error'
        break
      case 'complete':
        this.status = 'not-available'
        break
      case 'inactive':
      default:
        this.status = 'idle'
        break
    }
  }

  private clearReleaseMetadata(): void {
    this.latestVersion = undefined
    this.releaseName = undefined
    this.releaseDate = undefined
    this.releaseNotes = undefined
    this.releasePageUrl = undefined
    this.updateArchitecture = undefined
  }

  private handleError(message: string): void {
    this.status = 'error'
    this.errorMessage = message
    this.log(`[UpdateService] error: ${message}`)
    this.publish()
  }

  private startPeriodicChecks(): void {
    this.stopPeriodicChecks()
    this.periodicCheckTimer = setInterval(() => {
      // Preserve an actionable update. Rechecking clears its metadata and can
      // also make a deferred restart coordinator discard the user's request.
      if (
        this.status === 'disabled' ||
        this.status === 'checking' ||
        this.status === 'available' ||
        this.status === 'downloading' ||
        this.status === 'downloaded'
      ) {
        return
      }
      void this.checkForUpdates()
    }, UPDATE_CHECK_INTERVAL_MS)
  }

  private stopPeriodicChecks(): void {
    if (this.periodicCheckTimer) {
      clearInterval(this.periodicCheckTimer)
      this.periodicCheckTimer = null
    }
  }

  private publish(): void {
    const snap = this.snapshot()
    for (const listener of this.listeners) {
      try {
        listener(snap)
      } catch (err) {
        // Don't let a single bad listener break the rest.
        this.log(
          `[UpdateService] listener threw: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }
}

function normalizeReleaseNotes(
  notes: UpdateInfo['releaseNotes']
): ProductUpdateReleaseNotes | undefined {
  if (typeof notes === 'string') return notes
  if (!Array.isArray(notes)) return undefined
  const normalized = notes
    .map((note): ProductUpdateReleaseNoteInfo | null => {
      if (!note || typeof note.version !== 'string' || !note.version.trim()) {
        return null
      }
      return {
        version: note.version.trim(),
        note: typeof note.note === 'string' ? note.note : null
      }
    })
    .filter((note): note is ProductUpdateReleaseNoteInfo => note !== null)
  return normalized.length > 0 ? normalized : undefined
}
