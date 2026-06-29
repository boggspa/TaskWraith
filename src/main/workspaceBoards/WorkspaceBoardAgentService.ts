import type {
  ProviderId,
  WorkspaceBoardCard,
  WorkspaceBoardCardLink,
  WorkspaceBoardColumn,
  WorkspaceBoardColumnId,
  WorkspaceBoardDefinition,
  WorkspaceBoardProvenance,
  WorkspaceBoardProvenanceSourceKind
} from '../store/types'

type BoardSaveInput = Omit<WorkspaceBoardDefinition, 'id' | 'createdAt' | 'updatedAt' | 'activity'> &
  Partial<Pick<WorkspaceBoardDefinition, 'id' | 'createdAt' | 'updatedAt' | 'activity'>>
type CardSaveInput = Omit<WorkspaceBoardCard, 'id' | 'createdAt' | 'updatedAt' | 'activity'> &
  Partial<Pick<WorkspaceBoardCard, 'id' | 'createdAt' | 'updatedAt' | 'activity'>>

export interface WorkspaceBoardAgentStore {
  getWorkspaceBoards(workspaceId?: string): WorkspaceBoardDefinition[]
  saveWorkspaceBoard(board: BoardSaveInput): WorkspaceBoardDefinition
  updateWorkspaceBoard(id: string, partial: Partial<WorkspaceBoardDefinition>): WorkspaceBoardDefinition | null
  getWorkspaceBoardCards(boardId?: string): WorkspaceBoardCard[]
  saveWorkspaceBoardCard(card: CardSaveInput): WorkspaceBoardCard
  updateWorkspaceBoardCard(id: string, partial: Partial<WorkspaceBoardCard>): WorkspaceBoardCard | null
}

export interface WorkspaceBoardAgentCardProposal {
  cardId?: string
  title?: string
  body?: string | null
  columnId?: WorkspaceBoardColumnId
  sortOrder?: number
  humanOwner?: string | null
  labels?: string[]
  link?: WorkspaceBoardCardLink | null
  blockedReason?: string | null
  nextStep?: string | null
  reminderAt?: string | null
  sourceKind?: WorkspaceBoardProvenanceSourceKind
  sourceId?: string
  sourceTitle?: string
  note?: string
}

export interface WorkspaceBoardAgentPlanInput {
  workspaceId?: string
  workspacePath?: string
  boardId?: string
  name?: string
  description?: string | null
  sourceKind?: WorkspaceBoardProvenanceSourceKind
  sourceId?: string
  sourceTitle?: string
  provider?: ProviderId | string
  runId?: string
  note?: string
  cards?: WorkspaceBoardAgentCardProposal[]
}

export type WorkspaceBoardAgentOperationKind =
  | 'create-board'
  | 'update-board'
  | 'create-card'
  | 'update-card'

export interface WorkspaceBoardAgentOperation {
  kind: WorkspaceBoardAgentOperationKind
  summary: string
  boardId?: string
  cardId?: string
  title: string
  provenance: WorkspaceBoardProvenance
}

export interface WorkspaceBoardAgentPlanPreview {
  boardId?: string
  boardName: string
  workspaceId: string
  operations: WorkspaceBoardAgentOperation[]
}

export interface WorkspaceBoardAgentApplyResult extends WorkspaceBoardAgentPlanPreview {
  board: WorkspaceBoardDefinition
  cards: WorkspaceBoardCard[]
}

export interface WorkspaceBoardAgentServiceOptions {
  now?: () => Date
}

const DEFAULT_COLUMNS: WorkspaceBoardColumn[] = [
  { id: 'inbox', name: 'Inbox', sortOrder: 0 },
  { id: 'ready', name: 'Ready', sortOrder: 1 },
  { id: 'running', name: 'Running', sortOrder: 2 },
  { id: 'needs-input', name: 'Needs Input', sortOrder: 3 },
  { id: 'blocked', name: 'Blocked', sortOrder: 4 },
  { id: 'review-ready', name: 'Review Ready', sortOrder: 5 },
  { id: 'done', name: 'Done', sortOrder: 6 },
  { id: 'archived', name: 'Archived', sortOrder: 7 }
]

const AGENT_SOURCE_KINDS = new Set<WorkspaceBoardProvenanceSourceKind>([
  'thread',
  'goal',
  'plan',
  'agent'
])

const LINK_KINDS = new Set<WorkspaceBoardCardLink['kind']>([
  'chat',
  'workflow',
  'scheduled-task',
  'run-queue-job',
  'local-server'
])
const COLUMN_IDS = new Set<WorkspaceBoardColumnId>(DEFAULT_COLUMNS.map((column) => column.id))

function hasOwn(input: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key)
}

function text(value: unknown, max = 4000): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, max)
}

function requiredText(value: unknown, label: string, max = 4000): string {
  const out = text(value, max)
  if (!out) throw new Error(`${label} is required.`)
  return out
}

function nullableText(value: unknown, max = 4000): string | undefined {
  return text(value, max)
}

function normalizeSourceKind(value: unknown): WorkspaceBoardProvenanceSourceKind {
  return AGENT_SOURCE_KINDS.has(value as WorkspaceBoardProvenanceSourceKind)
    ? (value as WorkspaceBoardProvenanceSourceKind)
    : 'agent'
}

function normalizeLabels(labels: unknown): string[] | undefined {
  if (!Array.isArray(labels)) return undefined
  const out = labels
    .filter((label): label is string => typeof label === 'string')
    .map((label) => label.trim())
    .filter(Boolean)
    .slice(0, 12)
  return out.length ? out : undefined
}

function normalizeColumnId(value: unknown): WorkspaceBoardColumnId {
  return COLUMN_IDS.has(value as WorkspaceBoardColumnId) ? (value as WorkspaceBoardColumnId) : 'inbox'
}

function normalizeLink(link: unknown): WorkspaceBoardCardLink | undefined {
  if (!link || typeof link !== 'object') return undefined
  const input = link as Partial<WorkspaceBoardCardLink>
  const id = text(input.id, 500)
  if (!id || !LINK_KINDS.has(input.kind as WorkspaceBoardCardLink['kind'])) return undefined
  return { kind: input.kind as WorkspaceBoardCardLink['kind'], id }
}

function linkKey(link?: WorkspaceBoardCardLink): string | undefined {
  return link ? `${link.kind}:${link.id}` : undefined
}

function nowIso(options: WorkspaceBoardAgentServiceOptions | undefined): string {
  return (options?.now ? options.now() : new Date()).toISOString()
}

function createAgentProvenance(
  input: WorkspaceBoardAgentPlanInput,
  card: WorkspaceBoardAgentCardProposal | undefined,
  at: string
): WorkspaceBoardProvenance {
  return {
    actor: 'agent',
    sourceKind: normalizeSourceKind(card?.sourceKind || input.sourceKind),
    at,
    trust: 'agent-proposed',
    sourceId: text(card?.sourceId || input.sourceId, 500),
    sourceTitle: text(card?.sourceTitle || input.sourceTitle || input.name, 500),
    provider: text(input.provider, 80),
    runId: text(input.runId, 200),
    note: text(card?.note || input.note, 1000)
  }
}

function boardName(input: WorkspaceBoardAgentPlanInput): string {
  return (
    text(input.name, 120) ||
    (text(input.sourceTitle, 100) ? `${text(input.sourceTitle, 100)} Board` : undefined) ||
    'Agent Board'
  )
}

function boardDescription(input: WorkspaceBoardAgentPlanInput): string | undefined {
  return hasOwn(input, 'description') ? nullableText(input.description, 4000) : undefined
}

function findTargetBoard(
  store: WorkspaceBoardAgentStore,
  input: WorkspaceBoardAgentPlanInput,
  name: string
): WorkspaceBoardDefinition | null {
  const allBoards = store.getWorkspaceBoards(input.workspaceId)
  const boardId = text(input.boardId, 200)
  if (boardId) {
    const board = store.getWorkspaceBoards().find((item) => item.id === boardId) || null
    if (!board) throw new Error('Workspace board target was not found.')
    if (input.workspaceId && board.workspaceId !== input.workspaceId) {
      throw new Error('Workspace board target belongs to a different workspace.')
    }
    return board
  }
  if (!text(input.workspaceId, 200)) return null
  const normalizedName = name.toLowerCase()
  return (
    allBoards.find(
      (board) => !board.archived && board.name.trim().toLowerCase() === normalizedName
    ) || null
  )
}

function resolveWorkspace(
  input: WorkspaceBoardAgentPlanInput,
  targetBoard: WorkspaceBoardDefinition | null
): { workspaceId: string; workspacePath: string } {
  const workspaceId = text(input.workspaceId, 200) || targetBoard?.workspaceId
  const workspacePath = text(input.workspacePath, 4000) || targetBoard?.workspacePath
  if (!workspaceId || !workspacePath) {
    throw new Error('Workspace id and path are required to create an agent board plan.')
  }
  return { workspaceId, workspacePath }
}

function findMatchingCard(
  cards: WorkspaceBoardCard[],
  proposal: WorkspaceBoardAgentCardProposal
): WorkspaceBoardCard | null {
  const cardId = text(proposal.cardId, 200)
  if (cardId) {
    const card = cards.find((item) => item.id === cardId) || null
    if (!card) throw new Error(`Workspace board card target was not found: ${cardId}`)
    return card
  }
  const proposedLink = normalizeLink(proposal.link)
  const proposedLinkKey = linkKey(proposedLink)
  if (proposedLinkKey) {
    const linked = cards.find((card) => !card.archived && linkKey(card.link) === proposedLinkKey)
    if (linked) return linked
  }
  const title = text(proposal.title, 500)
  if (!title) return null
  return (
    cards.find((card) => !card.archived && card.title.trim().toLowerCase() === title.toLowerCase()) ||
    null
  )
}

function createCardInput(
  board: WorkspaceBoardDefinition,
  proposal: WorkspaceBoardAgentCardProposal,
  provenance: WorkspaceBoardProvenance,
  index: number,
  atMs: number
): CardSaveInput {
  return {
    boardId: board.id,
    workspaceId: board.workspaceId,
    columnId: normalizeColumnId(proposal.columnId),
    title: requiredText(proposal.title, 'Workspace board card title', 500),
    body: nullableText(proposal.body, 4000),
    sortOrder: Number.isFinite(Number(proposal.sortOrder))
      ? Math.max(0, Math.trunc(Number(proposal.sortOrder)))
      : atMs + index,
    humanOwner: nullableText(proposal.humanOwner, 200),
    labels: normalizeLabels(proposal.labels),
    link: normalizeLink(proposal.link),
    blockedReason: nullableText(proposal.blockedReason, 1000),
    nextStep: nullableText(proposal.nextStep, 1000),
    reminderAt: nullableText(proposal.reminderAt, 200),
    provenance
  }
}

function updateCardInput(
  proposal: WorkspaceBoardAgentCardProposal,
  provenance: WorkspaceBoardProvenance
): Partial<WorkspaceBoardCard> {
  const partial: Partial<WorkspaceBoardCard> = { provenance }
  if (hasOwn(proposal, 'title')) partial.title = requiredText(proposal.title, 'Workspace board card title', 500)
  if (hasOwn(proposal, 'body')) partial.body = nullableText(proposal.body, 4000)
  if (hasOwn(proposal, 'columnId')) partial.columnId = normalizeColumnId(proposal.columnId)
  if (Number.isFinite(Number(proposal.sortOrder))) {
    partial.sortOrder = Math.max(0, Math.trunc(Number(proposal.sortOrder)))
  }
  if (hasOwn(proposal, 'humanOwner')) partial.humanOwner = nullableText(proposal.humanOwner, 200)
  if (hasOwn(proposal, 'labels')) partial.labels = normalizeLabels(proposal.labels)
  if (hasOwn(proposal, 'link')) partial.link = normalizeLink(proposal.link)
  if (hasOwn(proposal, 'blockedReason')) partial.blockedReason = nullableText(proposal.blockedReason, 1000)
  if (hasOwn(proposal, 'nextStep')) partial.nextStep = nullableText(proposal.nextStep, 1000)
  if (hasOwn(proposal, 'reminderAt')) partial.reminderAt = nullableText(proposal.reminderAt, 200)
  return partial
}

function createOperation(
  kind: WorkspaceBoardAgentOperationKind,
  title: string,
  provenance: WorkspaceBoardProvenance,
  ids: Pick<WorkspaceBoardAgentOperation, 'boardId' | 'cardId'> = {}
): WorkspaceBoardAgentOperation {
  const verb = kind === 'create-board' || kind === 'create-card' ? 'Create' : 'Update'
  const target = kind.endsWith('board') ? 'board' : 'card'
  return {
    kind,
    summary: `${verb} ${target} "${title}"`,
    title,
    provenance,
    ...ids
  }
}

export function previewWorkspaceBoardAgentPlan(
  store: WorkspaceBoardAgentStore,
  input: WorkspaceBoardAgentPlanInput,
  options?: WorkspaceBoardAgentServiceOptions
): WorkspaceBoardAgentPlanPreview {
  const at = nowIso(options)
  const name = boardName(input)
  const targetBoard = findTargetBoard(store, input, name)
  const workspace = resolveWorkspace(input, targetBoard)
  const operations: WorkspaceBoardAgentOperation[] = []
  const boardProvenance = createAgentProvenance(input, undefined, at)

  if (!targetBoard) {
    operations.push(createOperation('create-board', name, boardProvenance))
  } else if (text(input.name, 120) || hasOwn(input, 'description')) {
    operations.push(createOperation('update-board', name, boardProvenance, { boardId: targetBoard.id }))
  }

  const cards = targetBoard ? store.getWorkspaceBoardCards(targetBoard.id) : []
  for (const proposal of (input.cards || []).slice(0, 50)) {
    const provenance = createAgentProvenance(input, proposal, at)
    const existing = targetBoard ? findMatchingCard(cards, proposal) : null
    const title = text(proposal.title, 500) || existing?.title || 'Untitled card'
    operations.push(
      createOperation(existing ? 'update-card' : 'create-card', title, provenance, {
        boardId: targetBoard?.id,
        cardId: existing?.id
      })
    )
  }

  return {
    boardId: targetBoard?.id,
    boardName: targetBoard ? text(input.name, 120) || targetBoard.name : name,
    workspaceId: workspace.workspaceId,
    operations
  }
}

export function applyWorkspaceBoardAgentPlan(
  store: WorkspaceBoardAgentStore,
  input: WorkspaceBoardAgentPlanInput,
  options?: WorkspaceBoardAgentServiceOptions
): WorkspaceBoardAgentApplyResult {
  const at = nowIso(options)
  const atMs = Date.parse(at)
  const name = boardName(input)
  const targetBoard = findTargetBoard(store, input, name)
  const workspace = resolveWorkspace(input, targetBoard)
  const boardProvenance = createAgentProvenance(input, undefined, at)
  const operations: WorkspaceBoardAgentOperation[] = []
  const description = boardDescription(input)

  let board: WorkspaceBoardDefinition
  if (targetBoard) {
    const partial: Partial<WorkspaceBoardDefinition> = {}
    if (text(input.name, 120)) partial.name = name
    if (hasOwn(input, 'description')) partial.description = description
    if (Object.keys(partial).length > 0) {
      partial.provenance = boardProvenance
      board = store.updateWorkspaceBoard(targetBoard.id, partial) || targetBoard
      operations.push(createOperation('update-board', board.name, boardProvenance, { boardId: board.id }))
    } else {
      board = targetBoard
    }
  } else {
    board = store.saveWorkspaceBoard({
      workspaceId: workspace.workspaceId,
      workspacePath: workspace.workspacePath,
      name,
      description,
      columns: DEFAULT_COLUMNS,
      provenance: boardProvenance
    })
    operations.push(createOperation('create-board', board.name, boardProvenance, { boardId: board.id }))
  }

  const savedCards: WorkspaceBoardCard[] = []
  let cards = store.getWorkspaceBoardCards(board.id)
  for (const [index, proposal] of (input.cards || []).slice(0, 50).entries()) {
    const provenance = createAgentProvenance(input, proposal, at)
    const existing = findMatchingCard(cards, proposal)
    if (existing) {
      const updated = store.updateWorkspaceBoardCard(existing.id, updateCardInput(proposal, provenance))
      if (updated) {
        savedCards.push(updated)
        cards = cards.map((card) => (card.id === updated.id ? updated : card))
        operations.push(createOperation('update-card', updated.title, provenance, {
          boardId: board.id,
          cardId: updated.id
        }))
      }
      continue
    }
    const saved = store.saveWorkspaceBoardCard(
      createCardInput(board, proposal, provenance, index, Number.isFinite(atMs) ? atMs : Date.now())
    )
    savedCards.push(saved)
    cards = [...cards, saved]
    operations.push(createOperation('create-card', saved.title, provenance, {
      boardId: board.id,
      cardId: saved.id
    }))
  }

  return {
    boardId: board.id,
    boardName: board.name,
    workspaceId: board.workspaceId,
    operations,
    board,
    cards: savedCards
  }
}
