import { randomUUID } from 'crypto'
import {
  WORKSPACE_BOARD_CARD_LINK_KINDS,
  type WorkspaceBoardActivityEntry,
  type WorkspaceBoardCard,
  type WorkspaceBoardCardLink,
  type WorkspaceBoardColumn,
  type WorkspaceBoardColumnId,
  type WorkspaceBoardDefinition,
  type WorkspaceBoardProvenance,
  type WorkspaceBoardProvenanceSourceKind
} from '../types'

export const WORKSPACE_BOARD_DEFAULT_COLUMNS: WorkspaceBoardColumn[] = [
  { id: 'inbox', name: 'Inbox', sortOrder: 0 },
  { id: 'ready', name: 'Ready', sortOrder: 1 },
  { id: 'running', name: 'Running', sortOrder: 2 },
  { id: 'needs-input', name: 'Needs Input', sortOrder: 3 },
  { id: 'blocked', name: 'Blocked', sortOrder: 4 },
  { id: 'review-ready', name: 'Review Ready', sortOrder: 5 },
  { id: 'done', name: 'Done', sortOrder: 6 },
  { id: 'archived', name: 'Archived', sortOrder: 7 }
]

const WORKSPACE_BOARD_COLUMN_IDS = new Set<WorkspaceBoardColumnId>(
  WORKSPACE_BOARD_DEFAULT_COLUMNS.map((column) => column.id)
)
const WORKSPACE_BOARD_CARD_LINK_KIND_SET = new Set<WorkspaceBoardCardLink['kind']>(
  WORKSPACE_BOARD_CARD_LINK_KINDS
)
const WORKSPACE_BOARD_PROVENANCE_SOURCE_KINDS = new Set<WorkspaceBoardProvenanceSourceKind>([
  'manual',
  'capture',
  'seed',
  'duplicate',
  'thread',
  'goal',
  'plan',
  'agent'
])

export function isWorkspaceBoardColumnId(value: unknown): value is WorkspaceBoardColumnId {
  return (
    typeof value === 'string' && WORKSPACE_BOARD_COLUMN_IDS.has(value as WorkspaceBoardColumnId)
  )
}

export function isWorkspaceBoardCardLinkKind(
  value: unknown
): value is WorkspaceBoardCardLink['kind'] {
  return (
    typeof value === 'string' &&
    WORKSPACE_BOARD_CARD_LINK_KIND_SET.has(value as WorkspaceBoardCardLink['kind'])
  )
}

export function normalizeWorkspaceBoardActivityEntry(
  value: unknown,
  fallbackAction: string,
  nowIso: string
): WorkspaceBoardActivityEntry | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<WorkspaceBoardActivityEntry>
  const action =
    typeof input.action === 'string' && input.action.trim() ? input.action.trim() : fallbackAction
  return {
    id: typeof input.id === 'string' && input.id ? input.id : randomUUID(),
    at: typeof input.at === 'string' && input.at ? input.at : nowIso,
    actor: input.actor === 'agent' || input.actor === 'system' ? input.actor : 'user',
    action,
    detail:
      typeof input.detail === 'string' && input.detail.trim() ? input.detail.trim() : undefined
  }
}

export function workspaceBoardActivityActorFromProvenance(
  provenance: unknown
): WorkspaceBoardActivityEntry['actor'] {
  if (!provenance || typeof provenance !== 'object') return 'user'
  const actor = (provenance as Partial<WorkspaceBoardProvenance>).actor
  return actor === 'agent' || actor === 'system' ? actor : 'user'
}

export function normalizeWorkspaceBoardProvenance(
  value: unknown,
  nowIso: string
): WorkspaceBoardProvenance | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Partial<WorkspaceBoardProvenance>
  const sourceKind = WORKSPACE_BOARD_PROVENANCE_SOURCE_KINDS.has(
    input.sourceKind as WorkspaceBoardProvenanceSourceKind
  )
    ? (input.sourceKind as WorkspaceBoardProvenanceSourceKind)
    : 'manual'
  return {
    actor: input.actor === 'agent' || input.actor === 'system' ? input.actor : 'user',
    sourceKind,
    at: typeof input.at === 'string' && input.at ? input.at : nowIso,
    trust:
      input.trust === 'agent-proposed' ||
      input.trust === 'system-derived' ||
      input.trust === 'user-confirmed'
        ? input.trust
        : undefined,
    sourceId:
      typeof input.sourceId === 'string' && input.sourceId.trim()
        ? input.sourceId.trim()
        : undefined,
    sourceTitle:
      typeof input.sourceTitle === 'string' && input.sourceTitle.trim()
        ? input.sourceTitle.trim()
        : undefined,
    provider:
      typeof input.provider === 'string' && input.provider.trim()
        ? input.provider.trim()
        : undefined,
    runId: typeof input.runId === 'string' && input.runId.trim() ? input.runId.trim() : undefined,
    note: typeof input.note === 'string' && input.note.trim() ? input.note.trim() : undefined
  }
}

export function normalizeWorkspaceBoardColumns(value: unknown): WorkspaceBoardColumn[] {
  const provided = Array.isArray(value) ? value : []
  const byId = new Map<WorkspaceBoardColumnId, WorkspaceBoardColumn>()
  for (const item of provided) {
    if (!item || typeof item !== 'object') continue
    const input = item as Partial<WorkspaceBoardColumn>
    if (!isWorkspaceBoardColumnId(input.id)) continue
    byId.set(input.id, {
      id: input.id,
      name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : input.id,
      sortOrder:
        typeof input.sortOrder === 'number' && Number.isFinite(input.sortOrder)
          ? Math.max(0, Math.floor(input.sortOrder))
          : WORKSPACE_BOARD_DEFAULT_COLUMNS.find((column) => column.id === input.id)?.sortOrder ||
            0,
      wipLimit:
        typeof input.wipLimit === 'number' && Number.isFinite(input.wipLimit) && input.wipLimit > 0
          ? Math.floor(input.wipLimit)
          : undefined
    })
  }
  for (const column of WORKSPACE_BOARD_DEFAULT_COLUMNS) {
    if (!byId.has(column.id)) byId.set(column.id, column)
  }
  return Array.from(byId.values()).sort((a, b) => a.sortOrder - b.sortOrder)
}

export function normalizeWorkspaceBoardLink(value: unknown): WorkspaceBoardCardLink | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Partial<WorkspaceBoardCardLink>
  if (!isWorkspaceBoardCardLinkKind(input.kind)) return undefined
  if (typeof input.id !== 'string' || !input.id.trim()) return undefined
  return { kind: input.kind, id: input.id.trim() }
}

export function normalizeWorkspaceBoardDefinitionRecord(
  value: unknown,
  nowMs: number
): WorkspaceBoardDefinition | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<WorkspaceBoardDefinition>
  if (typeof input.workspaceId !== 'string' || !input.workspaceId.trim()) return null
  if (typeof input.workspacePath !== 'string' || !input.workspacePath.trim()) return null
  const nowIso = new Date(nowMs).toISOString()
  return {
    id: typeof input.id === 'string' && input.id ? input.id : randomUUID(),
    workspaceId: input.workspaceId,
    workspacePath: input.workspacePath,
    name:
      typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'Workspace Board',
    description:
      typeof input.description === 'string' && input.description.trim()
        ? input.description.trim()
        : undefined,
    columns: normalizeWorkspaceBoardColumns(input.columns),
    provenance: normalizeWorkspaceBoardProvenance(input.provenance, nowIso),
    pinned: input.pinned === true,
    archived: input.archived === true,
    createdAt: typeof input.createdAt === 'string' && input.createdAt ? input.createdAt : nowIso,
    updatedAt: typeof input.updatedAt === 'string' && input.updatedAt ? input.updatedAt : nowIso,
    activity: Array.isArray(input.activity)
      ? input.activity
          .map((entry) => normalizeWorkspaceBoardActivityEntry(entry, 'updated', nowIso))
          .filter((entry): entry is WorkspaceBoardActivityEntry => Boolean(entry))
          .slice(-100)
      : []
  }
}

export function normalizeWorkspaceBoardCardRecord(
  value: unknown,
  nowMs: number
): WorkspaceBoardCard | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<WorkspaceBoardCard>
  if (typeof input.boardId !== 'string' || !input.boardId.trim()) return null
  if (typeof input.workspaceId !== 'string' || !input.workspaceId.trim()) return null
  const nowIso = new Date(nowMs).toISOString()
  const labels = Array.isArray(input.labels)
    ? input.labels
        .filter((label): label is string => typeof label === 'string')
        .map((label) => label.trim())
        .filter(Boolean)
        .slice(0, 12)
    : undefined
  return {
    id: typeof input.id === 'string' && input.id ? input.id : randomUUID(),
    boardId: input.boardId,
    workspaceId: input.workspaceId,
    columnId: isWorkspaceBoardColumnId(input.columnId) ? input.columnId : 'inbox',
    title:
      typeof input.title === 'string' && input.title.trim() ? input.title.trim() : 'Untitled card',
    body: typeof input.body === 'string' && input.body.trim() ? input.body.trim() : undefined,
    sortOrder:
      typeof input.sortOrder === 'number' && Number.isFinite(input.sortOrder)
        ? input.sortOrder
        : nowMs,
    humanOwner:
      typeof input.humanOwner === 'string' && input.humanOwner.trim()
        ? input.humanOwner.trim()
        : undefined,
    labels,
    link: normalizeWorkspaceBoardLink(input.link),
    blockedReason:
      typeof input.blockedReason === 'string' && input.blockedReason.trim()
        ? input.blockedReason.trim()
        : undefined,
    nextStep:
      typeof input.nextStep === 'string' && input.nextStep.trim()
        ? input.nextStep.trim()
        : undefined,
    reminderAt:
      typeof input.reminderAt === 'string' && input.reminderAt.trim()
        ? input.reminderAt.trim()
        : undefined,
    provenance: normalizeWorkspaceBoardProvenance(input.provenance, nowIso),
    archived: input.archived === true,
    createdAt: typeof input.createdAt === 'string' && input.createdAt ? input.createdAt : nowIso,
    updatedAt: typeof input.updatedAt === 'string' && input.updatedAt ? input.updatedAt : nowIso,
    activity: Array.isArray(input.activity)
      ? input.activity
          .map((entry) => normalizeWorkspaceBoardActivityEntry(entry, 'updated', nowIso))
          .filter((entry): entry is WorkspaceBoardActivityEntry => Boolean(entry))
          .slice(-100)
      : []
  }
}
