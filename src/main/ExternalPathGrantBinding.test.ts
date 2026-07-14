import { describe, expect, it } from 'vitest'
import {
  EXTERNAL_PATH_GRANT_BINDING_VERSION,
  hasCanonicalExternalPathGrantMembership,
  isExecutableExternalPathGrantDuration,
  matchesExternalPathGrantExecutionAuthority,
  matchesExternalPathGrantRunBinding,
  resolveChatPrimaryWorkspace,
  signExternalPathGrantPayload,
  verifyExternalPathGrantSignature
} from './ExternalPathGrantBinding'
import type { ExternalPathGrant, WorkspaceRecord } from './store/types'

const SECRET = Buffer.alloc(32, 7)
const canonicalPath = (value: string): string => value.replace(/\/+$/, '') || '/'

function workspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    id: 'ws-a',
    path: '/Users/test/Test 1',
    displayName: 'Test 1',
    createdAt: 1,
    lastOpenedAt: 1,
    pinned: false,
    ...overrides
  }
}

function boundGrant(overrides: Partial<ExternalPathGrant> = {}): ExternalPathGrant {
  const unsigned: ExternalPathGrant = {
    id: 'grant-a',
    provider: 'codex',
    bindingVersion: EXTERNAL_PATH_GRANT_BINDING_VERSION,
    workspaceId: 'ws-a',
    chatId: 'chat-a',
    path: '/Users/test/Test 2',
    kind: 'directory',
    access: 'write',
    duration: 'thisThread',
    issuedBy: 'main',
    signature: '',
    createdAt: '2026-07-13T00:00:00.000Z',
    ...overrides
  }
  return {
    ...unsigned,
    signature: signExternalPathGrantPayload(SECRET, unsigned, canonicalPath)
  }
}

describe('external path grant v2 binding', () => {
  it('accepts the originating chat and rejects A-to-B cross-chat replay', () => {
    const grant = boundGrant()
    expect(verifyExternalPathGrantSignature(SECRET, grant, canonicalPath)).toBe(true)
    expect(
      matchesExternalPathGrantRunBinding(grant, {
        provider: 'codex',
        appChatId: 'chat-a',
        workspaceId: 'ws-a'
      })
    ).toBe(true)
    expect(
      matchesExternalPathGrantRunBinding(grant, {
        provider: 'codex',
        appChatId: 'chat-b',
        workspaceId: 'ws-a'
      })
    ).toBe(false)
  })

  it('rejects workspace replay and provider/chat/workspace signature tampering', () => {
    const grant = boundGrant()
    expect(
      matchesExternalPathGrantRunBinding(grant, {
        provider: 'codex',
        appChatId: 'chat-a',
        workspaceId: 'ws-b'
      })
    ).toBe(false)

    for (const tampered of [
      { ...grant, provider: 'claude' as const },
      { ...grant, chatId: 'chat-b' },
      { ...grant, workspaceId: 'ws-b' },
      { ...grant, securityScopedBookmark: 'forged-bookmark' }
    ]) {
      expect(verifyExternalPathGrantSignature(SECRET, tampered, canonicalPath)).toBe(false)
    }
  })

  it('binds a security-scoped bookmark because it carries filesystem authority', () => {
    const grant = boundGrant({ securityScopedBookmark: 'bookmark-a' })
    expect(verifyExternalPathGrantSignature(SECRET, grant, canonicalPath)).toBe(true)
    expect(
      verifyExternalPathGrantSignature(
        SECRET,
        { ...grant, securityScopedBookmark: 'bookmark-b' },
        canonicalPath
      )
    ).toBe(false)
  })

  it('enforces an exact thisRun id when one was known at issuance', () => {
    const grant = boundGrant({ duration: 'thisRun', appRunId: 'run-a' })
    const context = {
      provider: 'codex' as const,
      appChatId: 'chat-a',
      workspaceId: 'ws-a'
    }
    expect(matchesExternalPathGrantRunBinding(grant, { ...context, appRunId: 'run-a' })).toBe(true)
    expect(matchesExternalPathGrantRunBinding(grant, { ...context, appRunId: 'run-b' })).toBe(false)
    expect(matchesExternalPathGrantRunBinding(grant, context)).toBe(false)

    const issuedBeforeRunId = boundGrant({ duration: 'thisRun', appRunId: undefined })
    expect(
      matchesExternalPathGrantRunBinding(issuedBeforeRunId, { ...context, appRunId: 'run-a' })
    ).toBe(false)
  })

  it('preserves legitimate solo grants but refuses an unbound Ensemble attachment grant', () => {
    const runContext = {
      provider: 'codex' as const,
      appChatId: 'chat-a',
      workspaceId: 'ws-a',
      appRunId: 'participant-run-1'
    }
    // A proactive/chat grant is minted before any later solo run id exists.
    expect(matchesExternalPathGrantRunBinding(boundGrant(), runContext)).toBe(true)
    // An Ensemble non-image attachment minted before the orchestrator allocates
    // per-participant ids must be rebound by main before it is executable.
    expect(
      matchesExternalPathGrantRunBinding(
        boundGrant({ duration: 'thisRun', appRunId: undefined }),
        runContext
      )
    ).toBe(false)
  })

  it('decodes a legacy signature for migration/display but never executes it', () => {
    const legacyUnsigned: ExternalPathGrant = {
      id: 'legacy',
      provider: 'codex',
      path: '/Users/test/Test 2',
      kind: 'directory',
      access: 'read',
      duration: 'thisThread',
      issuedBy: 'main',
      signature: '',
      createdAt: '2026-07-12T00:00:00.000Z'
    }
    const legacy = {
      ...legacyUnsigned,
      signature: signExternalPathGrantPayload(SECRET, legacyUnsigned, canonicalPath)
    }
    expect(verifyExternalPathGrantSignature(SECRET, legacy, canonicalPath)).toBe(true)
    expect(
      matchesExternalPathGrantRunBinding(legacy, {
        provider: 'codex',
        appChatId: 'chat-a',
        workspaceId: 'ws-a'
      })
    ).toBe(false)
  })

  it('requires exact canonical chat membership for a durable thread grant', () => {
    const current = boundGrant({ duration: 'thisThread' })
    expect(hasCanonicalExternalPathGrantMembership(current, [current])).toBe(true)
    expect(hasCanonicalExternalPathGrantMembership(current, [])).toBe(false)
    expect(
      hasCanonicalExternalPathGrantMembership(current, [
        { ...current, signature: '0'.repeat(64) }
      ])
    ).toBe(false)
    expect(
      hasCanonicalExternalPathGrantMembership(current, [
        { ...current, id: 'replacement-grant' }
      ])
    ).toBe(false)
  })

  it('accepts the exact signed workspace duration and rejects enum tampering', () => {
    const grant = boundGrant({ duration: 'workspace' })
    expect(isExecutableExternalPathGrantDuration(grant.duration)).toBe(true)
    expect(verifyExternalPathGrantSignature(SECRET, grant, canonicalPath)).toBe(true)
    expect(
      verifyExternalPathGrantSignature(
        SECRET,
        { ...grant, duration: 'thisThread' },
        canonicalPath
      )
    ).toBe(false)
    expect(isExecutableExternalPathGrantDuration('Workspace')).toBe(false)
    expect(isExecutableExternalPathGrantDuration('workspace ')).toBe(false)
  })

  it('requires same chat/workspace/provider and live canonical membership for workspace grants', () => {
    const grant = boundGrant({ duration: 'workspace' })
    const context = {
      provider: 'codex' as const,
      appChatId: 'chat-a',
      workspaceId: 'ws-a'
    }
    expect(matchesExternalPathGrantExecutionAuthority(grant, context, [grant])).toBe(true)
    expect(
      matchesExternalPathGrantExecutionAuthority(
        grant,
        { ...context, appChatId: 'chat-b' },
        [grant]
      )
    ).toBe(false)
    expect(
      matchesExternalPathGrantExecutionAuthority(
        grant,
        { ...context, workspaceId: 'ws-b' },
        [grant]
      )
    ).toBe(false)
    expect(
      matchesExternalPathGrantExecutionAuthority(
        grant,
        { ...context, provider: 'claude' },
        [grant]
      )
    ).toBe(false)
    expect(matchesExternalPathGrantExecutionAuthority(grant, context, [])).toBe(false)
  })
})

describe('resolveChatPrimaryWorkspace', () => {
  const workspaces = [
    workspace(),
    workspace({ id: 'ws-b', path: '/Users/test/Test 2', displayName: 'Test 2' })
  ]

  it('resolves canonical, legacy-name, and path-only legacy identities', () => {
    expect(
      resolveChatPrimaryWorkspace(
        { scope: 'workspace', workspaceId: 'ws-a', workspacePath: '/Users/test/Test 1/' },
        workspaces,
        canonicalPath
      )?.id
    ).toBe('ws-a')
    expect(
      resolveChatPrimaryWorkspace(
        { scope: 'workspace', workspaceId: 'Test 1', workspacePath: '/Users/test/Test 1' },
        workspaces,
        canonicalPath
      )?.id
    ).toBe('ws-a')
    expect(
      resolveChatPrimaryWorkspace(
        { scope: 'workspace', workspacePath: '/Users/test/Test 2/' },
        workspaces,
        canonicalPath
      )?.id
    ).toBe('ws-b')
  })

  it('fails closed for unresolved explicit ids instead of falling back to a path or focus', () => {
    expect(
      resolveChatPrimaryWorkspace(
        { scope: 'workspace', workspaceId: 'missing', workspacePath: '/Users/test/Test 1' },
        workspaces,
        canonicalPath
      )
    ).toBeNull()
    expect(
      resolveChatPrimaryWorkspace(
        { scope: 'workspace', workspaceId: 'ws-a', workspacePath: '/Users/test/Test 2' },
        workspaces,
        canonicalPath
      )
    ).toBeNull()
    expect(
      resolveChatPrimaryWorkspace({ scope: 'workspace' }, workspaces, canonicalPath)
    ).toBeNull()
    expect(
      resolveChatPrimaryWorkspace(
        { scope: 'global', workspaceId: 'ws-a', workspacePath: '/Users/test/Test 1' },
        workspaces,
        canonicalPath
      )
    ).toBeNull()
  })
})
