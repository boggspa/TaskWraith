import type { ProviderId, WorkspaceBoardCard, WorkspaceBoardDefinition } from '../store/types'
import type { WorkspaceToolContext } from './WorkspaceToolExecutors'
import {
  applyWorkspaceBoardAgentPlan,
  previewWorkspaceBoardAgentPlan,
  type WorkspaceBoardAgentPlanInput,
  type WorkspaceBoardAgentStore
} from '../workspaceBoards/WorkspaceBoardAgentService'
import type { ChatRecord } from '../store/types'

export const WORKSPACE_BOARD_MCP_TOOL_NAMES = [
  'workspace_board_snapshot',
  'workspace_board_preview_plan',
  'workspace_board_apply_plan'
] as const

export type WorkspaceBoardMcpToolName = (typeof WORKSPACE_BOARD_MCP_TOOL_NAMES)[number]

const WORKSPACE_BOARD_MCP_TOOL_NAME_SET = new Set<string>(WORKSPACE_BOARD_MCP_TOOL_NAMES)

export function isWorkspaceBoardMcpToolName(value: string): value is WorkspaceBoardMcpToolName {
  return WORKSPACE_BOARD_MCP_TOOL_NAME_SET.has(value)
}

export interface WorkspaceBoardToolStore extends WorkspaceBoardAgentStore {
  getChat(chatId: string): ChatRecord | undefined
}

export interface WorkspaceBoardToolExecutors {
  executeWorkspaceBoardMcpTool: (
    toolName: WorkspaceBoardMcpToolName,
    args: Record<string, any>,
    context: WorkspaceToolContext,
    metadata: WorkspaceBoardToolMetadata
  ) => Promise<{ result: unknown; isError: boolean }>
}

export interface WorkspaceBoardToolMetadata {
  provider: ProviderId
  runId?: string
}

export function createWorkspaceBoardToolExecutors(store: WorkspaceBoardToolStore): WorkspaceBoardToolExecutors {
  return {
    executeWorkspaceBoardMcpTool: (toolName, args, context, metadata) =>
      executeWorkspaceBoardMcpTool(store, toolName, args, context, metadata)
  }
}

function text(value: unknown, max = 4000): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function resolveWorkspace(store: WorkspaceBoardToolStore, context: WorkspaceToolContext) {
  if (context.scope !== 'workspace') {
    throw new Error('Workspace board tools require an active workspace chat.')
  }
  const chat = context.appChatId ? store.getChat(context.appChatId) : undefined
  if (!chat || chat.scope === 'global' || !chat.workspaceId || !chat.workspacePath) {
    throw new Error('Workspace board tools require a workspace-scoped chat context.')
  }
  return {
    workspaceId: chat.workspaceId,
    workspacePath: chat.workspacePath
  }
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined
  return value.length > max ? `${value.slice(0, max)}...` : value
}

function summarizeCard(card: WorkspaceBoardCard) {
  return {
    id: card.id,
    boardId: card.boardId,
    workspaceId: card.workspaceId,
    columnId: card.columnId,
    title: card.title,
    body: truncate(card.body, 1000),
    sortOrder: card.sortOrder,
    humanOwner: card.humanOwner,
    labels: card.labels,
    link: card.link,
    blockedReason: truncate(card.blockedReason, 500),
    nextStep: truncate(card.nextStep, 500),
    reminderAt: card.reminderAt,
    provenance: card.provenance,
    archived: card.archived === true,
    updatedAt: card.updatedAt
  }
}

function summarizeBoard(board: WorkspaceBoardDefinition, cards: WorkspaceBoardCard[]) {
  return {
    id: board.id,
    workspaceId: board.workspaceId,
    name: board.name,
    description: truncate(board.description, 1000),
    columns: board.columns,
    provenance: board.provenance,
    pinned: board.pinned === true,
    archived: board.archived === true,
    updatedAt: board.updatedAt,
    cardCount: cards.filter((card) => !card.archived).length,
    archivedCardCount: cards.filter((card) => card.archived).length
  }
}

function assertWorkspaceBoard(
  store: WorkspaceBoardToolStore,
  boardId: string | undefined,
  workspaceId: string
): WorkspaceBoardDefinition | undefined {
  if (!boardId) return undefined
  const board = store.getWorkspaceBoards(workspaceId).find((item) => item.id === boardId)
  if (!board) throw new Error('Workspace board target was not found in the active workspace.')
  return board
}

function planInputFromArgs(
  args: Record<string, any>,
  workspace: { workspaceId: string; workspacePath: string },
  metadata: WorkspaceBoardToolMetadata
): WorkspaceBoardAgentPlanInput {
  const input = args.plan && typeof args.plan === 'object' ? args.plan as Record<string, any> : args
  const requestedWorkspaceId = text(input.workspaceId, 200)
  if (requestedWorkspaceId && requestedWorkspaceId !== workspace.workspaceId) {
    throw new Error('Workspace board plan workspace does not match the active chat workspace.')
  }
  return {
    workspaceId: workspace.workspaceId,
    workspacePath: workspace.workspacePath,
    boardId: text(input.boardId, 200),
    name: text(input.name, 200),
    description: Object.prototype.hasOwnProperty.call(input, 'description')
      ? text(input.description, 4000)
      : undefined,
    sourceKind: input.sourceKind,
    sourceId: text(input.sourceId, 500),
    sourceTitle: text(input.sourceTitle, 500),
    provider: metadata.provider,
    runId: metadata.runId,
    note: text(input.note, 1000),
    cards: Array.isArray(input.cards) ? input.cards.slice(0, 50) : []
  }
}

function snapshotWorkspaceBoards(
  store: WorkspaceBoardToolStore,
  args: Record<string, any>,
  context: WorkspaceToolContext
) {
  const workspace = resolveWorkspace(store, context)
  const includeArchived = args.includeArchived === true
  const board = assertWorkspaceBoard(store, text(args.boardId, 200), workspace.workspaceId)
  const limit = integer(args.limit ?? args.maxCards, 100, 1, 500)
  const boards = (board ? [board] : store.getWorkspaceBoards(workspace.workspaceId))
    .filter((item) => includeArchived || !item.archived)
  const cardsByBoardId = new Map<string, WorkspaceBoardCard[]>()
  for (const item of boards) {
    const boardCards = store.getWorkspaceBoardCards(item.id)
      .filter((card) => includeArchived || !card.archived)
      .slice(0, limit)
    cardsByBoardId.set(item.id, boardCards)
  }
  return {
    ok: true,
    workspaceId: workspace.workspaceId,
    boardCount: boards.length,
    boards: boards.map((item) => summarizeBoard(item, store.getWorkspaceBoardCards(item.id))),
    cards: Object.fromEntries(
      boards.map((item) => [item.id, (cardsByBoardId.get(item.id) || []).map(summarizeCard)])
    )
  }
}

export async function executeWorkspaceBoardMcpTool(
  store: WorkspaceBoardToolStore,
  toolName: WorkspaceBoardMcpToolName,
  args: Record<string, any>,
  context: WorkspaceToolContext,
  metadata: WorkspaceBoardToolMetadata
): Promise<{ result: unknown; isError: boolean }> {
  try {
    if (toolName === 'workspace_board_snapshot') {
      return { result: snapshotWorkspaceBoards(store, args, context), isError: false }
    }
    const workspace = resolveWorkspace(store, context)
    const plan = planInputFromArgs(args, workspace, metadata)
    if (plan.boardId) assertWorkspaceBoard(store, plan.boardId, workspace.workspaceId)
    if (toolName === 'workspace_board_preview_plan') {
      return {
        result: { ok: true, ...previewWorkspaceBoardAgentPlan(store, plan) },
        isError: false
      }
    }
    if (toolName === 'workspace_board_apply_plan') {
      return {
        result: { ok: true, changed: true, ...applyWorkspaceBoardAgentPlan(store, plan) },
        isError: false
      }
    }
    return {
      result: { ok: false, error: `Unknown workspace board tool: ${toolName}` },
      isError: true
    }
  } catch (error) {
    return {
      result: {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      },
      isError: true
    }
  }
}
