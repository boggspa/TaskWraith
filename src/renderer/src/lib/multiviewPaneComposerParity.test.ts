import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

function paneComposerContextKeys(source: string): string[][] {
  const sourceFile = ts.createSourceFile(
    'App.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const contexts: string[][] = []

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'paneComposerCtx' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      const keys = node.initializer.properties.flatMap((property) => {
        if (ts.isSpreadAssignment(property)) return []
        if (!property.name) return []
        if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) {
          return [property.name.text]
        }
        return []
      })
      contexts.push(keys)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return contexts
}

describe('Multiview pane Composer context parity', () => {
  it('routes memoized and ref-ahead panes through one explicit prop surface', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
    const contexts = paneComposerContextKeys(source)
    const renderStart = source.indexOf('const renderMultiviewPaneCell =')
    const renderEnd = source.indexOf('// `buildPaneComposerCtx`', renderStart)
    const render = source.slice(renderStart, renderEnd)

    expect(contexts).toHaveLength(1)
    expect(contexts[0]).toHaveLength(new Set(contexts[0]).size)
    expect(render).toContain(
      'const memoizedPaneComposerCtx = paneComposerCtxByKey[paneComposerKey]'
    )
    expect(render).toContain('const fresh = buildPaneComposerCtx(viewerChatId, viewerPaneIndex)')
    expect(render).toContain('paneComposerRuntimeRegistryRef.current.stabilize(')
    expect(render).toContain('const effectivePaneComposerCtx = viewerOwnsHostProjection')
    expect(render).toContain('? composerCtx')
    expect(render).toContain(': resolveRestingPaneComposerCtx()')
  })

  it('derives linked-child state from each pane chat instead of forcing it on', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')

    expect(source).not.toContain('isCurrentChatLinkedChild: true')
    expect(
      source.match(/isCurrentChatLinkedChild: Boolean\(viewerChat\.parentChatId\)/g)
    ).toHaveLength(1)
  })

  it('keeps the focused goal-popover anchor out of the resting-pane builder', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')

    // Every pane's <Composer> mounts the goal button; without this override the
    // last-mounted pane clobbers the shared goalButtonRef and the focused goal
    // popover portals over the wrong pane (position is measured off that ref).
    expect(source.match(/goalButtonRef: paneGoalButtonDiscardRef/g)).toHaveLength(1)
  })

  it('routes the Return-key live steer to the pane chat, never the focused draft', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
    const builderStart = source.indexOf('const buildPaneComposerCtx =')
    const builderEnd = source.indexOf('const paneComposerCtxByKey =', builderStart)
    const builder = source.slice(builderStart, builderEnd)
    const paneSteerStart = source.indexOf('const handleSteerMultiviewPane =')
    const paneSteerEnd = source.indexOf(
      'const rememberMultiviewPaneComposerSelection =',
      paneSteerStart
    )
    const paneSteer = source.slice(paneSteerStart, paneSteerEnd)
    const steerStart = source.indexOf('const handleSteer = async')
    const steerEnd = source.indexOf('const handleSteerRef =', steerStart)
    const steer = source.slice(steerStart, steerEnd)

    // The stable base spreads the FOCUSED chat's handleSteer into every pane;
    // without this override a resting pane's Return-key steer builds its
    // request from the focused draft — an empty focused draft makes the
    // keypress a silent no-op, a non-empty one steers the WRONG chat.
    expect(builder).toContain(
      'handleSteer: () => handleSteerMultiviewPane(viewerPaneIndex, viewerChatId)'
    )
    expect(paneSteerStart).toBeGreaterThan(-1)
    // The pane steer targets its own chat, draft, and attachments…
    expect(paneSteer).toContain('handleSteerRef.current(undefined, undefined, {')
    expect(paneSteer).toContain('chat: paneChat,')
    expect(paneSteer).toContain('prompt: panePrompt,')
    expect(paneSteer).toContain(
      'discordContextSelection: discordContextSelectionByChatIdRef.current[chatId] || null'
    )
    // …never inherits focused Full Access…
    expect(paneSteer).toContain(
      'paneIndex === multiview.focusedPaneIndex && currentChatIdRef.current === chatId'
    )
    // …and relocks its own pane, not the host transcript.
    expect(paneSteer).toContain('multiview.paneRefs[paneIndex]?.relockToLatest()')
    // handleSteer forwards the pane target into the request builder…
    expect(steerEnd).toBeGreaterThan(steerStart)
    expect(steer).toContain('buildRunRequest(overrideModel, existingPrompt, target)')
    // …and only a steer of the visible chat may flip the global thinking badge.
    const ensembleThinkGate = steer.indexOf(
      'if (targetChatId === (currentChatIdRef.current || currentChat?.appChatId)) {'
    )
    const ensembleThink = steer.indexOf('setIsThinking(true)')
    expect(ensembleThinkGate).toBeGreaterThan(-1)
    expect(ensembleThink).toBeGreaterThan(ensembleThinkGate)
  })

  it('overrides every mutable Ensemble surface with pane-owned bindings', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
    const contexts = paneComposerContextKeys(source)
    const paneOwnedKeys = [
      'activeEnsembleFanoutPolicy',
      'applyEnsemblePermissionsToAllParticipants',
      'applyEnsembleRosterPreset',
      'currentComposerMentionParticipants',
      'currentDiscordContextSelection',
      'currentEnsembleActiveGoalStatus',
      'currentEnsembleContinuationHops',
      'currentEnsembleFanoutPolicy',
      'currentEnsembleMaxContinuationHops',
      'currentEnsembleRoundStatus',
      'effectiveSelectedParticipantId',
      'ensembleBlendStyle',
      'ensembleEnabledParticipantsForCurrent',
      'handleAttachWindow',
      'handleClearDiscordContext',
      'handleCollapseEnsembleToSolo',
      'handleDeleteQueuedMessage',
      'handleDetachWindow',
      'handleEditQueuedMessage',
      'handleReviewCurrentDiff',
      'handleSelectParticipant',
      'handleSteer',
      'handleSteerToQueuedMessage',
      'handleToggleWelcomeEnsemble',
      'isCurrentChatBusyForSteer',
      'isCurrentEnsembleRoundRunning',
      'isSteerBusyForCurrentChat',
      'openDiscordContextPicker',
      'patchEnsembleParticipantById',
      'queuedMessagesAboveRowEntries',
      'resumeAppWatchSnapshot',
      'selectedParticipant',
      'setActiveEnsembleRosterPresetId',
      'steerIndicatorMessage',
      'updateCurrentEnsembleFanoutIsolation',
      'updateCurrentEnsembleFanoutPolicy',
      'updateCurrentEnsembleMaxContinuationHops',
      'updateSelectedParticipant'
    ]

    for (const context of contexts) {
      expect(context).toEqual(expect.arrayContaining(paneOwnedKeys))
    }
    expect(source).not.toContain('queuedMessagesAboveRowEntries: []')
  })

  it('targets pane chat ids for seat gates, queues, and directed sends', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
    const layoutSource = readFileSync(
      join(process.cwd(), 'src/renderer/src/app/views/MainAppLayout.tsx'),
      'utf8'
    )
    const builderStart = source.indexOf('const buildPaneComposerCtx =')
    const builderEnd = source.indexOf('const paneComposerCtxByKey =', builderStart)
    const builder = source.slice(builderStart, builderEnd)
    const paneRunStart = source.indexOf('const handleRunMultiviewPane =')
    const paneRunEnd = source.indexOf('const handleCancelMultiviewPane =', paneRunStart)
    const paneRun = source.slice(paneRunStart, paneRunEnd)
    const editQueueStart = source.indexOf('const handleEditQueuedMessage =')
    const editQueueEnd = source.indexOf('const handleDeleteQueuedMessage =', editQueueStart)
    const editQueue = source.slice(editQueueStart, editQueueEnd)
    const deleteQueueStart = editQueueEnd
    const deleteQueueEnd = source.indexOf('const handleSteerToQueuedMessage =', deleteQueueStart)
    const deleteQueue = source.slice(deleteQueueStart, deleteQueueEnd)
    const steerQueueStart = deleteQueueEnd
    const steerQueueEnd = source.indexOf('const handleReorderQueuedMessages =', steerQueueStart)
    const steerQueue = source.slice(steerQueueStart, steerQueueEnd)
    const paneSlashStart = source.indexOf('const buildPaneComposerSlashCommands =')
    const paneSlashEnd = source.indexOf('const handleSelectMultiviewLayout =', paneSlashStart)
    const paneSlash = source.slice(paneSlashStart, paneSlashEnd)

    expect(builder).toContain('paneCtxHelpers.patchEnsembleParticipantForChat(')
    expect(builder).not.toContain('participants: source.ensemble.participants.map((participant) =>')
    expect(builder).toContain('paneCtxHelpers.handleEditQueuedMessage(entryId, viewerChat)')
    expect(builder).toContain('paneCtxHelpers.handleDeleteQueuedMessage(entryId, viewerChat)')
    expect(builder).toContain('paneCtxHelpers.handleSteerToQueuedMessage(entryId, viewerChat)')
    expect(builder).not.toContain('handleBlackboardQueuedMessage')
    expect(source).not.toContain('const handleBlackboardQueuedMessage =')
    // Edit must restore attachments from the queue snapshot into the composer;
    // hoisting only the prompt text is the regression that drops attached files.
    expect(editQueue).toContain('mapQueuedAttachmentsForComposer')
    expect(editQueue).toContain('setImageAttachmentsByChatId')
    expect(editQueue).toContain('result.imageAttachments')
    expect(builder).toContain('handleRunMultiviewPane(')
    expect(builder).toContain('viewerPaneIndex,')
    expect(builder).toContain('viewerChatId,')
    expect(builder).toContain('dmTargetParticipantId,')
    expect(builder).toContain('exactPickerParticipantId')
    expect(builder).not.toContain('registerFocusedRunPromptRoutingReader')
    expect(paneRun).toContain(
      'if (dmTargetParticipantId) request.dmTargetParticipantId = dmTargetParticipantId'
    )
    expect(paneRun).toContain(
      'if (exactPickerParticipantId) request.exactPickerParticipantId = exactPickerParticipantId'
    )
    expect(paneRun).toContain(
      'discordContextSelection: discordContextSelectionByChatIdRef.current[chatId] || null'
    )
    expect(paneRun).toContain(
      'setDiscordContextSelectionByChatId((prev) => ({ ...prev, [chatId]: null }))'
    )
    const buildRunRequestStart = source.indexOf('const buildRunRequest =')
    const buildRunRequestEnd = source.indexOf('const buildRunRequestRef =', buildRunRequestStart)
    const buildRunRequest = source.slice(buildRunRequestStart, buildRunRequestEnd)
    expect(buildRunRequest).toContain(
      "Object.prototype.hasOwnProperty.call(target, 'discordContextSelection')"
    )
    expect(buildRunRequest).toContain('resolveRunDiscordContextSelection({')
    expect(buildRunRequest).toContain('targetSelection: targetDiscordContextSelection')
    expect(source).toContain('selectedParticipantIdByChatId[currentChat.appChatId]')
    expect(source.match(/resolveMultiviewEnsembleParticipantSelection\(/g)).toHaveLength(2)
    expect(source.match(/paneSlashParticipant\?\.provider \?\? viewerProvider/g)).toHaveLength(1)
    expect(paneSlash).toContain('selectedParticipant: EnsembleParticipant | null')
    expect(paneSlash).toContain('const slashParticipant = selectedParticipant')
    expect(paneSlash).toContain('paneSlashCommandHelpers.resolveSlashPaletteItems')
    expect(paneSlash).toContain('paneSlashCommandHelpers.buildScopedComposerSlashExtraCommands')
    expect(editQueue).toContain('targetChat?.appChatId')
    expect(editQueue).toContain('setScheduleRunAtForChat(')
    expect(editQueue).toContain('updateEnsembleQueuedPromptsForRound(')
    expect(editQueue).toContain('round.roundId !== queuedRoundId')
    expect(deleteQueue).toContain('recordedOwnerChatId !== targetChat.appChatId')
    expect(deleteQueue).toContain('updateEnsembleQueuedPromptsForRound(')
    expect(deleteQueue).toContain('round.roundId !== queuedRoundId')
    expect(steerQueue).toContain('targetChat?.appChatId')
    expect(steerQueue).toContain('recordedOwnerChatId !== targetChat.appChatId')
    expect(steerQueue).toContain('round.roundId !== queuedRoundId')
    expect(source).toContain('updateChatByIdLocalOnly(chatId, (source) =>')
    expect(source).toContain('return summaryChatUpdateQueueRef.current.enqueue({')
    expect(source).toContain('summaryChatUpdateQueueRef.current.hasPending(chatId)')
    expect(source).toContain('resolveAvailableBase: (key) =>')
    expect(source).toContain('return updateChatById(key, queuedUpdater, queuedOptions)')
    const seatGate = source.slice(
      source.indexOf('const requestAuthoritativeParticipantSeatChange ='),
      source.indexOf('const patchEnsembleParticipantForChat =')
    )
    expect(seatGate).toContain('mutationState.requiresRuntimeSync')
    expect(seatGate).toContain('requestAuthoritativeParticipantSeatChange(')
    expect(seatGate).toContain('authoritativeParticipantSeatChangeQueueRef')
    expect(seatGate).toContain('(previous || Promise.resolve())')
    expect(seatGate).not.toContain('queueForNextRound')
    expect(seatGate).not.toContain('hasProviderOrModelSeatPatch')
    const participantPatch = source.slice(
      source.indexOf('const patchEnsembleParticipantForChat ='),
      source.indexOf('const applyEnsembleRosterPresetToChat =')
    )
    expect(participantPatch).toContain('updateChatById(chatId, (sourceChat) =>')
    expect(participantPatch).not.toContain('updateChatById(chatId, () =>')
    const applyPermissions = source.slice(
      source.indexOf('const applyEnsemblePermissionsToAllParticipantsForChat ='),
      source.indexOf('const requestLiveEnsembleRoundConfigUpdate =')
    )
    expect(applyPermissions).toContain(
      'applyParticipantPermissionsToEnsemble(source, participantId)'
    )
    expect(applyPermissions).toContain('requestAuthoritativeParticipantSeatChange(')
    expect(applyPermissions).toContain('cloneParticipantPermissionPatch(permissionPatch)')
    expect(applyPermissions).toContain(
      'isEnsembleActiveRoundDispatchLive(source.ensemble?.activeRound)'
    )
    expect(applyPermissions).toContain('await refreshSingleChat(chatId).catch(() => null)')
    const liveRoundIndex = applyPermissions.indexOf(
      'isEnsembleActiveRoundDispatchLive(canonical.ensemble?.activeRound)'
    )
    const requestIndex = applyPermissions.indexOf('requestAuthoritativeParticipantSeatChange(')
    const updateIndex = applyPermissions.indexOf('updateChatById(chatId, (source) =>')
    expect(liveRoundIndex).toBeGreaterThan(-1)
    expect(requestIndex).toBeGreaterThan(liveRoundIndex)
    expect(updateIndex).toBeGreaterThan(requestIndex)
    expect(applyPermissions.slice(updateIndex)).not.toContain('window.alert(')
    expect(applyPermissions).toContain('for (const participant')
    expect(applyPermissions.match(/updateChatById\(/g)).toHaveLength(1)
    const liveRoundConfig = source.slice(
      source.indexOf('const requestLiveEnsembleRoundConfigUpdate ='),
      source.indexOf('const updateSelectedParticipant =')
    )
    expect(liveRoundConfig).toContain('.updateLiveEnsembleRoundConfig({ chatId, ...patch })')
    expect(liveRoundConfig).toContain(
      'requestLiveEnsembleRoundConfigUpdate(chatId, { fanoutPolicy: nextPolicy })'
    )
    expect(liveRoundConfig).toContain(
      'const change = buildContinuationHopsChangeRequest(chatId, source.ensemble, nextMax)'
    )
    expect(liveRoundConfig).toContain(
      'previousMaxContinuationHops: change.previousMaxContinuationHops'
    )
    expect(liveRoundConfig).toContain('isEnsembleActiveRoundDispatchLive(activeRound)')
    expect(source).toContain("'stageRole',")
    const runtimeProfileControl = source.slice(
      source.indexOf('const runtimeProfileControl ='),
      source.indexOf('// Launch-seal maturity')
    )
    expect(runtimeProfileControl).toContain(
      "data-pending-next-turn={isCurrentComposerLocked ? 'true' : 'false'}"
    )
    expect(runtimeProfileControl).toContain('disabled={!currentChat}')
    expect(runtimeProfileControl).not.toContain(
      'disabled={!currentChat || isCurrentComposerLocked}'
    )
    expect(layoutSource).toContain(
      'applyEnsemblePermissionsToAllParticipantsForChat(\n      sideChat.appChatId,'
    )
    expect(layoutSource).not.toContain(
      'participants: sideChat.ensemble.participants.map((participant: any) =>'
    )
    expect(source).not.toContain('setSelectedParticipantId(')
    expect(source).toContain('setSelectedParticipantForChat(updatedChat.appChatId, null)')
  })
})
