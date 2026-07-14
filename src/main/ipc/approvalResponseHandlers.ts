import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { promises as fs } from 'fs'
import { randomBytes } from 'crypto'
import type { AgentApprovalAction, ChatRecord, ExternalPathGrant } from '../store/types'
import type { ApprovalService } from '../services/ApprovalService'
import {
  canonicalizeExternalPathGrantMetadata,
  collectExternalPathGrantsFromMetadata
} from '../store/ExternalPathGrants'

/**
 * approvalResponseHandlers — M3-3d approval-cluster extraction (per
 * `design-m3-3d-spec`). The LAST M3-3 slice: the `respond-agent-approval` IPC
 * endpoint that resolves a pending approval and, for external-path grant
 * actions, issues + persists a signed grant onto the chat before resolving.
 *
 * SHAPE-APPROPRIATE HOME: this is an `ipcMain.handle` ENDPOINT (response side),
 * so it lives in `ipc/` as a registrar — mirroring externalPathGrantHandlers.ts /
 * approvalLedgerHandlers.ts — NOT in `run/ApprovalOrchestration.ts` (which holds
 * the request-side orchestrators). Forcing this mixed-concern endpoint (resolve +
 * grant-issuance + chat-persist) into the pure-orchestration module would pollute
 * that module's dep surface the same way `ensureWorkspaceTrustForRun` would have.
 *
 * SECURITY-PRESERVING (co-move-FORBIDDEN ordering, design-m3-3-spec invariant #5):
 * for a grant action, the sequence
 *   fs.stat (kind probe) → issueExternalPathGrant (secret-bound signature)
 *   → getChat → canonicalize+collect grant metadata → saveChat (PERSIST)
 *   → broadcastChatUpdated (BROADCAST)
 * runs verbatim INSIDE the outer try/catch, and `resolve` runs LAST, OUTSIDE the
 * try — so it ALWAYS fires (partial-failure safety) but only AFTER the grant is
 * durably persisted. A reorder that let `resolve` fire before persist is a
 * partial-failure safety hole, not a behaviour change. `approvalResponseHandlers.
 * test.ts` fences this ordering.
 *
 * LATE-BINDING (design-rule-seam-bundle-latebinding, pattern B): `approvalService`
 * is injected BY VALUE — correct here, NOT the lazy accessor the request-side
 * seams needed. This registrar is called INSIDE whenReady, AFTER
 * `approvalServiceInstance` is constructed, so the captured value is live +
 * non-null. The registrar structurally cannot run pre-construction, so it can
 * never hit the stale-null bug the module-scope bundles risked.
 */
export interface ApprovalResponseHandlerDeps {
  approvalService: Pick<
    ApprovalService,
    'getPendingExternalPathDetection' | 'resolve'
  >
  assertSenderCanRespond: (event: IpcMainInvokeEvent, requestId: string) => void
  issueExternalPathGrant: (
    grant: Omit<ExternalPathGrant, 'issuedBy' | 'signature'>
  ) => ExternalPathGrant
  getChat: (chatId: string) => ChatRecord | null | undefined
  saveChat: (chat: ChatRecord) => void
  broadcastChatUpdated: (chat: ChatRecord) => void
}

export function registerApprovalResponseHandlers(deps: ApprovalResponseHandlerDeps): void {
  ipcMain.handle(
    'respond-agent-approval',
    async (event, requestId: string, action: AgentApprovalAction, intentNote?: string) => {
      deps.assertSenderCanRespond(event, requestId)
      // Order-4 — optional one-line "why" note captured in the
      // approval card. Trim + cap defensively (the renderer already
      // trims, but the IPC boundary is untrusted) and ride it on the
      // existing ledger metadata channel as `intentNote`. Empty stays
      // off the metadata entirely so we never persist a blank note.
      const trimmedIntentNote =
        typeof intentNote === 'string' ? intentNote.trim().slice(0, 280) : ''
      const resolveOptions = trimmedIntentNote
        ? { extraMetadata: { intentNote: trimmedIntentNote } }
        : undefined
      let actionToResolve = action
      // Slice 5 v2 of the external-path-redesign arc. When the user
      // clicks "Grant read access" / "Grant edit access" in an
      // external-path approval modal, peek at the pending approval's stashed
      // externalPathDetection BEFORE resolving — issue a signed grant
      // and persist it onto the chat's providerMetadata so the secondary
      // above-row appears the moment the modal closes.
      if (action === 'grantExternalPathRead' || action === 'grantExternalPathEdit') {
        const detection = deps.approvalService.getPendingExternalPathDetection(requestId)
        // A read grant can be useful for later reads, but it must never approve
        // the write operation that is currently paused. Persist the narrower
        // grant, then reject this one write request. The user must explicitly
        // choose edit access to let a pending mutation proceed.
        if (action === 'grantExternalPathRead' && detection?.access === 'write') {
          actionToResolve = 'declineExternalPath'
        }
        if (detection?.path && detection.appChatId) {
          try {
            const grantAccess: 'read' | 'write' =
              action === 'grantExternalPathEdit' ? 'write' : 'read'
            // Probe synchronously to determine file vs directory.
            // Best-effort — fall back to 'file' on any error.
            let grantKind: 'file' | 'directory' = 'file'
            try {
              const stat = await fs.stat(detection.path)
              if (stat.isDirectory()) grantKind = 'directory'
            } catch {
              /* keep default */
            }
            const grant = deps.issueExternalPathGrant({
              id: `runtime-${Date.now()}-${randomBytes(4).toString('hex')}`,
              provider: detection.provider,
              workspaceId: undefined,
              chatId: detection.appChatId,
              path: detection.path,
              kind: grantKind,
              access: grantAccess,
              duration: 'thisThread',
              securityScopedBookmark: undefined,
              createdAt: new Date().toISOString()
            })
            const chat = deps.getChat(detection.appChatId)
            if (chat) {
              const updatedChat = {
                ...chat,
                providerMetadata: canonicalizeExternalPathGrantMetadata(chat.providerMetadata, [
                  ...collectExternalPathGrantsFromMetadata(chat.providerMetadata),
                  grant
                ]),
                updatedAt: Date.now()
              }
              deps.saveChat(updatedChat)
              deps.broadcastChatUpdated(updatedChat)
            }
          } catch (err) {
            console.warn('[ExternalPathGrant] runtime grant persistence failed', err)
          }
        }
      }
      return deps.approvalService.resolve(requestId, actionToResolve, resolveOptions)
    }
  )
}
