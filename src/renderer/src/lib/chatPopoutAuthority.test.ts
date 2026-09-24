import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  chatPopoutAuthorityDisabledReason,
  shouldPersistApprovalElevationAck
} from './chatPopoutAuthority'

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const composerSource = readFileSync(new URL('../components/Composer.tsx', import.meta.url), 'utf8')

describe('chat popout authority projection', () => {
  it('keeps authority controls enabled in the main renderer', () => {
    expect(chatPopoutAuthorityDisabledReason(false, 'trusted-session')).toBeUndefined()
    expect(chatPopoutAuthorityDisabledReason(false, 'workspace-trust')).toBeUndefined()
    expect(shouldPersistApprovalElevationAck(false)).toBe(true)
  })

  it('explains disabled Full Access and workspace trust controls in a chat popout', () => {
    expect(chatPopoutAuthorityDisabledReason(true, 'trusted-session')).toBe(
      'Open this chat in the main window to change Full Access.'
    )
    expect(chatPopoutAuthorityDisabledReason(true, 'workspace-trust')).toBe(
      'Open this chat in the main window to change workspace trust.'
    )
  })

  it('never persists a global elevation acknowledgement from a detached renderer', () => {
    expect(shouldPersistApprovalElevationAck(true)).toBe(false)
  })

  it('wires detached capability reasons into the focused composer', () => {
    // Re-anchored after 5873079b5 gave composerCtx an intersection type.
    const composerContextStart = appSource.indexOf(
      'const composerCtx: ComposerProps & { onOpenCompactChat: () => void } ='
    )
    const composerContextEnd = appSource.indexOf(
      'const activeWorkspaceBoard =',
      composerContextStart
    )
    const composerContext = appSource.slice(composerContextStart, composerContextEnd)

    expect(composerContext).toContain('trustedSessionMutationDisabledReason')
    expect(composerContext).toContain('workspaceTrustMutationDisabledReason')
    expect(composerSource).toContain('disabledReason: trustedSessionMutationDisabledReason')
    expect(composerSource).toContain("'Full Access in main window'")
    expect(composerSource).toContain("'Trust in main window'")
  })

  it('keeps host-wide Discord history unavailable in a detached chat composer', () => {
    expect(appSource).toContain("'Open this chat in the main window to add Discord context.'")
    expect(appSource).toContain('openDiscordContextPicker: isChatPopoutWindow')
    expect(composerSource).toContain('Boolean(discordContextUnavailableReason)')
  })

  it('does not query or subscribe to main-renderer-only startup state from a chat popout', () => {
    expect(appSource).toContain(
      'isChatPopoutWindow\n        ? Promise.resolve(null)\n        : window.api.getManagedPolicyStatus()'
    )
    expect(appSource).toContain(
      "if (!isChatPopoutWindow && typeof window.api.getGeminiMcpBridgeStatus === 'function')"
    )
    expect(appSource).not.toContain(
      '.getProductOperationsStatus()\n        .then(setProductOperationsStatus)'
    )
    expect(appSource).toContain('const refreshProductOperationsStatus = async () => {')
    expect(appSource).toContain('    refreshProductOperationsStatus,')
    expect(appSource).toContain(
      'if (isChatPopoutWindow) return\n    const workspaceId = currentChatWorkspace?.id || currentWorkspace?.id\n    void window.api.getScheduledTasks(workspaceId)'
    )
    expect(appSource).not.toContain('onScheduledTaskDue')
    expect(appSource).toContain(
      "if (!isChatPopoutWindow && typeof window.api.onScheduledTasksChanged === 'function')"
    )
    expect(appSource).toContain(
      "if (!isChatPopoutWindow && typeof window.api.onWorkflowDefinitionsChanged === 'function')"
    )
    expect(appSource).toContain(
      "if (!isChatPopoutWindow && typeof window.api.agenticYoloGet === 'function')"
    )
    expect(appSource).toContain(
      "if (!isChatPopoutWindow && typeof window.api.onAgenticYoloState === 'function')"
    )
  })

  it('applies the chat-owned elevation before skipping global ack side effects', () => {
    const confirmStart = appSource.indexOf(
      'onConfirm={() => {',
      appSource.indexOf('{pendingElevation &&')
    )
    const confirmEnd = appSource.indexOf('        />', confirmStart)
    const confirm = appSource.slice(confirmStart, confirmEnd)

    expect(confirm.indexOf('pendingElevation.apply()')).toBeGreaterThanOrEqual(0)
    expect(
      confirm.indexOf('shouldPersistApprovalElevationAck(isChatPopoutWindow)')
    ).toBeGreaterThan(confirm.indexOf('pendingElevation.apply()'))
    expect(confirm.indexOf('?.recordApprovalElevationAck?.({')).toBeGreaterThan(
      confirm.indexOf('shouldPersistApprovalElevationAck(isChatPopoutWindow)')
    )
    expect(confirm.indexOf('.updateSettings(')).toBeGreaterThan(
      confirm.indexOf('shouldPersistApprovalElevationAck(isChatPopoutWindow)')
    )
  })
})
