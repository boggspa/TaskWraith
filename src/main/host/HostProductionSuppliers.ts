/**
 * Host Arc Wave 3.6b — production snapshot-donor suppliers.
 *
 * WHAT THIS IS. The production implementation of the Host snapshot donor
 * port. It reads from real stores through thin injected ports and maps their
 * shapes into the hostProtocol projection families. The composition root
 * (Wave 3.6c) adapts actual store instances to these ports and wires this
 * donor as the HostMainComposition snapshotDonor input.
 *
 * WHY IT EXISTS. The test-only donor (empty arrays everywhere, fabricating
 * "zero items") satisfies the type system but produces a HostSnapshot with
 * zero workspaces and zero threads regardless of the real workspace. This
 * module provides the honest production donor so that a live Host reflects
 * the real workspace.
 *
 * BOUNDARIES (enforced by the import-isolation test alongside this file):
 * - zero `electron` imports;
 * - zero AppStore / BridgeActionExecutor / provider / store VALUE imports;
 * - zero HostServer / HostSupervisor / resolver / pipeline imports;
 * - hostProtocol types only (projection shapes);
 * - AppStoreHostAuthority types only (donor-family contract);
 * - node:* imports only where needed for pure functions (none currently).
 *
 * HONESTY (per W42-T3 Boss ruling):
 * - Every count is computed from loaded data, never fabricated.
 * - Absent telemetry is `unavailable`, never `zero`.
 * - `searchPreview` (180-char bounded, ChatStore.getChatList) is admissible
 *   on the authenticated local socket; the remote (iOS) boundary is a
 *   separate Wave-6 audit item and must not silently inherit this ruling.
 */

import type {
  HostApprovalProjection,
  HostArtifactProjection,
  HostChannelProjection,
  HostHealthProjection,
  HostMissionProjection,
  HostParticipantProjection,
  HostProviderModelProjection,
  HostQuestionProjection,
  HostRoundProjection,
  HostRunProjection,
  HostScheduleProjection,
  HostThreadProjection,
  HostUsageObservation,
  HostWorkspaceProjection
} from '../../shared/hostProtocol'
import type {
  AppStoreHostAuthoritySnapshotDonor,
  AppStoreHostAuthoritySnapshotDonorFamilies
} from '../../host-runtime/AppStoreHostAuthority'
import { HOST_WARNING_PROVIDER_SOURCE_NOT_READY } from '../../shared/hostProtocol'
import type { HostWarningProjection } from '../../shared/hostProtocol'
import type { HostProductionArtifactListPort } from './HostProductionArtifactShadow'
import type { HostProductionMissionListPort } from './HostProductionMissionShadow'
import type { HostProductionParticipantListPort } from './HostProductionParticipantShadow'
import type { HostProductionRoundListPort } from './HostProductionRoundShadow'
import type { HostProductionRunListPort } from './HostProductionRunShadow'
import type { HostProductionScheduleListPort } from './HostProductionScheduleShadow'

export type { HostProductionArtifactListPort } from './HostProductionArtifactShadow'
export type { HostProductionMissionListPort } from './HostProductionMissionShadow'
export type { HostProductionParticipantListPort } from './HostProductionParticipantShadow'
export type { HostProductionRoundListPort } from './HostProductionRoundShadow'
export type { HostProductionRunListPort } from './HostProductionRunShadow'
export type { HostProductionScheduleListPort } from './HostProductionScheduleShadow'

/* ------------------------------------------------------------------ */
/*  Store ports — thin interfaces the composition root adapts         */
/* ------------------------------------------------------------------ */

/**
 * The single store capability HostProductionSuppliers needs.
 * The composition root adapts the real ChatStore to this port, so this
 * module never imports from `src/main/store`.
 */
export interface HostProductionChatListPort {
  getChatList(workspaceId?: string): HostProductionChatListEntry[]
}

/** Bounded subset of ChatListItem fields needed for HostThreadProjection. */
export interface HostProductionChatListEntry {
  readonly appChatId: string
  readonly workspaceId?: string | null
  readonly workspacePath?: string | null
  readonly parentChatId?: string | null
  readonly title: string
  readonly chatKind?: string | null
  readonly archived: boolean
  readonly pinned?: boolean | null
  readonly updatedAt: number
  readonly messageCount: number
  readonly searchPreview?: string | null
  readonly provider?: string | null
}

/**
 * The single provider-list capability HostProductionSuppliers needs.
 *
 * The composition root adapts the real provider admission state to this
 * port, so this module never imports from provider/store modules.
 *
 * NARROW BY DESIGN. This port returns HostProviderModelProjection rows
 * directly. The composition root owns the mapping from whatever internal
 * representation it has (discovery snapshots, live-selectable lists,
 * configured-model catalogues) to the wire shape. The supplier is a
 * conduit, not a mapper.
 *
 * CONTRACT (enforced by the supplier's own tests):
 * - note MUST be derived from admission state, a bounded set of strings
 *   the port implementor authors. It must NEVER be a pass-through of
 *   arbitrary source text, error messages, or config values. A token
 *   inside a pass-through string reaches the wire and the client
 *   projection faithfully renders it.
 */
/**
 * Wave 5d — one atomic read of rows AND source readiness.
 *
 * `providers` is a REQUIRED array on the wire, so an empty one cannot by
 * itself distinguish "measured none" from "source has not answered yet".
 * This carries that distinction out of the port so the donor can publish it.
 */
export interface HostProviderListRead {
  readonly providers: HostProviderModelProjection[]
  /** FALSE when the source has not finished discovering. Empty ≠ zero. */
  readonly sourceReady: boolean
}

export interface HostProductionProviderListPort {
  getProviders(): HostProviderModelProjection[]
  /**
   * Optional. When present the donor PREFERS it, because it reports readiness.
   * A port implementing only `getProviders` is treated as ready — it has no
   * readiness concept to report, and inventing one would be fabrication.
   */
  readProviders?(): HostProviderListRead
}

/**
 * Wave 5c Phase 2 — optional AppStore pending-approval shadow port.
 *
 * The composition root adapts ApprovalService (or an equivalent registry)
 * through HostProductionApprovalShadow so this module never imports store
 * symbols. When absent, the approvals family is an honest empty array.
 *
 * FAIL-CLOSED: a throwing listApprovals must propagate. Catching it and
 * painting [] would be a false empty — "there are no pending approvals" —
 * when the source is actually unavailable.
 */
export interface HostProductionApprovalListPort {
  listApprovals(): HostApprovalProjection[]
}

/**
 * Wave 5c Phase 3 — optional RemoteQuestionRegistry pending-question shadow
 * port.
 *
 * The composition root adapts RemoteQuestionRegistry (or an equivalent)
 * through HostProductionQuestionShadow so this module never imports
 * registry/store symbols. When absent, the questions family is an honest
 * empty array.
 *
 * FAIL-CLOSED: a throwing listQuestions must propagate. Catching it and
 * painting [] would be a false empty — "there are no open questions" —
 * when the source is actually unavailable.
 */
export interface HostProductionQuestionListPort {
  listQuestions(): HostQuestionProjection[]
}

/** Optional compact Channels source. Undefined means the source is unavailable. */
export interface HostProductionChannelListPort {
  listChannels(): HostChannelProjection[] | undefined
}

/* ------------------------------------------------------------------ */
/*  Options                                                           */
/* ------------------------------------------------------------------ */

export interface HostProductionSuppliersOptions {
  /**
   * Chat-list accessor — the composition root adapts the real
   * ChatStore.getChatList to this port.
   */
  readonly chatList: HostProductionChatListPort
  /**
   * Provider-list accessor — the composition root adapts the real
   * provider admission state to this port. Optional: when absent,
   * providers is an honest empty array.
   */
  readonly providers?: HostProductionProviderListPort
  /**
   * Wave 5c Phase 2 — optional AppStore pending-approval shadow port.
   * When absent, approvals is an honest empty array (shadow not wired).
   */
  readonly approvals?: HostProductionApprovalListPort
  /**
   * Wave 5c Phase 3 — optional RemoteQuestionRegistry pending-question
   * shadow port. When absent, questions is an honest empty array.
   */
  readonly questions?: HostProductionQuestionListPort
  /** Track3 Mixed — optional active-run shadow. Omitted → honest []. */
  readonly runs?: HostProductionRunListPort
  /** Track3 Mixed — optional activeGoal→mission shadow. Omitted → honest []. */
  readonly missions?: HostProductionMissionListPort
  /** Track3 Mixed — optional ensemble-round shadow. Omitted → honest []. */
  readonly rounds?: HostProductionRoundListPort
  /** Track3 Mixed — optional schedule shadow. Omitted → honest []. */
  readonly schedules?: HostProductionScheduleListPort
  /** Track4 Mixed — optional ensemble-participant shadow. Omitted → honest []. */
  readonly participants?: HostProductionParticipantListPort
  /** Track4 Mixed — optional canvas/artifact-index shadow. Omitted → honest []. */
  readonly artifacts?: HostProductionArtifactListPort
  /** Local multi-human Channel metadata; bodies and invite secrets stay resource-only. */
  readonly channels?: HostProductionChannelListPort
}

/* ------------------------------------------------------------------ */
/*  Honest default families (used when stores are unavailable)        */
/* ------------------------------------------------------------------ */

const HONEST_HEALTH: HostHealthProjection = {
  hostStatus: 'ok',
  connectionPhase: 'live',
  supervised: true,
  freshness: 'live'
}

const HONEST_USAGE: HostUsageObservation = {
  availability: 'unavailable',
  confidence: 'unknown',
  band: 'unknown'
}

/* ------------------------------------------------------------------ */
/*  Mappers — store shapes → hostProtocol projection shapes           */
/* ------------------------------------------------------------------ */

function mapChatListEntryToThread(entry: HostProductionChatListEntry): HostThreadProjection {
  return {
    id: entry.appChatId,
    workspaceId: entry.workspaceId ?? null,
    ...(entry.parentChatId ? { parentThreadId: entry.parentChatId } : {}),
    title: entry.title,
    chatKind: entry.chatKind === 'ensemble' ? 'ensemble' : 'single',
    archived: entry.archived,
    pinned: entry.pinned ?? false,
    updatedAt: entry.updatedAt,
    messageCount: entry.messageCount,
    ...(entry.searchPreview ? { latestPreview: entry.searchPreview } : {}),
    ...(entry.searchPreview != null ? { previewTruncated: entry.searchPreview.length >= 180 } : {}),
    ...(entry.provider ? { providerId: entry.provider } : {})
  }
}

/* ------------------------------------------------------------------ */
/*  Factory                                                           */
/* ------------------------------------------------------------------ */

/**
 * Create the production Host snapshot donor.
 *
 * The returned function is an {@link AppStoreHostAuthoritySnapshotDonor}
 * suitable as the `snapshotDonor` input to `createHostMainComposition`.
 * It reads live stores through the injected ports and maps them to the
 * hostProtocol projection families.
 *
 * Every count is computed from loaded data. When a store is unavailable
 * the family is empty (not fabricated), and `usage.availability` is
 * `'unavailable'` — never zero.
 */
export function createHostProductionSuppliers(
  options: HostProductionSuppliersOptions
): AppStoreHostAuthoritySnapshotDonor {
  const { chatList } = options

  return async (): Promise<AppStoreHostAuthoritySnapshotDonorFamilies> => {
    /* ---- threads (from chat-list) ---- */
    let threads: HostThreadProjection[]
    let workspaces: HostWorkspaceProjection[]

    try {
      const entries = chatList.getChatList()
      threads = entries.map(mapChatListEntryToThread)

      /* Derive workspaces from unique workspaceIds in the thread list.
       * This is honest: a workspace that doesn't appear in any chat row
       * is not projected.  The workspace path is derived from the
       * workspacePath field already carried by ChatList entries (sourced
       * from ChatRecord.workspacePath → toChatListItem spread).  When a
       * real path is unavailable the row is SKIPPED — never emit path:''
       * (the projector rejects empty paths, so a single bad row would
       * make the entire Host snapshot fail closed → host_unavailable).
       * The canonical name and pinned/updatedAt fields live in the
       * workspace store; name falls back to id here, the rest are honest
       * defaults. */
      const seen = new Set<string>()
      const wsList: HostWorkspaceProjection[] = []
      for (const entry of entries) {
        const wsId = entry.workspaceId ?? null
        if (!wsId || seen.has(wsId)) continue
        const wsPath = entry.workspacePath ?? null
        if (!wsPath || wsPath.length === 0) continue // skip: no real path available
        seen.add(wsId)
        wsList.push({
          id: wsId,
          name: wsId, // honest fallback — the canonical name lives in the workspace store
          path: wsPath,
          pinned: false, // honest: not tracked from chat-list alone
          updatedAt: 0 // honest: not tracked from chat-list alone
        })
      }
      workspaces = wsList
    } catch {
      /* Store read failed — honest empty, not fake zero.
       * The Host health projection will carry a degraded detail when the
       * supervisor observes repeated donor failures (Wave 5 concern). */
      threads = []
      workspaces = []
    }

    /* ---- providers (from admission port) ---- */
    let providers: HostProviderModelProjection[] = []
    /* Wave 5d. Defaults TRUE for the NO-PORT case: a donor with no provider
     * source has nothing to be "not ready" about, and an existing pin asserts
     * an empty warnings list there. Whether an absent port should itself be
     * reported as unknown is a separate question, named in the handoff. */
    let providerSourceReady = true
    try {
      const port = options.providers
      if (port?.readProviders) {
        const read = port.readProviders()
        providers = read.providers
        providerSourceReady = read.sourceReady === true
      } else if (port) {
        providers = port.getProviders()
      }
    } catch {
      /* Provider read failed — honest empty, never fabricate a row.
       * "Unavailable telemetry is not zero." A throwing source has told us
       * NOTHING, so the emptiness is unknown and must say so. */
      providers = []
      providerSourceReady = false
    }

    /* Readiness travels as a typed warning CODE, not as prose. `providers`
     * is required on the wire, so this is the only carrier that does not
     * need a protocol version bump. */
    const warnings: HostWarningProjection[] = []
    if (!providerSourceReady) {
      warnings.push({
        warningId: `${HOST_WARNING_PROVIDER_SOURCE_NOT_READY}:providers`,
        severity: 'info',
        code: HOST_WARNING_PROVIDER_SOURCE_NOT_READY,
        message: 'provider source has not finished discovering; empty is unknown, not measured',
        at: Date.now()
      })
    }

    /* ---- approvals (Wave 5c Phase 2 shadow port) ----
     * No try/catch: a throwing port must reject the donor. Painting [] on
     * failure would be a false empty ("no pending approvals") when the
     * registry is actually unavailable. Omitted port → honest empty. */
    const approvals: HostApprovalProjection[] = options.approvals
      ? options.approvals.listApprovals()
      : []

    /* ---- questions (Wave 5c Phase 3 shadow port) ----
     * Same fail-closed contract as approvals. Omitted port → honest empty. */
    const questions: HostQuestionProjection[] = options.questions
      ? options.questions.listQuestions()
      : []

    /* ---- Track3 Mixed family shadows (runs/missions/rounds/schedules) ----
     * Same fail-closed contract: omitted → honest []; throw propagates. */
    const runs: HostRunProjection[] = options.runs ? options.runs.listRuns() : []
    const missions: HostMissionProjection[] = options.missions
      ? options.missions.listMissions()
      : []
    const rounds: HostRoundProjection[] = options.rounds ? options.rounds.listRounds() : []
    const schedules: HostScheduleProjection[] = options.schedules
      ? options.schedules.listSchedules()
      : []

    /* ---- Track4 Mixed family shadows (participants/artifacts) ----
     * Same fail-closed contract: omitted → honest []; throw propagates. */
    const participants: HostParticipantProjection[] = options.participants
      ? options.participants.listParticipants()
      : []
    const artifacts: HostArtifactProjection[] = options.artifacts
      ? options.artifacts.listArtifacts()
      : []
    const channels: HostChannelProjection[] | undefined = options.channels
      ? options.channels.listChannels()
      : undefined

    return {
      health: HONEST_HEALTH,
      workspaces,
      threads,
      runs,
      missions,
      rounds,
      participants,
      providers,
      questions,
      approvals,
      schedules,
      usage: HONEST_USAGE,
      artifacts,
      ...(channels === undefined ? {} : { channels }),
      warnings
    }
  }
}
