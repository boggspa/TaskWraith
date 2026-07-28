import { describe, expect, it } from 'vitest'
import { effectiveAgenticSettings, taskWraithToolAgenticService } from './NativeApprovalPolicy'
import {
  DEFAULT_PERMISSION_PRESETS,
  resolveEffectiveRunPermissions
} from './EffectiveRunPermissions'
import { AGENTIC_SERVICE_IDS, AGENTIC_SERVICE_LABELS } from './AgenticServiceMessages'
import { RECALL_MCP_TOOL_NAMES } from './mcp/RecallToolExecutors'
import type {
  AgenticServiceId,
  AgenticServicePolicy,
  AgenticServicesSettings,
  AppSettings,
  EffectiveRunPermissions
} from './store/types'

function settings(
  over: Partial<AgenticServicesSettings>
): Pick<AppSettings, 'agenticServices' | 'agenticWorkspaceGrants'> {
  return {
    agenticServices: {
      shellCommands: 'ask',
      fileChanges: 'ask',
      mcpTools: 'ask',
      subThreadDelegation: 'ask',
      canvasInteraction: 'ask',
      sketchCanvas: 'allow',
      canvasEval: 'ask',
      networkAccess: 'allow',
      ...over
    },
    agenticWorkspaceGrants: []
  }
}

function effectiveServices(
  over: Partial<Record<AgenticServiceId, AgenticServicePolicy>>
): Record<AgenticServiceId, AgenticServicePolicy> {
  return {
    shellCommands: 'ask',
    fileChanges: 'ask',
    externalPublish: 'ask',
    mcpTools: 'ask',
    subThreadDelegation: 'ask',
    canvasInteraction: 'ask',
    sketchCanvas: 'allow',
    meshCanvas: 'ask',
    crossThreadRead: 'ask',
    threadMessage: 'ask',
    mediaEditing: 'ask',
    mediaRecording: 'deny',
    canvasEval: 'ask',
    ...over
  }
}

describe('crossThreadRead approval service', () => {
  it('routes every recall tool to crossThreadRead — never mcpTools', () => {
    for (const name of RECALL_MCP_TOOL_NAMES) {
      expect(taskWraithToolAgenticService(name)).toBe('crossThreadRead')
    }
    // A non-recall tool still falls through to mcpTools.
    expect(taskWraithToolAgenticService('some_other_tool')).toBe('mcpTools')
  })

  it('is enumerated wherever agentic services are listed', () => {
    expect(AGENTIC_SERVICE_IDS.has('crossThreadRead')).toBe(true)
    expect(AGENTIC_SERVICE_LABELS.crossThreadRead).toBeTruthy()
  })

  it('is denied under the read_only preset and allowed under full_access', () => {
    expect(DEFAULT_PERMISSION_PRESETS.read_only.agenticServices?.crossThreadRead).toBe('deny')
    expect(DEFAULT_PERMISSION_PRESETS.full_access.agenticServices?.crossThreadRead).toBe('allow')
  })

  it('resolves to deny under read_only even when settings would allow it', () => {
    const eff = resolveEffectiveRunPermissions({
      provider: 'claude',
      presetId: 'read_only',
      settings: settings({ crossThreadRead: 'allow' })
    })
    expect(eff.agenticServices.crossThreadRead).toBe('deny')
  })

  it('is GRANTABLE — honors a workspace/allow setting, unlike non-grantable canvasEval', () => {
    const eff = resolveEffectiveRunPermissions({
      provider: 'claude',
      presetId: 'default',
      settings: settings({ crossThreadRead: 'workspace', canvasEval: 'allow' })
    })
    expect(eff.agenticServices.crossThreadRead).toBe('workspace')
    // canvasEval is clamped (non-grantable) — a settings 'allow' must not survive.
    expect(eff.agenticServices.canvasEval).not.toBe('allow')
  })

  it('deny-survives the effective-settings rebuild (the P1 leak class)', () => {
    const merged = effectiveAgenticSettings(
      { agenticServices: settings({ crossThreadRead: 'allow' }).agenticServices } as AppSettings,
      {
        agenticServices: effectiveServices({ crossThreadRead: 'deny' }),
        networkAccess: 'allow'
      } as EffectiveRunPermissions
    )
    expect(merged.agenticServices.crossThreadRead).toBe('deny')
  })
})
