import { describe, expect, it } from 'vitest'
import {
  TASKWRAITH_CORE_MCP_PROFILE_ID,
  TASKWRAITH_FULL_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V1_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V2_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V3_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V4_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V5_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V6_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V7_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V7_MESH_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V8_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V8_MESH_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V9_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V9_MESH_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V10_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V10_MESH_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V11_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V11_MESH_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V12_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V12_MESH_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V13_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V13_MESH_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V14_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V14_MESH_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V15_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V15_MESH_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V16_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V16_MESH_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V17_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V17_MESH_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V18_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V18_MESH_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_SOLO_V1_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_SOLO_V2_MCP_PROFILE_ID,
  TASKWRAITH_FRESH_SOLO_GATEWAY_MCP_PROFILE_ID,
  createTaskWraithMcpProfileReceipt,
  isGatewayTaskWraithMcpProfile,
  isPermissionOpportunityDirectTaskWraithMcpProfile,
  isMeshCanvasDirectTaskWraithMcpProfile,
  isMeshTopologyDirectTaskWraithMcpProfile,
  isPortableEnsembleControlMcpProfile,
  isSoloTaskWraithMcpProfile,
  isSketchCanvasDirectTaskWraithMcpProfile,
  isGatewayV13DirectTaskWraithMcpProfile,
  isGatewayV2TaskWraithMcpProfile,
  isTaskWraithMcpProfileId,
  isTaskWraithMcpProfileReceiptForSession,
  isTaskWraithMcpEnsembleLanePresent,
  isTaskWraithMcpAuthorizedEphemeralReroute,
  isTaskWraithMcpRouteProviderMatch,
  resolveTaskWraithMcpDispatchSession,
  resolveTaskWraithMcpProfile,
  shouldAcceptTaskWraithMcpSessionId,
  taskWraithCoreMcpProfileOptInEnabled,
  taskWraithMcpRunStartedWithPinnedReceipt,
  taskWraithMcpProfileReceiptFingerprint,
  taskWraithMcpProfileStoreIdentity,
  transitionTaskWraithMcpProfileReceipt
} from './McpSessionProfileFence'

describe('resolveTaskWraithMcpProfile', () => {
  it('defaults a fresh persistable Claude session to the newest gateway profile', () => {
    for (const coreProfileOptIn of [false, true]) {
      expect(
        resolveTaskWraithMcpProfile({
          provider: 'claude',
          providerSessionId: null,
          coreProfileOptIn
        })
      ).toEqual({
        profileId: TASKWRAITH_GATEWAY_MCP_PROFILE_ID,
        source: 'fresh_gateway_default'
      })
      expect(TASKWRAITH_GATEWAY_MCP_PROFILE_ID).toBe(TASKWRAITH_GATEWAY_V18_MCP_PROFILE_ID)
    }
  })

  it('keeps an unpersistable fresh Claude run full to avoid an unfenced resumable birth', () => {
    expect(
      resolveTaskWraithMcpProfile({
        provider: 'claude',
        providerSessionId: null,
        profileReceiptCanPersist: false
      }).profileId
    ).toBe(TASKWRAITH_FULL_MCP_PROFILE_ID)
  })

  it('selects the lean immutable profile only for fresh single-provider threads', () => {
    for (const provider of ['claude', 'codex', 'kimi', 'cursor', 'ollama'] as const) {
      expect(
        resolveTaskWraithMcpProfile({
          provider,
          providerSessionId: null,
          soloThread: true,
          meshCanvasParticipantCanRequest: true
        })
      ).toEqual({
        profileId: TASKWRAITH_GATEWAY_SOLO_V2_MCP_PROFILE_ID,
        source: 'fresh_solo_gateway_default'
      })
    }
    expect(TASKWRAITH_FRESH_SOLO_GATEWAY_MCP_PROFILE_ID).toBe(
      TASKWRAITH_GATEWAY_SOLO_V2_MCP_PROFILE_ID
    )
  })

  it('grandfathers an unreceipted or mismatched Claude resume to full', () => {
    const wrong = createTaskWraithMcpProfileReceipt({
      provider: 'claude',
      providerSessionId: 'other-session',
      profileId: TASKWRAITH_CORE_MCP_PROFILE_ID
    })
    for (const receipt of [undefined, wrong]) {
      expect(
        resolveTaskWraithMcpProfile({
          provider: 'claude',
          providerSessionId: 'legacy-session',
          receipt,
          coreProfileOptIn: true
        })
      ).toEqual({ profileId: TASKWRAITH_FULL_MCP_PROFILE_ID, source: 'legacy_claude_full' })
    }
  })

  it('preserves exact existing receipts across the v8 to v9 birth boundary', () => {
    for (const profileId of [
      TASKWRAITH_FULL_MCP_PROFILE_ID,
      TASKWRAITH_CORE_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V1_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V2_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V8_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V8_MESH_MCP_PROFILE_ID
    ]) {
      const receipt = createTaskWraithMcpProfileReceipt({
        provider: 'claude',
        providerSessionId: 'claude-a',
        profileId
      })
      expect(
        resolveTaskWraithMcpProfile({
          provider: 'claude',
          providerSessionId: 'claude-a',
          receipt,
          coreProfileOptIn: false
        })
      ).toEqual({ profileId, source: 'pinned_receipt' })

      expect(
        resolveTaskWraithMcpProfile({
          provider: 'claude',
          providerSessionId: null,
          storeProviderSessionId: 'claude-a',
          receipt,
          coreProfileOptIn: true
        })
      ).toEqual({ profileId, source: 'pinned_receipt' })
    }
  })

  it('gives v8 and v9 receipts distinct immutable fingerprints', () => {
    const v8 = createTaskWraithMcpProfileReceipt({
      provider: 'claude',
      providerSessionId: 'claude-a',
      profileId: TASKWRAITH_GATEWAY_V8_MCP_PROFILE_ID
    })
    const v9 = createTaskWraithMcpProfileReceipt({
      provider: 'claude',
      providerSessionId: 'claude-a',
      profileId: TASKWRAITH_GATEWAY_V9_MCP_PROFILE_ID
    })
    expect(taskWraithMcpProfileReceiptFingerprint(v8)).not.toBe(
      taskWraithMcpProfileReceiptFingerprint(v9)
    )
  })

  it('defaults every fresh tool-capable provider to the newest gateway profile', () => {
    for (const provider of ['codex', 'kimi', 'cursor', 'ollama'] as const) {
      expect(
        resolveTaskWraithMcpProfile({
          provider,
          modelId: 'ordinary-model'
        }).profileId
      ).toBe(TASKWRAITH_GATEWAY_MCP_PROFILE_ID)
    }
    expect(
      resolveTaskWraithMcpProfile({
        provider: 'grok',
        modelId: 'grok-4.5',
        grokMcpAdvertised: true
      }).profileId
    ).toBe(TASKWRAITH_GATEWAY_MCP_PROFILE_ID)
  })

  it('recognizes every gateway generation without collapsing them', () => {
    for (const profileId of [
      TASKWRAITH_GATEWAY_V1_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V2_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V3_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V4_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V5_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V6_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V7_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V7_MESH_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V8_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V8_MESH_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V9_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V9_MESH_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V10_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V10_MESH_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V11_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V11_MESH_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V12_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V12_MESH_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V13_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V13_MESH_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V14_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V14_MESH_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V15_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V15_MESH_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V16_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V16_MESH_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V17_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V17_MESH_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V18_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V18_MESH_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_SOLO_V1_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_SOLO_V2_MCP_PROFILE_ID
    ]) {
      expect(isTaskWraithMcpProfileId(profileId)).toBe(true)
      // Load-bearing: this predicate drives the gateway-subset launch arg and
      // prompt composition. A generation missing here is born as a gateway
      // session that is not treated like one.
      expect(isGatewayTaskWraithMcpProfile(profileId)).toBe(true)
    }
    expect(isGatewayV2TaskWraithMcpProfile(TASKWRAITH_GATEWAY_V1_MCP_PROFILE_ID)).toBe(false)
    expect(isGatewayV2TaskWraithMcpProfile(TASKWRAITH_GATEWAY_V2_MCP_PROFILE_ID)).toBe(true)
    expect(isGatewayV2TaskWraithMcpProfile(TASKWRAITH_GATEWAY_V3_MCP_PROFILE_ID)).toBe(false)
    expect(isGatewayV2TaskWraithMcpProfile(TASKWRAITH_GATEWAY_V4_MCP_PROFILE_ID)).toBe(false)
    expect(isGatewayV2TaskWraithMcpProfile(TASKWRAITH_GATEWAY_V5_MCP_PROFILE_ID)).toBe(false)
    expect(isGatewayV2TaskWraithMcpProfile(TASKWRAITH_GATEWAY_V6_MCP_PROFILE_ID)).toBe(false)
    expect(isGatewayV2TaskWraithMcpProfile(TASKWRAITH_GATEWAY_V7_MCP_PROFILE_ID)).toBe(false)
    expect(isGatewayV2TaskWraithMcpProfile(TASKWRAITH_GATEWAY_V7_MESH_MCP_PROFILE_ID)).toBe(false)
    expect(isGatewayV2TaskWraithMcpProfile(TASKWRAITH_GATEWAY_V8_MCP_PROFILE_ID)).toBe(false)
    expect(isGatewayV2TaskWraithMcpProfile(TASKWRAITH_GATEWAY_V8_MESH_MCP_PROFILE_ID)).toBe(false)
    expect(isGatewayV2TaskWraithMcpProfile(TASKWRAITH_GATEWAY_V9_MCP_PROFILE_ID)).toBe(false)
    expect(isGatewayV2TaskWraithMcpProfile(TASKWRAITH_GATEWAY_V9_MESH_MCP_PROFILE_ID)).toBe(false)
    expect(isSoloTaskWraithMcpProfile(TASKWRAITH_GATEWAY_SOLO_V1_MCP_PROFILE_ID)).toBe(true)
    expect(isSoloTaskWraithMcpProfile(TASKWRAITH_GATEWAY_SOLO_V2_MCP_PROFILE_ID)).toBe(true)
    expect(isSoloTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V17_MCP_PROFILE_ID)).toBe(false)
  })

  it('selects the mesh-direct catalogue for a fresh participant that may request access', () => {
    expect(
      resolveTaskWraithMcpProfile({
        provider: 'codex',
        meshCanvasParticipantCanRequest: true
      })
    ).toEqual({
      profileId: TASKWRAITH_GATEWAY_V18_MESH_MCP_PROFILE_ID,
      source: 'fresh_gateway_mesh_participant'
    })
    expect(
      resolveTaskWraithMcpProfile({
        provider: 'codex',
        meshCanvasParticipantCanRequest: false
      })
    ).toEqual({
      profileId: TASKWRAITH_GATEWAY_V18_MCP_PROFILE_ID,
      source: 'fresh_gateway_default'
    })
    expect(isMeshCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V7_MESH_MCP_PROFILE_ID)).toBe(
      true
    )
    expect(isMeshCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V7_MCP_PROFILE_ID)).toBe(false)
    expect(isMeshCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V8_MESH_MCP_PROFILE_ID)).toBe(
      true
    )
    expect(isMeshCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V9_MESH_MCP_PROFILE_ID)).toBe(
      true
    )
    expect(isMeshCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V10_MESH_MCP_PROFILE_ID)).toBe(
      true
    )
    expect(isMeshCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V11_MESH_MCP_PROFILE_ID)).toBe(
      true
    )
    expect(isMeshCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V12_MESH_MCP_PROFILE_ID)).toBe(
      true
    )
    expect(isMeshCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V13_MESH_MCP_PROFILE_ID)).toBe(
      true
    )
    expect(isMeshCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V14_MESH_MCP_PROFILE_ID)).toBe(
      true
    )
    expect(isMeshCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V15_MESH_MCP_PROFILE_ID)).toBe(
      true
    )
    expect(isMeshCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V17_MESH_MCP_PROFILE_ID)).toBe(
      true
    )
    expect(isMeshCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V8_MCP_PROFILE_ID)).toBe(false)
    expect(isMeshCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V9_MCP_PROFILE_ID)).toBe(false)
    expect(isMeshCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V10_MCP_PROFILE_ID)).toBe(
      false
    )
    expect(isMeshCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V11_MCP_PROFILE_ID)).toBe(
      false
    )
    expect(isMeshCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V12_MCP_PROFILE_ID)).toBe(
      false
    )
    expect(isMeshCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V13_MCP_PROFILE_ID)).toBe(
      false
    )
    expect(isMeshCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V14_MCP_PROFILE_ID)).toBe(
      false
    )
    expect(isMeshCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V15_MCP_PROFILE_ID)).toBe(
      false
    )
    expect(isMeshCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V17_MCP_PROFILE_ID)).toBe(
      false
    )
    expect(isMeshCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_SOLO_V1_MCP_PROFILE_ID)).toBe(
      false
    )
    expect(
      isMeshTopologyDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V14_MESH_MCP_PROFILE_ID)
    ).toBe(false)
    expect(
      isMeshTopologyDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V15_MESH_MCP_PROFILE_ID)
    ).toBe(true)
    expect(
      isMeshTopologyDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V17_MESH_MCP_PROFILE_ID)
    ).toBe(true)
  })

  it('fences direct opportunity redemption to v18-derived receipts only', () => {
    for (const profileId of [
      TASKWRAITH_GATEWAY_V18_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V18_MESH_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_SOLO_V2_MCP_PROFILE_ID
    ]) {
      expect(isPermissionOpportunityDirectTaskWraithMcpProfile(profileId)).toBe(true)
    }
    for (const profileId of [
      TASKWRAITH_GATEWAY_V17_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_V17_MESH_MCP_PROFILE_ID,
      TASKWRAITH_GATEWAY_SOLO_V1_MCP_PROFILE_ID
    ]) {
      expect(isPermissionOpportunityDirectTaskWraithMcpProfile(profileId)).toBe(false)
    }
  })

  it('promotes Sketch on v8 and later births while preserving every v7 receipt', () => {
    expect(isSketchCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V7_MCP_PROFILE_ID)).toBe(
      false
    )
    expect(
      isSketchCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V7_MESH_MCP_PROFILE_ID)
    ).toBe(false)
    expect(isSketchCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V8_MCP_PROFILE_ID)).toBe(
      true
    )
    expect(
      isSketchCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V8_MESH_MCP_PROFILE_ID)
    ).toBe(true)
    expect(isSketchCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V9_MCP_PROFILE_ID)).toBe(
      true
    )
    expect(
      isSketchCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V9_MESH_MCP_PROFILE_ID)
    ).toBe(true)
    expect(isSketchCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V10_MCP_PROFILE_ID)).toBe(
      true
    )
    expect(
      isSketchCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V10_MESH_MCP_PROFILE_ID)
    ).toBe(true)
    expect(isSketchCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V11_MCP_PROFILE_ID)).toBe(
      true
    )
    expect(
      isSketchCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V11_MESH_MCP_PROFILE_ID)
    ).toBe(true)
    expect(isSketchCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V12_MCP_PROFILE_ID)).toBe(
      true
    )
    expect(
      isSketchCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V12_MESH_MCP_PROFILE_ID)
    ).toBe(true)
    expect(isSketchCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V13_MCP_PROFILE_ID)).toBe(
      true
    )
    expect(
      isSketchCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V13_MESH_MCP_PROFILE_ID)
    ).toBe(true)
    expect(isSketchCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V14_MCP_PROFILE_ID)).toBe(
      true
    )
    expect(
      isSketchCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V14_MESH_MCP_PROFILE_ID)
    ).toBe(true)
    expect(isSketchCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V15_MCP_PROFILE_ID)).toBe(
      true
    )
    expect(
      isSketchCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V15_MESH_MCP_PROFILE_ID)
    ).toBe(true)
    expect(isSketchCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V17_MCP_PROFILE_ID)).toBe(
      true
    )
    expect(
      isSketchCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V17_MESH_MCP_PROFILE_ID)
    ).toBe(true)
    expect(
      isSketchCanvasDirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_SOLO_V1_MCP_PROFILE_ID)
    ).toBe(false)
  })

  it('promotes gateway-v13 orchestration DIRECT tools on v13+ births (including v14)', () => {
    expect(isGatewayV13DirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V12_MCP_PROFILE_ID)).toBe(
      false
    )
    expect(isGatewayV13DirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V12_MESH_MCP_PROFILE_ID)).toBe(
      false
    )
    expect(isGatewayV13DirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V13_MCP_PROFILE_ID)).toBe(true)
    expect(isGatewayV13DirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V13_MESH_MCP_PROFILE_ID)).toBe(
      true
    )
    expect(isGatewayV13DirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V14_MCP_PROFILE_ID)).toBe(true)
    expect(isGatewayV13DirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V14_MESH_MCP_PROFILE_ID)).toBe(
      true
    )
    expect(isGatewayV13DirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V15_MCP_PROFILE_ID)).toBe(true)
    expect(isGatewayV13DirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V15_MESH_MCP_PROFILE_ID)).toBe(
      true
    )
    expect(isGatewayV13DirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V17_MCP_PROFILE_ID)).toBe(true)
    expect(isGatewayV13DirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_V17_MESH_MCP_PROFILE_ID)).toBe(
      true
    )
    expect(isGatewayV13DirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_MCP_PROFILE_ID)).toBe(true)
    expect(isGatewayV13DirectTaskWraithMcpProfile(null)).toBe(false)
    expect(isGatewayV13DirectTaskWraithMcpProfile(undefined)).toBe(false)
    // Solo keeps the generic await/lane/wave lifecycle through its exact direct
    // array; the bridge's separate solo selector still hides lane-only scout_brief.
    expect(isGatewayV13DirectTaskWraithMcpProfile(TASKWRAITH_GATEWAY_SOLO_V1_MCP_PROFILE_ID)).toBe(
      true
    )
    expect(isPortableEnsembleControlMcpProfile(TASKWRAITH_GATEWAY_SOLO_V1_MCP_PROFILE_ID)).toBe(
      true
    )
  })

  it('never lets participant eligibility override a persisted session receipt', () => {
    const receipt = createTaskWraithMcpProfileReceipt({
      provider: 'claude',
      providerSessionId: 'existing-session',
      profileId: TASKWRAITH_GATEWAY_V6_MCP_PROFILE_ID
    })
    expect(
      resolveTaskWraithMcpProfile({
        provider: 'claude',
        providerSessionId: 'existing-session',
        receipt,
        soloThread: true,
        meshCanvasParticipantCanRequest: true
      })
    ).toEqual({ profileId: TASKWRAITH_GATEWAY_V6_MCP_PROFILE_ID, source: 'pinned_receipt' })
  })

  it('does not claim a gateway surface for headless or toolless Grok runs', () => {
    for (const grokMcpAdvertised of [false, undefined]) {
      expect(
        resolveTaskWraithMcpProfile({
          provider: 'grok',
          modelId: 'cli-default',
          coreProfileOptIn: true,
          grokMcpAdvertised
        }).profileId
      ).toBe(TASKWRAITH_FULL_MCP_PROFILE_ID)
    }
  })

  it('rebases a Claude payload onto the authoritative store session before dispatch', () => {
    expect(
      resolveTaskWraithMcpDispatchSession({
        provider: 'claude',
        requestedProviderSessionId: 'stale-a',
        storeProviderSessionId: 'store-b'
      })
    ).toEqual({ action: 'rebase', providerSessionId: 'store-b' })
    expect(
      resolveTaskWraithMcpDispatchSession({
        provider: 'claude',
        requestedProviderSessionId: 'store-b',
        storeProviderSessionId: 'store-b'
      })
    ).toEqual({ action: 'unchanged', providerSessionId: 'store-b' })
    expect(
      resolveTaskWraithMcpDispatchSession({
        provider: 'claude',
        requestedProviderSessionId: null,
        storeProviderSessionId: 'store-b'
      })
    ).toEqual({ action: 'rebase', providerSessionId: 'store-b' })
    expect(
      resolveTaskWraithMcpDispatchSession({
        provider: 'claude',
        requestedProviderSessionId: 'stale-a',
        storeProviderSessionId: null
      })
    ).toEqual({ action: 'rebase', providerSessionId: null })
    expect(
      resolveTaskWraithMcpDispatchSession({
        provider: 'claude',
        requestedProviderSessionId: null,
        storeProviderSessionId: null
      })
    ).toEqual({ action: 'unchanged', providerSessionId: null })
  })

  it('rejects only an orphaned stale Claude payload with no canonical store identity', () => {
    expect(
      resolveTaskWraithMcpDispatchSession({
        provider: 'claude',
        requestedProviderSessionId: 'orphan-a',
        storeIdentityKnown: false
      })
    ).toEqual({ action: 'reject_unknown_store', providerSessionId: null })
    expect(
      resolveTaskWraithMcpDispatchSession({
        provider: 'claude',
        requestedProviderSessionId: null,
        storeIdentityKnown: false
      })
    ).toEqual({ action: 'unchanged', providerSessionId: null })
  })

  it('leaves non-Claude provider sessions unchanged', () => {
    expect(
      resolveTaskWraithMcpDispatchSession({
        provider: 'codex',
        requestedProviderSessionId: 'codex-a',
        storeProviderSessionId: 'codex-b'
      })
    ).toEqual({ action: 'unchanged', providerSessionId: 'codex-a' })
  })

  it('requires an exact provider match for an ensemble route', () => {
    expect(
      isTaskWraithMcpRouteProviderMatch({
        payloadProvider: 'claude',
        ownerProvider: 'claude'
      })
    ).toBe(true)
    expect(
      isTaskWraithMcpRouteProviderMatch({
        payloadProvider: 'claude',
        ownerProvider: 'codex'
      })
    ).toBe(false)
  })

  it('requires a participant lane for ensemble store ownership', () => {
    expect(
      isTaskWraithMcpEnsembleLanePresent({
        chatIsEnsemble: true,
        participantId: undefined,
        participantFound: false
      })
    ).toBe(false)
    expect(
      isTaskWraithMcpEnsembleLanePresent({
        chatIsEnsemble: true,
        participantId: 'seat-1',
        participantFound: true
      })
    ).toBe(true)
    expect(
      isTaskWraithMcpEnsembleLanePresent({
        chatIsEnsemble: false,
        participantId: 'malformed-seat',
        participantFound: false
      })
    ).toBe(false)
    expect(
      isTaskWraithMcpEnsembleLanePresent({
        chatIsEnsemble: false,
        participantId: undefined,
        participantFound: false
      })
    ).toBe(true)
  })

  it('accepts a facade-validated ephemeral route independent of stale store ownership', () => {
    const reroute = {
      from: 'codex' as const,
      to: 'claude' as const,
      reason: 'provider-paused' as const,
      savedAsDefault: true
    }
    expect(
      isTaskWraithMcpAuthorizedEphemeralReroute({
        payloadProvider: 'cursor',
        providerReroute: {
          from: 'claude',
          to: 'cursor',
          reason: 'provider-paused'
        }
      })
    ).toBe(true)
    expect(
      isTaskWraithMcpAuthorizedEphemeralReroute({
        payloadProvider: 'claude',
        providerReroute: reroute
      })
    ).toBe(true)
    expect(
      isTaskWraithMcpAuthorizedEphemeralReroute({
        payloadProvider: 'codex',
        providerReroute: reroute
      })
    ).toBe(false)
  })

  it('allows the same validated ephemeral route on an exact ensemble participant lane', () => {
    expect(
      isTaskWraithMcpEnsembleLanePresent({
        chatIsEnsemble: true,
        participantId: 'seat-codex',
        participantFound: true
      }) &&
        isTaskWraithMcpAuthorizedEphemeralReroute({
          payloadProvider: 'claude',
          providerReroute: {
            from: 'codex',
            to: 'claude',
            reason: 'provider-paused'
          }
        })
    ).toBe(true)
  })
})

describe('MCP profile receipt validation and CAS rotation', () => {
  it('binds the gateway generation into the durable receipt fingerprint', () => {
    const common = {
      provider: 'claude' as const,
      providerSessionId: 'claude-a',
      pinnedAt: '2026-07-11T10:00:00.000Z'
    }
    const v1 = createTaskWraithMcpProfileReceipt({
      ...common,
      profileId: TASKWRAITH_GATEWAY_V1_MCP_PROFILE_ID
    })
    const v2 = createTaskWraithMcpProfileReceipt({
      ...common,
      profileId: TASKWRAITH_GATEWAY_V2_MCP_PROFILE_ID
    })
    expect(taskWraithMcpProfileReceiptFingerprint(v1)).not.toBe(
      taskWraithMcpProfileReceiptFingerprint(v2)
    )
  })

  it('keeps the immutable run-start pin authoritative across later CAS rotations', () => {
    const fence = {
      runStartedProviderSessionId: 'claude-a',
      runStartedReceiptFingerprint: 'receipt-a',
      storeWritable: true
    }
    expect(
      taskWraithMcpRunStartedWithPinnedReceipt({
        providerSessionId: 'claude-a',
        fence
      })
    ).toBe(true)
    expect(
      taskWraithMcpRunStartedWithPinnedReceipt({
        providerSessionId: null,
        fence
      })
    ).toBe(false)
  })

  it('requires an exact provider and session match', () => {
    const receipt = createTaskWraithMcpProfileReceipt({
      provider: 'claude',
      providerSessionId: 'claude-a',
      profileId: TASKWRAITH_CORE_MCP_PROFILE_ID
    })
    expect(
      isTaskWraithMcpProfileReceiptForSession(receipt, {
        provider: 'claude',
        providerSessionId: 'claude-a'
      })
    ).toBe(true)
    expect(
      isTaskWraithMcpProfileReceiptForSession(receipt, {
        provider: 'claude',
        providerSessionId: 'claude-b'
      })
    ).toBe(false)
  })

  it('rotates Claude A to B while preserving its pinned profile and timestamp', () => {
    const receiptA = createTaskWraithMcpProfileReceipt({
      provider: 'claude',
      providerSessionId: 'claude-a',
      profileId: TASKWRAITH_CORE_MCP_PROFILE_ID,
      pinnedAt: '2026-07-11T10:00:00.000Z'
    })
    const transition = transitionTaskWraithMcpProfileReceipt({
      provider: 'claude',
      profileId: TASKWRAITH_FULL_MCP_PROFILE_ID,
      nextProviderSessionId: 'claude-b',
      previousRunProviderSessionId: 'claude-a',
      expectedStoreIdentity: taskWraithMcpProfileStoreIdentity({
        providerSessionId: 'claude-a',
        receipt: receiptA
      }),
      currentStoreSessionId: 'claude-a',
      currentReceipt: receiptA
    })
    expect(transition).toEqual({
      accepted: true,
      receipt: { ...receiptA, providerSessionId: 'claude-b' }
    })
  })

  it('never upgrades a receipted gateway-v1 lineage during CAS rotation', () => {
    const receiptV1 = createTaskWraithMcpProfileReceipt({
      provider: 'claude',
      providerSessionId: 'claude-v1-a',
      profileId: TASKWRAITH_GATEWAY_V1_MCP_PROFILE_ID,
      pinnedAt: '2026-07-11T10:00:00.000Z'
    })
    expect(
      transitionTaskWraithMcpProfileReceipt({
        provider: 'claude',
        profileId: TASKWRAITH_GATEWAY_V2_MCP_PROFILE_ID,
        nextProviderSessionId: 'claude-v1-b',
        previousRunProviderSessionId: 'claude-v1-a',
        expectedStoreIdentity: taskWraithMcpProfileStoreIdentity({
          providerSessionId: 'claude-v1-a',
          receipt: receiptV1
        }),
        currentStoreSessionId: 'claude-v1-a',
        currentReceipt: receiptV1
      })
    ).toEqual({
      accepted: true,
      receipt: { ...receiptV1, providerSessionId: 'claude-v1-b' }
    })
  })

  it('rejects stale B replay after the store has advanced to C', () => {
    const receiptB = createTaskWraithMcpProfileReceipt({
      provider: 'claude',
      providerSessionId: 'claude-b',
      profileId: TASKWRAITH_CORE_MCP_PROFILE_ID
    })
    const receiptC = { ...receiptB, providerSessionId: 'claude-c' }
    expect(
      transitionTaskWraithMcpProfileReceipt({
        provider: 'claude',
        profileId: TASKWRAITH_CORE_MCP_PROFILE_ID,
        nextProviderSessionId: 'claude-b',
        previousRunProviderSessionId: 'claude-b',
        expectedStoreIdentity: taskWraithMcpProfileStoreIdentity({
          providerSessionId: 'claude-b',
          receipt: receiptB
        }),
        currentStoreSessionId: 'claude-c',
        currentReceipt: receiptC
      })
    ).toEqual({ accepted: false, reason: 'stale_store_identity' })
  })

  it('lets a null-resume run select a profile when the provider returns a different session', () => {
    const oldReceipt = createTaskWraithMcpProfileReceipt({
      provider: 'claude',
      providerSessionId: 'old-session',
      profileId: TASKWRAITH_FULL_MCP_PROFILE_ID
    })
    const transition = transitionTaskWraithMcpProfileReceipt({
      provider: 'claude',
      profileId: TASKWRAITH_CORE_MCP_PROFILE_ID,
      nextProviderSessionId: 'fresh-session',
      expectedStoreIdentity: taskWraithMcpProfileStoreIdentity({
        providerSessionId: 'old-session',
        receipt: oldReceipt
      }),
      currentStoreSessionId: 'old-session',
      currentReceipt: oldReceipt,
      pinnedAt: '2026-07-11T11:00:00.000Z'
    })
    expect(transition.accepted).toBe(true)
    if (transition.accepted && transition.receipt) {
      expect(transition.receipt.profileId).toBe(TASKWRAITH_CORE_MCP_PROFILE_ID)
      expect(transition.receipt.pinnedAt).toBe('2026-07-11T11:00:00.000Z')
    } else {
      throw new Error('Expected a receipted transition')
    }
  })

  it('preserves a receipt when a null-resume run returns the same store session id', () => {
    const receipt = createTaskWraithMcpProfileReceipt({
      provider: 'claude',
      providerSessionId: 'same-session',
      profileId: TASKWRAITH_CORE_MCP_PROFILE_ID,
      pinnedAt: '2026-07-11T10:00:00.000Z'
    })
    expect(
      transitionTaskWraithMcpProfileReceipt({
        provider: 'claude',
        profileId: TASKWRAITH_FULL_MCP_PROFILE_ID,
        nextProviderSessionId: 'same-session',
        previousRunProviderSessionId: null,
        expectedStoreIdentity: taskWraithMcpProfileStoreIdentity({
          providerSessionId: 'same-session',
          receipt
        }),
        currentStoreSessionId: 'same-session',
        currentReceipt: receipt
      })
    ).toEqual({ accepted: true, receipt })
  })

  it('rejects a run that resumed stale A after the store relinked to B', () => {
    const receiptB = createTaskWraithMcpProfileReceipt({
      provider: 'claude',
      providerSessionId: 'b',
      profileId: TASKWRAITH_CORE_MCP_PROFILE_ID
    })
    expect(
      transitionTaskWraithMcpProfileReceipt({
        provider: 'claude',
        profileId: TASKWRAITH_FULL_MCP_PROFILE_ID,
        nextProviderSessionId: 'c',
        previousRunProviderSessionId: 'a',
        expectedStoreIdentity: taskWraithMcpProfileStoreIdentity({
          providerSessionId: 'b',
          receipt: receiptB
        }),
        currentStoreSessionId: 'b',
        currentReceipt: receiptB
      })
    ).toEqual({ accepted: false, reason: 'stale_run_session' })
  })

  it('preserves profile and pinnedAt across A to B to C and rejects replayed B', () => {
    const receiptA = createTaskWraithMcpProfileReceipt({
      provider: 'claude',
      providerSessionId: 'a',
      profileId: TASKWRAITH_CORE_MCP_PROFILE_ID,
      pinnedAt: '2026-07-11T10:00:00.000Z'
    })
    const aToB = transitionTaskWraithMcpProfileReceipt({
      provider: 'claude',
      profileId: TASKWRAITH_CORE_MCP_PROFILE_ID,
      nextProviderSessionId: 'b',
      previousRunProviderSessionId: 'a',
      expectedStoreIdentity: taskWraithMcpProfileStoreIdentity({
        providerSessionId: 'a',
        receipt: receiptA
      }),
      currentStoreSessionId: 'a',
      currentReceipt: receiptA
    })
    expect(aToB.accepted).toBe(true)
    if (!aToB.accepted || !aToB.receipt) throw new Error('A to B transition failed')
    const bToC = transitionTaskWraithMcpProfileReceipt({
      provider: 'claude',
      profileId: TASKWRAITH_FULL_MCP_PROFILE_ID,
      nextProviderSessionId: 'c',
      previousRunProviderSessionId: 'b',
      expectedStoreIdentity: taskWraithMcpProfileStoreIdentity({
        providerSessionId: 'b',
        receipt: aToB.receipt
      }),
      currentStoreSessionId: 'b',
      currentReceipt: aToB.receipt
    })
    expect(bToC).toEqual({
      accepted: true,
      receipt: { ...receiptA, providerSessionId: 'c' }
    })
    expect(
      shouldAcceptTaskWraithMcpSessionId({
        nextProviderSessionId: 'b',
        currentProviderSessionId: 'c',
        seenProviderSessionIds: new Set(['a', 'b', 'c'])
      })
    ).toBe(false)
  })

  it('preserves a valid receipt lineage while MCP attachment is temporarily disabled', () => {
    const receipt = createTaskWraithMcpProfileReceipt({
      provider: 'claude',
      providerSessionId: 'a',
      profileId: TASKWRAITH_CORE_MCP_PROFILE_ID,
      pinnedAt: '2026-07-11T10:00:00.000Z'
    })
    expect(
      transitionTaskWraithMcpProfileReceipt({
        provider: 'claude',
        profileId: TASKWRAITH_FULL_MCP_PROFILE_ID,
        mcpAdvertised: false,
        nextProviderSessionId: 'b',
        previousRunProviderSessionId: 'a',
        expectedStoreIdentity: taskWraithMcpProfileStoreIdentity({
          providerSessionId: 'a',
          receipt
        }),
        currentStoreSessionId: 'a',
        currentReceipt: receipt
      })
    ).toEqual({ accepted: true, receipt: { ...receipt, providerSessionId: 'b' } })
  })

  it('does not create a receipt for an unreceipted birth when MCP is not attached', () => {
    expect(
      transitionTaskWraithMcpProfileReceipt({
        provider: 'claude',
        profileId: TASKWRAITH_CORE_MCP_PROFILE_ID,
        mcpAdvertised: false,
        nextProviderSessionId: 'a',
        expectedStoreIdentity: { providerSessionId: null, receiptFingerprint: null },
        currentStoreSessionId: null
      })
    ).toEqual({ accepted: true })
  })

  it('rejects structurally invalid provider receipts', () => {
    expect(
      isTaskWraithMcpProfileReceiptForSession(
        {
          schemaVersion: 1,
          profileId: TASKWRAITH_CORE_MCP_PROFILE_ID,
          provider: 'not-a-provider',
          providerSessionId: 'session',
          pinnedAt: '2026-07-11T10:00:00.000Z'
        },
        { provider: 'claude', providerSessionId: 'session' }
      )
    ).toBe(false)
  })
})

it('keeps the rollout gate default-off', () => {
  expect(taskWraithCoreMcpProfileOptInEnabled({})).toBe(false)
  expect(taskWraithCoreMcpProfileOptInEnabled({ TASKWRAITH_CORE_MCP_PROFILE: '1' })).toBe(true)
})
