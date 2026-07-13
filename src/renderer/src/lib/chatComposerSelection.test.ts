import { describe, expect, it } from 'vitest'
import { resolveChatApprovalMode } from './chatComposerSelection'

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
