import { describe, expect, it, vi } from 'vitest'
import type {
  AgenticServiceId,
  AppSettings,
  ExternalPathGrant,
  PermissionPresetId
} from '../store/types'

// PermissionService transitively loads the store, which reads electron.app on
// import (mirrors PermissionService.test.ts).
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/taskwraith-test'
  }
}))

import { resolveEffectiveRunPermissions } from '../EffectiveRunPermissions'
import { effectiveAgenticSettings } from '../NativeApprovalPolicy'
import { isNetworkAccessBlockedTool } from '../ToolClassTaxonomy'
import { PermissionService } from '../PermissionService'
import { RunManager } from '../RunManager'

// Executable form of the tier-retirement write/shell approval proof.
//
// Context (2026-07): Ollama's bespoke tool-control tier ladder was retired. Local
// models now get the full tool surface, governed by the SAME standard permission
// role (read_only / plan / default / workspace_write / full_access) as every other
// provider — the run's `effectivePermissions` reaches the approval gate via the
// run session state (runOllamaProviderAdapter now carries it; see index.ts).
//
// This suite proves the security matrix at the REAL gate-decision seam
// (resolveEffectiveRunPermissions -> effectiveAgenticSettings ->
// PermissionService.resolvePermission), independent of the retired tier: an Ollama
// write_file / run_shell_command is DENIED under read_only/plan, PROMPTS under
// default (no standing grant) and honors an explicit grant / full_access, and web
// reads are permitted under read_only/plan while a global kill switch still denies.

// Mirror the real agenticServicesDefaults the app ships with: shell auto-allows
// only inside a granted workspace, file edits prompt, network is open.
const baseSettings = (overrides?: Partial<AppSettings['agenticServices']>): AppSettings =>
  ({
    agenticServices: {
      shellCommands: 'workspace',
      fileChanges: 'ask',
      externalPublish: 'ask',
      mcpTools: 'ask',
      subThreadDelegation: 'ask',
      canvasInteraction: 'ask',
      canvasEval: 'ask',
      networkAccess: 'allow',
      ...overrides
    },
    agenticWorkspaceGrants: []
  }) as unknown as AppSettings

const WORKSPACE = '/repo'

// Reproduce the gate's decision path for a single service: resolve the run's
// effectivePermissions for `presetId` (undefined models a solo default/auto_edit
// run, which carries no preset — parity with every other provider), fold them into
// the global settings exactly like requestAgenticServiceApproval does, then ask the
// PermissionService for the deny/ask/allow decision.
function gateDecision(
  presetId: PermissionPresetId | undefined,
  service: AgenticServiceId,
  opts: { grant?: boolean; settings?: AppSettings } = {}
): 'allow' | 'ask' | 'deny' {
  const settings = opts.settings ?? baseSettings()
  const effectivePermissions = presetId
    ? resolveEffectiveRunPermissions({
        provider: 'ollama',
        workspacePath: WORKSPACE,
        settings,
        presetId
      })
    : undefined
  const withGrant: AppSettings = opts.grant
    ? {
        ...settings,
        agenticWorkspaceGrants: [
          {
            id: `grant-${service}`,
            provider: 'ollama',
            service,
            workspacePath: WORKSPACE,
            createdAt: '2026-07-01T00:00:00.000Z',
            updatedAt: '2026-07-01T00:00:00.000Z'
          }
        ]
      }
    : settings
  const effectiveSettings = effectiveAgenticSettings(withGrant, effectivePermissions)
  const service_ = new PermissionService({ runManager: new RunManager(), sessionGrants: new Set() })
  return service_.resolvePermission('ollama', service, WORKSPACE, undefined, effectiveSettings)
    .decision
}

describe('Ollama role governance (tier retired) — write/shell approval matrix', () => {
  it('adds a secondary workspace without changing the selected permission role', () => {
    const grant: ExternalPathGrant = {
      id: 'ollama-secondary',
      provider: 'ollama',
      path: '/secondary',
      kind: 'directory',
      access: 'write',
      duration: 'thisThread',
      issuedBy: 'main',
      signature: 'signed',
      createdAt: '2026-07-11T00:00:00.000Z'
    }
    const readOnly = resolveEffectiveRunPermissions({
      provider: 'ollama',
      workspacePath: WORKSPACE,
      settings: baseSettings(),
      presetId: 'read_only',
      explicitExternalPathGrants: [grant]
    })
    const workspaceWrite = resolveEffectiveRunPermissions({
      provider: 'ollama',
      workspacePath: WORKSPACE,
      settings: baseSettings(),
      presetId: 'workspace_write',
      explicitExternalPathGrants: [grant]
    })

    expect(readOnly.externalPathGrants).toEqual([grant])
    expect(readOnly.agenticServices.fileChanges).toBe('deny')
    expect(readOnly.readOnly).toBe(true)
    expect(workspaceWrite.externalPathGrants).toEqual([grant])
    expect(workspaceWrite.agenticServices.fileChanges).toBe('workspace')
    expect(workspaceWrite.readOnly).toBe(false)
  })

  it('DENIES file edits and shell under read_only and plan', () => {
    for (const presetId of ['read_only', 'plan'] as const) {
      expect(gateDecision(presetId, 'fileChanges')).toBe('deny')
      expect(gateDecision(presetId, 'shellCommands')).toBe('deny')
      // A standing workspace grant CANNOT override a preset 'deny' — deny wins.
      expect(gateDecision(presetId, 'fileChanges', { grant: true })).toBe('deny')
      expect(gateDecision(presetId, 'shellCommands', { grant: true })).toBe('deny')
    }
  })

  it('PROMPTS (never silently auto-executes) file edits and shell under default with no grant', () => {
    // default preset carries no service overrides -> falls to global policy, exactly
    // like every other provider's Default Approval. No standing grant => prompt.
    expect(gateDecision('default', 'fileChanges')).toBe('ask')
    expect(gateDecision('default', 'shellCommands')).toBe('ask')
    // The solo composer sends no preset for a plain 'default'/'auto_edit' run
    // (effectivePermissions undefined); the raw global fallback must still prompt.
    expect(gateDecision(undefined, 'fileChanges')).toBe('ask')
    expect(gateDecision(undefined, 'shellCommands')).toBe('ask')
  })

  it('honors an explicit standing grant under default / workspace_write, and auto-allows under full_access', () => {
    // The user's own standing workspace grant auto-allows — this is explicit prior
    // authorization, identical to every provider, NOT a silent tier bump.
    expect(gateDecision('default', 'shellCommands', { grant: true })).toBe('allow')
    expect(gateDecision('workspace_write', 'fileChanges', { grant: true })).toBe('allow')
    expect(gateDecision('workspace_write', 'shellCommands', { grant: true })).toBe('allow')
    // workspace_write without a grant still prompts.
    expect(gateDecision('workspace_write', 'fileChanges')).toBe('ask')
    // full_access is an explicit user opt-in -> auto-allow with no grant needed.
    expect(gateDecision('full_access', 'fileChanges')).toBe('allow')
    expect(gateDecision('full_access', 'shellCommands')).toBe('allow')
  })
})

describe('Ollama role governance (tier retired) — web read matrix', () => {
  const settings = baseSettings()

  it('permits web_search / web_fetch under read_only and plan (the original bug)', () => {
    for (const presetId of ['read_only', 'plan'] as const) {
      const perms = resolveEffectiveRunPermissions({
        provider: 'ollama',
        workspacePath: WORKSPACE,
        settings,
        presetId
      })
      expect(perms.networkAccess).toBe('allow')
      expect(isNetworkAccessBlockedTool('web_search', perms, settings)).toBe(false)
      expect(isNetworkAccessBlockedTool('web_fetch', perms, settings)).toBe(false)
      expect(isNetworkAccessBlockedTool('github_ci_status', perms, settings)).toBe(false)
    }
  })

  it('permits web reads on a default/auto_edit run (undefined effectivePermissions)', () => {
    expect(isNetworkAccessBlockedTool('web_search', undefined, settings)).toBe(false)
    expect(isNetworkAccessBlockedTool('web_fetch', undefined, settings)).toBe(false)
    expect(isNetworkAccessBlockedTool('github_ci_status', undefined, settings)).toBe(false)
  })

  it('a global network kill switch still denies web reads even under read_only', () => {
    const denied = baseSettings({ networkAccess: 'deny' })
    const perms = resolveEffectiveRunPermissions({
      provider: 'ollama',
      workspacePath: WORKSPACE,
      settings: denied,
      presetId: 'read_only'
    })
    // Global 'deny' wins over the preset's 'allow'.
    expect(perms.networkAccess).toBe('deny')
    expect(isNetworkAccessBlockedTool('web_search', perms, denied)).toBe(true)
    expect(isNetworkAccessBlockedTool('github_ci_status', perms, denied)).toBe(true)
  })

  it('a preview-risk model stays offline under read_only regardless of the preset flip', () => {
    const perms = resolveEffectiveRunPermissions({
      provider: 'claude',
      workspacePath: WORKSPACE,
      model: 'preview:anthropic:claude-fable-5',
      settings,
      presetId: 'read_only'
    })
    expect(perms.networkAccess).toBe('deny')
    expect(isNetworkAccessBlockedTool('web_search', perms, settings)).toBe(true)
  })
})
