/**
 * Renderer-session selection for the Project references explicitly attached to
 * a chat's next send. This is intentionally ephemeral: the durable Project
 * library is owned by main, while this store only remembers current composer
 * intent until an accepted dispatch or durable queue handoff clears it.
 */

import {
  MAX_PROJECT_REFERENCE_CONTEXT_ID_LENGTH,
  MAX_PROJECT_REFERENCE_CONTEXT_ITEMS,
  type ProjectReferenceContextSelection
} from '../../../shared/projectReferenceContext'

export {
  MAX_PROJECT_REFERENCE_CONTEXT_ITEMS,
  type ProjectReferenceContextSelection
} from '../../../shared/projectReferenceContext'

type SelectionListener = () => void

type ProjectReferenceContextSelectionState = {
  selection: ProjectReferenceContextSelection
  generation: number
  claimId?: string
}

export type ProjectReferenceContextClaim = Readonly<{
  schemaVersion: 1
  claimId: string
  chatId: string
  generation: number
  selection: ProjectReferenceContextSelection
}>

export type ProjectReferenceContextClaimOutcome = 'accepted' | 'rejected'

const selectionsByChatId = new Map<string, ProjectReferenceContextSelectionState>()
const listenersByChatId = new Map<string, Set<SelectionListener>>()
let nextSelectionGeneration = 0
let nextClaimSequence = 0

function normalizeId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= MAX_PROJECT_REFERENCE_CONTEXT_ID_LENGTH
    ? normalized
    : null
}

function normalizeReferenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids: string[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    const id = normalizeId(candidate)
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    if (ids.length === MAX_PROJECT_REFERENCE_CONTEXT_ITEMS) break
  }
  return ids
}

function freezeSelection(
  projectId: string,
  referenceIds: readonly string[]
): ProjectReferenceContextSelection {
  const frozenReferenceIds = [...referenceIds]
  Object.freeze(frozenReferenceIds)
  return Object.freeze({
    schemaVersion: 1,
    projectId,
    referenceIds: frozenReferenceIds
  })
}

function selectionsEqual(
  left: ProjectReferenceContextSelection | undefined,
  right: ProjectReferenceContextSelection
): boolean {
  return Boolean(
    left &&
    left.projectId === right.projectId &&
    left.referenceIds.length === right.referenceIds.length &&
    left.referenceIds.every((id, index) => id === right.referenceIds[index])
  )
}

function createSelectionState(
  selection: ProjectReferenceContextSelection
): ProjectReferenceContextSelectionState {
  nextSelectionGeneration += 1
  return { selection, generation: nextSelectionGeneration }
}

function notifyChat(chatId: string): void {
  for (const listener of [...(listenersByChatId.get(chatId) ?? [])]) {
    try {
      listener()
    } catch {
      // One composer leaf must not prevent sibling subscribers from updating.
    }
  }
}

/** Returns a stable, immutable snapshot until this chat's selection changes. */
export function getProjectReferenceContextSelection(
  chatId: string | null | undefined
): ProjectReferenceContextSelection | null {
  const normalizedChatId = normalizeId(chatId)
  return normalizedChatId
    ? (selectionsByChatId.get(normalizedChatId)?.selection ?? null)
    : null
}

/** Subscribe only to changes for one chat; other composers remain untouched. */
export function subscribeProjectReferenceContextSelection(
  chatId: string | null | undefined,
  listener: SelectionListener
): () => void {
  const normalizedChatId = normalizeId(chatId)
  if (!normalizedChatId || typeof listener !== 'function') return () => {}
  const listeners = listenersByChatId.get(normalizedChatId) ?? new Set<SelectionListener>()
  listeners.add(listener)
  listenersByChatId.set(normalizedChatId, listeners)
  return () => {
    const current = listenersByChatId.get(normalizedChatId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listenersByChatId.delete(normalizedChatId)
  }
}

/**
 * Replace one chat's next-send selection. Empty reference input clears it;
 * choosing another Project atomically replaces the former Project bucket.
 */
export function setProjectReferenceContextSelection(
  chatId: string | null | undefined,
  projectId: string | null | undefined,
  referenceIds: unknown
): ProjectReferenceContextSelection | null {
  const normalizedChatId = normalizeId(chatId)
  const normalizedProjectId = normalizeId(projectId)
  if (!normalizedChatId || !normalizedProjectId) return getProjectReferenceContextSelection(chatId)

  const normalizedReferenceIds = normalizeReferenceIds(referenceIds)
  if (normalizedReferenceIds.length === 0) {
    clearProjectReferenceContextSelection(normalizedChatId)
    return null
  }

  const next = freezeSelection(normalizedProjectId, normalizedReferenceIds)
  const previous = selectionsByChatId.get(normalizedChatId)
  if (selectionsEqual(previous?.selection, next)) return previous?.selection ?? next
  selectionsByChatId.set(normalizedChatId, createSelectionState(next))
  notifyChat(normalizedChatId)
  return next
}

/** Add/remove one reference while preserving stable insertion order. */
export function toggleProjectReferenceContextSelection(
  chatId: string | null | undefined,
  projectId: string | null | undefined,
  referenceId: string | null | undefined
): ProjectReferenceContextSelection | null {
  const normalizedChatId = normalizeId(chatId)
  const normalizedProjectId = normalizeId(projectId)
  const normalizedReferenceId = normalizeId(referenceId)
  if (!normalizedChatId || !normalizedProjectId || !normalizedReferenceId) {
    return getProjectReferenceContextSelection(chatId)
  }

  const previous = selectionsByChatId.get(normalizedChatId)?.selection
  const currentIds = previous?.projectId === normalizedProjectId ? previous.referenceIds : []
  const existingIndex = currentIds.indexOf(normalizedReferenceId)
  if (existingIndex >= 0) {
    const nextIds = currentIds.filter((_, index) => index !== existingIndex)
    return setProjectReferenceContextSelection(normalizedChatId, normalizedProjectId, nextIds)
  }
  if (currentIds.length >= MAX_PROJECT_REFERENCE_CONTEXT_ITEMS) return previous ?? null
  return setProjectReferenceContextSelection(normalizedChatId, normalizedProjectId, [
    ...currentIds,
    normalizedReferenceId
  ])
}

export function clearProjectReferenceContextSelection(chatId: string | null | undefined): boolean {
  const normalizedChatId = normalizeId(chatId)
  if (!normalizedChatId || !selectionsByChatId.delete(normalizedChatId)) return false
  notifyChat(normalizedChatId)
  return true
}

/**
 * Atomically reserve the current generation for one submission. The selection
 * remains display-facing while acceptance is pending, but another request
 * cannot capture it. Claims live only in renderer memory.
 */
export function claimProjectReferenceContextSelection(
  chatId: string | null | undefined
): ProjectReferenceContextClaim | null {
  const normalizedChatId = normalizeId(chatId)
  if (!normalizedChatId) return null
  const current = selectionsByChatId.get(normalizedChatId)
  if (!current || current.claimId) return null

  nextClaimSequence += 1
  const claimId = `project-reference-context-claim-${nextClaimSequence}`
  selectionsByChatId.set(normalizedChatId, { ...current, claimId })
  return Object.freeze({
    schemaVersion: 1,
    claimId,
    chatId: normalizedChatId,
    generation: current.generation,
    selection: current.selection
  })
}

/**
 * Settle exactly the generation reserved by a request. A newer mutation or
 * exact re-selection has a different generation, so an old receipt is a no-op.
 */
export function settleProjectReferenceContextClaim(
  claim: ProjectReferenceContextClaim | null | undefined,
  outcome: ProjectReferenceContextClaimOutcome
): boolean {
  if (
    !claim ||
    claim.schemaVersion !== 1 ||
    !Number.isSafeInteger(claim.generation) ||
    claim.generation <= 0 ||
    (outcome !== 'accepted' && outcome !== 'rejected')
  ) {
    return false
  }
  const chatId = normalizeId(claim.chatId)
  const claimId = normalizeId(claim.claimId)
  if (!chatId || !claimId) return false

  const current = selectionsByChatId.get(chatId)
  if (
    !current ||
    current.generation !== claim.generation ||
    current.claimId !== claimId
  ) {
    return false
  }

  if (outcome === 'accepted') {
    selectionsByChatId.delete(chatId)
    notifyChat(chatId)
  } else {
    selectionsByChatId.set(chatId, {
      selection: current.selection,
      generation: current.generation
    })
  }
  return true
}

/** Test seam: production intentionally has no durable hydrate/persist lifecycle. */
export function resetProjectReferenceContextSelectionForTests(): void {
  selectionsByChatId.clear()
  listenersByChatId.clear()
  nextSelectionGeneration = 0
  nextClaimSequence = 0
}
