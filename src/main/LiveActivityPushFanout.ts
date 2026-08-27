/**
 * Keeps a phone's Live Activity honest after it stops being able to talk to us.
 *
 * The phone updates its own activity while it is connected. The moment the
 * relay socket drops — locking the phone is enough — those updates stop, and
 * the card is frozen with a timer still counting. This is the other half: the
 * Mac pushes the same content-state over APNs so the card stays right.
 *
 * It also PUSH-STARTS one (iOS 17.2+) for a run begun while the phone app was
 * not running at all — but only after a grace period. The phone raises its own
 * card the moment it sees the run over the live socket, and the Mac cannot tell
 * whether the app is running; starting immediately would give a connected user
 * two cards for one run. So a start is scheduled, then reconsidered: if the
 * phone registered an update token for that thread in the meantime, it is
 * running and we stand down.
 *
 * The accent hex for a start comes from the map the PHONE shipped with its
 * start token. The Mac has no provider-hex table of its own, and inventing one
 * here would be a third copy of a catalogue that already exists twice.
 *
 * CONTAINMENT: the content-state is NOT encrypted and cannot be — see the block
 * at the top of shared/apns/liveActivityPayload.ts. Everything sent from here
 * goes through `buildLiveActivityContentState`, which is a whitelist.
 */

import {
  buildLiveActivityContentState,
  isTerminalLiveActivityPhase,
  type LiveActivityAttributes,
  type LiveActivityContentState,
  type LiveActivityPhase
} from '../shared/apns/liveActivityPayload'
import type { LiveActivityTokenStore } from './LiveActivityTokenStore'

/** Mirrors `TWRunActivityPlanner.phase(forCardStatus:)` on the phone. The two
 *  must agree or a push would contradict what the device already rendered. */
export function livePhaseForCardStatus(status: string | undefined): LiveActivityPhase | null {
  switch (status) {
    case 'queued':
    case 'running':
      return 'running'
    case 'awaitingApproval':
      return 'awaitingApproval'
    case 'awaitingQuestion':
      return 'awaitingQuestion'
    case 'success':
      return 'complete'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    // 'idle' and anything a newer build invents. Unknown must NOT become
    // 'running' — a status we do not understand is not evidence of work.
    default:
      return null
  }
}

/**
 * Maps ensemble participant lifecycle statuses to existing Live Activity wire phases.
 * Unknown statuses deliberately stay running: the seat remains visible while a
 * newer runtime status is waiting for a compatible mobile projection.
 */
export function participantSeatPhase(status: string | undefined): LiveActivityPhase {
  switch (status) {
    case 'answered':
    case 'yielded':
    case 'sleeping':
    case 'completed':
    case 'done':
      return 'complete'
    case 'unreachable':
    case 'failed':
    case 'error':
      return 'failed'
    case 'skipped':
    case 'cancelled':
      return 'cancelled'
    default:
      return 'running'
  }
}

/** Stable value key for "have we already pushed exactly this?". */
export function contentFingerprint(state: LiveActivityContentState): string {
  return [
    state.phase,
    state.startedAtUnix,
    state.filesChanged,
    state.additions,
    state.deletions,
    state.activeRuns,
    state.ahead,
    state.behind,
    state.hasGitSnapshot ? 1 : 0,
    state.seats.map((s) => `${s.provider}:${s.phase}`).join(',')
  ].join('|')
}

export interface LiveActivityPushSender {
  pushLiveActivityToToken(
    tokenHex: string,
    env: 'production' | 'sandbox',
    payload: {
      event: 'start' | 'update' | 'end'
      contentState: LiveActivityContentState
      collapseId: string
      needsUser: boolean
      staleAtUnix?: number
      dismissAtUnix?: number
      attributes?: LiveActivityAttributes
    }
  ): Promise<{ delivered: boolean; reason?: string }>
}

/** The user's Live Activity settings, read fresh on each push so a change
 *  takes effect without restarting anything. */
export interface LiveActivityAppearanceSource {
  enabled: boolean
  archetype: string
  /** The user's diff palette as 0xRRGGBB. The MAC owns these
   *  (`settings.diffStatColors`) — unlike the provider accents, which only the
   *  phone has a table for. */
  successHex: number
  failureHex: number
}

export interface LiveActivityFanoutDeps {
  store: LiveActivityTokenStore
  sender: () => LiveActivityPushSender | null
  /** Read fresh per push — the master switch must be able to stop traffic
   *  immediately, not at the next restart. */
  appearance: () => LiveActivityAppearanceSource
  /** Unix SECONDS. */
  now?: () => number
  /** Injectable so tests do not wait out the grace period in real time. */
  schedule?: (fn: () => void, ms: number) => { cancel: () => void }
  log?: (line: string) => void
}

export interface WorkspaceLiveActivityInput {
  workspaceId: string
  phase: LiveActivityPhase
  startedAtUnix: number
  activeRuns: number
  filesChanged: number
  additions: number
  deletions: number
  ahead: number
  behind: number
  hasGitSnapshot: boolean
  seats: readonly { provider?: unknown; phase?: unknown }[]
}

/** Mirrors TWRunActivityLimits so a pushed state ages out on the same schedule
 *  the on-device one does. */
export const LIVE_ACTIVITY_STALE_WINDOW_SECONDS = 8 * 60
export const LIVE_ACTIVITY_DISMISS_AFTER_SECONDS = 8 * 60

/**
 * How long to wait before push-STARTING a card the phone has not raised itself.
 *
 * A connected phone sees the run over the live socket and starts its own within
 * a second or two; this is the window in which it can prove it is awake. Too
 * short and a connected user gets two cards for one run; too long and someone
 * whose phone is closed watches nothing happen. 20s errs toward not
 * double-carding, because a duplicate is a bug the user has to clear by hand.
 */
export const LIVE_ACTIVITY_START_GRACE_SECONDS = 20

export class LiveActivityPushFanout {
  private readonly store: LiveActivityTokenStore
  private readonly senderFn: () => LiveActivityPushSender | null
  private readonly appearanceFn: () => LiveActivityAppearanceSource
  private readonly now: () => number
  private readonly scheduleFn: (fn: () => void, ms: number) => { cancel: () => void }
  private readonly log: (line: string) => void
  /** `pairID|subject` -> the pending push-to-start, cancelled the moment the
   *  phone proves it is awake or the run ends. */
  private readonly pendingStarts = new Map<string, { cancel: () => void }>()

  constructor(deps: LiveActivityFanoutDeps) {
    this.store = deps.store
    this.senderFn = deps.sender
    this.appearanceFn = deps.appearance
    this.now = deps.now ?? ((): number => Math.floor(Date.now() / 1000))
    this.scheduleFn =
      deps.schedule ??
      ((fn, ms): { cancel: () => void } => {
        const handle = setTimeout(fn, ms)
        // unref so a pending start never holds the process open at quit.
        handle.unref?.()
        return { cancel: (): void => clearTimeout(handle) }
      })
    this.log = deps.log ?? ((): void => {})
  }

  /**
   * Called for every projected task card. Cheap on the common path: no
   * registration for the thread means one Map miss and out.
   */
  onTaskCard(card: {
    id: string
    status?: string
    runId?: string
    /** Needed only to colour a push-STARTED card; an update reuses whatever
     *  attributes the activity was created with (they are immutable). */
    provider?: string
    isEnsemble?: boolean
    startedAtUnix?: number
    filesChanged?: number
    additions?: number
    deletions?: number
    seats?: readonly { provider?: unknown; phase?: unknown }[]
  }): void {
    if (!this.appearanceFn().enabled) return

    const registrations = this.store.forThread(card.id)
    const phase = livePhaseForCardStatus(card.status)

    // A run with no card anywhere is the push-to-start case. Considered BEFORE
    // the early return below, which only covers threads we already own.
    if (phase && !isTerminalLiveActivityPhase(phase)) {
      this.considerStart(card, phase)
    } else {
      this.cancelPendingStarts(card.id)
    }

    if (registrations.length === 0) return

    if (!phase) {
      // The run went idle or reported something we cannot map. We have no
      // outcome to show, so end the card rather than leave a frozen one up.
      for (const reg of registrations) {
        void this.send(reg, 'end', this.emptyState(card), false)
        this.store.forget(reg.pairID, reg.activityRef)
      }
      return
    }

    const state = buildLiveActivityContentState({
      phase,
      startedAtUnix: card.startedAtUnix ?? this.now(),
      filesChanged: card.filesChanged,
      additions: card.additions,
      deletions: card.deletions,
      seats: card.seats
    })
    const fingerprint = contentFingerprint(state)
    const terminal = isTerminalLiveActivityPhase(phase)
    const needsUser = phase === 'awaitingApproval' || phase === 'awaitingQuestion'

    for (const reg of registrations) {
      // Projection snapshots arrive constantly and mostly change nothing.
      // Pushing an identical state would burn the frequent-update budget for no
      // visible difference.
      if (!this.store.markPushed(reg.pairID, reg.activityRef, fingerprint)) continue
      void this.send(reg, terminal ? 'end' : 'update', state, needsUser)
      if (terminal) this.store.forget(reg.pairID, reg.activityRef)
    }
  }

  /** Update one anonymous workspace summary. `workspaceId` is routing-only and
   *  never survives the content-state whitelist below. */
  onWorkspaceActivity(summary: WorkspaceLiveActivityInput): void {
    if (!this.appearanceFn().enabled) return
    if (summary.activeRuns < 2) {
      this.abandonWorkspace(summary.workspaceId)
      return
    }

    const registrations = this.store.forWorkspace(summary.workspaceId)
    if (!isTerminalLiveActivityPhase(summary.phase)) {
      this.considerWorkspaceStart(summary)
    } else {
      this.cancelPendingWorkspaceStarts(summary.workspaceId)
    }

    if (registrations.length === 0) return
    const state = buildLiveActivityContentState({
      phase: summary.phase,
      startedAtUnix: summary.startedAtUnix,
      filesChanged: summary.filesChanged,
      additions: summary.additions,
      deletions: summary.deletions,
      seats: summary.seats,
      activeRuns: summary.activeRuns,
      ahead: summary.ahead,
      behind: summary.behind,
      hasGitSnapshot: summary.hasGitSnapshot
    })
    const fingerprint = contentFingerprint(state)
    const terminal = isTerminalLiveActivityPhase(summary.phase)
    const needsUser = summary.phase === 'awaitingApproval' || summary.phase === 'awaitingQuestion'
    for (const reg of registrations) {
      if (!this.store.markPushed(reg.pairID, reg.activityRef, fingerprint)) continue
      void this.send(reg, terminal ? 'end' : 'update', state, needsUser)
      if (terminal) this.store.forget(reg.pairID, reg.activityRef)
    }
  }

  /** Tear down a per-run card because its run is now represented by a workspace
   *  summary. This is presentation reconciliation, never cancellation. */
  abandonThread(threadId: string): void {
    this.cancelPendingStarts(threadId)
    for (const reg of this.store.forThread(threadId)) {
      void this.send(reg, 'end', this.emptyState(), false)
      this.store.forget(reg.pairID, reg.activityRef)
    }
  }

  abandonWorkspace(workspaceId: string): void {
    this.cancelPendingWorkspaceStarts(workspaceId)
    for (const reg of this.store.forWorkspace(workspaceId)) {
      void this.send(reg, 'end', this.emptyState(), false)
      this.store.forget(reg.pairID, reg.activityRef)
    }
  }

  /**
   * Schedule a push-to-start for every paired device that could show this run
   * but is not already showing it.
   *
   * Re-checked at FIRE time, not now: the whole point of the delay is to give a
   * connected phone the chance to raise its own card first. Scheduling is also
   * idempotent per (device, thread) — a projection storm must not queue twenty
   * starts for one run.
   */
  private considerStart(
    card: {
      id: string
      provider?: string
      isEnsemble?: boolean
      startedAtUnix?: number
      filesChanged?: number
      additions?: number
      deletions?: number
      seats?: readonly { provider?: unknown; phase?: unknown }[]
    },
    phase: LiveActivityPhase
  ): void {
    for (const reg of this.store.startRegistrations()) {
      if (this.store.hasActivityForThread(reg.pairID, card.id)) continue
      const key = `${reg.pairID}|thread:${card.id}`
      if (this.pendingStarts.has(key)) continue
      const handle = this.scheduleFn(() => {
        this.pendingStarts.delete(key)
        // The phone woke up and raised its own — stand down rather than
        // give the user two cards for one run.
        if (this.store.hasActivityForThread(reg.pairID, card.id)) return
        if (!this.appearanceFn().enabled) return
        void this.sendStart(reg, card, phase)
      }, LIVE_ACTIVITY_START_GRACE_SECONDS * 1000)
      this.pendingStarts.set(key, handle)
    }
  }

  private cancelPendingStarts(threadId: string): void {
    for (const [key, handle] of this.pendingStarts) {
      if (key.endsWith(`|thread:${threadId}`)) {
        handle.cancel()
        this.pendingStarts.delete(key)
      }
    }
  }

  private considerWorkspaceStart(summary: WorkspaceLiveActivityInput): void {
    for (const reg of this.store.startRegistrations()) {
      if (this.store.hasActivityForWorkspace(reg.pairID, summary.workspaceId)) continue
      const key = `${reg.pairID}|workspace:${summary.workspaceId}`
      if (this.pendingStarts.has(key)) continue
      const handle = this.scheduleFn(() => {
        this.pendingStarts.delete(key)
        if (this.store.hasActivityForWorkspace(reg.pairID, summary.workspaceId)) return
        if (!this.appearanceFn().enabled) return
        void this.sendWorkspaceStart(reg, summary)
      }, LIVE_ACTIVITY_START_GRACE_SECONDS * 1000)
      this.pendingStarts.set(key, handle)
    }
  }

  private cancelPendingWorkspaceStarts(workspaceId: string): void {
    for (const [key, handle] of this.pendingStarts) {
      if (key.endsWith(`|workspace:${workspaceId}`)) {
        handle.cancel()
        this.pendingStarts.delete(key)
      }
    }
  }

  private async sendStart(
    reg: {
      pairID: string
      token: string
      env: 'production' | 'sandbox'
      providerAccents: Record<string, number>
    },
    card: {
      id: string
      provider?: string
      isEnsemble?: boolean
      startedAtUnix?: number
      filesChanged?: number
      additions?: number
      deletions?: number
      seats?: readonly { provider?: unknown; phase?: unknown }[]
    },
    phase: LiveActivityPhase
  ): Promise<void> {
    const sender = this.senderFn()
    if (!sender) return
    const appearance = this.appearanceFn()
    const provider = card.isEnsemble ? 'ensemble' : card.provider || 'codex'
    const now = this.now()
    // The ref is generated HERE and is opaque — never the threadId, which would
    // hand APNs (and later the relay) a stable key linking a card to a chat.
    const activityRef = `s${now.toString(36)}${Math.random().toString(36).slice(2, 10)}`
    const attributes: LiveActivityAttributes = {
      provider,
      // An ensemble chat forces the ensemble layout: the other three have
      // nowhere to put per-seat state. Same rule the phone applies.
      archetype: card.isEnsemble ? 'ensemble' : appearance.archetype,
      palette: {
        // Unknown provider ⇒ the app's default accent rather than black. A map
        // from an older phone build simply will not have a brand added since.
        accent: reg.providerAccents[provider] ?? 0x5a8cff,
        success: appearance.successHex,
        failure: appearance.failureHex,
        attention: 0xf5a623
      },
      activityRef
    }
    const result = await sender.pushLiveActivityToToken(reg.token, reg.env, {
      event: 'start',
      contentState: buildLiveActivityContentState({
        phase,
        startedAtUnix: card.startedAtUnix ?? now,
        filesChanged: card.filesChanged,
        additions: card.additions,
        deletions: card.deletions,
        seats: card.seats
      }),
      collapseId: activityRef,
      needsUser: phase === 'awaitingApproval' || phase === 'awaitingQuestion',
      staleAtUnix: now + LIVE_ACTIVITY_STALE_WINDOW_SECONDS,
      attributes
    })
    if (!result.delivered) {
      this.log(`[LiveActivityPushFanout] start failed: ${result.reason ?? 'unknown'}`)
      return
    }
    // Register it against ourselves so subsequent projections UPDATE this card
    // rather than starting another. The phone will replace this entry with a
    // real per-activity token the moment the app next runs.
    this.store.register({
      pairID: reg.pairID,
      activityRef,
      token: reg.token,
      env: reg.env,
      threadId: card.id
    })
  }

  private async sendWorkspaceStart(
    reg: {
      pairID: string
      token: string
      env: 'production' | 'sandbox'
      providerAccents: Record<string, number>
    },
    summary: WorkspaceLiveActivityInput
  ): Promise<void> {
    const sender = this.senderFn()
    if (!sender) return
    const appearance = this.appearanceFn()
    const now = this.now()
    const activityRef = `w${now.toString(36)}${Math.random().toString(36).slice(2, 10)}`
    const attributes: LiveActivityAttributes = {
      provider: 'taskwraith',
      archetype: 'workspace',
      palette: {
        accent: reg.providerAccents.taskwraith ?? 0x5a8cff,
        success: appearance.successHex,
        failure: appearance.failureHex,
        attention: 0xf5a623
      },
      activityRef
    }
    const result = await sender.pushLiveActivityToToken(reg.token, reg.env, {
      event: 'start',
      contentState: buildLiveActivityContentState({
        phase: summary.phase,
        startedAtUnix: summary.startedAtUnix,
        filesChanged: summary.filesChanged,
        additions: summary.additions,
        deletions: summary.deletions,
        seats: summary.seats,
        activeRuns: summary.activeRuns,
        ahead: summary.ahead,
        behind: summary.behind,
        hasGitSnapshot: summary.hasGitSnapshot
      }),
      collapseId: activityRef,
      needsUser: summary.phase === 'awaitingApproval' || summary.phase === 'awaitingQuestion',
      staleAtUnix: now + LIVE_ACTIVITY_STALE_WINDOW_SECONDS,
      attributes
    })
    if (!result.delivered) {
      this.log(`[LiveActivityPushFanout] workspace start failed: ${result.reason ?? 'unknown'}`)
      return
    }
    this.store.register({
      pairID: reg.pairID,
      activityRef,
      token: reg.token,
      env: reg.env,
      workspaceId: summary.workspaceId
    })
  }

  private emptyState(_card?: { id: string }): LiveActivityContentState {
    return buildLiveActivityContentState({ phase: 'cancelled', startedAtUnix: this.now() })
  }

  private async send(
    reg: { pairID: string; activityRef: string; token: string; env: 'production' | 'sandbox' },
    event: 'update' | 'end',
    contentState: LiveActivityContentState,
    needsUser: boolean
  ): Promise<void> {
    const sender = this.senderFn()
    if (!sender) return
    const now = this.now()
    const result = await sender.pushLiveActivityToToken(reg.token, reg.env, {
      event,
      contentState,
      collapseId: reg.activityRef,
      needsUser,
      // No stale date on a terminal push: the run is over, so the state cannot
      // go out of date, and greying out an accurate outcome would be wrong.
      staleAtUnix: event === 'end' ? undefined : now + LIVE_ACTIVITY_STALE_WINDOW_SECONDS,
      dismissAtUnix: event === 'end' ? now + LIVE_ACTIVITY_DISMISS_AFTER_SECONDS : undefined
    })
    if (!result.delivered) {
      this.log(
        `[LiveActivityPushFanout] ${event} failed ref=${reg.activityRef}: ${result.reason ?? 'unknown'}`
      )
      // A dead activity token answers 410 Unregistered / BadDeviceToken. Unlike
      // the DEVICE token store we can drop on any failure here: the token is
      // per-activity and worthless once the activity is gone, so there is no
      // live registration to destroy by mistake.
      this.store.forget(reg.pairID, reg.activityRef)
    }
  }
}
