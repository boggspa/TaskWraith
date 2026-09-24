import { describe, expect, it } from 'vitest'
import {
  shouldShowComposerWelcomeBranchPicker,
  type ComposerWelcomeBranchPickerInput
} from './composerWelcomeBranchPicker'

const welcomeWithWorkspace = (
  overrides: Partial<ComposerWelcomeBranchPickerInput> = {}
): ComposerWelcomeBranchPickerInput => ({
  isWelcomeChat: true,
  showWorkspaceGitAboveRows: true,
  hasThreadTokenTally: false,
  isGlobalChat: false,
  workspacePath: '/repo',
  ...overrides
})

describe('shouldShowComposerWelcomeBranchPicker', () => {
  it('shows the picker on a welcome chat that has a workspace', () => {
    expect(shouldShowComposerWelcomeBranchPicker(welcomeWithWorkspace())).toBe(true)
  })

  it('hides the picker once the chat is no longer in the welcome state', () => {
    expect(
      shouldShowComposerWelcomeBranchPicker(welcomeWithWorkspace({ isWelcomeChat: false }))
    ).toBe(false)
  })

  it('hides the picker on surfaces that opt out of workspace git chrome', () => {
    expect(
      shouldShowComposerWelcomeBranchPicker(
        welcomeWithWorkspace({ showWorkspaceGitAboveRows: false })
      )
    ).toBe(false)
  })

  it('yields the zone back as soon as a token tally exists', () => {
    expect(
      shouldShowComposerWelcomeBranchPicker(welcomeWithWorkspace({ hasThreadTokenTally: true }))
    ).toBe(false)
  })

  it('hides the picker in a workspace-less global chat', () => {
    expect(
      shouldShowComposerWelcomeBranchPicker(welcomeWithWorkspace({ isGlobalChat: true }))
    ).toBe(false)
  })

  it('treats a missing or blank workspace path as no repository', () => {
    expect(
      shouldShowComposerWelcomeBranchPicker(welcomeWithWorkspace({ workspacePath: null }))
    ).toBe(false)
    expect(
      shouldShowComposerWelcomeBranchPicker(welcomeWithWorkspace({ workspacePath: '   ' }))
    ).toBe(false)
  })
})
