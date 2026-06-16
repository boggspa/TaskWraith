import { describe, expect, it } from 'vitest'

import { shouldRebindCurrentChatOnWorkspaceSelect } from './workspaceSelection'

describe('shouldRebindCurrentChatOnWorkspaceSelect', () => {
  it('rebinds an Ensemble chat in place on an intentional switch (composer / welcome picker)', () => {
    // The deliberate switch surfaces must preserve the curated Ensemble panel
    // + transcript by rebinding in place (1.0.5-EW41).
    expect(
      shouldRebindCurrentChatOnWorkspaceSelect({ intent: 'switch', isCurrentEnsembleChat: true })
    ).toBe(true)
  })

  it('does not rebind a non-Ensemble chat even on an intentional switch', () => {
    expect(
      shouldRebindCurrentChatOnWorkspaceSelect({ intent: 'switch', isCurrentEnsembleChat: false })
    ).toBe(false)
  })

  it('never rebinds when navigating from the sidebar rail, even for an Ensemble chat', () => {
    // Regression guard for the dangerous bug: clicking a workspace in the
    // sidebar must open a fresh draft for that workspace, NOT relocate the
    // current Ensemble chat onto it (which would direct the next run at the
    // wrong workspace's files).
    expect(
      shouldRebindCurrentChatOnWorkspaceSelect({ intent: 'navigate', isCurrentEnsembleChat: true })
    ).toBe(false)
  })

  it('never rebinds when navigating with a non-Ensemble chat', () => {
    expect(
      shouldRebindCurrentChatOnWorkspaceSelect({ intent: 'navigate', isCurrentEnsembleChat: false })
    ).toBe(false)
  })
})
