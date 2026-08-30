import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const composerSource = readFileSync(new URL('./Composer.tsx', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const suggestionSource = readFileSync(
  new URL('../lib/composerSuggestion.ts', import.meta.url),
  'utf8'
)
const checkpointSource = readFileSync(
  new URL('../lib/composerContinuationCheckpoint.ts', import.meta.url),
  'utf8'
)
const composerCss = readFileSync(
  new URL('../assets/css/03-composer-welcome-activity.css', import.meta.url),
  'utf8'
)

describe('contextual AutoDraft Composer wiring', () => {
  it('uses a native multiline placeholder without making it draft value', () => {
    expect(composerSource).toContain('placeholder={composerGhostText || composerPlaceholder}')
    expect(composerSource).toContain('value={prompt}')
    expect(composerSource).toContain("aria-keyshortcuts={composerGhostText ? 'Tab Escape'")
    expect(composerCss).toContain('field-sizing: content')
    expect(composerCss).toContain('.composer-textarea.has-ghost-suggestion::placeholder')
  })

  it('contains no model-hover, ambient-Git, or raw-goal template fallback', () => {
    expect(composerSource).not.toContain('setConsideredModel')
    expect(suggestionSource).not.toContain('Commit the working changes')
    expect(suggestionSource).not.toContain('Retry that last turn')
    expect(checkpointSource).not.toContain('Continue with:')
  })

  it('registers exact participant identity only after Tab acceptance', () => {
    expect(composerSource).toContain('accepted.targetParticipantId')
    expect(composerSource).toContain('accepted.targetMentionText')
    expect(composerSource).toContain('pickerParticipantMentionDraftRef.current = {')
    expect(composerSource).toContain('setChatPromptDraft(currentComposerChatId, accepted.text)')
  })

  it('preserves exact participant identity through the window-level Run Prompt command', () => {
    expect(composerSource).toContain('registerFocusedRunPromptRoutingReader(() => {')
    expect(composerSource).toContain('exactPickerParticipantTarget(prompt)')
    expect(appSource).toContain('routing?.chatId === focusedChatId')
    expect(appSource).toContain('keyboardActions.runCurrentPromptFromKeyboard()')
    expect(appSource).not.toContain(
      "if (commandId === 'run-prompt') {\n          keyboardActions.handleRun()"
    )
  })
})
