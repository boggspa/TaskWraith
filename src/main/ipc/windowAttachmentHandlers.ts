/**
 * Screen Watch / App Drive window attachment and sticky-AppWatch IPC.
 *
 * Extracted from `src/main/index.ts` as a behavior-preserving move: the same
 * channels, the same argument validation, the same registration order, and the
 * same refusal shapes the composition root registered inline.
 *
 * Late-bound main-process state is injected as getters rather than values. The
 * native-window coordinator and the bridge daemon are both constructed after
 * IPC registration and can be replaced or torn down while the app runs, so a
 * handler must read whichever ref is live at invocation time — capturing either
 * at registration time would pin a stale (usually null) reference.
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { NativeCapabilitySnapshot } from '../NativeCapabilities'
import {
  appDrivePreviewFrameFromDaemon,
  shouldRequestPreviewFrame,
  type AppDrivePreviewFrameResult,
  type AppDrivePreviewFrameSource
} from '../nativeWindow/AppDrivePreviewFrame'
import type {
  NativeWindowCoordinatorAccessParams,
  NativeWindowCoordinatorControlSessionAction,
  NativeWindowCoordinatorPickResult,
  NativeWindowCoordinatorRendererStatus
} from '../nativeWindow/NativeWindowCoordinator'
import type { ScopedAttachedWindowSnapshot } from '../nativeWindow/ScopedAttachedWindowState'
import { requireNonEmptyString } from '../settings/MainSanitizers'
import type { StashInput, StickyAppWatchSnapshot } from '../stickyAppWatch'

/** The coordinator surface these channels use — deliberately no wider. */
export interface WindowAttachmentCoordinatorLike {
  pick(chatId: string): Promise<NativeWindowCoordinatorPickResult>
  detach(chatId: string, generation: number): Promise<boolean>
  controlSession(
    chatId: string,
    action: NativeWindowCoordinatorControlSessionAction
  ): Promise<NativeWindowCoordinatorRendererStatus>
  statusForChat(chatId: string): NativeWindowCoordinatorRendererStatus
  getForChat(chatId: string | null | undefined): ScopedAttachedWindowSnapshot | null
  observationAccessForChat(
    chatId: string | null | undefined
  ): NativeWindowCoordinatorAccessParams | null
}

/** The bridge-daemon surface the dock preview uses — deliberately no wider. */
export interface WindowAttachmentDaemonLike {
  status(): { running: boolean }
  request<T = unknown>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number }
  ): Promise<T>
}

export interface StickyAppWatchStoreLike {
  get(chatId: string): Promise<StickyAppWatchSnapshot | null>
  stash(input: StashInput): Promise<void>
  clear(chatId: string): Promise<boolean>
}

/** Renderer-supplied stash payload. Every field is untrusted. */
export interface StickyAppWatchStashRequest {
  chatId: string
  windowMeta: StickyAppWatchSnapshot['windowMeta']
  attachedAt: string
  wasStreaming: boolean
}

export interface WindowAttachmentHandlersDeps {
  assertSenderChatScope: (event: IpcMainInvokeEvent, chatId: string) => void
  getNativeCapabilities: () => NativeCapabilitySnapshot
  getNativeWindowCoordinator: () => WindowAttachmentCoordinatorLike | null
  getBridgeDaemon: () => WindowAttachmentDaemonLike | null
  stickyAppWatchStore: StickyAppWatchStoreLike
}

export function registerWindowAttachmentHandlers(deps: WindowAttachmentHandlersDeps): void {
  // Screen Watch is observation-first. The coordinator owns the private
  // daemon scope and may offer a separate, exact-run View & Control decision
  // only after the user picks one canonical window.
  ipcMain.handle('attach-window:pick', async (event, chatId: string) => {
    const canonicalChatId = requireNonEmptyString(chatId, 'Chat')
    deps.assertSenderChatScope(event, canonicalChatId)
    const nativeCapabilities = deps.getNativeCapabilities()
    if (!nativeCapabilities.screenWatch.available) {
      throw new Error(
        nativeCapabilities.screenWatch.reason || 'Screen Watch is unavailable on this host.'
      )
    }
    const coordinator = deps.getNativeWindowCoordinator()
    if (!coordinator) throw new Error('Native-window coordination is not ready.')
    return coordinator.pick(canonicalChatId)
  })

  ipcMain.handle('attach-window:detach', async (event, chatId: string, generation: number) => {
    const canonicalChatId = requireNonEmptyString(chatId, 'Chat')
    deps.assertSenderChatScope(event, canonicalChatId)
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new Error('Attachment generation must be a positive integer.')
    }
    const coordinator = deps.getNativeWindowCoordinator()
    if (!coordinator) throw new Error('Native-window coordination is not ready.')
    const detached = await coordinator.detach(canonicalChatId, generation)
    return {
      detached,
      status: coordinator.statusForChat(canonicalChatId)
    }
  })

  ipcMain.handle('attach-window:control-session', async (event, chatId: string, action: string) => {
    const canonicalChatId = requireNonEmptyString(chatId, 'Chat')
    deps.assertSenderChatScope(event, canonicalChatId)
    if (action !== 'pause' && action !== 'resume' && action !== 'takeover' && action !== 'stop') {
      throw new Error('Unknown App Drive session action.')
    }
    const coordinator = deps.getNativeWindowCoordinator()
    if (!coordinator) throw new Error('Native-window coordination is not ready.')
    return coordinator.controlSession(canonicalChatId, action)
  })

  ipcMain.handle('attach-window:status', (event, chatId: string) => {
    const canonicalChatId = requireNonEmptyString(chatId, 'Chat')
    deps.assertSenderChatScope(event, canonicalChatId)
    const coordinator = deps.getNativeWindowCoordinator()
    if (!coordinator) throw new Error('Native-window coordination is not ready.')
    return coordinator.statusForChat(canonicalChatId)
  })

  // App Drive dock preview. The user's own view of the window they attached,
  // rendered locally — this mints no lease, admits no action, consumes no
  // step budget, and sends nothing to a provider. It is NOT secret-redacted;
  // see AppDrivePreviewFrame before putting any redaction claim on this
  // surface. Refusals are returned, never thrown: an absent frame is the
  // ordinary state while a stream warms up.
  ipcMain.handle(
    'attach-window:preview-frame',
    async (event, chatId: string): Promise<AppDrivePreviewFrameResult> => {
      const canonicalChatId = requireNonEmptyString(chatId, 'Chat')
      deps.assertSenderChatScope(event, canonicalChatId)
      const coordinator = deps.getNativeWindowCoordinator()
      if (!coordinator) return { ok: false, reason: 'no_attachment' }
      // getForChat applies the live protected-host check and can revoke the
      // attachment, so read it before the access envelope: if it cleared,
      // observationAccessForChat returns null and this fails closed.
      const attachment = coordinator.getForChat(canonicalChatId)
      const access = attachment ? coordinator.observationAccessForChat(canonicalChatId) : null
      if (!attachment || !access) return { ok: false, reason: 'no_attachment' }
      if (!shouldRequestPreviewFrame({ observation: attachment })) {
        return { ok: false, reason: 'no_frame' }
      }
      const daemon = deps.getBridgeDaemon()
      if (!daemon?.status().running) return { ok: false, reason: 'no_frame' }
      let source: AppDrivePreviewFrameSource
      try {
        source = await daemon.request<AppDrivePreviewFrameSource>('appwatch.latestFrame', access, {
          timeoutMs: 10_000
        })
      } catch {
        // A dock preview never surfaces daemon errors as a failed IPC — the
        // panel just keeps showing its placeholder.
        return { ok: false, reason: 'no_frame' }
      }
      // Re-read the attachment after the await: a frame captured under a
      // superseded generation must not be projected under the new target.
      const current = coordinator.getForChat(canonicalChatId)
      if (!current || current.generation !== attachment.generation) {
        return { ok: false, reason: 'no_attachment' }
      }
      return appDrivePreviewFrameFromDaemon({ source, generation: current.generation })
    }
  )

  // M11 (1.0.7) — sticky AppWatch. The renderer stashes a chat's attachment
  // metadata on auto-detach and asks for it back when the user returns to the
  // owning chat (to offer "Resume watching <app>"). Persisted so it survives a
  // restart. macOS can't silently re-grant a window (SCContentSharingPicker is
  // interactive), so this is metadata for the resume affordance, never a live
  // grant.
  ipcMain.handle('sticky-appwatch:get', async (event, chatId: string) => {
    const canonicalChatId = requireNonEmptyString(chatId, 'Chat')
    deps.assertSenderChatScope(event, canonicalChatId)
    return { snapshot: await deps.stickyAppWatchStore.get(canonicalChatId) }
  })
  ipcMain.handle('sticky-appwatch:stash', async (event, input: StickyAppWatchStashRequest) => {
    const canonicalChatId = requireNonEmptyString(input?.chatId, 'Chat')
    deps.assertSenderChatScope(event, canonicalChatId)
    await deps.stickyAppWatchStore.stash({
      chatId: canonicalChatId,
      windowMeta: input?.windowMeta,
      attachedAt: String(input?.attachedAt || new Date().toISOString()),
      wasStreaming: Boolean(input?.wasStreaming),
      stashedAt: new Date().toISOString()
    })
    return { ok: true }
  })
  ipcMain.handle('sticky-appwatch:clear', async (event, chatId: string) => {
    const canonicalChatId = requireNonEmptyString(chatId, 'Chat')
    deps.assertSenderChatScope(event, canonicalChatId)
    await deps.stickyAppWatchStore.clear(canonicalChatId)
    return { ok: true }
  })
}
