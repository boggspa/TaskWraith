import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  buildSideChatComposerProps,
  handleSideChatComposerKeyDown,
  shouldSubmitSideChatComposerKey
} from './sideChatComposer'

function keyEvent(overrides: Partial<Parameters<typeof shouldSubmitSideChatComposerKey>[0]> = {}) {
  return {
    key: 'Enter',
    shiftKey: false,
    nativeEvent: {
      isComposing: false
    },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides
  }
}

describe('sideChatComposer', () => {
  it('submits on Enter and stops the global composer shortcut from also firing', () => {
    const event = keyEvent()
    const submit = vi.fn()

    expect(handleSideChatComposerKeyDown(event, submit)).toBe(true)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(submit).toHaveBeenCalledOnce()
  })

  it('also treats modified Enter as a side-chat submit', () => {
    const event = keyEvent({ metaKey: true })
    const submit = vi.fn()

    expect(handleSideChatComposerKeyDown(event, submit)).toBe(true)

    expect(event.stopPropagation).toHaveBeenCalledOnce()
  })

  it('does not submit on Shift+Enter or IME composition', () => {
    expect(shouldSubmitSideChatComposerKey(keyEvent({ shiftKey: true }))).toBe(false)
    expect(shouldSubmitSideChatComposerKey(keyEvent({ nativeEvent: { isComposing: true } }))).toBe(
      false
    )
  })

  it('clears focused-chat surfaces before applying side-scoped composer state', () => {
    const setParentDiffActionMenuOpen = vi.fn()
    const parentGoalButtonRef = { current: { id: 'parent-goal-button' } }
    const parentGoalPopoverRef = { current: { id: 'parent-goal-popover' } }
    const selectParentMultiviewLayout = vi.fn()
    const toggleParentEnsemble = vi.fn()
    const syncParentGeminiModel = vi.fn()
    const respondToParentApproval = vi.fn()
    const parentExternalTextareaRef = { current: { id: 'parent-textarea' } }
    const focused = {
      currentChat: { appChatId: 'parent' },
      imageAttachments: [{ id: 'parent-image' }],
      pendingAgentApproval: { id: 'parent-approval' },
      pendingPlanImport: { id: 'parent-plan' },
      primaryGitSnapshot: { branch: 'parent-branch' },
      composerSlashCommands: [{ command: '/parent-only' }],
      diffActionMenuOpen: true,
      setDiffActionMenuOpen: setParentDiffActionMenuOpen,
      goalButtonRef: parentGoalButtonRef,
      goalPopoverRef: parentGoalPopoverRef,
      handleSelectMultiviewLayout: selectParentMultiviewLayout,
      handleToggleWelcomeEnsemble: toggleParentEnsemble,
      isEnsembleModeEnabled: true,
      openDiscordContextPicker: vi.fn(),
      openInspectorTab: vi.fn(),
      handleReviewCurrentDiff: vi.fn(),
      handleAgentApprovalAction: respondToParentApproval,
      syncPersistentModelSelection: syncParentGeminiModel,
      externalComposerTextareaRef: parentExternalTextareaRef,
      showWorkspaceGitAboveRows: true,
      resumeAppWatchSnapshot: { windowMeta: { applicationName: 'Parent App' } },
      geminiWorkspaceTrustReady: false,
      sessionYoloMode: { enabled: true },
      externalPathGrants: [{ id: 'parent-path' }],
      visibleScheduledTasks: [{ id: 'parent-schedule' }],
      runtimeProfileControl: { id: 'parent-runtime' }
    }

    const scoped = buildSideChatComposerProps(focused, {
      currentChat: { appChatId: 'side' },
      imageAttachments: [{ id: 'side-image' }],
      pendingAgentApproval: { id: 'side-approval' }
    })

    expect(scoped).toMatchObject({
      currentChat: { appChatId: 'side' },
      imageAttachments: [{ id: 'side-image' }],
      pendingAgentApproval: { id: 'side-approval' }
    })
    expect(scoped.pendingPlanImport).toBeNull()
    expect(scoped.primaryGitSnapshot).toBeNull()
    expect(scoped.externalPathGrants).toEqual([])
    expect(scoped.visibleScheduledTasks).toEqual([])
    expect(scoped.runtimeProfileControl).toBeNull()

    const isolatedWithoutSideAttachments = buildSideChatComposerProps(focused, {
      currentChat: { appChatId: 'side' }
    })
    expect(isolatedWithoutSideAttachments.imageAttachments).toEqual([])
    expect(isolatedWithoutSideAttachments.composerSlashCommands).toEqual([])
    expect(isolatedWithoutSideAttachments.diffActionMenuOpen).toBe(false)
    expect(isolatedWithoutSideAttachments.resumeAppWatchSnapshot).toBeNull()
    expect(isolatedWithoutSideAttachments.geminiWorkspaceTrustReady).toBe(true)
    expect(isolatedWithoutSideAttachments.sessionYoloMode).toEqual({ enabled: false })
    expect(isolatedWithoutSideAttachments.goalButtonRef).not.toBe(parentGoalButtonRef)
    expect(isolatedWithoutSideAttachments.goalPopoverRef).not.toBe(parentGoalPopoverRef)
    expect(isolatedWithoutSideAttachments.goalButtonRef.current).toBeNull()
    expect(isolatedWithoutSideAttachments.goalPopoverRef.current).toBeNull()
    expect(isolatedWithoutSideAttachments.isEnsembleModeEnabled).toBe(false)
    isolatedWithoutSideAttachments.handleSelectMultiviewLayout('quad')
    isolatedWithoutSideAttachments.handleToggleWelcomeEnsemble()
    expect(selectParentMultiviewLayout).not.toHaveBeenCalled()
    expect(toggleParentEnsemble).not.toHaveBeenCalled()
    expect(isolatedWithoutSideAttachments.openDiscordContextPicker).toBeUndefined()
    expect(isolatedWithoutSideAttachments.openInspectorTab).toBeUndefined()
    expect(isolatedWithoutSideAttachments.handleReviewCurrentDiff).toBeUndefined()
    isolatedWithoutSideAttachments.handleAgentApprovalAction('approval', 'accept')
    isolatedWithoutSideAttachments.syncPersistentModelSelection('gemini-model')
    expect(respondToParentApproval).not.toHaveBeenCalled()
    expect(syncParentGeminiModel).not.toHaveBeenCalled()
    expect(isolatedWithoutSideAttachments.externalComposerTextareaRef).toBeUndefined()
    expect(isolatedWithoutSideAttachments.showWorkspaceGitAboveRows).toBe(false)
    isolatedWithoutSideAttachments.setDiffActionMenuOpen(true)
    expect(setParentDiffActionMenuOpen).not.toHaveBeenCalled()
  })

  it('keeps the linked-chat pane on the shared Composer instead of a bespoke form', () => {
    const source = readFileSync(
      new URL('../app/views/MainAppLayout.tsx', import.meta.url),
      'utf8'
    )

    expect(source).toContain('<Composer {...sideComposerCtx} />')
    expect(source).not.toContain('side-chat-compact-composer')
  })

  it('keeps the focused command-palette shortcut out of the linked pane', () => {
    const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

    expect(source).toContain("target?.closest('.side-chat-pane')")
    expect(source).not.toContain("target?.closest('.side-chat-composer')")
  })

  it('keeps side submission, focus, and live seat changes scoped to the linked chat', () => {
    const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    const layoutSource = readFileSync(
      new URL('../app/views/MainAppLayout.tsx', import.meta.url),
      'utf8'
    )
    const composerSource = readFileSync(
      new URL('../components/Composer.tsx', import.meta.url),
      'utf8'
    )

    expect(appSource).toMatch(
      /const handleSideRun = \([\s\S]*?runRequestHasContent\([\s\S]*?imageAttachments: sideRunAttachments/
    )
    expect(appSource).toContain(
      'if (dmTargetParticipantId) request.dmTargetParticipantId = dmTargetParticipantId'
    )
    expect(appSource).toMatch(
      /const handleSideRun = \([\s\S]*?approvalMode: sideSelectedApprovalMode,[\s\S]*?workflowMode: sideComposerWorkflowMode/
    )
    expect(appSource).toMatch(
      /getChatComposerSelection\(\s*sideComposerSourceChat,\s*getChatProvider\(sideComposerSourceChat\),\s*'default'\s*\)/
    )
    expect(appSource).toContain("(isSubThreadChat(chat) ? 'default' : approvalMode)")
    expect(layoutSource).toContain('externalComposerTextareaRef: sideComposerTextareaRef')
    expect(layoutSource).toContain('patchSideParticipantWithSeatGate(sideChat, participantId, patch)')
    expect(layoutSource).toContain('withSessionActivityLedger(sideChat, nextChat)')
    expect(layoutSource).toContain('persistSideChatActivity({')
    expect(layoutSource).toContain("if (activeRightDockTab !== 'chat') return")
    expect(composerSource).toContain(
      'const shouldClearDraft = openSideChatFromSlashCommand(sideCommand) !== false'
    )
    expect(layoutSource).toContain(
      "window.alert('Nested side chats are unavailable from a linked chat.')"
    )
    expect(layoutSource).toContain("approvalMode: sideComposerSelection?.approvalMode || 'default'")
  })

  it('anchors the side-chat type menu to the pane instead of the narrow trigger pill', () => {
    const css = readFileSync(
      new URL('../assets/css/11-side-chat.css', import.meta.url),
      'utf8'
    )

    expect(css).toMatch(/\.side-chat-type-picker\s*\{[\s\S]*?position:\s*static;/)
    expect(css).toMatch(
      /\.side-chat-type-picker-menu\s*\{[\s\S]*?left:\s*50%;[\s\S]*?width:\s*min\(320px, calc\(100% - 24px\)\);/
    )
    expect(css).toMatch(
      /\.side-chat-pane\s+\.composer-multiview-trigger\s*\{[\s\S]*?display:\s*none;/
    )
    expect(css).toMatch(
      /\.side-chat-pane\s+\.composer-permission-note\s*\{[\s\S]*?display:\s*none;/
    )
  })
})
