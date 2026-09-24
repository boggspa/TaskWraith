import { describe, expect, it } from 'vitest'
import {
  effectiveAgenticSettings,
  taskWraithToolAgenticService,
  taskWraithToolServiceIfKnown
} from './NativeApprovalPolicy'
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
    simulatorCanvas: 'ask',
    crossThreadRead: 'ask',
    threadMessage: 'ask',
    mediaEditing: 'ask',
    mediaRecording: 'deny',
    canvasEval: 'ask',
    webBrowsing: 'ask',
    ...over
  }
}

describe('crossThreadRead approval service', () => {
  it('routes every recall tool to crossThreadRead — never mcpTools', () => {
    for (const name of RECALL_MCP_TOOL_NAMES) {
      expect(taskWraithToolAgenticService(name)).toBe('crossThreadRead')
    }
    // An unknown execution label fails explicit instead of inheriting mcpTools.
    expect(taskWraithToolServiceIfKnown('some_other_tool')).toBeNull()
  })

  it('is enumerated wherever agentic services are listed', () => {
    expect(AGENTIC_SERVICE_IDS.has('crossThreadRead')).toBe(true)
    expect(AGENTIC_SERVICE_LABELS.crossThreadRead).toBeTruthy()
  })

  it('asks under the read_only preset and allows under full_access', () => {
    expect(DEFAULT_PERMISSION_PRESETS.read_only.agenticServices?.crossThreadRead).toBe('ask')
    expect(DEFAULT_PERMISSION_PRESETS.full_access.agenticServices?.crossThreadRead).toBe('allow')
  })

  it('stays per-invocation under read_only even when settings would allow it', () => {
    const eff = resolveEffectiveRunPermissions({
      provider: 'claude',
      presetId: 'read_only',
      settings: settings({ crossThreadRead: 'allow' })
    })
    expect(eff.agenticServices.crossThreadRead).toBe('ask')
  })

  it('honors a broad workspace setting, unlike exact-surface-window canvasEval', () => {
    const eff = resolveEffectiveRunPermissions({
      provider: 'claude',
      presetId: 'default',
      settings: settings({ crossThreadRead: 'workspace', canvasEval: 'allow' })
    })
    expect(eff.agenticServices.crossThreadRead).toBe('workspace')
    // A canvasEval settings allow cannot become an all-surfaces grant; its
    // dedicated live-surface window is resolved at the approval gate.
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
