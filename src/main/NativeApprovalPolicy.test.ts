import { describe, expect, it } from 'vitest'
import {
  canonicalTaskWraithToolName,
  effectiveAgenticSettings,
  resolveCodexMcpApprovalIdentity,
  resolveCodexStructuralApproval,
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
    externalPublish: 'deny',
    mcpTools: 'ask',
    subThreadDelegation: 'ask',
    canvasInteraction: 'deny',
    sketchCanvas: 'deny',
    meshCanvas: 'deny',
    simulatorCanvas: 'deny',
    crossThreadRead: 'deny',
    threadMessage: 'deny',
    mediaEditing: 'deny',
    mediaRecording: 'deny',
    canvasEval: 'deny',
    webBrowsing: 'deny'
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
    expect(canonicalTaskWraithToolName('ASkUserQuestion')).toBe('ask_user_question')
    expect(canonicalTaskWraithToolName('mcp__TaskWraith__AskUserQuestion')).toBe(
      'ask_user_question'
    )
    expect(canonicalTaskWraithToolName('TaskWraith__Ask_User_Question')).toBe('ask_user_question')
    // Codex's host request method is not a TaskWraith MCP alias.
    expect(canonicalTaskWraithToolName('Request_User_Input')).toBe('request_user_input')
  })
})

describe('taskWraithToolServiceIfKnown', () => {
  it('maps native TaskWraith MCP approvals to their real agentic service', () => {
    expect(taskWraithToolServiceIfKnown('mcp__taskwraith__run_shell_command')).toBe('shellCommands')
    expect(taskWraithToolServiceIfKnown('mcp_taskwraith-broker-run_shell_command')).toBe(
      'shellCommands'
    )
    expect(taskWraithToolServiceIfKnown('mcp__taskwraith__get_diagnostics')).toBe('shellCommands')
    expect(taskWraithToolServiceIfKnown('mcp__other_server__write_file')).toBeNull()
    expect(taskWraithToolServiceIfKnown('taskwraith__write_file')).toBe('fileChanges')
    expect(taskWraithToolServiceIfKnown('taskwraith__delete_path')).toBe('fileChanges')
    expect(taskWraithToolServiceIfKnown('taskwraith__move_path')).toBe('fileChanges')
    expect(taskWraithToolServiceIfKnown('taskwraith__git_push')).toBe('externalPublish')
    expect(taskWraithToolServiceIfKnown('taskwraith__git_create_pr')).toBe('externalPublish')
    expect(taskWraithToolServiceIfKnown('taskwraith__github_ci_status')).toBe('mcpTools')
    expect(taskWraithToolServiceIfKnown('delegate_to_subthread')).toBe('subThreadDelegation')
    expect(taskWraithToolServiceIfKnown('list_active_runs')).toBe('mcpTools')
    expect(taskWraithToolServiceIfKnown('cancel_active_run')).toBe('mcpTools')
    expect(taskWraithToolServiceIfKnown('ensemble_yield')).toBe('mcpTools')
    expect(
      taskWraithToolServiceIfKnown('capability_invoke', {
        name: 'write_file',
        arguments: { path: 'src/example.ts', content: 'example' }
      })
    ).toBe('fileChanges')
  })

  it('leaves non-TaskWraith tool names unclassified', () => {
    expect(taskWraithToolServiceIfKnown('mcp__other_server__totally_unknown')).toBeNull()
    expect(taskWraithToolServiceIfKnown('totally_unknown')).toBeNull()
  })
})

describe('resolveCodexStructuralApproval', () => {
  it('binds exact app-server methods to the closed Codex adapter', () => {
    expect(
      resolveCodexStructuralApproval({
        method: 'item/commandExecution/requestApproval',
        params: { command: ['git', 'status'] }
      })
    ).toEqual({
      kind: 'resolved',
      nativeAction: 'commandExecution',
      catalogTool: 'run_shell_command',
      service: 'shellCommands'
    })
    expect(
      resolveCodexStructuralApproval({
        method: 'item/fileChange/requestApproval',
        params: { changes: [{ path: 'src/example.ts', kind: 'edit' }] }
      })
    ).toEqual({
      kind: 'resolved',
      nativeAction: 'fileChange',
      catalogTool: 'apply_patch',
      service: 'fileChanges'
    })
  })

  it('accepts an exact structural item type on a generic approval method', () => {
    expect(
      resolveCodexStructuralApproval({
        method: 'approval/request',
        params: {
          item: {
            type: 'fileChange',
            patch: '*** Begin Patch\n*** End Patch'
          }
        }
      })
    ).toMatchObject({
      kind: 'resolved',
      nativeAction: 'fileChange',
      service: 'fileChanges'
    })
  })

  it('denies method/type disagreement and payload cross-class injection', () => {
    for (const input of [
      {
        method: 'item/fileChange/requestApproval',
        params: {
          type: 'commandExecution',
          changes: [{ path: 'src/example.ts' }]
        }
      },
      {
        method: 'item/fileChange/requestApproval',
        params: {
          changes: [{ path: 'src/example.ts' }],
          command: ['rm', '-rf', '../outside']
        }
      },
      {
        method: 'item/commandExecution/requestApproval',
        params: {
          command: 'git status',
          patch: '*** Begin Patch\n*** End Patch'
        }
      }
    ]) {
      expect(resolveCodexStructuralApproval(input)).toMatchObject({
        kind: 'deny',
        code: 'codex_structural_identity_conflict'
      })
    }
  })

  it('denies structurally identified approvals without their expected payload', () => {
    expect(
      resolveCodexStructuralApproval({
        method: 'item/fileChange/requestApproval',
        params: { itemId: 'item-without-cached-patch' }
      })
    ).toMatchObject({
      kind: 'deny',
      code: 'codex_structural_payload_missing'
    })
    expect(
      resolveCodexStructuralApproval({
        method: 'item/commandExecution/requestApproval',
        params: { command: [] }
      })
    ).toMatchObject({
      kind: 'deny',
      code: 'codex_structural_payload_missing'
    })
  })

  it('permits an exact file request backed by the host-cached patch only', () => {
    expect(
      resolveCodexStructuralApproval({
        method: 'item/fileChange/requestApproval',
        params: { itemId: 'cached-item' },
        cachedFileChangeAvailable: true
      })
    ).toMatchObject({
      kind: 'resolved',
      nativeAction: 'fileChange',
      service: 'fileChanges'
    })
  })

  it('leaves unrelated MCP and elicitation approval methods to their own resolver', () => {
    expect(
      resolveCodexStructuralApproval({
        method: 'mcpServer/elicitation/request',
        params: { toolName: 'write_file', arguments: { path: 'src/example.ts' } }
      })
    ).toEqual({ kind: 'not_applicable' })
  })
})

describe('resolveCodexMcpApprovalIdentity', () => {
  it('recognizes exact qualified and split-field TaskWraith identities', () => {
    expect(
      resolveCodexMcpApprovalIdentity({
        toolName: 'mcp__taskwraith__read_file',
        toolArgs: { path: 'README.md' }
      })
    ).toMatchObject({
      recognized: true,
      toolName: 'read_file',
      service: 'mcpTools'
    })
    expect(
      resolveCodexMcpApprovalIdentity({
        serverName: 'TaskWraith',
        toolName: 'write_file',
        toolArgs: { path: 'src/example.ts', content: 'body' }
      })
    ).toMatchObject({
      recognized: true,
      toolName: 'write_file',
      service: 'fileChanges'
    })
  })

  it('leaves foreign and contradictory server identities generic', () => {
    for (const input of [
      { toolName: 'mcp__evil__read_file' },
      { toolName: 'taskwraith-broker__mcp__evil__read_file' },
      { serverName: 'evil', toolName: 'read_file' },
      { serverName: 'evil', toolName: 'mcp__taskwraith__read_file' },
      { serverName: 'TaskWraith', toolName: 'mcp__evil__read_file' }
    ]) {
      expect(resolveCodexMcpApprovalIdentity(input), JSON.stringify(input)).toEqual({
        recognized: false
      })
    }
  })

  it('inherits capability target service without trusting the wrapper', () => {
    expect(
      resolveCodexMcpApprovalIdentity({
        serverName: 'TaskWraith',
        toolName: 'capability_invoke',
        toolArgs: {
          name: 'write_file',
          arguments: { path: 'src/example.ts', content: 'body' }
        }
      })
    ).toMatchObject({
      recognized: true,
      toolName: 'capability_invoke',
      effectiveToolName: 'write_file',
      service: 'fileChanges'
    })
  })
})

describe('taskWraithToolAgenticService — canvas interaction bucket', () => {
  it('keeps web Canvas control separate from Sketch mutation, leaving reads on mcpTools', () => {
    expect(taskWraithToolAgenticService('canvas_click')).toBe('canvasInteraction')
    expect(taskWraithToolAgenticService('canvas_fill')).toBe('canvasInteraction')
    expect(taskWraithToolAgenticService('canvas_sketch_update')).toBe('sketchCanvas')
    expect(taskWraithToolAgenticService('canvas_sketch_update')).not.toBe('canvasInteraction')
    expect(taskWraithToolAgenticService('canvas_sketch_open')).toBe('mcpTools')
    expect(taskWraithToolAgenticService('canvas_sketch_get')).toBe('mcpTools')
    expect(taskWraithToolAgenticService('canvas_snapshot')).toBe('mcpTools')
    expect(taskWraithToolAgenticService('canvas_open_launch')).toBe('mcpTools')
  })

  it('routes canvas_eval to its own stricter canvasEval bucket', () => {
    // Distinct from canvasInteraction: eval is non-grantable / never-auto-allowed.
    expect(taskWraithToolAgenticService('canvas_eval')).toBe('canvasEval')
    expect(taskWraithToolAgenticService('canvas_eval')).not.toBe('canvasInteraction')
  })

  it('routes every Mesh Canvas operation through the participant-run meshCanvas service', () => {
    for (const tool of [
      'mesh_scene_create',
      'mesh_scene_list',
      'mesh_scene_inspect',
      'mesh_scene_import',
      'mesh_scene_apply',
      'mesh_scene_set_material',
      'mesh_scene_present',
      'mesh_scene_close',
      'mesh_scene_delete'
    ] as const) {
      expect(taskWraithToolAgenticService(tool)).toBe('meshCanvas')
    }
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

  it('auto-allows a task-scoped Full Access external write after deny and non-grantable guards', () => {
    expect(
      resolveNativeApprovalPreflightDecision({
        resolution: resolution('allow', 'allow'),
        externalPathDetected: true,
        trustedSessionExternalWrite: true
      })
    ).toMatchObject({ kind: 'allow', reason: 'trusted_session', scope: 'session' })
  })

  it('does not let a Full Access external write override an explicit deny or non-grantable tool', () => {
    expect(
      resolveNativeApprovalPreflightDecision({
        resolution: resolution('deny'),
        externalPathDetected: true,
        trustedSessionExternalWrite: true
      })
    ).toMatchObject({ kind: 'deny' })
    expect(
      resolveNativeApprovalPreflightDecision({
        resolution: resolution('allow', 'allow'),
        externalPathDetected: true,
        trustedSessionExternalWrite: true,
        neverAutoAllow: true
      })
    ).toMatchObject({ kind: 'ask' })
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
    expect(merged.agenticServices.sketchCanvas).toBe('deny')
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
      externalPublish: 'ask',
      mcpTools: 'allow',
      subThreadDelegation: 'allow',
      canvasInteraction: 'ask',
      sketchCanvas: 'allow',
      meshCanvas: 'ask',
      simulatorCanvas: 'ask',
      crossThreadRead: 'ask',
      threadMessage: 'ask',
      mediaEditing: 'ask',
      mediaRecording: 'deny',
      canvasEval: 'ask',
      webBrowsing: 'ask'
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

describe('resolveNativeApprovalPreflightDecision — readOnlyShellFastPath (git status)', () => {
  it('allows a posture-denied git status without a prompt, request-scoped', () => {
    expect(
      resolveNativeApprovalPreflightDecision({
        resolution: resolution('deny'),
        readOnlyShellFastPath: true
      })
    ).toMatchObject({ kind: 'allow', reason: 'readonly_shell', scope: 'request' })
  })

  it('skips the prompt an ask-policy would raise', () => {
    expect(
      resolveNativeApprovalPreflightDecision({
        resolution: resolution('ask'),
        readOnlyShellFastPath: true
      })
    ).toMatchObject({ kind: 'allow', reason: 'readonly_shell' })
  })

  it('leaves a policy-allow on the ordinary audited path', () => {
    expect(
      resolveNativeApprovalPreflightDecision({
        resolution: resolution('allow', 'allow'),
        readOnlyShellFastPath: true
      })
    ).toMatchObject({ kind: 'allow', reason: 'policy' })
  })

  it('yields to external-path detection and neverAutoAllow', () => {
    expect(
      resolveNativeApprovalPreflightDecision({
        resolution: resolution('ask'),
        readOnlyShellFastPath: true,
        externalPathDetected: true
      })
    ).toMatchObject({ kind: 'ask' })
    expect(
      resolveNativeApprovalPreflightDecision({
        resolution: resolution('ask'),
        readOnlyShellFastPath: true,
        neverAutoAllow: true
      })
    ).toMatchObject({ kind: 'ask' })
  })

  it('changes nothing when the flag is absent', () => {
    expect(
      resolveNativeApprovalPreflightDecision({ resolution: resolution('deny') })
    ).toMatchObject({ kind: 'deny' })
    expect(resolveNativeApprovalPreflightDecision({ resolution: resolution('ask') })).toMatchObject(
      { kind: 'ask' }
    )
  })
})

describe('resolveNativeApprovalPreflightDecision — external read split (slice E)', () => {
  const base = {
    resolution: {
      policy: 'ask' as const,
      workspaceGrantAllowed: false,
      sessionGrantAllowed: false,
      decision: 'ask' as const
    }
  }

  it('auto-allows a detected external READ when the caller marks the write-tier split', () => {
    const decision = resolveNativeApprovalPreflightDecision({
      ...base,
      externalPathDetected: true,
      externalPathReadAutoAllowed: true
    })
    expect(decision).toMatchObject({ kind: 'allow', reason: 'external_read', scope: 'request' })
  })

  it('still asks for detected external paths without the read split, and deny/hold always win', () => {
    expect(
      resolveNativeApprovalPreflightDecision({ ...base, externalPathDetected: true })
    ).toMatchObject({ kind: 'ask' })
    expect(
      resolveNativeApprovalPreflightDecision({
        ...base,
        externalPathDetected: true,
        externalPathReadAutoAllowed: true,
        neverAutoAllow: true
      })
    ).toMatchObject({ kind: 'ask' })
    expect(
      resolveNativeApprovalPreflightDecision({
        resolution: { ...base.resolution, decision: 'deny', policy: 'deny' },
        externalPathDetected: true,
        externalPathReadAutoAllowed: true
      })
    ).toMatchObject({ kind: 'deny' })
  })
})
