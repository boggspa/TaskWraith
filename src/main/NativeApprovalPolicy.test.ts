import { describe, expect, it } from 'vitest'
import {
  canonicalTaskWraithToolName,
  effectiveAgenticSettings,
  resolveNativeApprovalPreflightDecision,
  taskWraithToolAgenticService,
  taskWraithToolServiceIfKnown
} from './NativeApprovalPolicy'
import type {
  AgenticServiceId,
  AgenticServicePolicy,
  AppSettings,
  EffectiveRunPermissions
} from './store/types'

const resolution = (
  decision: 'allow' | 'ask' | 'deny',
  policy: AgenticServicePolicy = decision === 'deny' ? 'deny' : 'ask',
  grants: Partial<{ workspaceGrantAllowed: boolean; sessionGrantAllowed: boolean }> = {}
) => ({
  policy,
  workspaceGrantAllowed: Boolean(grants.workspaceGrantAllowed),
  sessionGrantAllowed: Boolean(grants.sessionGrantAllowed),
  decision
})

const effectivePermissions = (
  readOnly: boolean,
  agenticServices: Record<AgenticServiceId, AgenticServicePolicy> = {
    shellCommands: 'deny',
    fileChanges: 'deny',
    mcpTools: 'ask',
    subThreadDelegation: 'ask',
    canvasInteraction: 'deny',
    crossThreadRead: 'deny',
    mediaEditing: 'deny',
    mediaRecording: 'deny',
    canvasEval: 'deny'
  }
): EffectiveRunPermissions => ({
  presetId: readOnly ? 'read_only' : 'default',
  approvalMode: 'default',
  agenticServices,
  networkAccess: 'deny',
  externalPathGrants: [],
  workspaceGrantServiceIds: [],
  readOnly
})

describe('canonicalTaskWraithToolName', () => {
  it('normalizes provider-native MCP wrappers to TaskWraith tool names', () => {
    expect(canonicalTaskWraithToolName('mcp__taskwraith__write_file')).toBe('write_file')
    expect(canonicalTaskWraithToolName('taskwraith__delegate_to_subthread')).toBe(
      'delegate_to_subthread'
    )
    expect(canonicalTaskWraithToolName('mcp__TaskWraith__RUN_SHELL_COMMAND')).toBe(
      'run_shell_command'
    )
    expect(canonicalTaskWraithToolName('mcp_taskwraith-broker-write_file')).toBe('write_file')
    expect(canonicalTaskWraithToolName('mcp_taskwraith-broker_run_shell_command')).toBe(
      'run_shell_command'
    )
    expect(canonicalTaskWraithToolName('mcp_taskwraith-read_file')).toBe('read_file')
  })
})

describe('taskWraithToolServiceIfKnown', () => {
  it('maps native TaskWraith MCP approvals to their real agentic service', () => {
    expect(taskWraithToolServiceIfKnown('mcp__taskwraith__run_shell_command')).toBe('shellCommands')
    expect(taskWraithToolServiceIfKnown('mcp_taskwraith-broker-run_shell_command')).toBe(
      'shellCommands'
    )
    expect(taskWraithToolServiceIfKnown('mcp__taskwraith__get_diagnostics')).toBe(
      'shellCommands'
    )
    expect(taskWraithToolServiceIfKnown('mcp__other_server__write_file')).toBe('fileChanges')
    expect(taskWraithToolServiceIfKnown('taskwraith__write_file')).toBe('fileChanges')
    expect(taskWraithToolServiceIfKnown('taskwraith__delete_path')).toBe('fileChanges')
    expect(taskWraithToolServiceIfKnown('taskwraith__move_path')).toBe('fileChanges')
    expect(taskWraithToolServiceIfKnown('taskwraith__git_push')).toBe('fileChanges')
    expect(taskWraithToolServiceIfKnown('taskwraith__git_create_pr')).toBe('fileChanges')
    expect(taskWraithToolServiceIfKnown('delegate_to_subthread')).toBe('subThreadDelegation')
    expect(taskWraithToolServiceIfKnown('list_active_runs')).toBe('mcpTools')
    expect(taskWraithToolServiceIfKnown('cancel_active_run')).toBe('mcpTools')
    expect(taskWraithToolServiceIfKnown('ensemble_yield')).toBe('mcpTools')
  })

  it('leaves non-TaskWraith tool names unclassified', () => {
    expect(taskWraithToolServiceIfKnown('mcp__other_server__totally_unknown')).toBeNull()
    expect(taskWraithToolServiceIfKnown('totally_unknown')).toBeNull()
  })
})

describe('taskWraithToolAgenticService — canvas interaction bucket', () => {
  it('routes canvas_click/canvas_fill to canvasInteraction, leaves reads on mcpTools', () => {
    expect(taskWraithToolAgenticService('canvas_click')).toBe('canvasInteraction')
    expect(taskWraithToolAgenticService('canvas_fill')).toBe('canvasInteraction')
    expect(taskWraithToolAgenticService('canvas_snapshot')).toBe('mcpTools')
    expect(taskWraithToolAgenticService('canvas_open_launch')).toBe('mcpTools')
  })

  it('routes canvas_eval to its own stricter canvasEval bucket', () => {
    // Distinct from canvasInteraction: eval is non-grantable / never-auto-allowed.
    expect(taskWraithToolAgenticService('canvas_eval')).toBe('canvasEval')
    expect(taskWraithToolAgenticService('canvas_eval')).not.toBe('canvasInteraction')
  })
})

describe('taskWraithToolAgenticService — Run-Button launch bucket', () => {
  it('routes launch start/stop to shellCommands and keeps launch reads on mcpTools', () => {
    expect(taskWraithToolAgenticService('launch_start')).toBe('shellCommands')
    expect(taskWraithToolAgenticService('launch_stop')).toBe('shellCommands')
    expect(taskWraithToolAgenticService('launch_list_targets')).toBe('mcpTools')
    expect(taskWraithToolAgenticService('launch_status')).toBe('mcpTools')
  })
})

describe('resolveNativeApprovalPreflightDecision — neverAutoAllow (canvas_eval / RCE)', () => {
  it('clamps an automatic allow down to a prompt', () => {
    // A workspace/session grant would normally auto-allow (decision: 'allow').
    expect(
      resolveNativeApprovalPreflightDecision({
        resolution: resolution('allow', 'ask', { sessionGrantAllowed: true }),
        neverAutoAllow: true
      })
    ).toMatchObject({ kind: 'ask' })
  })

  it('clamps session-YOLO down to a prompt for a non-read-only run', () => {
    expect(
      resolveNativeApprovalPreflightDecision({
        resolution: resolution('ask'),
        sessionYoloEnabled: true,
        readOnly: false,
        neverAutoAllow: true
      })
    ).toMatchObject({ kind: 'ask' })
  })

  it('still lets an explicit deny win over neverAutoAllow', () => {
    expect(
      resolveNativeApprovalPreflightDecision({
        resolution: resolution('deny'),
        neverAutoAllow: true
      })
    ).toMatchObject({ kind: 'deny' })
  })
})

describe('resolveNativeApprovalPreflightDecision — neverAutoAllow (mediaRecording capture)', () => {
  // mediaRecording (future mic/camera capture) is a default-deny, NON-grantable scaffold whose
  // invariant is that capture must NEVER be promoted above default-deny — not by a grant and not
  // by session-YOLO (see store/types.ts mediaRecording docs + EffectiveRunPermissions clamps).
  // The two gate sites set neverAutoAllow whenever the service is mediaRecording (alongside
  // canvasEval): index.ts:5957 (resolveNativeApprovalPreflight, Codex/Kimi native path) and
  // index.ts:6120 (requestAgenticServiceApproval, Gemini/MCP-dispatcher/Claude/Kimi path).
  // These pin the downstream clamp so the day a capture tool classifies as mediaRecording,
  // session-YOLO cannot silently auto-allow it.
  it('clamps session-YOLO down to a prompt for a non-read-only run', () => {
    expect(
      resolveNativeApprovalPreflightDecision({
        resolution: resolution('ask'),
        sessionYoloEnabled: true,
        readOnly: false,
        neverAutoAllow: true
      })
    ).toMatchObject({ kind: 'ask' })
  })

  it('clamps a grant-driven automatic allow down to a prompt', () => {
    expect(
      resolveNativeApprovalPreflightDecision({
        resolution: resolution('allow', 'ask', { sessionGrantAllowed: true }),
        neverAutoAllow: true
      })
    ).toMatchObject({ kind: 'ask' })
  })

  it('still lets an explicit deny win (capture stays denied)', () => {
    expect(
      resolveNativeApprovalPreflightDecision({
        resolution: resolution('deny'),
        neverAutoAllow: true
      })
    ).toMatchObject({ kind: 'deny' })
  })
})

describe('resolveNativeApprovalPreflightDecision', () => {
  it('keeps deny as the strongest decision', () => {
    expect(
      resolveNativeApprovalPreflightDecision({
        resolution: resolution('deny'),
        externalPathDetected: true,
        sessionYoloEnabled: true,
        readOnly: false
      })
    ).toMatchObject({ kind: 'deny', policy: 'deny' })
  })

  it('forces a prompt for external paths before automatic allows', () => {
    expect(
      resolveNativeApprovalPreflightDecision({
        resolution: resolution('allow', 'allow'),
        externalPathDetected: true,
        sessionYoloEnabled: true,
        readOnly: false
      })
    ).toMatchObject({ kind: 'ask', policy: 'allow' })
  })

  it('does not let YOLO weaken read-only posture', () => {
    expect(
      resolveNativeApprovalPreflightDecision({
        resolution: resolution('ask'),
        sessionYoloEnabled: true,
        readOnly: true,
        effectivePermissions: effectivePermissions(true)
      })
    ).toMatchObject({ kind: 'ask', policy: 'ask' })
  })

  it('auto-allows YOLO only when the run is not read-only', () => {
    expect(
      resolveNativeApprovalPreflightDecision({
        resolution: resolution('ask'),
        sessionYoloEnabled: true,
        readOnly: false
      })
    ).toMatchObject({ kind: 'allow', reason: 'session_yolo', scope: 'session' })
  })

  it('preserves the reason and scope for policy, session, and workspace allows', () => {
    expect(
      resolveNativeApprovalPreflightDecision({
        resolution: resolution('allow', 'allow')
      })
    ).toMatchObject({ kind: 'allow', reason: 'policy', scope: 'request' })

    expect(
      resolveNativeApprovalPreflightDecision({
        resolution: resolution('allow', 'ask', { sessionGrantAllowed: true })
      })
    ).toMatchObject({ kind: 'allow', reason: 'session_grant', scope: 'session' })

    expect(
      resolveNativeApprovalPreflightDecision({
        resolution: resolution('allow', 'workspace', { workspaceGrantAllowed: true })
      })
    ).toMatchObject({ kind: 'allow', reason: 'workspace_grant', scope: 'workspace' })
  })
})

describe('effectiveAgenticSettings', () => {
  it('overlays effective run permissions onto global settings', () => {
    const settings = {
      agenticServices: {
        shellCommands: 'allow',
        fileChanges: 'allow',
        mcpTools: 'allow',
        subThreadDelegation: 'allow',
        networkAccess: 'allow'
      }
    } as AppSettings
    const effective = effectivePermissions(true)

    const merged = effectiveAgenticSettings(settings, effective)

    expect(merged.agenticServices.shellCommands).toBe('deny')
    expect(merged.agenticServices.fileChanges).toBe('deny')
    expect(merged.agenticServices.mcpTools).toBe('ask')
    expect(merged.agenticServices.networkAccess).toBe('deny')
    // Read-only canvasInteraction deny must survive the effective-settings merge
    // (it previously got dropped here — P1 review GAP 2).
    expect(merged.agenticServices.canvasInteraction).toBe('deny')
    // Same guarantee for canvas_eval (RCE): read-only deny must survive the merge.
    expect(merged.agenticServices.canvasEval).toBe('deny')
  })

  it('preserves current explicit deny when merging stale effective permissions', () => {
    const settings = {
      agenticServices: {
        shellCommands: 'deny',
        fileChanges: 'deny',
        mcpTools: 'deny',
        subThreadDelegation: 'deny',
        networkAccess: 'deny'
      }
    } as AppSettings
    const effective = effectivePermissions(false, {
      shellCommands: 'allow',
      fileChanges: 'allow',
      mcpTools: 'allow',
      subThreadDelegation: 'allow',
      canvasInteraction: 'ask',
      crossThreadRead: 'ask',
      mediaEditing: 'ask',
      mediaRecording: 'deny',
      canvasEval: 'ask'
    })
    effective.networkAccess = 'allow'

    const merged = effectiveAgenticSettings(settings, effective)

    expect(merged.agenticServices.shellCommands).toBe('deny')
    expect(merged.agenticServices.fileChanges).toBe('deny')
    expect(merged.agenticServices.mcpTools).toBe('deny')
    expect(merged.agenticServices.subThreadDelegation).toBe('deny')
    expect(merged.agenticServices.networkAccess).toBe('deny')
  })
})
