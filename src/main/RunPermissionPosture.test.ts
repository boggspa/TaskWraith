import { describe, expect, it, vi } from 'vitest'
import {
  approvalModeRank,
  canonicalRunPermissionPosture,
  clampUntrustedRunPosture,
  coerceApprovalMode,
  signRunPermissionPosture,
  verifyRunPermissionPosture,
  type ClampRunPostureDeps,
  type RunPostureScope
} from './RunPermissionPosture'
import type { EffectiveRunPermissions } from './store/types'

const SECRET = Buffer.from('a'.repeat(64), 'hex')

function readOnlyPerms(): EffectiveRunPermissions {
  return {
    presetId: 'read_only',
    approvalMode: 'plan',
    agenticServices: {
      shellCommands: 'deny',
      fileChanges: 'deny',
      mcpTools: 'ask',
      subThreadDelegation: 'ask'
    },
    networkAccess: 'deny',
    externalPathGrants: [],
    workspaceGrantServiceIds: [],
    readOnly: true
  }
}

function fullAccessPerms(): EffectiveRunPermissions {
  return {
    presetId: 'full_access',
    approvalMode: 'auto_edit',
    agenticServices: {
      shellCommands: 'allow',
      fileChanges: 'allow',
      mcpTools: 'allow',
      subThreadDelegation: 'allow'
    },
    networkAccess: 'allow',
    externalPathGrants: [],
    workspaceGrantServiceIds: [],
    readOnly: false
  }
}

function defaultPerms(): EffectiveRunPermissions {
  return {
    presetId: 'default',
    approvalMode: 'default',
    agenticServices: {
      shellCommands: 'workspace',
      fileChanges: 'ask',
      mcpTools: 'ask',
      subThreadDelegation: 'ask'
    },
    networkAccess: 'allow',
    externalPathGrants: [],
    workspaceGrantServiceIds: [],
    readOnly: false
  }
}

/** Verifier + read-only re-derivation bound to the test secret. */
function deps(
  reDerive: () => EffectiveRunPermissions = readOnlyPerms
): ClampRunPostureDeps & {
  reDeriveReadOnly: ReturnType<typeof vi.fn>
  reDeriveDefault: ReturnType<typeof vi.fn>
} {
  return {
    verify: (mode, perms, sig, context) =>
      verifyRunPermissionPosture(SECRET, mode, perms, sig, context),
    reDeriveReadOnly: vi.fn(reDerive),
    reDeriveDefault: vi.fn(defaultPerms)
  }
}

describe('coerceApprovalMode', () => {
  it('passes recognized modes through unchanged', () => {
    expect(coerceApprovalMode('plan')).toBe('plan')
    expect(coerceApprovalMode('default')).toBe('default')
    expect(coerceApprovalMode('auto_edit')).toBe('auto_edit')
  })

  it('passes undefined/empty through (provider default applies)', () => {
    expect(coerceApprovalMode(undefined)).toBeUndefined()
    expect(coerceApprovalMode(null)).toBeUndefined()
    expect(coerceApprovalMode('')).toBeUndefined()
  })

  it('collapses unrecognized strings to default (never auto-approve)', () => {
    expect(coerceApprovalMode('yolo')).toBe('default')
    expect(coerceApprovalMode('full-auto')).toBe('default')
    expect(coerceApprovalMode('auto_edit ')).toBe('default')
  })
})

describe('approvalModeRank', () => {
  it('orders plan < default < auto_edit, unknown lowest', () => {
    expect(approvalModeRank('plan')).toBe(0)
    expect(approvalModeRank('default')).toBe(1)
    expect(approvalModeRank('auto_edit')).toBe(2)
    expect(approvalModeRank('mystery')).toBe(0)
    expect(approvalModeRank(undefined)).toBe(0)
  })
})

describe('canonical posture + sign/verify', () => {
  it('is independent of object key insertion order', () => {
    const a = canonicalRunPermissionPosture('default', fullAccessPerms())
    const reordered: EffectiveRunPermissions = {
      readOnly: false,
      workspaceGrantServiceIds: [],
      externalPathGrants: [],
      networkAccess: 'allow',
      agenticServices: {
        subThreadDelegation: 'allow',
        mcpTools: 'allow',
        fileChanges: 'allow',
        shellCommands: 'allow'
      },
      approvalMode: 'auto_edit',
      presetId: 'full_access'
    }
    expect(canonicalRunPermissionPosture('default', reordered)).toBe(a)
  })

  it('round-trips: a signed posture verifies', () => {
    const perms = fullAccessPerms()
    const sig = signRunPermissionPosture(SECRET, 'auto_edit', perms)
    expect(verifyRunPermissionPosture(SECRET, 'auto_edit', perms, sig)).toBe(true)
  })

  it('binds signatures to run context when provided', () => {
    const context = {
      provider: 'codex',
      scope: 'workspace',
      appRunId: 'run-1',
      appChatId: 'chat-1',
      prompt: 'Do the thing',
      runtimeProfileId: 'builtin:codex:local'
    }
    const sig = signRunPermissionPosture(SECRET, 'default', undefined, context)
    expect(verifyRunPermissionPosture(SECRET, 'default', undefined, sig, context)).toBe(true)
    expect(
      verifyRunPermissionPosture(SECRET, 'default', undefined, sig, {
        ...context,
        appRunId: 'run-2'
      })
    ).toBe(false)
    expect(
      verifyRunPermissionPosture(SECRET, 'default', undefined, sig, {
        ...context,
        runtimeProfileId: 'custom:codex:auto'
      })
    ).toBe(false)
  })

  it('signs even when effectivePermissions is undefined (binds approvalMode)', () => {
    const sig = signRunPermissionPosture(SECRET, 'auto_edit', undefined)
    expect(verifyRunPermissionPosture(SECRET, 'auto_edit', undefined, sig)).toBe(true)
    // A bumped approvalMode no longer matches the signature.
    expect(verifyRunPermissionPosture(SECRET, 'plan', undefined, sig)).toBe(false)
  })

  it('detects approvalMode tampering', () => {
    const perms = readOnlyPerms()
    const sig = signRunPermissionPosture(SECRET, 'plan', perms)
    expect(verifyRunPermissionPosture(SECRET, 'auto_edit', perms, sig)).toBe(false)
  })

  it('detects effectivePermissions tampering', () => {
    const sig = signRunPermissionPosture(SECRET, 'plan', readOnlyPerms())
    const inflated = { ...readOnlyPerms(), agenticServices: fullAccessPerms().agenticServices }
    expect(verifyRunPermissionPosture(SECRET, 'plan', inflated, sig)).toBe(false)
  })

  it('rejects a foreign-secret signature', () => {
    const perms = fullAccessPerms()
    const foreign = signRunPermissionPosture(Buffer.from('b'.repeat(64), 'hex'), 'auto_edit', perms)
    expect(verifyRunPermissionPosture(SECRET, 'auto_edit', perms, foreign)).toBe(false)
  })

  it('rejects malformed / empty signatures', () => {
    const perms = fullAccessPerms()
    expect(verifyRunPermissionPosture(SECRET, 'auto_edit', perms, '')).toBe(false)
    expect(verifyRunPermissionPosture(SECRET, 'auto_edit', perms, undefined)).toBe(false)
    expect(verifyRunPermissionPosture(SECRET, 'auto_edit', perms, 'not-hex!!')).toBe(false)
  })

  it('fails closed when effectivePermissions cannot be canonicalized', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const sig = signRunPermissionPosture(SECRET, 'default', undefined)
    expect(
      verifyRunPermissionPosture(
        SECRET,
        'default',
        cyclic as unknown as EffectiveRunPermissions,
        sig
      )
    ).toBe(false)
  })
})

describe('clampUntrustedRunPosture — trusted (signed) postures pass byte-for-byte', () => {
  it('passes a signed permissive workspace posture through unchanged', () => {
    const perms = fullAccessPerms()
    const signature = signRunPermissionPosture(SECRET, 'auto_edit', perms)
    const d = deps()
    const result = clampUntrustedRunPosture(
      { scope: 'workspace', approvalMode: 'auto_edit', effectivePermissions: perms, signature },
      d
    )
    expect(result.downgraded).toBe(false)
    expect(result.approvalMode).toBe('auto_edit')
    expect(result.effectivePermissions).toEqual(fullAccessPerms())
    expect(result.signature).toBe(signature)
    expect(d.reDeriveReadOnly).not.toHaveBeenCalled()
  })

  it('passes a signed read-only (plan) single-run posture through unchanged', () => {
    const perms = readOnlyPerms()
    const signature = signRunPermissionPosture(SECRET, 'plan', perms)
    const result = clampUntrustedRunPosture(
      { scope: 'workspace', approvalMode: 'plan', effectivePermissions: perms, signature },
      deps()
    )
    expect(result.downgraded).toBe(false)
    expect(result.approvalMode).toBe('plan')
    expect(result.effectivePermissions).toEqual(readOnlyPerms())
  })

  it('caps a signed global permissive posture to a default-derived permission object', () => {
    const perms = fullAccessPerms()
    const signature = signRunPermissionPosture(SECRET, 'auto_edit', perms)
    const d = deps()
    const result = clampUntrustedRunPosture(
      { scope: 'global', approvalMode: 'auto_edit', effectivePermissions: perms, signature },
      d
    )
    expect(result.downgraded).toBe(true)
    expect(result.reason).toBe('global-effective-permissions-capped')
    expect(result.approvalMode).toBe('default')
    expect(result.effectivePermissions).toEqual(defaultPerms())
    expect(result.signature).toBeUndefined()
    expect(d.reDeriveReadOnly).not.toHaveBeenCalled()
    expect(d.reDeriveDefault).toHaveBeenCalledTimes(1)
  })

  it('synthesizes read-only permissions for a signed plan posture missing the object', () => {
    const signature = signRunPermissionPosture(SECRET, 'plan', undefined)
    const d = deps()
    const result = clampUntrustedRunPosture(
      { scope: 'workspace', approvalMode: 'plan', effectivePermissions: undefined, signature },
      d
    )
    expect(result.downgraded).toBe(true)
    expect(result.reason).toBe('missing-readonly-effective-permissions')
    expect(result.approvalMode).toBe('plan')
    expect(result.effectivePermissions).toEqual(readOnlyPerms())
    expect(result.signature).toBeUndefined()
    expect(d.reDeriveReadOnly).toHaveBeenCalledTimes(1)
  })

  it('replaces a signed plan posture whose permission object is not read-only', () => {
    const perms = fullAccessPerms()
    const signature = signRunPermissionPosture(SECRET, 'plan', perms)
    const d = deps()
    const result = clampUntrustedRunPosture(
      { scope: 'workspace', approvalMode: 'plan', effectivePermissions: perms, signature },
      d
    )
    expect(result.downgraded).toBe(true)
    expect(result.reason).toBe('missing-readonly-effective-permissions')
    expect(result.approvalMode).toBe('plan')
    expect(result.effectivePermissions).toEqual(readOnlyPerms())
  })

  it('rejects a valid signature over a malformed effectivePermissions object', () => {
    const malformed = {
      presetId: 'default',
      approvalMode: 'default',
      readOnly: false
    } as unknown as EffectiveRunPermissions
    const signature = signRunPermissionPosture(SECRET, 'default', malformed)
    const result = clampUntrustedRunPosture(
      { scope: 'workspace', approvalMode: 'default', effectivePermissions: malformed, signature },
      deps()
    )
    expect(result.downgraded).toBe(true)
    expect(result.reason).toBe('invalid-effective-permissions-shape')
    expect(result.approvalMode).toBe('plan')
    expect(result.effectivePermissions).toEqual(readOnlyPerms())
  })
})

describe('clampUntrustedRunPosture — over-permissive payloads are downgraded', () => {
  it('downgrades an UNSIGNED inflated effectivePermissions object to read-only', () => {
    const d = deps()
    const result = clampUntrustedRunPosture(
      {
        scope: 'workspace',
        approvalMode: 'auto_edit',
        effectivePermissions: fullAccessPerms(),
        signature: undefined
      },
      d
    )
    expect(result.downgraded).toBe(true)
    expect(result.reason).toBe('unsigned-effective-permissions')
    expect(result.approvalMode).toBe('plan')
    expect(result.effectivePermissions).toEqual(readOnlyPerms())
    expect(result.signature).toBeUndefined()
    expect(d.reDeriveReadOnly).toHaveBeenCalledTimes(1)
  })

  it('downgrades when the signature is present but does not verify (approvalMode bump)', () => {
    const perms = readOnlyPerms()
    // Signed as plan; attacker bumps approvalMode to auto_edit but cannot re-sign.
    const signature = signRunPermissionPosture(SECRET, 'plan', perms)
    const result = clampUntrustedRunPosture(
      { scope: 'workspace', approvalMode: 'auto_edit', effectivePermissions: perms, signature },
      deps()
    )
    expect(result.downgraded).toBe(true)
    expect(result.reason).toBe('invalid-posture-signature')
    expect(result.approvalMode).toBe('plan')
    expect(result.effectivePermissions).toEqual(readOnlyPerms())
  })

  it('downgrades a forged permissive posture signed with the wrong secret', () => {
    const perms = fullAccessPerms()
    const forged = signRunPermissionPosture(Buffer.from('c'.repeat(64), 'hex'), 'auto_edit', perms)
    const result = clampUntrustedRunPosture(
      {
        scope: 'workspace',
        approvalMode: 'auto_edit',
        effectivePermissions: perms,
        signature: forged
      },
      deps()
    )
    expect(result.downgraded).toBe(true)
    expect(result.approvalMode).toBe('plan')
    expect(result.effectivePermissions).toEqual(readOnlyPerms())
  })
})

describe('clampUntrustedRunPosture — legitimate unsigned paths (no effectivePermissions)', () => {
  const cases: Array<{
    scope: RunPostureScope
    mode: string | undefined
    expected: string | undefined
  }> = [
    { scope: 'workspace', mode: 'default', expected: 'default' },
    { scope: 'workspace', mode: undefined, expected: undefined },
    { scope: 'workspace', mode: 'garbage', expected: 'default' },
    { scope: 'global', mode: 'auto_edit', expected: 'default' },
    { scope: 'global', mode: undefined, expected: 'default' }
  ]
  it.each(cases)('coerces approvalMode without downgrading (%o)', ({ scope, mode, expected }) => {
    const d = deps()
    const result = clampUntrustedRunPosture(
      { scope, approvalMode: mode, effectivePermissions: undefined, signature: undefined },
      d
    )
    expect(result.downgraded).toBe(false)
    expect(result.approvalMode).toBe(expected)
    expect(result.effectivePermissions).toBeUndefined()
    expect(d.reDeriveReadOnly).not.toHaveBeenCalled()
  })

  it.each([
    { scope: 'workspace' as const, mode: 'plan' },
    { scope: 'global' as const, mode: 'plan' }
  ])('adds read-only permissions for unsigned plan payloads (%o)', ({ scope, mode }) => {
    const d = deps()
    const result = clampUntrustedRunPosture(
      { scope, approvalMode: mode, effectivePermissions: undefined, signature: undefined },
      d
    )
    expect(result.downgraded).toBe(true)
    expect(result.reason).toBe('missing-readonly-effective-permissions')
    expect(result.approvalMode).toBe('plan')
    expect(result.effectivePermissions).toEqual(readOnlyPerms())
    expect(d.reDeriveReadOnly).toHaveBeenCalledTimes(1)
  })

  it('caps unsigned workspace auto_edit to default because raised modes must be signed', () => {
    const d = deps()
    const result = clampUntrustedRunPosture(
      {
        scope: 'workspace',
        approvalMode: 'auto_edit',
        effectivePermissions: undefined,
        signature: undefined
      },
      d
    )
    expect(result.downgraded).toBe(true)
    expect(result.reason).toBe('unsigned-raised-approval-mode')
    expect(result.approvalMode).toBe('default')
    expect(result.effectivePermissions).toBeUndefined()
    expect(d.reDeriveReadOnly).not.toHaveBeenCalled()
  })
})
