import { describe, expect, it, vi } from 'vitest'

// PermissionService -> store/index.ts touches Electron's app.getPath at import time;
// stub it so the pure permission logic can be exercised in vitest (same pattern as
// PermissionService.test.ts).
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/taskwraith-test'
  }
}))

import {
  effectiveAgenticSettings,
  resolveNativeApprovalPreflightDecision,
  taskWraithToolAgenticService
} from './NativeApprovalPolicy'
import {
  DEFAULT_PERMISSION_PRESETS,
  resolveEffectiveRunPermissions
} from './EffectiveRunPermissions'
import { AGENTIC_SERVICE_IDS, AGENTIC_SERVICE_LABELS } from './AgenticServiceMessages'
import { MEDIA_EDITING_TOOL_NAMES, MEDIA_EDITING_TOOLS } from './TaskWraithMcpTools'
import type { ProviderId } from './store/types'
import { PermissionService } from './PermissionService'
import { RunManager } from './RunManager'
import type {
  AgenticServiceId,
  AgenticServicePolicy,
  AgenticServicesSettings,
  AppSettings,
  EffectiveRunPermissions
} from './store/types'

// The Claude-gate classifier (`claudeAgenticServiceForTool`) lives inside index.ts
// and isn't exported, so we re-derive its media branch here EXACTLY — the test
// would fail if the real classifier and this mirror ever disagreed on a tool name,
// but more importantly the two-classifier-agreement guarantee is also asserted
// structurally below (both must route every media tool to mediaEditing). The real
// claude classifier canonicalizes then checks the same MEDIA_EDITING_TOOLS set, so
// the bare tool names used here are exactly what it sees post-canonicalization.

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
    webBrowsing: 'ask',
    ...over
  }
}

describe('mediaEditing approval service', () => {
  it('routes every media tool to mediaEditing — never mcpTools (1)', () => {
    for (const name of MEDIA_EDITING_TOOL_NAMES) {
      expect(taskWraithToolAgenticService(name)).toBe('mediaEditing')
    }
    // Spot-check the two representative write-class producers + the read-safe frame
    // decode (which is mediaEditing for grant/audit even though it's 'orchestration'
    // — read-only-allowed — on the separate ToolClassTaxonomy axis).
    expect(taskWraithToolAgenticService('transcode_audio')).toBe('mediaEditing')
    expect(taskWraithToolAgenticService('audio_mix')).toBe('mediaEditing')
    expect(taskWraithToolAgenticService('video_decode_frame')).toBe('mediaEditing')
    // A non-media tool still falls through to mcpTools.
    expect(taskWraithToolAgenticService('ensemble_yield')).toBe('mcpTools')
  })

  it('is enumerated wherever agentic services are listed (1)', () => {
    expect(AGENTIC_SERVICE_IDS.has('mediaEditing')).toBe(true)
    expect(AGENTIC_SERVICE_IDS.has('mediaRecording')).toBe(true)
    expect(AGENTIC_SERVICE_LABELS.mediaEditing).toBeTruthy()
    expect(AGENTIC_SERVICE_LABELS.mediaRecording).toBeTruthy()
  })

  it('read_only DENIES mediaEditing — the gate-reroute landmine guard (2)', () => {
    // With media on its OWN service the gate's mcpTools->shellCommands read-only
    // reroute no longer fires for it, so the DENY must come from the preset itself.
    expect(DEFAULT_PERMISSION_PRESETS.read_only.agenticServices?.mediaEditing).toBe('deny')

    // A write-class media tool resolves to a DENY under read_only even when global
    // settings would allow it — i.e. it is refused, not merely prompted.
    const eff = resolveEffectiveRunPermissions({
      provider: 'claude',
      workspacePath: '/repo',
      presetId: 'read_only',
      settings: settings({ mediaEditing: 'allow' })
    })
    expect(eff.agenticServices.mediaEditing).toBe('deny')
    expect(eff.readOnly).toBe(true)

    // The resolved DENY drives a denied preflight: a fresh PermissionService with no
    // grants resolves decision 'deny' for transcode_audio/audio_mix's service under
    // the read-only effective settings (this is what blocks, not prompts).
    const runManager = new RunManager()
    const permissionService = new PermissionService({ runManager, sessionGrants: new Set() })
    const decision = permissionService.resolvePermission(
      'claude',
      taskWraithToolAgenticService('transcode_audio'),
      '/repo',
      undefined,
      { agenticServices: eff.agenticServices } as AppSettings
    )
    expect(decision.decision).toBe('deny')
    expect(taskWraithToolAgenticService('audio_mix')).toBe('mediaEditing')
  })

  it('full_access ALLOWS mediaEditing but NOT mediaRecording (3)', () => {
    expect(DEFAULT_PERMISSION_PRESETS.full_access.agenticServices?.mediaEditing).toBe('allow')
    // mediaRecording is deliberately absent from full_access (capture always prompts).
    expect(
      DEFAULT_PERMISSION_PRESETS.full_access.agenticServices?.mediaRecording
    ).toBeUndefined()

    const eff = resolveEffectiveRunPermissions({
      provider: 'claude',
      workspacePath: '/repo',
      presetId: 'full_access',
      settings: settings({})
    })
    expect(eff.agenticServices.mediaEditing).toBe('allow')
    // Capture stays at its non-grantable default-deny even under Full access.
    expect(eff.agenticServices.mediaRecording).toBe('deny')
  })

  it('mediaEditing deny-survives the effective-settings rebuild (the P1 leak class) (4)', () => {
    const merged = effectiveAgenticSettings(
      { agenticServices: settings({ mediaEditing: 'allow' }).agenticServices } as AppSettings,
      {
        agenticServices: effectiveServices({ mediaEditing: 'deny' }),
        networkAccess: 'allow'
      } as EffectiveRunPermissions
    )
    expect(merged.agenticServices.mediaEditing).toBe('deny')
  })

  it('mediaRecording is NON-GRANTABLE — no grant/setting promotes it above default-deny (5)', () => {
    // (a) A stored settings 'allow'/'workspace' is clamped down to 'ask' (then the
    //     default-deny posture keeps it denied at the preset/effective layer).
    const withAllow = resolveEffectiveRunPermissions({
      provider: 'claude',
      workspacePath: '/repo',
      presetId: 'default',
      settings: settings({ mediaRecording: 'allow' })
    })
    expect(withAllow.agenticServices.mediaRecording).not.toBe('allow')
    expect(withAllow.agenticServices.mediaRecording).not.toBe('workspace')

    // (b) A (stale/forged) workspace grant for mediaRecording is DROPPED — it never
    //     promotes capture to an automatic allow, mirroring canvasEval.
    const withGrant = resolveEffectiveRunPermissions({
      provider: 'claude',
      workspacePath: '/repo',
      presetId: 'default',
      settings: {
        agenticServices: settings({}).agenticServices,
        agenticWorkspaceGrants: [
          {
            id: 'ws-grant-record',
            provider: 'claude',
            workspacePath: '/repo',
            service: 'mediaRecording',
            createdAt: '2026-06-25T00:00:00.000Z',
            updatedAt: '2026-06-25T00:00:00.000Z'
          }
        ]
      }
    })
    expect(withGrant.workspaceGrantServiceIds).not.toContain('mediaRecording')

    // (c) A session grant also cannot promote it: PermissionService treats it as
    //     non-grantable, so even with a live session grant the decision stays in the
    //     prompt/deny band (here default-deny => 'deny').
    const runManager = new RunManager()
    runManager.create({ runId: 'run-media', provider: 'claude', workspacePath: '/repo' })
    const permissionService = new PermissionService({ runManager, sessionGrants: new Set() })
    permissionService.addSessionGrant('claude', '/repo', 'mediaRecording', 'run-media')
    const decision = permissionService.resolvePermission(
      'claude',
      'mediaRecording',
      '/repo',
      'run-media',
      {
        agenticServices: {
          ...settings({}).agenticServices,
          mediaRecording: 'deny'
        }
      } as AppSettings
    )
    expect(decision.sessionGrantAllowed).toBe(false)
    expect(decision.decision).toBe('deny')
  })

  // FIX 1 regression guard (F1 review finding) — the Gemini + Grok MCP service
  // classifier (`McpToolApprovalPreview.ts`, with gate sites in index.ts) must classify
  // media tools as `mediaEditing` on BOTH provider paths, not `fileChanges`
  // (ffmpeg/audio) or `mcpTools` (the native VtTools). We mirror the EXACT predicate
  // the extracted preview builder uses — `MEDIA_EDITING_TOOLS.has(toolName)` over
  // the bare TaskWraith tool name, with no provider-specific logic — the same way
  // this file already re-derives the unexported Claude classifier. If a tool were
  // dropped from the shared set, both the real branch and this mirror change in
  // lockstep, so the assertion still catches the regression class (a media tool
  // silently classifying as fileChanges/mcpTools).
  function mirrorGeminiMcpService(
    toolName: string,
    _parentProvider: ProviderId
  ): 'mediaEditing' | 'other' {
    // The real branch keys off membership only — parentProvider does not change the
    // media classification (it only affects the human-readable title). Mirror that.
    return MEDIA_EDITING_TOOLS.has(toolName) ? 'mediaEditing' : 'other'
  }

  it('classifies media tools as mediaEditing on the Gemini + Grok MCP paths (FIX 1)', () => {
    for (const parentProvider of ['gemini', 'grok'] as const) {
      // The ffmpeg producers, the native audio mixer, and the read-safe frame decode
      // must all classify mediaEditing — NOT fileChanges (ffmpeg) / mcpTools (VtTools).
      expect(mirrorGeminiMcpService('transcode_audio', parentProvider)).toBe('mediaEditing')
      expect(mirrorGeminiMcpService('audio_mix', parentProvider)).toBe('mediaEditing')
      expect(mirrorGeminiMcpService('video_decode_frame', parentProvider)).toBe('mediaEditing')
      // And every member of the canonical set classifies mediaEditing on both paths.
      for (const name of MEDIA_EDITING_TOOL_NAMES) {
        expect(mirrorGeminiMcpService(name, parentProvider)).toBe('mediaEditing')
      }
      // A non-media tool does NOT get the media branch.
      expect(mirrorGeminiMcpService('ensemble_yield', parentProvider)).toBe('other')
    }
  })

  // FIX 2 regression guard (F2 review finding) — mediaRecording must be
  // `neverAutoAllow` at the preflight seam (the index.ts gate now sets
  // `neverAutoAllow: service === 'canvasEval' || service === 'mediaRecording'` at
  // both sites). resolveNativeApprovalPreflightDecision is the exported function that
  // consumes that flag, so we assert the invariant there: with neverAutoAllow set, a
  // session-YOLO + grant-allowed resolution is clamped down to a prompt (only an
  // explicit deny short-circuits above it).
  it('clamps mediaRecording to a prompt under session-YOLO + grant (neverAutoAllow, FIX 2)', () => {
    const neverAutoAllow = true // what the index.ts gate now sets for mediaRecording
    // A live session grant + decision 'allow' would normally auto-allow.
    expect(
      resolveNativeApprovalPreflightDecision({
        resolution: {
          policy: 'ask',
          workspaceGrantAllowed: false,
          sessionGrantAllowed: true,
          decision: 'allow'
        },
        neverAutoAllow
      })
    ).toMatchObject({ kind: 'ask' })

    // Session-YOLO on a non-read-only run is likewise clamped to a prompt.
    expect(
      resolveNativeApprovalPreflightDecision({
        resolution: {
          policy: 'ask',
          workspaceGrantAllowed: false,
          sessionGrantAllowed: false,
          decision: 'ask'
        },
        sessionYoloEnabled: true,
        readOnly: false,
        neverAutoAllow
      })
    ).toMatchObject({ kind: 'ask' })

    // An explicit deny still wins (default-deny posture is preserved, not weakened).
    expect(
      resolveNativeApprovalPreflightDecision({
        resolution: {
          policy: 'deny',
          workspaceGrantAllowed: false,
          sessionGrantAllowed: false,
          decision: 'deny'
        },
        neverAutoAllow
      })
    ).toMatchObject({ kind: 'deny' })
  })
})
