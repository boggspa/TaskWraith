import { describe, expect, it } from 'vitest'
import { resolveChatApprovalMode, staleTrustedSessionDemotionPatch } from './chatComposerSelection'

describe('resolveChatApprovalMode', () => {
  it('prefers chat-owned metadata, then its creation snapshot', () => {
    expect(
      resolveChatApprovalMode({
        metadataApprovalMode: 'plan',
        settingsSnapshotApprovalMode: 'default',
        fallbackApprovalMode: 'auto_edit'
      })
    ).toBe('plan')
    expect(
      resolveChatApprovalMode({
        settingsSnapshotApprovalMode: 'auto_edit',
        fallbackApprovalMode: 'plan'
      })
    ).toBe('auto_edit')
  })

  it('uses an explicit caller fallback without inheriting another pane', () => {
    expect(resolveChatApprovalMode({ fallbackApprovalMode: 'plan' })).toBe('plan')
  })

  it('defaults an unconfigured chat independently', () => {
    expect(resolveChatApprovalMode({})).toBe('default')
  })
})

describe('staleTrustedSessionDemotionPatch', () => {
  it('demotes a remembered full_access selection whose grant is gone', () => {
    expect(
      staleTrustedSessionDemotionPatch({
        rememberedPresetId: 'full_access',
        trustedSessionEnabled: false
      })
    ).toEqual({
      approvalMode: 'auto_edit',
      workflowMode: 'normal',
      permissionPresetId: 'workspace_write'
    })
  })

  it('leaves a live Trusted Session untouched', () => {
    expect(
      staleTrustedSessionDemotionPatch({
        rememberedPresetId: 'full_access',
        trustedSessionEnabled: true
      })
    ).toBeNull()
  })

  it('never touches non-full_access selections, granted or not', () => {
    for (const rememberedPresetId of ['workspace_write', 'default', 'read_only', undefined, 42]) {
      expect(
        staleTrustedSessionDemotionPatch({ rememberedPresetId, trustedSessionEnabled: false })
      ).toBeNull()
    }
  })
})
