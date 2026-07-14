import { describe, expect, it } from 'vitest'
import type { ExternalPathGrant } from '../../../main/store/types'
import { normalizeExternalPathGrants } from './normalizeExternalPathGrants'

function boundGrant(overrides: Partial<ExternalPathGrant> = {}): ExternalPathGrant {
  return {
    id: 'grant-v2',
    provider: 'codex',
    bindingVersion: 2,
    workspaceId: 'workspace-a',
    chatId: 'chat-a',
    appRunId: 'run-a',
    path: ' /signed/path-with-edge-space ',
    kind: 'directory',
    access: 'write',
    duration: 'thisRun',
    securityScopedBookmark: 'bookmark-a',
    issuedBy: 'main',
    signature: 'signed-v2-payload',
    createdAt: '2026-07-13T10:00:00.000Z',
    ...overrides
  }
}

describe('normalizeExternalPathGrants', () => {
  it('preserves every signed v2 binding field and bookmark verbatim', () => {
    const source = boundGrant()
    const [normalized] = normalizeExternalPathGrants([source])

    expect(normalized).toMatchObject(source)
    expect(normalized.path).toBe(source.path)
    expect(normalized.workspaceId).toBe('workspace-a')
    expect(normalized.chatId).toBe('chat-a')
    expect(normalized.appRunId).toBe('run-a')
    expect(normalized.bindingVersion).toBe(2)
    expect(normalized.signature).toBe('signed-v2-payload')
    expect(normalized.securityScopedBookmark).toBe('bookmark-a')
  })

  it('does not fabricate defaults for malformed signed authority', () => {
    expect(
      normalizeExternalPathGrants([
        boundGrant({ id: '' }),
        boundGrant({ kind: 'invalid' as ExternalPathGrant['kind'] }),
        boundGrant({ access: 'invalid' as ExternalPathGrant['access'] }),
        boundGrant({ duration: 'invalid' as ExternalPathGrant['duration'] }),
        boundGrant({ createdAt: '' })
      ])
    ).toEqual([])
  })
})
