import { describe, expect, it, vi } from 'vitest'
import {
  clampUntrustedRunPosture,
  signRunPermissionPosture,
  verifyRunPermissionPosture,
  type ClampRunPostureDeps,
  type RunPermissionPostureContext
} from './RunPermissionPosture'
import { coalesceExternalPathGrants } from './store/ExternalPathGrants'
import type { EffectiveRunPermissions, ExternalPathGrant } from './store/types'

const SECRET = Buffer.from('d'.repeat(64), 'hex')

function readOnlyPerms(): EffectiveRunPermissions {
  return {
    presetId: 'read_only',
    approvalMode: 'plan',
    agenticServices: {
      shellCommands: 'deny',
      fileChanges: 'deny',
      externalPublish: 'deny',
      mcpTools: 'ask',
      subThreadDelegation: 'ask',
      canvasInteraction: 'ask',
      sketchCanvas: 'deny',
      meshCanvas: 'ask',
      crossThreadRead: 'ask',
      threadMessage: 'ask',
      mediaEditing: 'deny',
      mediaRecording: 'deny',
      canvasEval: 'ask',
      webBrowsing: 'ask'
    },
    networkAccess: 'deny',
    externalPathGrants: [],
    workspaceGrantServiceIds: [],
    readOnly: true
  }
}

function fullAccessPerms(
  externalPathGrants: ExternalPathGrant[] = []
): EffectiveRunPermissions {
  return {
    presetId: 'full_access',
    approvalMode: 'auto_edit',
    agenticServices: {
      shellCommands: 'allow',
      fileChanges: 'allow',
      externalPublish: 'ask',
      mcpTools: 'allow',
      subThreadDelegation: 'allow',
      canvasInteraction: 'ask',
      sketchCanvas: 'allow',
      meshCanvas: 'ask',
      crossThreadRead: 'ask',
      threadMessage: 'ask',
      mediaEditing: 'allow',
      mediaRecording: 'deny',
      canvasEval: 'ask',
      webBrowsing: 'allow'
    },
    networkAccess: 'allow',
    externalPathGrants,
    workspaceGrantServiceIds: ['shellCommands', 'fileChanges'],
    readOnly: false
  }
}

function defaultPerms(): EffectiveRunPermissions {
  return {
    ...fullAccessPerms(),
    presetId: 'default',
    approvalMode: 'default',
    agenticServices: {
      ...fullAccessPerms().agenticServices,
      shellCommands: 'workspace',
      fileChanges: 'ask',
      mcpTools: 'ask',
      subThreadDelegation: 'ask',
      mediaEditing: 'ask'
    },
    workspaceGrantServiceIds: [],
    readOnly: false
  }
}

function clampDeps(): ClampRunPostureDeps & {
  reDeriveReadOnly: ReturnType<typeof vi.fn>
  reDeriveDefault: ReturnType<typeof vi.fn>
} {
  return {
    verify: (approvalMode, effectivePermissions, signature, context) =>
      verifyRunPermissionPosture(
        SECRET,
        approvalMode,
        effectivePermissions,
        signature,
        context
      ),
    reDeriveReadOnly: vi.fn(readOnlyPerms),
    reDeriveDefault: vi.fn(defaultPerms)
  }
}

function grant(
  provider: ExternalPathGrant['provider'],
  path: string,
  overrides: Partial<ExternalPathGrant> = {}
): ExternalPathGrant {
  return {
    id: `${provider}-${path}`,
    provider,
    path,
    kind: 'directory',
    access: 'read',
    duration: 'thisRun',
    createdAt: '2026-07-08T00:00:00.000Z',
    ...overrides
  }
}

describe('M3 run-payload trust boundary gates', () => {
  it('clamps unsigned effective permissions to a plan/read-only posture', () => {
    const deps = clampDeps()
    const result = clampUntrustedRunPosture(
      {
        scope: 'workspace',
        approvalMode: 'auto_edit',
        effectivePermissions: fullAccessPerms(),
        signature: undefined
      },
      deps
    )

    expect(result).toMatchObject({
      approvalMode: 'plan',
      effectivePermissions: readOnlyPerms(),
      signature: undefined,
      downgraded: true,
      reason: 'unsigned-effective-permissions'
    })
    expect(deps.reDeriveReadOnly).toHaveBeenCalledTimes(1)
    expect(deps.reDeriveDefault).not.toHaveBeenCalled()
  })

  it('accepts a signed main-issued posture roundtrip bound to run context', () => {
    const externalPathGrants = [
      grant('codex', '/repo-extra', {
        access: 'write',
        issuedBy: 'main',
        signature: 'signed-grant'
      })
    ]
    const effectivePermissions = fullAccessPerms(externalPathGrants)
    const context: RunPermissionPostureContext = {
      provider: 'codex',
      scope: 'workspace',
      appRunId: 'run-1',
      appChatId: 'chat-1',
      prompt: 'refactor the trust boundary',
      workflowMode: 'normal',
      runtimeProfileId: 'builtin:codex:local'
    }
    const signature = signRunPermissionPosture(
      SECRET,
      'auto_edit',
      effectivePermissions,
      context
    )
    const deps = clampDeps()

    const result = clampUntrustedRunPosture(
      {
        scope: 'workspace',
        approvalMode: 'auto_edit',
        effectivePermissions,
        signature,
        context
      },
      deps
    )

    expect(result).toEqual({
      approvalMode: 'auto_edit',
      effectivePermissions,
      signature,
      downgraded: false
    })
    expect(deps.reDeriveReadOnly).not.toHaveBeenCalled()
    expect(deps.reDeriveDefault).not.toHaveBeenCalled()
  })

  it('keeps external path grant ordering stable before provider filtering', () => {
    const normalized = coalesceExternalPathGrants([
      grant('kimi', '/z-later', {
        createdAt: '2026-07-08T00:03:00.000Z'
      }),
      grant('codex', '/shared', {
        createdAt: '2026-07-08T00:02:00.000Z'
      }),
      grant('grok', '/shared', {
        createdAt: '2026-07-08T00:02:30.000Z'
      }),
      grant('codex', '/a-first', {
        createdAt: '2026-07-08T00:01:00.000Z'
      }),
      grant('codex', '/shared', {
        id: 'codex-/shared-write',
        access: 'write',
        createdAt: '2026-07-08T00:04:00.000Z'
      })
    ])

    expect(normalized.map((item) => [item.provider, item.path, item.access, item.order])).toEqual([
      ['codex', '/a-first', 'read', 0],
      ['codex', '/shared', 'write', 1],
      ['grok', '/shared', 'read', 1],
      ['kimi', '/z-later', 'read', 2]
    ])
    expect(normalized.filter((item) => item.provider === 'codex').map((item) => item.path)).toEqual(
      ['/a-first', '/shared']
    )
  })
})
