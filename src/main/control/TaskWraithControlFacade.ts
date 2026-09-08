import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type {
  BridgeCancelRunAction,
  BridgeComposerPromptAction,
  BridgeEnsembleCancelRoundAction,
  BridgeEnsembleRosterUpdateAction,
  BridgeEnsembleSteerAction
} from '../BridgeActionPayload'
import type { BridgeActionExecutionResult } from '../BridgeActionExecutor'
import { AppStore } from '../store'
import { getCachedRemoteEnsemblePresets } from '../remote/EnsembleRosterPresetsCache'
import type { ChatRecord, WorkspaceRecord } from '../store/types'
import type {
  TaskWraithControlSnapshot,
  TaskWraithControlThreadOffers,
  TaskWraithControlThreadSnapshot
} from '../../shared/taskWraithControlProtocol'
import {
  clampTaskWraithControlThreadLimit,
  type TaskWraithControlThreadProjection,
  type TaskWraithControlThreadProjectionProvider
} from '../../shared/taskWraithControlProjection'
import { LocalControlServer, type LocalControlServerOptions } from './LocalControlServer'
import {
  activeRun,
  hydrateTaskWraithControlThread,
  hydrateTaskWraithControlThreadSnapshot,
  modelForChat,
  nonEmptyString,
  participantForActiveRound,
  projectTaskWraithControlThread,
  providerForChat,
  reasoningForProvider,
  record,
  taskWraithControlRevisionOf,
  taskWraithControlThreadFactsFromInventoryRow,
  threadProvider,
  type TaskWraithControlInventoryRow
} from './TaskWraithControlProjector'
import {
  resolveTaskWraithThreadOffers,
  validateTaskWraithThreadSelection
} from './TaskWraithThreadOffers'

/**
 * Bounded store reads only: the chat-list projection feeds the 450 ms poll,
 * one record is opened for a user action, and the selected thread's pane
 * comes from `getThreadProjection`. Never the full-history getter.
 */
export interface TaskWraithControlStore {
  getChatList(): TaskWraithControlInventoryRow[]
  getChat(chatId: string): ChatRecord | null
  getWorkspaces(): WorkspaceRecord[]
}

export interface TaskWraithControlFacadeOptions {
  executeComposerPrompt: (
    action: BridgeComposerPromptAction
  ) => Promise<BridgeActionExecutionResult>
  executeCancelRun: (action: BridgeCancelRunAction) => Promise<BridgeActionExecutionResult>
  executeEnsembleSteer: (action: BridgeEnsembleSteerAction) => Promise<BridgeActionExecutionResult>
  executeEnsembleCancelRound: (
    action: BridgeEnsembleCancelRoundAction
  ) => Promise<BridgeActionExecutionResult>
  executeEnsembleRosterUpdate: (
    action: BridgeEnsembleRosterUpdateAction
  ) => Promise<BridgeActionExecutionResult>
  now?: () => number
  /** Defaults to `AppStore`. */
  store?: TaskWraithControlStore
  /**
   * Selected-thread projections, normally answered by the thread-catalogue
   * worker (see src/shared/taskWraithControlProjection.ts). Defaults to an
   * in-process projection of `store.getChat` — one record, bounded rows.
   */
  getThreadProjection?: TaskWraithControlThreadProjectionProvider
}

export interface StartTaskWraithLocalControlOptions extends TaskWraithControlFacadeOptions {
  userDataPath: string
  hostVersion: string
  log?: (line: string) => void
  platform?: NodeJS.Platform
}

function workspaceSummary(workspace: WorkspaceRecord) {
  return {
    id: workspace.id,
    name: workspace.displayName || basename(workspace.path),
    path: workspace.path,
    pinned: workspace.pinned,
    updatedAt: workspace.lastOpenedAt
  }
}

/**
 * What has to move before a cached pane is rebuilt: the catalogue revision,
 * or — on a legacy chat-list row that carries none — the save stamp and the
 * counts that change with it.
 */
function inventoryRowSignature(row: TaskWraithControlInventoryRow): string {
  if (Number.isSafeInteger(row.persistenceRevision)) return `r${row.persistenceRevision}`
  const messages = row.messageCount ?? row.messages?.length ?? 0
  const runs = row.runCount ?? row.runs?.length ?? 0
  return `u${row.updatedAt}:m${messages}:r${runs}`
}

/** The interim provider: the selected record, projected here, bounded by `limit`. */
function inProcessThreadProjection(
  store: TaskWraithControlStore,
  now: () => number
): TaskWraithControlThreadProjectionProvider {
  return async (request) => {
    const chat = store.getChat(request.threadId)
    if (!chat) return { kind: 'missing' }
    const revision = taskWraithControlRevisionOf(chat)
    if (revision > 0 && request.knownRevision === revision) return { kind: 'unchanged', revision }
    return {
      kind: 'projection',
      projection: projectTaskWraithControlThread(chat, request, new Date(now()).toISOString())
    }
  }
}

interface CachedPane {
  limit: number
  rowSignature: string | undefined
  projection: TaskWraithControlThreadProjection
}

export function createTaskWraithControlFacade(options: TaskWraithControlFacadeOptions) {
  const now = options.now ?? (() => Date.now())
  const store: TaskWraithControlStore = options.store ?? AppStore
  const projectThread = options.getThreadProjection ?? inProcessThreadProjection(store, now)
  const presetName = (presetId: string | undefined): string | undefined =>
    presetId
      ? getCachedRemoteEnsemblePresets().find((preset) => preset.id === presetId)?.name
      : undefined
  let sequence = 0
  /** Rows from the latest poll; the selected thread's revision is read from here. */
  let rowsById = new Map<string, TaskWraithControlInventoryRow>()
  const panes = new Map<string, CachedPane>()

  const refreshRows = (): TaskWraithControlInventoryRow[] => {
    const rows = store.getChatList()
    rowsById = new Map(rows.map((row) => [row.appChatId, row]))
    return rows
  }
  const rowFor = (threadId: string): TaskWraithControlInventoryRow | undefined => {
    if (!rowsById.has(threadId)) refreshRows()
    return rowsById.get(threadId)
  }

  const snapshot = (): TaskWraithControlSnapshot => {
    const at = now()
    const rows = refreshRows()
    return {
      generatedAt: new Date(at).toISOString(),
      sequence: ++sequence,
      workspaces: store.getWorkspaces().map(workspaceSummary),
      threads: rows.map((row) =>
        hydrateTaskWraithControlThread(taskWraithControlThreadFactsFromInventoryRow(row), {
          now: at,
          presetName
        })
      )
    }
  }

  const selectThread = async (
    threadId: string,
    limit: number
  ): Promise<TaskWraithControlThreadSnapshot> => {
    const clamped = clampTaskWraithControlThreadLimit(limit)
    const row = rowFor(threadId)
    const signature = row ? inventoryRowSignature(row) : undefined
    const cached = panes.get(threadId)
    const held = cached && cached.limit === clamped ? cached : undefined
    let projection =
      held && signature !== undefined && held.rowSignature === signature
        ? held.projection
        : undefined
    if (!projection) {
      const result = await projectThread({
        threadId,
        limit: clamped,
        ...(held ? { knownRevision: held.projection.revision } : {})
      })
      if (result.kind === 'projection') {
        projection = result.projection
      } else if (result.kind === 'unchanged' && held) {
        projection = held.projection
      } else if (result.kind === 'unchanged') {
        // `unchanged` against a revision this facade never offered: ask for
        // the pane itself before giving up on the thread.
        const again = await projectThread({ threadId, limit: clamped })
        if (again.kind !== 'projection') {
          panes.delete(threadId)
          throw new Error('Thread not found.')
        }
        projection = again.projection
      } else {
        panes.delete(threadId)
        throw new Error('Thread not found.')
      }
      panes.set(threadId, { limit: clamped, rowSignature: signature, projection })
    }
    return hydrateTaskWraithControlThreadSnapshot(projection, {
      now: now(),
      sequence: ++sequence,
      workspaces: store.getWorkspaces(),
      presetName
    })
  }

  const threadOffers = (threadId: string): TaskWraithControlThreadOffers => {
    const chat = store.getChat(threadId)
    if (!chat) throw new Error('Thread not found.')
    const presentation = threadProvider(chat)
    const currentModel = modelForChat(chat)
    const currentReasoning = reasoningForProvider(
      presentation.runtimeProvider,
      chat,
      participantForActiveRound(chat)
    )
    return resolveTaskWraithThreadOffers({
      threadId,
      provider: presentation.runtimeProvider,
      ...(currentModel ? { currentModel } : {}),
      ...(currentReasoning ? { currentReasoningEffort: currentReasoning } : {}),
      ensemble: chat.chatKind === 'ensemble' || chat.ensemble?.enabled === true,
      archived: chat.archived === true
    })
  }

  const sendPrompt = async (
    threadId: string,
    text: string,
    selection?: { model?: string; reasoningEffort?: string }
  ) => {
    const chat = store.getChat(threadId)
    if (!chat) throw new Error('Thread not found.')
    if (chat.archived) throw new Error('Archived threads cannot start a new turn.')
    const prompt = text.trim()
    if (!prompt) throw new Error('Prompt is empty.')
    const issuedAt = now()
    const workspaceId = chat.scope === 'global' ? 'global' : chat.workspaceId || ''
    if (chat.chatKind === 'ensemble' || chat.ensemble?.enabled) {
      if (selection?.model || selection?.reasoningEffort) {
        throw new Error('Model switching from the terminal is solo-thread only.')
      }
      const action: BridgeEnsembleSteerAction = {
        kind: 'ensembleSteer',
        actionId: `tui-ensemble:${threadId}:${randomUUID()}`,
        issuedAt,
        expiresAt: issuedAt + 2 * 60_000,
        workspaceId,
        threadId,
        ...(chat.ensemble?.activeRound?.status === 'running'
          ? { roundId: chat.ensemble.activeRound.roundId }
          : {}),
        text: prompt,
        message: 'Sent from the local TaskWraith TUI.'
      }
      const result = await options.executeEnsembleSteer(action)
      return { dispatched: result.executed, message: result.message }
    }
    const provider = providerForChat(chat)
    // A selection may only name ids the facade itself would offer for this
    // thread right now — the client picks among offers, it never nominates.
    let overrideModel: string | undefined
    let overrideEffort: string | undefined
    if (selection?.model || selection?.reasoningEffort) {
      const offers = threadOffers(threadId)
      const validated = validateTaskWraithThreadSelection(offers, selection)
      if (!validated.ok) throw new Error(validated.error)
      overrideModel = validated.value.model
      overrideEffort = validated.value.reasoningEffort
    }
    const metadata = record(chat.providerMetadata)
    const defaultModel = modelForChat(chat)
    const defaultEffort = reasoningForProvider(provider, chat, participantForActiveRound(chat))
    const action: BridgeComposerPromptAction = {
      kind: 'composerPrompt',
      actionId: `tui:${threadId}:${randomUUID()}`,
      issuedAt,
      expiresAt: issuedAt + 2 * 60_000,
      workspaceId,
      threadId,
      text: prompt,
      provider,
      ...(overrideModel ? { model: overrideModel } : defaultModel ? { model: defaultModel } : {}),
      ...(chat.workflowMode ? { workflowMode: chat.workflowMode } : {}),
      ...(nonEmptyString(metadata.approvalMode, chat.settingsSnapshot?.approvalMode)
        ? {
            approvalMode: nonEmptyString(metadata.approvalMode, chat.settingsSnapshot?.approvalMode)
          }
        : {}),
      // iOS wire parity: Claude rides its dedicated effort field, every other
      // provider the shared one. The no-selection fallback keeps the existing
      // derived-effort behaviour untouched.
      ...(overrideEffort
        ? provider === 'claude'
          ? { claudeReasoningEffort: overrideEffort }
          : { reasoningEffort: overrideEffort }
        : defaultEffort
          ? { reasoningEffort: defaultEffort }
          : {})
    }
    const result = await options.executeComposerPrompt(action)
    return { dispatched: result.executed, message: result.message }
  }

  const toggleEnsembleSeat = async (threadId: string, participantId: string, enabled: boolean) => {
    const chat = store.getChat(threadId)
    if (!chat) throw new Error('Thread not found.')
    const participants = chat.ensemble?.participants
    if (!(chat.chatKind === 'ensemble' || chat.ensemble?.enabled) || !participants?.length) {
      throw new Error('Thread is not an Ensemble chat.')
    }
    const target = participants.find((participant) => participant.id === participantId)
    if (!target) throw new Error('That seat no longer exists.')
    if (target.enabled === enabled) {
      return {
        updated: false,
        message: enabled ? 'Seat is already enabled.' : 'Seat is already disabled.'
      }
    }
    if (!enabled && participants.filter((participant) => participant.enabled).length <= 1) {
      // Mirror of the host executor's floor so the seat lens gets an honest
      // refusal without a round trip; the executor remains the authority.
      throw new Error('At least one participant must stay enabled.')
    }
    const issuedAt = now()
    const action: BridgeEnsembleRosterUpdateAction = {
      kind: 'ensembleRosterUpdate',
      actionId: `tui-seat:${threadId}:${randomUUID()}`,
      issuedAt,
      expiresAt: issuedAt + 60_000,
      workspaceId: chat.scope === 'global' ? 'global' : chat.workspaceId || '',
      threadId,
      // Replay the FULL canonical roster in `order` sequence with only the one
      // flag flipped: known ids update in place, array order is the speaking
      // order, and an omitted entry would REMOVE that seat.
      participants: [...participants]
        .sort((left, right) => left.order - right.order)
        .map((participant) => ({
          id: participant.id,
          provider: participant.provider,
          enabled: participant.id === participantId ? enabled : participant.enabled
        }))
    }
    const result = await options.executeEnsembleRosterUpdate(action)
    return { updated: result.executed, message: result.message }
  }

  const cancelRun = async (threadId: string) => {
    const chat = store.getChat(threadId)
    if (!chat) throw new Error('Thread not found.')
    const issuedAt = now()
    const workspaceId = chat.scope === 'global' ? 'global' : chat.workspaceId || ''
    if (
      (chat.chatKind === 'ensemble' || chat.ensemble?.enabled) &&
      chat.ensemble?.activeRound?.status === 'running'
    ) {
      const action: BridgeEnsembleCancelRoundAction = {
        kind: 'ensembleCancelRound',
        actionId: `tui-cancel-ensemble:${chat.ensemble.activeRound.roundId}:${randomUUID()}`,
        issuedAt,
        expiresAt: issuedAt + 60_000,
        workspaceId,
        threadId,
        roundId: chat.ensemble.activeRound.roundId,
        message: 'Cancelled from the local TaskWraith TUI.'
      }
      const result = await options.executeEnsembleCancelRound(action)
      return { cancelled: result.executed, message: result.message }
    }
    const run = activeRun(chat)
    if (!run?.runId) return { cancelled: false, message: 'No active run to cancel.' }
    const action: BridgeCancelRunAction = {
      kind: 'cancelRun',
      actionId: `tui-cancel:${run.runId}:${randomUUID()}`,
      issuedAt,
      expiresAt: issuedAt + 60_000,
      workspaceId,
      threadId,
      provider: run.provider || chat.provider || 'gemini',
      runId: run.runId,
      message: 'Cancelled from the local TaskWraith TUI.'
    }
    const result = await options.executeCancelRun(action)
    return { cancelled: result.executed, message: result.message }
  }

  return { snapshot, selectThread, sendPrompt, cancelRun, threadOffers, toggleEnsembleSeat }
}

export async function startTaskWraithLocalControl(
  options: StartTaskWraithLocalControlOptions
): Promise<LocalControlServer> {
  const facade = createTaskWraithControlFacade(options)
  const serverOptions: LocalControlServerOptions = {
    userDataPath: options.userDataPath,
    hostVersion: options.hostVersion,
    facade,
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.log ? { log: options.log } : {})
  }
  const server = new LocalControlServer(serverOptions)
  await server.start()
  return server
}
