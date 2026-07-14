// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { normalizeAgentRunPayload, type AgentRunNormalizerDeps } from './AgentRunNormalizer'
import type {
  AppSettings,
  ChatRecord,
  EffectiveRunPermissions,
  ExternalPathGrant
} from '../store/types'

/**
 * M3-1b wrapper-level regression net. GH1's committed M3RunPayloadTrustBoundary
 * tests fence the trust PRIMITIVES (clampUntrustedRunPosture / coalesce) in
 * isolation. This test fences the WRAPPER: that normalizeAgentRunPayload threads
 * its 7 injected deps to the right places and that the clamp's decision
 * propagates end-to-end into the returned payload. Deps are fully faked (the
 * extraction's whole purpose), so no Electron / AppStore / secret bootstrap.
 */

// resolveEffectiveRunPermissions (real, invoked by the clamp's reDerive closures)
// reads only Pick<AppSettings, 'agenticServices' | 'agenticWorkspaceGrants'>.
const FAKE_SETTINGS = {
  agenticServices: {
    shellCommands: 'ask',
    fileChanges: 'ask',
    externalPublish: 'ask',
    mcpTools: 'ask',
    subThreadDelegation: 'ask',
    canvasInteraction: 'ask',
    crossThreadRead: 'ask',
    mediaEditing: 'ask',
    mediaRecording: 'ask',
    canvasEval: 'ask',
    networkAccess: 'allow'
  },
  agenticWorkspaceGrants: []
} as unknown as AppSettings

// A shape-valid signed posture (passes isEffectiveRunPermissions in the clamp).
const VALID_PERMS: EffectiveRunPermissions = {
  presetId: 'full_access',
  approvalMode: 'auto_edit',
  agenticServices: {
    shellCommands: 'allow',
    fileChanges: 'allow',
    externalPublish: 'ask',
    mcpTools: 'allow',
    subThreadDelegation: 'allow',
    canvasInteraction: 'ask',
    crossThreadRead: 'ask',
    mediaEditing: 'allow',
    mediaRecording: 'deny',
    canvasEval: 'ask'
  },
  networkAccess: 'allow',
  externalPathGrants: [],
  workspaceGrantServiceIds: [],
  readOnly: false
}

function grant(overrides: Partial<ExternalPathGrant> = {}): ExternalPathGrant {
  return {
    id: 'g1',
    provider: 'codex',
    path: '/x',
    kind: 'directory',
    access: 'read',
    duration: 'thisRun',
    createdAt: '2026-07-08T00:00:00.000Z',
    ...overrides
  }
}

function makeDeps(overrides: Partial<AgentRunNormalizerDeps> = {}): AgentRunNormalizerDeps {
  return {
    verifyRunPosture: vi.fn(() => false),
    normalizeExternalPathGrants: vi.fn((grants?: ExternalPathGrant[]) => grants ?? []),
    isMainIssuedExternalPathGrant: vi.fn(() => true),
    requireGlobalChat: vi.fn(() => ({}) as ChatRecord),
    globalRunCwd: vi.fn(() => '/home/user'),
    canonicalWorkspacePath: vi.fn((value: string) => `/canon${value}`),
    getSettings: vi.fn(() => FAKE_SETTINGS),
    ...overrides
  }
}

describe('normalizeAgentRunPayload — wrapper-level invariants (faked deps)', () => {
  it('strips renderer-supplied MCP profile and fence state', () => {
    const result = normalizeAgentRunPayload(
      {
        provider: 'claude',
        scope: 'workspace',
        workspace: '/repo',
        prompt: 'do work',
        taskWraithMcpProfileId: 'taskwraith-core-v1',
        taskWraithMcpAdvertised: true,
        taskWraithMcpProfileFence: {
          expectedStoreProviderSessionId: 'forged',
          expectedStoreReceiptFingerprint: 'forged',
          runStartedProviderSessionId: 'forged',
          runStartedReceiptFingerprint: 'forged',
          storeWritable: true
        }
      },
      makeDeps()
    )

    expect(result.taskWraithMcpProfileId).toBeUndefined()
    expect(result.taskWraithMcpAdvertised).toBeUndefined()
    expect(result.taskWraithMcpProfileFence).toBeUndefined()
  })

  it('preserves only a structurally valid main-canonical provider reroute', () => {
    const valid = normalizeAgentRunPayload(
      {
        provider: 'claude',
        providerReroute: {
          from: 'codex',
          to: 'claude',
          reason: 'provider-paused',
          savedAsDefault: true
        },
        scope: 'workspace',
        workspace: '/repo',
        prompt: 'work'
      },
      makeDeps()
    )
    expect(valid.providerReroute).toEqual({
      from: 'codex',
      to: 'claude',
      reason: 'provider-paused',
      savedAsDefault: true
    })
    const malformed = normalizeAgentRunPayload(
      {
        provider: 'claude',
        providerReroute: { from: 'codex', to: 'kimi', reason: 'provider-paused' },
        scope: 'workspace',
        workspace: '/repo',
        prompt: 'work'
      },
      makeDeps()
    )
    expect(malformed.providerReroute).toBeUndefined()
  })

  // Invariant 1: unsigned effectivePermissions → the clamp's read-only downgrade
  // PROPAGATES into the returned payload (end-to-end, not clamp-in-isolation),
  // and the injected getSettings feeds the reDerive closure.
  it('propagates the unsigned-effective-permissions clamp downgrade into the payload', () => {
    const deps = makeDeps()
    const result = normalizeAgentRunPayload(
      {
        provider: 'codex',
        scope: 'workspace',
        workspace: '/repo',
        prompt: 'do work',
        effectivePermissions: VALID_PERMS // present, but NO signature → unsigned
      },
      deps
    )

    expect(result.approvalMode).toBe('plan')
    expect(result.workflowMode).toBe('normal') // downgraded runs are forced to normal
    expect(result.effectivePermissions?.readOnly).toBe(true) // reDeriveReadOnly result landed
    expect(vi.mocked(deps.getSettings)).toHaveBeenCalled() // reDerive closure invoked the dep
    expect(vi.mocked(deps.verifyRunPosture)).not.toHaveBeenCalled() // no signature → verify skipped
  })

  // Invariant 2: a signed main-issued posture passes through untouched
  // (downgraded:false) and verify is threaded with the built run context.
  it('passes a signed, verified posture through unchanged', () => {
    const deps = makeDeps({ verifyRunPosture: vi.fn(() => true) })
    const result = normalizeAgentRunPayload(
      {
        provider: 'codex',
        scope: 'workspace',
        workspace: '/repo',
        prompt: 'do work',
        approvalMode: 'auto_edit',
        effectivePermissions: VALID_PERMS,
        effectivePermissionsSignature: 'deadbeef'
      },
      deps
    )

    expect(result.approvalMode).toBe('auto_edit')
    expect(result.effectivePermissions).toEqual(VALID_PERMS)
    expect(result.effectivePermissionsSignature).toBe('deadbeef')
    expect(vi.mocked(deps.getSettings)).not.toHaveBeenCalled() // no downgrade → no reDerive
    expect(vi.mocked(deps.verifyRunPosture)).toHaveBeenCalledWith(
      'auto_edit',
      VALID_PERMS,
      'deadbeef',
      expect.objectContaining({ provider: 'codex', scope: 'workspace' })
    )
  })

  // Invariant 3: external path grants flow through the injected
  // normalizeExternalPathGrants + isMainIssuedExternalPathGrant deps, and the
  // normalized+provider-scoped result is assigned to the payload.
  it('threads external path grants through the injected grant deps', () => {
    const rawGrant = grant({ issuedBy: 'main', signature: 'sig' })
    const normalizedGrant = grant({ issuedBy: 'main', signature: 'sig', path: '/canon/x' })
    const deps = makeDeps({
      verifyRunPosture: vi.fn(() => true),
      normalizeExternalPathGrants: vi.fn(() => [normalizedGrant])
    })

    const result = normalizeAgentRunPayload(
      {
        provider: 'codex',
        scope: 'workspace',
        workspace: '/repo',
        prompt: 'do work',
        approvalMode: 'auto_edit',
        effectivePermissions: VALID_PERMS,
        effectivePermissionsSignature: 'deadbeef',
        externalPathGrants: [rawGrant]
      },
      deps
    )

    expect(vi.mocked(deps.normalizeExternalPathGrants)).toHaveBeenCalledWith([rawGrant])
    expect(vi.mocked(deps.isMainIssuedExternalPathGrant)).toHaveBeenCalled() // main-tagged grant guard
    expect(result.externalPathGrants).toEqual([normalizedGrant]) // provider 'codex' kept
  })

  it('rejects cross-chat/workspace grant replay at the dispatch boundary', () => {
    const rawGrant = grant({
      issuedBy: 'main',
      signature: 'sig',
      bindingVersion: 2,
      chatId: 'chat-a',
      workspaceId: 'ws-a'
    })
    const isMainIssuedExternalPathGrant = vi.fn(
      (_grant: ExternalPathGrant, context?: { appChatId?: string; workspacePath?: string }) =>
        context === undefined
    )
    const deps = makeDeps({
      normalizeExternalPathGrants: vi.fn(() => [rawGrant]),
      isMainIssuedExternalPathGrant
    })

    expect(() =>
      normalizeAgentRunPayload(
        {
          provider: 'codex',
          scope: 'workspace',
          workspace: '/repo-b',
          appChatId: 'chat-b',
          appRunId: 'run-b',
          prompt: 'do work',
          externalPathGrants: [rawGrant]
        },
        deps
      )
    ).toThrow('does not match this chat, workspace, provider, or run')
    expect(isMainIssuedExternalPathGrant).toHaveBeenLastCalledWith(rawGrant, {
      provider: 'codex',
      appChatId: 'chat-b',
      appRunId: 'run-b',
      workspacePath: '/canon/repo-b'
    })
  })

  it('rejects a grant issued for a different provider instead of silently dropping it', () => {
    const wrongProviderGrant = grant({
      provider: 'claude',
      issuedBy: 'main',
      signature: 'sig',
      bindingVersion: 2,
      chatId: 'chat-a',
      workspaceId: 'ws-a'
    })
    const deps = makeDeps({
      normalizeExternalPathGrants: vi.fn(() => [wrongProviderGrant])
    })

    expect(() =>
      normalizeAgentRunPayload(
        {
          provider: 'codex',
          scope: 'workspace',
          workspace: '/repo',
          appChatId: 'chat-a',
          prompt: 'do work',
          externalPathGrants: [wrongProviderGrant]
        },
        deps
      )
    ).toThrow('provider does not match the dispatched provider')
  })

  it('rejects integrity-valid legacy grants when they lack v2 run binding', () => {
    const legacyGrant = grant({ issuedBy: 'main', signature: 'legacy-sig' })
    const isMainIssuedExternalPathGrant = vi.fn(
      (_grant: ExternalPathGrant, context?: unknown) => context === undefined
    )
    const deps = makeDeps({
      normalizeExternalPathGrants: vi.fn(() => [legacyGrant]),
      isMainIssuedExternalPathGrant
    })

    expect(() =>
      normalizeAgentRunPayload(
        {
          provider: 'codex',
          scope: 'workspace',
          workspace: '/repo',
          appChatId: 'chat-a',
          prompt: 'do work',
          externalPathGrants: [legacyGrant]
        },
        deps
      )
    ).toThrow('does not match this chat, workspace, provider, or run')
  })

  // Invariant 4: provider-liveness — a retired/invalid provider is rejected at
  // the chokepoint before any dependency runs.
  it('rejects an invalid/retired provider before invoking any dep', () => {
    const deps = makeDeps()
    expect(() =>
      normalizeAgentRunPayload(
        { provider: 'not-a-provider', scope: 'workspace', workspace: '/repo', prompt: 'x' },
        deps
      )
    ).toThrow()
    expect(vi.mocked(deps.canonicalWorkspacePath)).not.toHaveBeenCalled()
  })

  it('drops stale Claude Fast mode for Fable while preserving it for supported Opus models', () => {
    const deps = makeDeps()
    const normalizeClaude = (model: string) =>
      normalizeAgentRunPayload(
        {
          provider: 'claude',
          scope: 'workspace',
          workspace: '/repo',
          prompt: 'do work',
          model,
          claudeFastMode: true
        },
        deps
      )

    expect(normalizeClaude('claude-fable-5').claudeFastMode).toBeUndefined()
    expect(normalizeClaude('claude-fable-5-1m').claudeFastMode).toBeUndefined()
    expect(normalizeClaude('claude-opus-4-8-1m').claudeFastMode).toBe(true)
  })

  // Invariant 5 (coverage): the global-scope branch threads requireGlobalChat +
  // globalRunCwd (and skips the workspace canonicalizer). Combined with the tests
  // above, all 7 deps are asserted "called where expected":
  //   verifyRunPosture (2,3) · normalizeExternalPathGrants (3) ·
  //   isMainIssuedExternalPathGrant (3) · canonicalWorkspacePath (1,2,3) ·
  //   getSettings (1) · requireGlobalChat + globalRunCwd (here).
  it('threads the global-scope deps and derives cwd from globalRunCwd', () => {
    const deps = makeDeps({ verifyRunPosture: vi.fn(() => true) })
    const result = normalizeAgentRunPayload(
      {
        provider: 'codex',
        scope: 'global',
        appChatId: 'chat-1',
        prompt: 'do work',
        approvalMode: 'default'
      },
      deps
    )

    expect(vi.mocked(deps.requireGlobalChat)).toHaveBeenCalledWith('chat-1', 'Run global chat')
    expect(vi.mocked(deps.globalRunCwd)).toHaveBeenCalled()
    expect(result.workspace).toBe('/home/user')
    expect(vi.mocked(deps.canonicalWorkspacePath)).not.toHaveBeenCalled()
  })
})
