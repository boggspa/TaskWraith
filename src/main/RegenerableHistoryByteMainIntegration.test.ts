import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

function between(start: string, end: string): string {
  const startAt = source.indexOf(start)
  const endAt = source.indexOf(end, startAt + start.length)
  expect(startAt, `missing start anchor: ${start}`).toBeGreaterThanOrEqual(0)
  expect(endAt, `missing end anchor: ${end}`).toBeGreaterThan(startAt)
  return source.slice(startAt, endAt)
}

describe('regenerable history-byte main integration', () => {
  it('initializes and recovers the store before any media protocol or run-queue work', () => {
    const migration = source.indexOf('migrateLegacyUserDataSync()')
    const initialize = source.indexOf('await regenerableHistoryByteStore.initializeStrict(')
    const mediaProtocol = source.indexOf('session.defaultSession.webRequest.onBeforeRequest(')
    const runQueue = source.indexOf('const runQueueService = new RunQueueService({')

    expect(migration).toBeGreaterThanOrEqual(0)
    expect(initialize).toBeGreaterThan(migration)
    expect(initialize).toBeLessThan(mediaProtocol)
    expect(mediaProtocol).toBeLessThan(runQueue)
    expect(source).not.toContain('sweepMediaStagingDir')
  })

  it('uses synchronous reservations for every PDF, dictation, staged-input, and produced-output path', () => {
    const helper = between(
      'async function stageWorkspaceMediaSnapshotInHistoryStore(',
      'function allocateProducedMediaStagingPath('
    )
    expect(helper.indexOf("regenerableHistoryByteStore.begin('media')")).toBeLessThan(
      helper.indexOf('await stageWorkspaceMediaSnapshot({')
    )
    expect(helper).toContain('regenerableHistoryByteStore.isCurrent(reservation)')

    const dictation = between(
      'async function transcribeComposerAudioPayload(',
      'const ffmpegToolExecutors = createFfmpegToolExecutors({'
    )
    expect(dictation.indexOf("regenerableHistoryByteStore.begin('media')")).toBeLessThan(
      dictation.indexOf('await fs.writeFile(sourcePath, wav')
    )
    expect(dictation).toContain('regenerableHistoryByteStore.isCurrent(reservation)')
    expect(dictation).toContain('completeRegenerableHistoryByteOperation({')
    expect(dictation).toContain(
      'release: () => endRegenerableHistoryByteReservation(reservation)'
    )

    const pdf = between(
      'async function renderPdfPagesForAttachments(',
      'async function expandPdfAttachmentsForDispatch'
    )
    expect(pdf.indexOf("regenerableHistoryByteStore.begin('pdf')")).toBeLessThan(
      pdf.indexOf('await renderPdfAttachmentPages(')
    )
    expect(pdf).toContain('regenerableHistoryByteStore.isCurrent(reservation)')
    expect(pdf).toContain('assertPdfRenderReservationCurrent(reservation')
    expect(pdf).toContain("'authority_revoked'")
    expect(pdf).toContain('retry the dispatch after deletion completes')
    expect(pdf).toContain('if (result.skipped.length > 0)')
    expect(pdf).toContain('pdfAttachmentIncompleteRenderError()')
    expect(pdf).toContain('mediaStore.writeOwnedContentAddressedFromFile({')
    expect(pdf).toContain('const ownerChatId = appChatId.trim()')
    expect(pdf).toContain('appChatId: ownerChatId')
    expect(pdf.indexOf('mediaStore.commitOwnedFileWrite(entry.receipt)')).toBeLessThan(
      pdf.indexOf('endRegenerableHistoryByteReservation(reservation)')
    )

    const soloExpansion = between(
      'async function expandPdfImagePathsForPayload(',
      'function isPathInsideRoot('
    )
    expect(soloExpansion).toContain('if (rendered.length === 0) throw pdfAttachmentNoPagesError()')
    expect(soloExpansion.indexOf('if (rendered.length === 0)')).toBeLessThan(
      soloExpansion.indexOf('payload.imagePaths =')
    )

    const graphDispatch = between(
      'const dispatchMainOwnedExecutionGraphAttempt =',
      'executionGraphAttemptDispatcher = dispatchMainOwnedExecutionGraphAttempt'
    )
    expect(graphDispatch).toContain('await expandPdfImagePathsForPayload(entry.payload)')
    expect(graphDispatch).not.toContain('graph expansion failed')

    expect(source.match(/stageWorkspaceMediaSnapshotInHistoryStore\(\{/g)).toHaveLength(4)
    expect(source.match(/allocateProducedMediaStagingPath\(ext\)/g)).toHaveLength(2)
    expect(source).not.toContain('MEDIA_STAGING_DIR')
  })

  it('materializes PDF previews while their cache lease is live', () => {
    const preview = between(
      'const readImageViaMacImageServices = async (',
      'registerMediaAssetHandlers({'
    )
    const handler = between(
      "ipcMain.handle('read-image-preview'",
      'registerMediaAssetHandlers({'
    )
    const pdfPreview = between(
      'if (isPdfAttachmentPath(real)) {',
      '} else {\n          if (stat.size > IMAGE_PREVIEW_MAX_BYTES)'
    )
    const beginAt = pdfPreview.indexOf("regenerableHistoryByteStore.begin('pdf')")
    const renderAt = pdfPreview.indexOf('await renderPdfAttachmentPages(')
    const materializeAt = pdfPreview.indexOf('nativeImage.createFromPath(firstPage)')
    const finalCheckAt = pdfPreview.lastIndexOf(
      'regenerableHistoryByteStore.isCurrent(reservation)'
    )
    const releaseAt = pdfPreview.indexOf('endRegenerableHistoryByteReservation(reservation)')
    expect(beginAt).toBeGreaterThanOrEqual(0)
    expect(renderAt).toBeGreaterThan(beginAt)
    expect(materializeAt).toBeGreaterThan(renderAt)
    expect(finalCheckAt).toBeGreaterThan(materializeAt)
    expect(releaseAt).toBeGreaterThan(finalCheckAt)
    expect(preview).toContain("fs.mkdtemp(join(reservation.root, '.image-preview-'))")
    expect(preview).toContain('await fs.rm(tempDir, { recursive: true, force: true })')
    expect(preview).not.toContain('taskwraith-image-preview-')
    expect(preview).not.toContain("join(os.tmpdir(), 'taskwraith-image-preview-')")
    expect(handler).toContain('readImageViaMacImageServices(firstPage, reservation)')
    expect(handler).toContain("regenerableHistoryByteStore.begin('media')")
  })

  it('cancels every Ensemble history authority, including orphan timers without an active round', () => {
    const lifecycle = between(
      'const beginChatHistoryMutation = ',
      'const revokeApprovalsForChat = '
    )
    expect(lifecycle.indexOf('historyClearAdmissionGate.beginChat(chatId)')).toBeLessThan(
      lifecycle.indexOf('const beginEnsembleHistoryClear = ')
    )
    const scopedEnsembleClear = between(
      'const beginEnsembleHistoryClear = ',
      'const revokeApprovalsForChat = '
    )
    expect(scopedEnsembleClear).toContain(
      "const expectedRoundId = round?.status === 'running' ? round.roundId : undefined"
    )
    expect(scopedEnsembleClear).toContain(
      ".cancelRoundForHistory(chatId, 'chat history cleared', expectedRoundId)"
    )
    expect(scopedEnsembleClear).not.toContain("round?.status !== 'running'")
    expect(scopedEnsembleClear).not.toContain('if (!expectedRoundId)')

    const broadEnsembleClear = between(
      'const beginBroadEnsembleHistoryClear = ',
      'const broadSoloWakeupHistoryScope = '
    )
    expect(broadEnsembleClear).toContain(
      "const expectedRoundId = round?.status === 'running' ? round.roundId : undefined"
    )
    expect(broadEnsembleClear).toContain(
      ".cancelRoundForHistory(chatId, 'chat history cleared', expectedRoundId)"
    )
    expect(broadEnsembleClear).not.toContain("round?.status !== 'running'")
    expect(broadEnsembleClear).not.toContain('if (!expectedRoundId)')
    const scoped = between(
      'const scopedHistoryDeletionCoordinator = new ScopedHistoryDeletionCoordinator({',
      'const deleteChatWithLifecycle = '
    )
    expect(scoped).toContain('beginEnsembleClear: beginEnsembleHistoryClear')

    const broad = between(
      'type BroadHistoryDeletionHolds = {',
      'const clearBroadChatHistory = '
    )
    expect(broad).toContain('ensemblePurges: Map<string, BroadHistoryStrictAttempt>')
    expect(broad).toContain('beginBroadEnsembleHistoryClear(chatId)')
    expect(broad).toContain(
      'await Promise.all([...holds.ensemblePurges.values()].map((attempt) => attempt.promise))'
    )
  })

  it('bundles derived bytes into the durable media receipt and releases only after outer commit', () => {
    const broad = between('type BroadHistoryDeletionHolds = {', 'const clearBroadChatHistory = ')
    expect(broad).toContain('derivedByteHold: RegenerableHistoryByteHistoryHold')
    expect(broad).toContain('regenerableHistoryByteStore.beginHistoryMutation(')
    expect(broad).toContain('await regenerableHistoryByteStore.purgeStrict(holds.derivedByteHold)')
    const commitAt = broad.indexOf('AppStore.commitPreparedHistoryDeletion(operationId)')
    const releaseAt = broad.indexOf(
      'regenerableHistoryByteStore.endHistoryMutation(holds.derivedByteHold)'
    )
    expect(commitAt).toBeGreaterThanOrEqual(0)
    expect(releaseAt).toBeGreaterThan(commitAt)

    const scoped = between('type ScopedMediaHistoryHold = {', 'const deleteChatWithLifecycle = ')
    expect(scoped).toContain('derived: regenerableHistoryByteStore.beginHistoryMutation(')
    expect(scoped).toContain('await regenerableHistoryByteStore.purgeStrict(scopedHold.derived)')
    expect(scoped).toContain('regenerableHistoryByteStore.endHistoryMutation(scopedHold.derived)')
  })
})
