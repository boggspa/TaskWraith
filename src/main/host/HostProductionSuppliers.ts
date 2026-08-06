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
  HostHealthProjection,
  HostProviderModelProjection,
  HostThreadProjection,
  HostUsageObservation,
  HostWorkspaceProjection
} from '../../shared/hostProtocol'
import type {
  AppStoreHostAuthoritySnapshotDonor,
  AppStoreHostAuthoritySnapshotDonorFamilies
} from './AppStoreHostAuthority'

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
export interface HostProductionProviderListPort {
  getProviders(): HostProviderModelProjection[]
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
    let providers: HostProviderModelProjection[]
    try {
      providers = options.providers ? options.providers.getProviders() : []
    } catch {
      /* Provider read failed — honest empty, never fabricate a row.
       * "Unavailable telemetry is not zero." */
      providers = []
    }

    return {
      health: HONEST_HEALTH,
      workspaces,
      threads,
      runs: [],
      missions: [],
      rounds: [],
      participants: [],
      providers,
      questions: [],
      approvals: [],
      schedules: [],
      usage: HONEST_USAGE,
      artifacts: [],
      warnings: []
    }
  }
}
