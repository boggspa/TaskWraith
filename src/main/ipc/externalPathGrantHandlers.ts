import {
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  ipcMain
} from 'electron'
import type { ChatRecord, ExternalPathGrant, ProviderId, WorkspaceRecord } from '../store/types'
import { assertSafeChatId } from '../ChatPath'

interface ExternalPathGrantDialogResult {
  canceled: boolean
  filePaths: string[]
  bookmarks?: string[]
}

interface ExternalPathGrantStatLike {
  isDirectory(): boolean
  dev?: number | bigint
  ino?: number | bigint
}

interface RegisteredExplicitExternalPath {
  path: string
  workspace: WorkspaceRecord
}

type PickAndPersistResult =
  | { ok: true; grants: ExternalPathGrant[]; path: string; selectionReceipt?: string }
  | { ok: false; reason: 'no-chat' | 'cancelled' | 'no-provider' | 'no-window' }
  // The explicit path came from an existing main-signed grant but no longer
  // resolves on disk — the renderer offers removal instead of looping.
  | { ok: false; reason: 'missing-path'; path: string }

interface ExternalPathGrantPersistPayload {
  chatId?: string
  access?: 'read' | 'write'
  path?: string
  deferPersist?: boolean
  selectionReceipt?: string
}

interface ExternalPathGrantRevokePayload {
  chatId?: string
  grantIds?: unknown
}

type RevokeExternalPathGrantsResult =
  | { ok: true; grants: ExternalPathGrant[]; revokedGrantIds: string[] }
  | { ok: false; reason: 'no-chat' | 'no-grants' }

export interface ExternalPathGrantHandlersDeps {
  getMainWindow: () => BrowserWindow | null
  showOpenDialog: (
    window: BrowserWindow,
    options: OpenDialogOptions
  ) => Promise<ExternalPathGrantDialogResult>
  stat: (pathValue: string) => Promise<ExternalPathGrantStatLike>
  realpath: (pathValue: string) => Promise<string>
  resolvePath: (pathValue: string) => string
  providerLabel: (provider: ProviderId) => string
  issueExternalPathGrant: (
    grant: Omit<ExternalPathGrant, 'issuedBy' | 'signature'>,
    options?: { canonicalPath: string }
  ) => ExternalPathGrant
  getChat: (chatId: string) => ChatRecord | null | undefined
  saveChat: (chat: ChatRecord) => void
  broadcastChatUpdated: (chat: ChatRecord) => void
  collectExternalPathGrantsFromMetadata: (
    metadata: Record<string, unknown> | null | undefined
  ) => ExternalPathGrant[]
  canonicalizeExternalPathGrantMetadata: (
    metadata: Record<string, unknown> | null | undefined,
    nextGrants?: ExternalPathGrant[]
  ) => Record<string, unknown>
  isExternalPathGrantDispatchProvider: (provider: ProviderId | string) => boolean
  resolveRegisteredExplicitExternalPath: (input: {
    explicitPath: string
    findRegisteredWorkspace: (workspacePath: string) => WorkspaceRecord | undefined
    canonicalPath: (value: string) => string
  }) => RegisteredExplicitExternalPath | null
  findRegisteredWorkspace: (workspacePath: string) => WorkspaceRecord | undefined
  canonicalPath: (value: string) => string
  /**
   * Signature-only verification of a persisted grant row (no run binding) —
   * the provenance check behind the preflight card's receipt-less re-grant.
   */
  verifyExternalPathGrantSignatureForGrant: (grant: ExternalPathGrant) => boolean
  optionalString: (value: unknown) => string | undefined
  randomBytes: (size: number) => Buffer
  securityScopedBookmarks: boolean
  probeExternalPath: (absolutePath: string) => Promise<unknown>
  assertSenderScope: (
    event: IpcMainInvokeEvent,
    input: { capability: 'external-grant'; chatId: string; workspacePath?: string }
  ) => void
  assertSenderCanProbeExternalPath: (event: IpcMainInvokeEvent) => void
}

interface ExternalPathSelectionReceipt {
  senderId: number
  chatId: string
  path: string
  access: 'read' | 'write'
  kind: ExternalPathGrant['kind']
  bookmark?: string
  workspaceScope: 'global' | 'workspace'
  workspaceId?: string
  workspacePath?: string
  dispatchProviders: ProviderId[]
  expiresAt: number
  device: string
  inode: string
}

const EXTERNAL_PATH_SELECTION_RECEIPT_TTL_MS = 5 * 60 * 1000

export function grantProvidersForChat(
  chat: ChatRecord,
  isDispatchProvider: ExternalPathGrantHandlersDeps['isExternalPathGrantDispatchProvider']
): ProviderId[] {
  const targetProviders: ProviderId[] = []
  if (chat.chatKind === 'ensemble' && chat.ensemble?.participants?.length) {
    const seen = new Set<ProviderId>()
    for (const participant of chat.ensemble.participants) {
      if (!participant.enabled || seen.has(participant.provider)) continue
      seen.add(participant.provider)
      targetProviders.push(participant.provider)
    }
  } else if (chat.provider) {
    targetProviders.push(chat.provider)
  }
  return targetProviders.filter((provider) => isDispatchProvider(provider))
}

function sameGrantWorkspaceBinding(left: ChatRecord, right: ChatRecord): boolean {
  // Keep raw === for chat↔chat mid-dialog cancel (pre-trim semantics).
  // Detection↔chat Accept uses trimmed sameChatGrantWorkspaceBinding instead.
  const leftScope = left.scope === 'global' ? 'global' : 'workspace'
  const rightScope = right.scope === 'global' ? 'global' : 'workspace'
  if (leftScope !== rightScope) return false
  if (leftScope === 'global') return true
  return left.workspaceId === right.workspaceId && left.workspacePath === right.workspacePath
}

function sameGrantProviderSet(left: readonly ProviderId[], right: readonly ProviderId[]): boolean {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every((provider) => rightSet.has(provider))
}

function selectionReceiptMatchesChat(
  receipt: ExternalPathSelectionReceipt,
  chat: ChatRecord,
  dispatchProviders: readonly ProviderId[]
): boolean {
  const workspaceScope = chat.scope === 'global' ? 'global' : 'workspace'
  return (
    receipt.workspaceScope === workspaceScope &&
    (workspaceScope === 'global' ||
      (receipt.workspaceId === chat.workspaceId && receipt.workspacePath === chat.workspacePath)) &&
    sameGrantProviderSet(receipt.dispatchProviders, dispatchProviders)
  )
}

export function registerExternalPathGrantHandlers(deps: ExternalPathGrantHandlersDeps): void {
  const selectionReceipts = new Map<string, ExternalPathSelectionReceipt>()
  ipcMain.handle('select-external-path-grant', async () => {
    // Deprecated pre-chat picker. It has no chat identity and therefore
    // cannot mint an executable v2 grant. Keep the IPC shape for old
    // renderers, but fail closed; callers must use the chat-aware
    // `external-path:pick-and-persist` flow below.
    return null
  })

  ipcMain.handle(
    'external-path:pick-and-persist',
    async (event, payload: ExternalPathGrantPersistPayload): Promise<PickAndPersistResult> => {
      const mainWindow = deps.getMainWindow()
      if (!mainWindow) return { ok: false, reason: 'no-window' }
      const chatId = deps.optionalString(payload?.chatId)
      if (!chatId) return { ok: false, reason: 'no-chat' }
      assertSafeChatId(chatId)
      deps.assertSenderScope(event, { capability: 'external-grant', chatId })
      const chat = deps.getChat(chatId)
      if (!chat) return { ok: false, reason: 'no-chat' }

      const access: 'read' | 'write' = payload?.access === 'write' ? 'write' : 'read'

      const dispatchProviders = grantProvidersForChat(
        chat,
        deps.isExternalPathGrantDispatchProvider
      )
      if (dispatchProviders.length === 0) {
        return { ok: false, reason: 'no-provider' }
      }

      const explicitPath = deps.optionalString(payload?.path)
      let selectedPath: string
      let bookmark: string | undefined
      let selectedKind: ExternalPathGrant['kind'] | undefined
      let selectedIdentity: { device: string; inode: string } | undefined
      let selectedPathIsCanonical = false
      let registeredExplicitWorkspace: WorkspaceRecord | undefined
      if (explicitPath) {
        const registeredExplicitPath = deps.resolveRegisteredExplicitExternalPath({
          explicitPath,
          findRegisteredWorkspace: deps.findRegisteredWorkspace,
          canonicalPath: deps.canonicalPath
        })
        if (registeredExplicitPath) {
          selectedPath = registeredExplicitPath.path
          registeredExplicitWorkspace = registeredExplicitPath.workspace
          // Registration is not a capability for a secondary renderer. Re-run
          // the sender check with the exact requested path so a chat popout
          // cannot attach a different registered workspace to its owned chat.
          deps.assertSenderScope(event, {
            capability: 'external-grant',
            chatId,
            workspacePath: selectedPath
          })
          try {
            await deps.stat(selectedPath)
          } catch {
            return { ok: false, reason: 'cancelled' }
          }
          bookmark = undefined
        } else if (
          (() => {
            // Third provenance (grant-card repair, 2026-08-04): the renderer
            // may re-grant a path the user ALREADY consented to — an existing
            // main-signed grant row for this chat and exact path — to the
            // chat's CURRENT provider set (e.g. the ensemble gained seats
            // after the original OS-dialog consent). This is re-derivation
            // from main-verified state, not renderer-forged authority: the
            // signature is verified, access never widens beyond what was
            // consented, and the path must still resolve on disk. A vanished
            // path returns 'missing-path' so the card can offer removal
            // instead of silently looping.
            const existingForPath = deps
              .collectExternalPathGrantsFromMetadata(chat.providerMetadata)
              .filter(
                (grant) =>
                  grant.path?.trim() === explicitPath &&
                  grant.issuedBy === 'main' &&
                  typeof grant.signature === 'string' &&
                  grant.signature.length > 0 &&
                  deps.verifyExternalPathGrantSignatureForGrant(grant)
              )
            const accessSatisfied =
              access === 'read' || existingForPath.some((grant) => grant.access === 'write')
            return existingForPath.length > 0 && accessSatisfied
          })()
        ) {
          let currentRealPath: string
          let currentStat: ExternalPathGrantStatLike
          try {
            currentRealPath = await deps.realpath(explicitPath)
            currentStat = await deps.stat(currentRealPath)
          } catch {
            return { ok: false, reason: 'missing-path', path: explicitPath }
          }
          selectedPath = currentRealPath
          selectedKind = currentStat.isDirectory() ? 'directory' : 'file'
          if (currentStat.dev !== undefined && currentStat.ino !== undefined) {
            selectedIdentity = { device: String(currentStat.dev), inode: String(currentStat.ino) }
          }
          selectedPathIsCanonical = true
          bookmark = deps
            .collectExternalPathGrantsFromMetadata(chat.providerMetadata)
            .find(
              (grant) => grant.path?.trim() === explicitPath && grant.securityScopedBookmark
            )?.securityScopedBookmark
        } else {
          const receiptId = deps.optionalString(payload?.selectionReceipt)
          const receipt = receiptId ? selectionReceipts.get(receiptId) : undefined
          if (receiptId) selectionReceipts.delete(receiptId)
          const receiptDispatchProviders = receipt
            ? grantProvidersForChat(chat, deps.isExternalPathGrantDispatchProvider)
            : []
          if (
            !receipt ||
            receipt.expiresAt < Date.now() ||
            receipt.senderId !== event.sender.id ||
            receipt.chatId !== chatId ||
            receipt.path !== explicitPath ||
            receipt.access !== access ||
            !selectionReceiptMatchesChat(receipt, chat, receiptDispatchProviders)
          ) {
            return { ok: false, reason: 'cancelled' }
          }
          selectedPath = receipt.path
          selectedKind = receipt.kind
          let currentRealPath: string
          let currentStat: ExternalPathGrantStatLike
          try {
            currentRealPath = await deps.realpath(receipt.path)
            currentStat = await deps.stat(currentRealPath)
          } catch {
            return { ok: false, reason: 'cancelled' }
          }
          if (
            currentRealPath !== receipt.path ||
            String(currentStat.dev ?? '') !== receipt.device ||
            String(currentStat.ino ?? '') !== receipt.inode
          ) {
            return { ok: false, reason: 'cancelled' }
          }
          selectedIdentity = { device: receipt.device, inode: receipt.inode }
          selectedPathIsCanonical = true
          bookmark = receipt.bookmark
        }
      } else {
        const accessVerb = access === 'write' ? 'can edit' : 'can read'
        const providerSummary =
          dispatchProviders.length > 1
            ? ` One grant per active provider (${dispatchProviders
                .map((provider) => deps.providerLabel(provider))
                .join(', ')}).`
            : ''
        const dialogResult = await deps.showOpenDialog(mainWindow, {
          title: `Select folder agents in this chat ${accessVerb}`,
          message: `Issues a ${
            access === 'write' ? 'read+write' : 'read-only'
          } grant scoped to this chat.${providerSummary}`,
          properties: ['openFile', 'openDirectory', 'createDirectory'],
          securityScopedBookmarks: deps.securityScopedBookmarks
        } as OpenDialogOptions)
        if (dialogResult.canceled || dialogResult.filePaths.length === 0) {
          return { ok: false, reason: 'cancelled' }
        }
        try {
          selectedPath = await deps.realpath(deps.resolvePath(dialogResult.filePaths[0]))
        } catch {
          return { ok: false, reason: 'cancelled' }
        }
        selectedPathIsCanonical = true
        bookmark = Array.isArray((dialogResult as any).bookmarks)
          ? (dialogResult as any).bookmarks[0]
          : undefined
      }
      let kind: ExternalPathGrant['kind'] = selectedKind || 'file'
      if (!selectedKind) {
        try {
          const stat = await deps.stat(selectedPath)
          kind = stat.isDirectory() ? 'directory' : 'file'
          if (stat.dev !== undefined && stat.ino !== undefined) {
            selectedIdentity = { device: String(stat.dev), inode: String(stat.ino) }
          }
        } catch {
          kind = 'file'
        }
      }

      if (payload?.deferPersist) {
        if (!selectedIdentity) return { ok: false, reason: 'cancelled' }
        const currentChat = deps.getChat(chatId)
        if (!currentChat) return { ok: false, reason: 'no-chat' }
        const currentDispatchProviders = grantProvidersForChat(
          currentChat,
          deps.isExternalPathGrantDispatchProvider
        )
        if (
          !sameGrantWorkspaceBinding(chat, currentChat) ||
          !sameGrantProviderSet(dispatchProviders, currentDispatchProviders) ||
          currentDispatchProviders.length === 0
        ) {
          return { ok: false, reason: 'cancelled' }
        }
        const now = Date.now()
        for (const [id, receipt] of selectionReceipts) {
          if (receipt.expiresAt < now) selectionReceipts.delete(id)
        }
        const selectionReceipt = `selection-${deps.randomBytes(24).toString('base64url')}`
        selectionReceipts.set(selectionReceipt, {
          senderId: event.sender.id,
          chatId,
          path: selectedPath,
          access,
          kind,
          bookmark,
          workspaceScope: currentChat.scope === 'global' ? 'global' : 'workspace',
          workspaceId: currentChat.workspaceId,
          workspacePath: currentChat.workspacePath,
          dispatchProviders: [...currentDispatchProviders],
          expiresAt: now + EXTERNAL_PATH_SELECTION_RECEIPT_TTL_MS,
          device: selectedIdentity.device,
          inode: selectedIdentity.inode
        })
        return { ok: true, grants: [], path: selectedPath, selectionReceipt }
      }

      // The picker yields to the event loop. Re-read the canonical record before
      // minting or saving anything so a revoke cannot be undone by this stale
      // snapshot. If the chat moved workspaces or its provider set changed while
      // the dialog was open, the user's original consent no longer describes the
      // target authority; fail closed and let them reopen the picker.
      const currentChat = deps.getChat(chatId)
      if (!currentChat) return { ok: false, reason: 'no-chat' }
      const currentDispatchProviders = grantProvidersForChat(
        currentChat,
        deps.isExternalPathGrantDispatchProvider
      )
      if (
        !sameGrantWorkspaceBinding(chat, currentChat) ||
        !sameGrantProviderSet(dispatchProviders, currentDispatchProviders)
      ) {
        return { ok: false, reason: 'cancelled' }
      }
      if (currentDispatchProviders.length === 0) {
        return { ok: false, reason: 'no-provider' }
      }

      const now = Date.now()
      const newGrants: ExternalPathGrant[] = currentDispatchProviders.map((provider) => {
        const grantInput: Omit<ExternalPathGrant, 'issuedBy' | 'signature'> = {
          id: `proactive-${now}-${provider}-${deps.randomBytes(4).toString('hex')}`,
          provider,
          workspaceId: registeredExplicitWorkspace?.id,
          chatId,
          path: selectedPath,
          kind,
          access,
          duration: 'thisThread',
          securityScopedBookmark: bookmark,
          createdAt: new Date(now).toISOString()
        }
        return selectedPathIsCanonical
          ? deps.issueExternalPathGrant(grantInput, { canonicalPath: selectedPath })
          : deps.issueExternalPathGrant(grantInput)
      })

      const existing = deps.collectExternalPathGrantsFromMetadata(currentChat.providerMetadata)
      const updatedChat: ChatRecord = {
        ...currentChat,
        providerMetadata: deps.canonicalizeExternalPathGrantMetadata(currentChat.providerMetadata, [
          ...existing,
          ...newGrants
        ]),
        updatedAt: now
      }
      deps.saveChat(updatedChat)
      deps.broadcastChatUpdated(updatedChat)

      return { ok: true, grants: newGrants, path: selectedPath }
    }
  )

  ipcMain.handle(
    'external-path:revoke',
    async (
      event,
      payload: ExternalPathGrantRevokePayload
    ): Promise<RevokeExternalPathGrantsResult> => {
      const chatId = deps.optionalString(payload?.chatId)
      if (!chatId) return { ok: false, reason: 'no-chat' }
      assertSafeChatId(chatId)
      deps.assertSenderScope(event, { capability: 'external-grant', chatId })
      const chat = deps.getChat(chatId)
      if (!chat) return { ok: false, reason: 'no-chat' }

      const requestedIds = Array.isArray(payload?.grantIds)
        ? [
            ...new Set(
              payload.grantIds
                .map((value) => deps.optionalString(value))
                .filter((value): value is string => Boolean(value))
            )
          ]
        : []
      if (requestedIds.length === 0) return { ok: false, reason: 'no-grants' }

      const requestedIdSet = new Set(requestedIds)
      const canonicalGrants = deps.collectExternalPathGrantsFromMetadata(chat.providerMetadata)
      const revokedGrantIds = [
        ...new Set(
          canonicalGrants.filter((grant) => requestedIdSet.has(grant.id)).map((grant) => grant.id)
        )
      ]
      if (revokedGrantIds.length === 0) {
        return { ok: true, grants: canonicalGrants, revokedGrantIds: [] }
      }

      const revokedIdSet = new Set(revokedGrantIds)
      const grants = canonicalGrants.filter((grant) => !revokedIdSet.has(grant.id))
      const updatedChat: ChatRecord = {
        ...chat,
        providerMetadata: deps.canonicalizeExternalPathGrantMetadata(chat.providerMetadata, grants),
        updatedAt: Date.now()
      }
      deps.saveChat(updatedChat)
      deps.broadcastChatUpdated(updatedChat)
      return { ok: true, grants, revokedGrantIds }
    }
  )

  ipcMain.handle('probe-external-path', async (event, absolutePath: string) => {
    deps.assertSenderCanProbeExternalPath(event)
    return deps.probeExternalPath(absolutePath)
  })

  /**
   * Silent remint for secondary workspaces the user already consented to,
   * rebound onto the chat's current primary workspace id. Used when the
   * primary was removed/re-added and old grant rows still look signed but
   * fail main's chat/workspace binding check. Paths without prior consent
   * remain as gaps for the grant prompt — never fail-closed into a skip.
   */
  ipcMain.handle(
    'external-path:repair-stale',
    async (
      event,
      payload: { chatId?: string }
    ): Promise<
      | {
          ok: true
          repairedPaths: string[]
          remainingGaps: Array<{
            path: string
            access: 'read' | 'write'
            missingProviders: ProviderId[]
          }>
        }
      | { ok: false; reason: 'no-chat' | 'no-provider' }
    > => {
      const chatId = deps.optionalString(payload?.chatId)
      if (!chatId) return { ok: false, reason: 'no-chat' }
      assertSafeChatId(chatId)
      deps.assertSenderScope(event, { capability: 'external-grant', chatId })
      const { repairStaleExternalPathGrantsForChat } = await import('../ExternalPathGrantRepair')
      const result = await repairStaleExternalPathGrantsForChat(chatId, {
        getChat: deps.getChat,
        saveChat: deps.saveChat,
        broadcastChatUpdated: deps.broadcastChatUpdated,
        collectExternalPathGrantsFromMetadata: deps.collectExternalPathGrantsFromMetadata,
        canonicalizeExternalPathGrantMetadata: deps.canonicalizeExternalPathGrantMetadata,
        grantProvidersForChat: (chat) =>
          grantProvidersForChat(chat, deps.isExternalPathGrantDispatchProvider),
        issueExternalPathGrant: deps.issueExternalPathGrant,
        verifyExternalPathGrantSignatureForGrant: deps.verifyExternalPathGrantSignatureForGrant,
        realpath: deps.realpath,
        stat: deps.stat,
        primaryWorkspacePathForChat: (chat) => {
          // Handlers don't own the workspace registry — resolve via path on the
          // chat record when present; repair still remints using issueExternalPathGrant's
          // canonical primary workspace id binding.
          const path = typeof chat.workspacePath === 'string' ? chat.workspacePath.trim() : ''
          return path || null
        },
        randomBytes: deps.randomBytes
      })
      if (!result.ok) return result
      return {
        ok: true,
        repairedPaths: result.repairedPaths,
        remainingGaps: result.remainingGaps
      }
    }
  )
}
