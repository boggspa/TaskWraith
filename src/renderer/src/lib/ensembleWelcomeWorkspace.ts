import type { ChatRecord, WorkspaceRecord } from '../../../main/store/types'

export function shouldApplyFocusedWorkspaceRebind(input: {
  canonicalChanged: boolean
  rendererAlreadyAtTarget: boolean
}): boolean {
  // A true main-process no-op may preserve the focused provider session only
  // when this renderer already agrees with the canonical target. A stale
  // renderer still needs the full transition reset even if main was already
  // bound correctly (for example another renderer completed the rebind first).
  return input.canonicalChanged || !input.rendererAlreadyAtTarget
}
import { EXTERNAL_PATH_GRANT_METADATA_KEYS } from '../../../main/store/ExternalPathGrants'

export function rebindWelcomeEnsembleChatToWorkspace(
  chat: ChatRecord | null | undefined,
  workspace: WorkspaceRecord,
  isWelcomeChat: boolean,
  now = Date.now()
): ChatRecord | null {
  if (!isWelcomeChat || chat?.chatKind !== 'ensemble' || !chat.ensemble) return null
  if (isChatBoundToWorkspace(chat, workspace)) return null
  return clearWorkspaceBoundContinuity({
    ...chat,
    scope: 'workspace',
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    updatedAt: now,
    ensemble: {
      ...chat.ensemble,
      updatedAt: new Date(now).toISOString()
    }
  })
}

/**
 * 1.0.5-EW41 — Sibling of `rebindWelcomeEnsembleChatToWorkspace`
 * for the non-welcome case. The user is mid-Ensemble (curated
 * panel, possibly with transcript) and switches the workspace
 * from the composer's workspace switcher. Pre-EW41 the caller
 * (`handleSelectExistingWorkspace`) only had the welcome-gated
 * helper, so non-welcome Ensemble chats fell through to the
 * single-provider "create new chat in target workspace" path —
 * tossing the user out of their Ensemble entirely.
 *
 * This helper rebinds in place: same chat id, participants,
 * transcript, and Ensemble config. The workspace pointer changes
 * and workspace-bound provider session / prompt receipts are reset,
 * so subsequent rounds start fresh against the new sandbox. The
 * transcript history can still reference the old workspace by string,
 * but no resumed provider session can reach back into it.
 *
 * Returns null when the rebind is a no-op (chat is already on
 * this workspace) or when the input isn't a valid Ensemble chat,
 * signalling the caller can skip the save round-trip OR fall
 * back to the create-new path respectively.
 */
export function rebindEnsembleChatToWorkspace(
  chat: ChatRecord | null | undefined,
  workspace: WorkspaceRecord,
  now = Date.now()
): ChatRecord | null {
  if (chat?.chatKind !== 'ensemble' || !chat.ensemble) return null
  // Already pointing at this workspace — no-op so callers can
  // skip the rebind/save round-trip entirely.
  if (isChatBoundToWorkspace(chat, workspace)) return null
  return clearWorkspaceBoundContinuity({
    ...chat,
    scope: 'workspace',
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    updatedAt: now,
    ensemble: {
      ...chat.ensemble,
      updatedAt: new Date(now).toISOString()
    }
  })
}

/**
 * 1.0.5-EW4 — Companion to `rebindWelcomeEnsembleChatToWorkspace`,
 * for the "No workspace (system chat)" path. The user is on an empty
 * Ensemble welcome chat in some workspace, has built their panel
 * (added participants, set per-participant providers / models /
 * reasoning, etc.), then clicks "No workspace" in the welcome
 * workspace picker. Pre-EW4 the click called `handleNewGlobalChat`
 * which created a brand-new global Ensemble chat with default
 * participants — silently losing the user's setup. Now: if we're on
 * a welcome Ensemble chat we rebind it in place to `scope: 'global'`
 * + clear the workspace fields, preserving every participant + the
 * rest of the ensemble config. The helper returns null when the
 * input isn't an unsendable Ensemble welcome chat, signalling the
 * caller should fall back to the create-new path.
 */
export function rebindWelcomeEnsembleChatToGlobal(
  chat: ChatRecord | null | undefined,
  isWelcomeChat: boolean,
  now = Date.now()
): ChatRecord | null {
  if (!isWelcomeChat || chat?.chatKind !== 'ensemble' || !chat.ensemble) return null
  // Already global — no-op signal so the caller can skip the
  // rebind/save round-trip entirely.
  if (chat.scope === 'global' && !chat.workspaceId && !chat.workspacePath) return null
  const next: ChatRecord = clearWorkspaceBoundContinuity({
    ...chat,
    scope: 'global',
    updatedAt: now,
    ensemble: {
      ...chat.ensemble,
      updatedAt: new Date(now).toISOString()
    }
  })
  delete (next as Partial<ChatRecord>).workspaceId
  delete (next as Partial<ChatRecord>).workspacePath
  return next
}

/**
 * Provider-native sessions and their delivery receipts are born against one
 * workspace. A renderer-side optimistic rebind must never show those sessions
 * as reusable while main validates and persists the canonical transition.
 */
function clearWorkspaceBoundContinuity(chat: ChatRecord): ChatRecord {
  const next: ChatRecord = {
    ...chat,
    providerMetadata: clearExternalPathGrantMetadata(chat.providerMetadata),
    ...(chat.ensemble
      ? {
          ensemble: {
            ...chat.ensemble,
            participants: chat.ensemble.participants.map((participant) => {
              const fresh = { ...participant }
              delete fresh.linkedProviderSessionId
              delete fresh.taskWraithMcpProfileReceipt
              delete fresh.promptShellVersion
              delete fresh.promptDynamicStateVersion
              delete fresh.seatGeneration
              delete fresh.contextCompactionSummary
              const permissionOverrides = clearExternalPathGrantOverrides(fresh.permissionOverrides)
              if (permissionOverrides) fresh.permissionOverrides = permissionOverrides
              else delete fresh.permissionOverrides
              return fresh
            })
          }
        }
      : {})
  }
  delete next.linkedProviderSessionId
  delete next.linkedGeminiSessionId
  delete next.taskWraithMcpProfileReceipt
  delete next.seatGeneration
  delete next.contextCompactionSummary
  return next
}

function isChatBoundToWorkspace(chat: ChatRecord, workspace: WorkspaceRecord): boolean {
  return (
    chat.scope !== 'global' &&
    chat.workspaceId === workspace.id &&
    chat.workspacePath === workspace.path
  )
}

function clearExternalPathGrantMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!metadata) return undefined
  const next = { ...metadata }
  for (const key of EXTERNAL_PATH_GRANT_METADATA_KEYS) {
    delete next[key]
  }
  return Object.keys(next).length > 0 ? next : undefined
}

function clearExternalPathGrantOverrides(
  overrides: NonNullable<ChatRecord['ensemble']>['participants'][number]['permissionOverrides']
): NonNullable<ChatRecord['ensemble']>['participants'][number]['permissionOverrides'] {
  if (!overrides) return undefined
  const next = { ...overrides }
  delete next.externalPathGrants
  return Object.keys(next).length > 0 ? next : undefined
}
