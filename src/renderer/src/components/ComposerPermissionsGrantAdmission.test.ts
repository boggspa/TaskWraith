import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const composerSource = readFileSync(new URL('./Composer.tsx', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

function sourceRegion(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endMarker, start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('Composer permission-picker admission while running', () => {
  it('does not disable the permission picker solely because the solo composer is locked', () => {
    const region = sourceRegion(
      composerSource,
      'const pickerDisabled =',
      '<CombinedPermissionsPicker'
    )

    // The picker may still disable for unavailable providers / Gemini trust,
    // but a live solo run must not freeze permission changes.
    expect(region).toContain('const pickerDisabled =')
    expect(region).not.toMatch(/const pickerDisabled =\s*[\s\S]*isCurrentComposerLocked/)
    expect(region).toContain('providerRunUnavailableReason(')
    expect(region).toContain('effectiveProvider')
    expect(region).not.toContain('configuredProviderSnapshot.providerIds')
  })

  it('does not wire the retired Tool Grants column into the composer picker', () => {
    expect(composerSource).not.toContain('handleToggleGrantForPicker')
    expect(composerSource).not.toContain('grantServices={')
    expect(composerSource).not.toContain('enabledGrantIds={')
    expect(composerSource).not.toContain('onToggleGrant={')
  })

  it('does not insert the obsolete next-round seat-change notice', () => {
    expect(composerSource).not.toContain(
      'Provider/model changes during this round will apply to the next round.'
    )
    expect(composerSource).not.toContain('updateSelectedParticipantWithNotice')
  })

  it('wires the participant editor through live seat and roster boundaries', () => {
    const participantEditorRegion = sourceRegion(
      composerSource,
      '<EnsembleParticipantsAboveRow',
      'onCollapseToSolo={handleCollapseEnsembleToSolo}'
    )
    expect(participantEditorRegion).toContain(
      'onPatchParticipant={(participantId, patch) =>'
    )
    expect(participantEditorRegion).toContain(
      'participantProjection={currentComposerMentionParticipants}'
    )
    expect(participantEditorRegion).toContain(
      'patchEnsembleParticipantById(participantId, patch)'
    )
    expect(participantEditorRegion).toContain('onLiveRosterMutation={(mutation) =>')
    expect(participantEditorRegion).toContain(
      '.requestEnsembleUserRosterMutation({'
    )
    expect(participantEditorRegion).toContain('chatId: currentChat.appChatId')
  })

  it('keeps revocations available during a solo run', () => {
    const externalGrantRegion = sourceRegion(
      composerSource,
      'className="composer-image-strip composer-external-grant-strip"',
      '{externalPathGrantPrompt &&'
    )
    expect(externalGrantRegion).not.toContain('isCurrentComposerLocked')
  })

  it('keeps next-turn draft controls available during a solo run', () => {
    // The tray now renders INSIDE `.composer-textarea-wrap`, so the old
    // `.composer-inner-module` end-marker no longer follows it. Bound the
    // region on the comment that opens the highlight-overlay block instead —
    // it isolates exactly the tray element, same as before.
    const attachmentRegion = sourceRegion(
      composerSource,
      '<ComposerAttachmentTray',
      '{composerRichActive && ('
    )
    expect(attachmentRegion).not.toContain('disabled={isCurrentComposerLocked}')

    const plusRegion = sourceRegion(
      composerSource,
      'const plusSections: ComposerPlusPickerSection[]',
      'triggerIcon={<PlusSymbolIcon />}'
    )
    expect(plusRegion).not.toContain('isCurrentComposerLocked')

    expect(composerSource).not.toMatch(
      /<ComposerVoiceInputButton[\s\S]{0,180}isCurrentComposerLocked/
    )
    expect(composerSource).not.toContain(
      '<ComposerPlanImportCard\n                        pendingPlanImport={pendingPlanImport}\n                        disabled={isCurrentComposerLocked}'
    )
  })

  it('accepts custom-model selections at the next safe boundary', () => {
    const customModelRegion = sourceRegion(
      composerSource,
      'className="composer-inline-custom-model"',
      'Codex speed-tier `<select>` removed'
    )
    expect(customModelRegion).not.toContain('disabled={isCurrentComposerLocked}')
    expect(customModelRegion).toContain('data-pending-next-turn=')

    const groundingRegion = sourceRegion(
      appSource,
      'const planImportGroundingDisabledReason =',
      '// Slice F v2'
    )
    expect(groundingRegion).not.toContain("'Composer is busy.'")
    expect(groundingRegion).not.toContain('isCurrentComposerLocked')
  })
})
