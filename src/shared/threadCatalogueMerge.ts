import { CHAT_COMPOSER_SELECTION_METADATA_KEYS } from './chatComposerSelectionPatch'
import type { ChatListItem, ChatRecord } from '../main/store/types'

export const CATALOGUE_EDITABLE_FIELDS = [
  'title',
  'pinned',
  'hiddenFromMainList',
  'archived',
  'provider',
  'workflowMode'
] as const
export type CatalogueEditBase = Pick<ChatRecord, (typeof CATALOGUE_EDITABLE_FIELDS)[number]> & {
  providerMetadata?: Record<string, unknown>
}

export function catalogueEditBase(chat: ChatRecord): CatalogueEditBase {
  const base: Record<string, unknown> = {}
  for (const key of CATALOGUE_EDITABLE_FIELDS) base[key] = chat[key]
  base.providerMetadata = {}
  for (const key of CHAT_COMPOSER_SELECTION_METADATA_KEYS) {
    const value = chat.providerMetadata?.[key]
    if (value !== undefined) (base.providerMetadata as Record<string, unknown>)[key] = value
  }
  return base as CatalogueEditBase
}

/** Compare actual UI edits with the row's original values, preserving every other canonical field. */
export function applyCatalogueEdits(canonical: ChatRecord, incoming: ChatListItem): ChatRecord {
  const base = incoming.catalogueEditBase
  if (!base) throw new Error('Catalogue row is missing its edit base')
  const next = { ...canonical }
  for (const key of CATALOGUE_EDITABLE_FIELDS) {
    if (!Object.is(incoming[key], base[key]))
      (next as unknown as Record<string, unknown>)[key] = incoming[key]
  }
  for (const key of CHAT_COMPOSER_SELECTION_METADATA_KEYS) {
    if (Object.is(incoming.providerMetadata?.[key], base.providerMetadata?.[key])) continue
    next.providerMetadata = { ...next.providerMetadata }
    const value = incoming.providerMetadata?.[key]
    if (value === undefined) delete next.providerMetadata[key]
    else next.providerMetadata[key] = value
  }
  return next
}

/** A display refresh may update chrome; it never replaces hydrated context with bounded previews. */
export function mergeCatalogueDisplay(existing: ChatRecord, incoming: ChatListItem): ChatRecord {
  const next = { ...existing }
  for (const key of [
    ...CATALOGUE_EDITABLE_FIELDS,
    'updatedAt',
    'threadTitle',
    'workspaceId',
    'workspacePath',
    'parentChatId',
    'parentChatRelation',
    'gitWorkflow',
    'watchedPr'
  ] as const) {
    ;(next as unknown as Record<string, unknown>)[key] = incoming[key]
  }
  if (incoming.providerMetadata)
    next.providerMetadata = { ...existing.providerMetadata, ...incoming.providerMetadata }
  return next
}
