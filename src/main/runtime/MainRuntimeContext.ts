import type { BrowserWindow, WebContents } from 'electron'
import type { ApprovalService } from '../services/ApprovalService'
import type { ComposerService } from '../services/ComposerService'
import type { EnsembleOrchestrator } from '../services/EnsembleOrchestrator'
import type { RunCoordinator } from '../services/RunCoordinator'
import type { RunQueueService } from '../services/RunQueueService'
import type { RunLifecycleCoordinator } from '../services/RunLifecycleCoordinator'
import type { RunRepository } from '../RunRepository'
import type { SettingsService } from '../services/SettingsService'
import type { WakeupTimerService } from '../WakeupTimerService'
import type { SessionCheckpointStore } from '../checkpoints/SessionCheckpoint'
import type { AuditOrchestrator } from '../audit/AuditOrchestrator'
import type { CreativeApprovalGate } from '../CreativeApprovalGate'
import type { PluginHost } from '../plugins/PluginHost'
import type { PluginContributionManager } from '../plugins/PluginContributionManager'
import type { LocalServersService } from '../LocalServersService'
import type { BridgeBroadcaster } from '../BridgeBroadcaster'
import type { BridgeDaemonClient } from '../BridgeDaemonClient'
import type { BridgeApnsTokenStore } from '../BridgeApnsTokenStore'
import type { RemoteGitSnapshotFeed } from '../services/RemoteGitSnapshotFeed'
import type { TranscriptMediaAssetStore } from '../services/TranscriptMediaAssetStore'

/**
 * MainRuntimeContext — typed seam for late-bound main-process roots.
 *
 * Ownership rules (mirrors the landed humanCollaborationHandlers precedent):
 * - Registrars NEVER take the whole context. They receive narrow XxxHandlerDeps
 *   built from context fields at the composition site in index.ts.
 * - TWO getter flavours:
 *   (1) getX(): X | null  — for lifecycle-nullable roots (window, bridge, daemon).
 *   (2) requireX(): X      — for Tier-B assign-once services; throws a named
 *       error if called before init.
 *
 * Domain groups keep this from flattening into a 68-field bag:
 *   windows  — window lifecycle (nullable)
 *   runtime  — run dispatch & coordination (requireX + lazy non-null getter)
 *   services — settings, approval, composer, ensemble, etc. (requireX)
 *   remote   — bridge / daemon / git snapshot (nullable)
 *
 * This file is a SCAFFOLD — interface + factory skeleton + ownership comments.
 * Zero wiring into index.ts until the M0 ownership-map slice lands.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Windows (Tier A — lifecycle nullable)
// ─────────────────────────────────────────────────────────────────────────────

export interface MainWindowAccess {
  /** The primary BrowserWindow, or null before creation / after 'closed'. */
  getMainWindow: () => BrowserWindow | null
}

export interface RendererSend {
  /** Send a payload to the main window's renderer process. No-op if window is null. */
  sendToRenderer: (channel: string, payload: unknown) => void
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime (Tier B — assign-once inside whenReady; requireX throws pre-init)
// ─────────────────────────────────────────────────────────────────────────────

export interface RunDispatch {
  /** Centralised run dispatch. Throws if called before whenReady assignment. */
  dispatchRun: (payload: unknown, event?: { sender: WebContents }) => Promise<void>
}

export interface RunCoordination {
  requireRunCoordinator: () => RunCoordinator
  requireRunQueue: () => RunQueueService
  requireRunLifecycle: () => RunLifecycleCoordinator
  /** Lazy singleton — always constructs on first access, never throws pre-init. */
  getRunRepository: () => RunRepository
}

// ─────────────────────────────────────────────────────────────────────────────
// Services (Tier B — assign-once inside whenReady; requireX throws pre-init)
// ─────────────────────────────────────────────────────────────────────────────

export interface CoreServices {
  requireSettings: () => SettingsService
  requireApprovalService: () => ApprovalService
  requireComposerService: () => ComposerService
  requireEnsembleOrchestrator: () => EnsembleOrchestrator
  requireWakeupTimers: () => WakeupTimerService
  requireSessionCheckpoints: () => SessionCheckpointStore
  /** Nullable flavour — for consumers with deliberate graceful-null handling (does NOT throw). */
  getSessionCheckpoints: () => SessionCheckpointStore | null
  requireAuditOrchestrator: () => AuditOrchestrator
  /** Nullable flavour — for consumers with deliberate defensive null-handling (does NOT throw). */
  getAuditOrchestrator: () => AuditOrchestrator | null
  requireCreativeApprovalGate: () => CreativeApprovalGate
  requirePluginHost: () => PluginHost
  requirePluginContributions: () => PluginContributionManager
  requireLocalServers: () => LocalServersService
  /** Tier B — assign-once whenReady (L1736 in index.ts). */
  requireApnsTokenStore: () => BridgeApnsTokenStore
}

// ─────────────────────────────────────────────────────────────────────────────
// Remote (Tier C — connection-lifecycle mutables; nullable getters only)
// ─────────────────────────────────────────────────────────────────────────────

export interface RemoteBridgeAccess {
  getBridgeBroadcaster: () => BridgeBroadcaster | null
  getBridgeDaemon: () => BridgeDaemonClient | null
  getGitSnapshotFeed: () => RemoteGitSnapshotFeed | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier E — lazy singletons (wrap existing getters; always-constructs on first access)
// ─────────────────────────────────────────────────────────────────────────────

export interface LazySingletons {
  /** Lazy singleton — always constructs on first access, never throws pre-init. */
  getTranscriptMediaAssetStore: () => TranscriptMediaAssetStore
}

// ─────────────────────────────────────────────────────────────────────────────
// Context composition
// ─────────────────────────────────────────────────────────────────────────────

export interface MainRuntimeContext
  extends MainWindowAccess,
    RendererSend,
    RunDispatch,
    RunCoordination,
    CoreServices,
    RemoteBridgeAccess,
    LazySingletons {}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

class NotInitializedError extends Error {
  constructor(public readonly serviceName: string) {
    super(`MainRuntimeContext: ${serviceName} has not been initialized yet`)
    this.name = 'NotInitializedError'
  }
}

function requireOrThrow<T>(getValue: () => T | null | undefined, name: string): T {
  const value = getValue()
  if (value == null) {
    throw new NotInitializedError(name)
  }
  return value
}

/**
 * Build a MainRuntimeContext from individually-injected getter closures.
 *
 * All getters are captured at call time; the factory does NOT re-evaluate closures.
 * This is intentional: index.ts will call createMainRuntimeContext once, late,
 * after all Tier-B services have been assigned.
 *
 * @param opts.windows — live nullable window getter
 * @param opts.runtime — run-dispatch closure + service getters
 * @param opts.services — service getters
 * @param opts.remote — nullable remote getters
 * @param opts.lazy — lazy singleton factories (always-constructs)
 */
export function createMainRuntimeContext(opts: {
  windows: {
    getMainWindow: () => BrowserWindow | null
    sendToRenderer: (channel: string, payload: unknown) => void
  }
  runtime: {
    dispatchRun: (payload: unknown, event?: { sender: WebContents }) => Promise<void>
    getRunCoordinator: () => RunCoordinator | null
    getRunQueue: () => RunQueueService | null
    getRunLifecycle: () => RunLifecycleCoordinator | null
    getRunRepository: () => RunRepository
  }
  services: {
    getSettings: () => SettingsService | null
    getApprovalService: () => ApprovalService | null
    getComposerService: () => ComposerService | null
    getEnsembleOrchestrator: () => EnsembleOrchestrator | null
    getWakeupTimers: () => WakeupTimerService | null
    getSessionCheckpoints: () => SessionCheckpointStore | null
    getAuditOrchestrator: () => AuditOrchestrator | null
    getCreativeApprovalGate: () => CreativeApprovalGate | null
    getPluginHost: () => PluginHost | null
    getPluginContributions: () => PluginContributionManager | null
    getLocalServers: () => LocalServersService | null
    getApnsTokenStore: () => BridgeApnsTokenStore | null
  }
  remote: {
    getBridgeBroadcaster: () => BridgeBroadcaster | null
    getBridgeDaemon: () => BridgeDaemonClient | null
    getGitSnapshotFeed: () => RemoteGitSnapshotFeed | null
  }
  lazy: {
    getTranscriptMediaAssetStore: () => TranscriptMediaAssetStore
  }
}): MainRuntimeContext {
  const { windows, runtime, services, remote, lazy } = opts

  return {
    // Windows
    getMainWindow: windows.getMainWindow,
    sendToRenderer: windows.sendToRenderer,

    // Runtime
    dispatchRun: runtime.dispatchRun,
    requireRunCoordinator: () => requireOrThrow(runtime.getRunCoordinator, 'RunCoordinator'),
    requireRunQueue: () => requireOrThrow(runtime.getRunQueue, 'RunQueueService'),
    requireRunLifecycle: () => requireOrThrow(runtime.getRunLifecycle, 'RunLifecycleCoordinator'),
    getRunRepository: runtime.getRunRepository,

    // Services
    requireSettings: () => requireOrThrow(services.getSettings, 'SettingsService'),
    requireApprovalService: () => requireOrThrow(services.getApprovalService, 'ApprovalService'),
    requireComposerService: () => requireOrThrow(services.getComposerService, 'ComposerService'),
    requireEnsembleOrchestrator: () =>
      requireOrThrow(services.getEnsembleOrchestrator, 'EnsembleOrchestrator'),
    requireWakeupTimers: () => requireOrThrow(services.getWakeupTimers, 'WakeupTimerService'),
    requireSessionCheckpoints: () =>
      requireOrThrow(services.getSessionCheckpoints, 'SessionCheckpointStore'),
    getSessionCheckpoints: services.getSessionCheckpoints,
    requireAuditOrchestrator: () =>
      requireOrThrow(services.getAuditOrchestrator, 'AuditOrchestrator'),
    getAuditOrchestrator: services.getAuditOrchestrator,
    requireCreativeApprovalGate: () =>
      requireOrThrow(services.getCreativeApprovalGate, 'CreativeApprovalGate'),
    requirePluginHost: () => requireOrThrow(services.getPluginHost, 'PluginHost'),
    requirePluginContributions: () =>
      requireOrThrow(services.getPluginContributions, 'PluginContributionManager'),
    requireLocalServers: () => requireOrThrow(services.getLocalServers, 'LocalServersService'),
    requireApnsTokenStore: () => requireOrThrow(services.getApnsTokenStore, 'BridgeApnsTokenStore'),

    // Remote
    getBridgeBroadcaster: remote.getBridgeBroadcaster,
    getBridgeDaemon: remote.getBridgeDaemon,
    getGitSnapshotFeed: remote.getGitSnapshotFeed,

    // Lazy singletons
    getTranscriptMediaAssetStore: lazy.getTranscriptMediaAssetStore,
  }
}
