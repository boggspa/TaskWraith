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
  it('keeps the live fallback and memoized builder on the same explicit prop surface', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
    const contexts = paneComposerContextKeys(source)

    expect(contexts).toHaveLength(2)
    for (const context of contexts) {
      expect(context).toHaveLength(new Set(context).size)
    }
    expect([...new Set(contexts[0])].sort()).toEqual(
      [...new Set(contexts[1])].sort()
    )
  })

  it('derives linked-child state from each pane chat instead of forcing it on', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')

    expect(source).not.toContain('isCurrentChatLinkedChild: true')
    expect(source.match(/isCurrentChatLinkedChild: Boolean\(viewerChat\.parentChatId\)/g)).toHaveLength(
      2
    )
  })

  it('overrides every mutable Ensemble surface with pane-owned bindings', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
    const contexts = paneComposerContextKeys(source)
    const paneOwnedKeys = [
      'activeEnsembleConcurrentMode',
      'activeEnsembleFanoutPolicy',
      'activeEnsembleOrchestrationMode',
      'applyEnsemblePermissionsToAllParticipants',
      'applyEnsembleRosterPreset',
      'currentComposerMentionParticipants',
      'currentDiscordContextSelection',
      'currentEnsembleActiveGoalStatus',
      'currentEnsembleConcurrentMode',
      'currentEnsembleContinuationHops',
      'currentEnsembleFanoutPolicy',
      'currentEnsembleMaxContinuationHops',
      'currentEnsembleOrchestrationMode',
      'currentEnsembleRoundStatus',
      'effectiveSelectedParticipantId',
      'ensembleBlendStyle',
      'ensembleEnabledParticipantsForCurrent',
      'ensembleOllamaContextWarning',
      'handleBlackboardQueuedMessage',
      'handleAttachWindow',
      'handleClearDiscordContext',
      'handleDeleteQueuedMessage',
      'handleDetachWindow',
      'handleEditQueuedMessage',
      'handleReviewCurrentDiff',
      'handleSelectParticipant',
      'handleStopWorkSession',
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
      'setShowWorkSessionSheet',
      'steerIndicatorMessage',
      'updateCurrentEnsembleConcurrentMode',
      'updateCurrentEnsembleContextChars',
      'updateCurrentEnsembleFanoutPolicy',
      'updateCurrentEnsembleMaxContinuationHops',
      'updateCurrentEnsembleOrchestrationMode',
      'updateSelectedParticipant'
    ]

    for (const context of contexts) {
      expect(context).toEqual(expect.arrayContaining(paneOwnedKeys))
    }
    expect(source).not.toContain('queuedMessagesAboveRowEntries: []')
  })

  it('targets pane chat ids for seat gates, queues, and directed sends', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
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
    const deleteQueueEnd = source.indexOf(
      'const handleBlackboardQueuedMessage =',
      deleteQueueStart
    )
    const deleteQueue = source.slice(deleteQueueStart, deleteQueueEnd)
    const blackboardQueueStart = deleteQueueEnd
    const blackboardQueueEnd = source.indexOf(
      'const handleSteerToQueuedMessage =',
      blackboardQueueStart
    )
    const blackboardQueue = source.slice(blackboardQueueStart, blackboardQueueEnd)
    const steerQueueStart = source.indexOf('const handleSteerToQueuedMessage =')
    const steerQueueEnd = source.indexOf('const handleReorderQueuedMessages =', steerQueueStart)
    const steerQueue = source.slice(steerQueueStart, steerQueueEnd)
    const paneSlashStart = source.indexOf('const buildPaneComposerSlashCommands =')
    const paneSlashEnd = source.indexOf('const handleSelectMultiviewLayout =', paneSlashStart)
    const paneSlash = source.slice(paneSlashStart, paneSlashEnd)

    expect(builder).toContain('paneCtxHelpers.patchEnsembleParticipantForChat(')
    expect(builder).not.toContain(
      'participants: source.ensemble.participants.map((participant) =>'
    )
    expect(builder).toContain('paneCtxHelpers.handleEditQueuedMessage(entryId, viewerChat)')
    expect(builder).toContain('paneCtxHelpers.handleDeleteQueuedMessage(entryId, viewerChat)')
    expect(builder).toContain('paneCtxHelpers.handleBlackboardQueuedMessage(entryId, viewerChat)')
    expect(builder).toContain('paneCtxHelpers.handleSteerToQueuedMessage(entryId, viewerChat)')
    expect(builder).toContain(
      'handleRunMultiviewPane(viewerPaneIndex, viewerChatId, dmTargetParticipantId)'
    )
    expect(paneRun).toContain(
      'if (dmTargetParticipantId) request.dmTargetParticipantId = dmTargetParticipantId'
    )
    expect(paneRun).toContain(
      'discordContextSelection: discordContextSelectionByChatIdRef.current[chatId] || null'
    )
    expect(paneRun).toContain(
      'setDiscordContextSelectionByChatId((prev) => ({ ...prev, [chatId]: null }))'
    )
    const buildRunRequestStart = source.indexOf('const buildRunRequest =')
    const buildRunRequestEnd = source.indexOf(
      'const buildRunRequestRef =',
      buildRunRequestStart
    )
    const buildRunRequest = source.slice(buildRunRequestStart, buildRunRequestEnd)
    expect(buildRunRequest).toContain(
      "Object.prototype.hasOwnProperty.call(target, 'discordContextSelection')"
    )
    expect(buildRunRequest).toContain('resolveRunDiscordContextSelection({')
    expect(buildRunRequest).toContain('targetSelection: targetDiscordContextSelection')
    expect(source).toContain('selectedParticipantIdByChatId[currentChat.appChatId]')
    expect(
      source.match(/resolveMultiviewEnsembleParticipantSelection\(/g)
    ).toHaveLength(3)
    expect(source.match(/paneSlashParticipant\?\.provider \?\? viewerProvider/g)).toHaveLength(2)
    expect(paneSlash).toContain('selectedParticipant: EnsembleParticipant | null')
    expect(paneSlash).toContain('const slashParticipant = selectedParticipant')
    expect(paneSlash).toContain('paneSlashCommandHelpers.resolveSlashPaletteItems')
    expect(paneSlash).toContain(
      'paneSlashCommandHelpers.buildScopedComposerSlashExtraCommands'
    )
    expect(editQueue).toContain('targetChat?.appChatId')
    expect(editQueue).toContain('setScheduleRunAtForChat(')
    expect(editQueue).toContain('updateEnsembleQueuedPromptsForRound(')
    expect(editQueue).toContain('round.roundId !== queuedRoundId')
    expect(deleteQueue).toContain('recordedOwnerChatId !== targetChat.appChatId')
    expect(deleteQueue).toContain('updateEnsembleQueuedPromptsForRound(')
    expect(deleteQueue).toContain('round.roundId !== queuedRoundId')
    expect(blackboardQueue).toContain('updateEnsembleQueuedPromptsForRound(')
    expect(blackboardQueue).toContain('round.roundId !== queuedRoundId')
    expect(steerQueue).toContain('targetChat?.appChatId')
    expect(steerQueue).toContain('recordedOwnerChatId !== targetChat.appChatId')
    expect(steerQueue).toContain('round.roundId !== queuedRoundId')
    expect(source).toContain('updateChatByIdLocalOnly(chatId, (source) =>')
    expect(source).toContain(
      'patchEnsembleParticipantForChat(chatId, participant.id, {'
    )
    expect(source).not.toContain('setSelectedParticipantId(')
    expect(source).toContain('setSelectedParticipantForChat(updatedChat.appChatId, null)')
  })
})
