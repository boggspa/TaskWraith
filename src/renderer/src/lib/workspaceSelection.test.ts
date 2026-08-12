import { describe, expect, it } from 'vitest'

import {
  resolveWorkspaceAddDialogIntent,
  shouldRebindCurrentChatOnWorkspaceSelect
} from './workspaceSelection'

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

describe('resolveWorkspaceAddDialogIntent', () => {
  it('defaults a bare call to navigate, so adding a workspace opens a new thread', () => {
    // Sidebar `+` / Settings "Add workspace" invoke the dialog without
    // options. Landing on a fresh draft for the new workspace — instead of
    // relocating whatever chat happens to be open — is the safe default.
    expect(resolveWorkspaceAddDialogIntent()).toBe('navigate')
    expect(resolveWorkspaceAddDialogIntent(undefined)).toBe('navigate')
  })

  it('treats a stray DOM click event as navigate, not as an opt-in', () => {
    // Sidebar and Settings wire the dialog as onClick={onSelectWorkspaceDialog},
    // so React hands the handler a MouseEvent as its first argument. A truthy
    // event object must never read as consent to rebind the current chat.
    const clickEventShaped = { type: 'click', nativeEvent: {}, preventDefault: () => {} }
    expect(resolveWorkspaceAddDialogIntent(clickEventShaped)).toBe('navigate')
  })

  it("honours the composer's explicit switch opt-in", () => {
    // The composer workspace switcher is the one sanctioned surface allowed
    // to rebind the current chat onto the newly added workspace (EW41).
    expect(resolveWorkspaceAddDialogIntent({ intent: 'switch' })).toBe('switch')
  })

  it('keeps an explicit navigate as navigate', () => {
    expect(resolveWorkspaceAddDialogIntent({ intent: 'navigate' })).toBe('navigate')
  })

  it('never lets malformed intent values escalate to switch', () => {
    expect(resolveWorkspaceAddDialogIntent({ intent: 'SWITCH' })).toBe('navigate')
    expect(resolveWorkspaceAddDialogIntent('switch')).toBe('navigate')
    expect(resolveWorkspaceAddDialogIntent(null)).toBe('navigate')
  })
})
