import type { IpcMainInvokeEvent } from 'electron'
import { isDirectoryComposerAttachment } from '../../shared/composerAttachment'
import type { isEnsembleRoundDispatchLive } from '../../shared/ensembleRoundLifecycle'
import { parseProjectReferenceContextSelection } from '../../shared/projectReferenceContext'
import type { DiscordContextSnapshot } from '../channels/DiscordContextService'
import {
  authorizeAttachmentRecords,
  authorizeThenExpandAttachmentRecords
} from '../RendererAttachmentAuthorization'
import { midRunSteeringAbsorbEligible } from '../run/MidRunSteering'
import {
  ensembleDmTargetResolutionError,
  resolveEnsembleDmTargetForDispatch
} from '../services/EnsembleMentionAlias'
import type { EnsembleOrchestrator } from '../services/EnsembleOrchestrator'
import type { PdfAttachmentLike } from '../services/PdfAttachmentRenderService'
import type { ChatRecord, EnsembleFanoutPolicy, ExternalPathGrant } from '../store/types'

/**
 * Local alias mirroring the composition root (`index.ts`) and the Gemini CLI
 * handler module: only the sender side of the invoke event is ever inspected.
 */
type RendererSenderEvent = Pick<IpcMainInvokeEvent, 'sender'>

type EnsembleRoundOrchestrator = Pick<EnsembleOrchestrator, 'absorbMidRunSteering' | 'startRound'>

/**
 * Collaborators owned by the composition root. The orchestrator is read through
 * a getter on every invocation because `ensembleOrchestratorRef` is a mutable
 * module-level binding assigned AFTER IPC registration — capturing it by value
 * here would pin `null` for the life of the process.
 */
export interface EnsembleRoundHandlerDeps {
  getEnsembleOrchestrator: () => EnsembleRoundOrchestrator | null
  isEnsembleModeEnabled: () => boolean
  getChat: (chatId: string) => ChatRecord | null | undefined
  awaitChatRecordPersisted: (chatId: string) => Promise<void>
  requireNonEmptyString: (value: unknown, label: string) => string
  /** Main renderers may address every chat; secondary renderers are scoped. */
  assertSenderChatScope: (event: IpcMainInvokeEvent, chatId: string) => void
  /** Throws when a scheduled round currently forbids interactive dispatch. */
  assertScheduledEnsembleInteractiveAvailable: (chatId: string) => void
  imageAttachmentSnapshots: (
    value: unknown
  ) => Array<{ id?: string; path: string; name?: string; kind?: 'directory' }>
  resolveRendererAttachmentPaths: (event: RendererSenderEvent, rawPaths: unknown) => string[]
  expandPdfAttachmentsForDispatch: <T extends PdfAttachmentLike>(
    attachments: T[],
    appChatId: string
  ) => Promise<Array<T | { id: string; path: string; name: string }>>
  normalizeExternalPathGrants: (grants?: ExternalPathGrant[]) => ExternalPathGrant[]
  ensembleRoundLiveForSteerAbsorb: (
    chatId: string,
    round: Parameters<typeof isEnsembleRoundDispatchLive>[0]
  ) => boolean
}

export interface RunEnsembleRoundPayload {
  chatId?: string
  prompt?: string
  mode?: 'normal' | 'queue' | 'steer'
  concurrentMode?: boolean
  fanoutPolicy?: EnsembleFanoutPolicy
  imageAttachments?: Array<{
    id?: string
    path?: string
    name?: string
    kind?: 'file' | 'directory'
  }>
  imageThumbnails?: Array<{
    dataBase64: string
    mimeType: string
    width?: number
    height?: number
  }>
  discordContextSnapshots?: DiscordContextSnapshot[]
  dmTargetParticipantId?: string
  exactPickerParticipantId?: string
  externalPathGrants?: ExternalPathGrant[]
  scheduledTaskId?: string
  projectReferenceContextSelection?: unknown
  /**
   * Rewind-from-message ("Edit & resend from here") restart hints,
   * honoured only with `mode: 'steer'` — see
   * EnsembleRewindRoundOptions on the orchestrator.
   */
  rewind?: {
    resumeFromParticipantId?: unknown
    suppressPromptEcho?: unknown
  }
}

export type RunEnsembleRoundResult =
  | ReturnType<EnsembleRoundOrchestrator['absorbMidRunSteering']>
  | ReturnType<EnsembleRoundOrchestrator['startRound']>
  | undefined

/**
 * Body of the `run-ensemble-round` IPC handler. The `ipcMain.handle(...)`
 * REGISTRATION deliberately stays in `index.ts`: StartupWindowGate pins the
 * channel string positionally and projectReferenceContextDispatch pins the
 * exact `ipcMain.handle(\n      'run-ensemble-round'` shape, so moving the
 * registration would red those suites. Do not "complete" this extraction by
 * moving the handle call — the split is intentional.
 */
export async function handleRunEnsembleRound(
  deps: EnsembleRoundHandlerDeps,
  event: IpcMainInvokeEvent,
  payload: RunEnsembleRoundPayload
): Promise<RunEnsembleRoundResult> {
  if (!deps.isEnsembleModeEnabled()) {
    throw new Error('Ensemble Mode is disabled.')
  }
  const chatId = deps.requireNonEmptyString(payload?.chatId, 'Ensemble chat id')
  deps.assertSenderChatScope(event, chatId)
  if (Object.prototype.hasOwnProperty.call(payload, 'scheduledTaskId')) {
    throw new Error('Renderer scheduled-round dispatch is retired; MAIN owns every occurrence.')
  }
  const imageAttachments = deps.imageAttachmentSnapshots(payload?.imageAttachments)
  const prompt = typeof payload?.prompt === 'string' ? payload.prompt : ''
  const projectReferenceContextSelection = parseProjectReferenceContextSelection(
    payload?.projectReferenceContextSelection
  )
  if (
    Object.prototype.hasOwnProperty.call(payload, 'projectReferenceContextSelection') &&
    payload.projectReferenceContextSelection != null &&
    !projectReferenceContextSelection
  ) {
    throw new Error('Project reference context selection is invalid.')
  }
  // P1 F6 — reference-only Use-next sends are valid for ensemble rounds.
  if (!prompt.trim() && imageAttachments.length === 0 && !projectReferenceContextSelection) {
    throw new Error('Ensemble prompt, attachment, or Project reference selection is required.')
  }
  const folderAttachments = imageAttachments.filter(isDirectoryComposerAttachment)
  const fileAttachments = imageAttachments.filter(
    (attachment) => !isDirectoryComposerAttachment(attachment)
  )
  const dispatchFolderAttachments = authorizeAttachmentRecords(folderAttachments, (paths) =>
    deps.resolveRendererAttachmentPaths(event, paths)
  )
  const dispatchFileAttachments = await authorizeThenExpandAttachmentRecords(
    fileAttachments,
    (paths) => deps.resolveRendererAttachmentPaths(event, paths),
    (authorizedAttachments) => deps.expandPdfAttachmentsForDispatch(authorizedAttachments, chatId)
  )
  const dispatchImageAttachments = [...dispatchFolderAttachments, ...dispatchFileAttachments]
  // 1.0.4-AT4 — normalize the renderer-supplied grants the
  // same way solo-run dispatch does. Drops malformed entries
  // and produces an [] when nothing is granted.
  const externalPathGrantInput = payload?.externalPathGrants
  const externalPathGrants = Array.isArray(externalPathGrantInput)
    ? deps.normalizeExternalPathGrants(externalPathGrantInput as ExternalPathGrant[])
    : []
  const discordContextSnapshots = Array.isArray(payload?.discordContextSnapshots)
    ? payload.discordContextSnapshots
    : []
  deps.assertScheduledEnsembleInteractiveAvailable(chatId)
  const ensembleChat = deps.getChat(chatId)
  if (!ensembleChat?.ensemble) {
    throw new Error('Ensemble chat not found.')
  }
  // MAIN owns participant routing. The renderer's id is advisory because
  // its roster snapshot can be stale and its historical plain-mention
  // resolver selected the first seat for duplicate aliases. Re-resolve
  // the prompt against the current roster. Structured legacy links and a
  // separately transported picker selection retain exact identity, while
  // ambiguous or stale targets fail before launch.
  // `participants` is declared required, so tsc sees nothing here -- but a
  // catalogue projection drops it once the chrome budget is spent, and the
  // alias resolver then dereferences undefined. Refuse with a named error
  // instead of a TypeError the renderer cannot classify.
  const roster = ensembleChat.ensemble.participants
  if (!Array.isArray(roster)) {
    throw new Error('Ensemble roster is unavailable; reopen the thread and retry.')
  }
  const dmTargetResolution = resolveEnsembleDmTargetForDispatch({
    text: prompt,
    participants: roster,
    advisoryParticipantId: payload?.dmTargetParticipantId,
    exactPickerParticipantId: payload?.exactPickerParticipantId
  })
  const dmTargetError = ensembleDmTargetResolutionError(dmTargetResolution, roster)
  if (dmTargetError) throw new Error(dmTargetError)
  const dmTargetParticipantId =
    dmTargetResolution.kind === 'target' ? dmTargetResolution.participantId : undefined
  // Rewind-from-message restart hints (steer-mode only). Both fields are
  // advisory routing hints, never authority: MAIN re-resolves the seat id
  // against the canonical roster inside beginRound and fails soft to the
  // full rotation order, and a resolved DM target already scopes the
  // round to one seat, which makes a resume anchor meaningless.
  const rewindInput = payload?.mode === 'steer' ? payload?.rewind : undefined
  const rewindResumeFromParticipantId =
    typeof rewindInput?.resumeFromParticipantId === 'string' &&
    rewindInput.resumeFromParticipantId.trim().length > 0 &&
    !dmTargetParticipantId
      ? rewindInput.resumeFromParticipantId.trim()
      : undefined
  const rewind =
    rewindInput && (rewindResumeFromParticipantId || rewindInput.suppressPromptEcho === true)
      ? {
          ...(rewindResumeFromParticipantId
            ? { resumeFromParticipantId: rewindResumeFromParticipantId }
            : {}),
          ...(rewindInput.suppressPromptEcho === true ? { suppressPromptEcho: true as const } : {})
        }
      : undefined
  // Mid-run steering: any steer into a LIVE round is absorbed — appended
  // immediately and delivered at the next hop — instead of cancelling
  // the active speaker and restarting. Attachments / DM / grants /
  // discord context merge onto the live runtime. Idle chats still
  // beginRound via startRound below.
  const steerAbsorbRound = deps.getChat(chatId)?.ensemble?.activeRound
  if (
    steerAbsorbRound &&
    midRunSteeringAbsorbEligible({
      mode: payload?.mode,
      roundLive: deps.ensembleRoundLiveForSteerAbsorb(chatId, steerAbsorbRound),
      text: prompt,
      hasImageAttachments: dispatchImageAttachments.length > 0,
      hasDmTarget: Boolean(dmTargetParticipantId),
      hasDiscordContext: discordContextSnapshots.length > 0,
      hasExternalPathGrants: externalPathGrants.length > 0
    })
  ) {
    const absorbed = deps.getEnsembleOrchestrator()?.absorbMidRunSteering({
      chatId,
      text: prompt,
      roundId: steerAbsorbRound.roundId,
      imageAttachments: dispatchImageAttachments,
      ...(payload?.imageThumbnails?.length ? { imageThumbnails: payload.imageThumbnails } : {}),
      ...(dmTargetParticipantId ? { dmTargetParticipantId } : {}),
      ...(externalPathGrants.length > 0 ? { externalPathGrants } : {}),
      ...(discordContextSnapshots.length > 0 ? { discordContextSnapshots } : {})
    })
    if (absorbed?.status === 'steered') {
      // Durability barrier: the absorbed steer row must be persisted
      // through the Host before this handler reports success.
      await deps.awaitChatRecordPersisted(chatId)
      return absorbed
    }
  }
  // P1 F6 — Use-next selection is stored on the round runtime and
  // re-resolved per seat into the Project reference prompt appendix.
  const ensembleStartResult = deps.getEnsembleOrchestrator()?.startRound({
    chatId,
    prompt,
    event,
    mode: payload?.mode || 'normal',
    ...(payload?.concurrentMode !== undefined
      ? {
          concurrentMode: Boolean(payload.concurrentMode)
        }
      : {}),
    ...(payload?.fanoutPolicy !== undefined ? { fanoutPolicy: payload.fanoutPolicy } : {}),
    imageAttachments: dispatchImageAttachments,
    ...(discordContextSnapshots.length > 0 ? { discordContextSnapshots } : {}),
    ...(dmTargetParticipantId ? { dmTargetParticipantId } : {}),
    ...(externalPathGrants.length > 0 ? { externalPathGrants } : {}),
    ...(projectReferenceContextSelection ? { projectReferenceContextSelection } : {}),
    ...(rewind ? { rewind } : {})
  })
  if (ensembleStartResult?.status === 'started' || ensembleStartResult?.status === 'steered') {
    // Durability barrier: the round-started record must be persisted
    // through the Host before this handler reports success.
    await deps.awaitChatRecordPersisted(chatId)
  }
  return ensembleStartResult
}
