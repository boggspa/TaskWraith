import { describe, expect, it, vi } from 'vitest'
import {
  BridgeActionRouter,
  approvalModeFromPayload,
  AUTO_EDIT_TIER_PRESET_IDS
} from './BridgeActionRouter'
import { DEFAULT_PERMISSION_PRESETS } from './EffectiveRunPermissions'
import { RemoteWorkspaceAllowlist } from './RemoteWorkspaceAllowlist'
import type { BridgeActionExecutionResult, BridgeActionExecutor } from './BridgeActionExecutor'
import type {
  RemoteDeviceAuditLedgerWriter,
  RemoteDeviceAuditRecord,
  RemoteDeviceAuditRecordInput
} from './remote/RemoteDeviceAuditLedger'
import type { BridgeActionPayload } from './BridgeActionPayload'

describe('approvalModeFromPayload — auto-edit preset allowlist gating', () => {
  const payload = (extra: Record<string, unknown>): BridgeActionPayload =>
    ({
      kind: 'composerPrompt',
      workspaceId: 'ws',
      threadId: 't',
      provider: 'codex',
      text: 'x',
      ...extra
    }) as unknown as BridgeActionPayload

  it('normalizes top-level auto-edit presets to auto_edit regardless of approvalMode', () => {
    // Escalation-prevention: a low approvalMode must NOT let auto-edit slip past
    // the workspace allowlist (allowedApprovalModes) — it is gated as auto_edit.
    expect(
      approvalModeFromPayload(payload({ approvalMode: 'default', permissionPresetId: 'full_access' }))
    ).toBe('auto_edit')
    expect(approvalModeFromPayload(payload({ permissionPresetId: 'full_access' }))).toBe('auto_edit')
    expect(
      approvalModeFromPayload(
        payload({ approvalMode: 'default', permissionPresetId: 'workspace_write' })
      )
    ).toBe('auto_edit')
  })

  it('passes through the raw approvalMode when the preset is not auto-edit tier', () => {
    expect(approvalModeFromPayload(payload({ approvalMode: 'default', permissionPresetId: 'default' }))).toBe(
      'default'
    )
    expect(approvalModeFromPayload(payload({ approvalMode: 'plan' }))).toBe('plan')
    expect(approvalModeFromPayload(payload({}))).toBeUndefined()
  })

  // ---- Ensemble roster path: the preset is nested per-participant with NO
  // top-level approvalMode, so without the roster branch it would gate as the
  // 'default' fallback and slip an auto-edit seat past a workspace that grants
  // `steer` + `default` but not `auto_edit`. ----
  const roster = (participants: Array<Record<string, unknown>>): BridgeActionPayload =>
    ({
      kind: 'ensembleRosterUpdate',
      workspaceId: 'ws',
      threadId: 't',
      participants
    }) as unknown as BridgeActionPayload

  it('normalizes a roster update to auto_edit when any participant is full_access', () => {
    expect(
      approvalModeFromPayload(roster([{ provider: 'codex', permissionPresetId: 'full_access' }]))
    ).toBe('auto_edit')
    // full_access anywhere in the roster (not just the first seat) trips the gate.
    expect(
      approvalModeFromPayload(
        roster([
          { provider: 'claude', permissionPresetId: 'default' },
          { provider: 'codex', permissionPresetId: 'full_access' }
        ])
      )
    ).toBe('auto_edit')
  })

  it('also gates workspace_write roster seats as auto_edit (the roster honors it)', () => {
    // workspace_write auto-edits (sandbox-contained), so it must clear the same
    // auto_edit gate as full_access even though it does not drop host sandboxing.
    expect(
      approvalModeFromPayload(roster([{ provider: 'codex', permissionPresetId: 'workspace_write' }]))
    ).toBe('auto_edit')
  })

  it('leaves a roster update with no auto-edit participant on its normal gate', () => {
    // read_only/plan/default seats carry no escalation, so no synthetic auto_edit;
    // the payload has no top-level approvalMode and falls through to undefined
    // (the capability gate still applies downstream).
    expect(
      approvalModeFromPayload(
        roster([
          { provider: 'claude', permissionPresetId: 'plan' },
          { provider: 'codex', permissionPresetId: 'default' }
        ])
      )
    ).toBeUndefined()
  })

  it('keeps AUTO_EDIT_TIER_PRESET_IDS in lockstep with the canonical presets', () => {
    // Cross-seam parity: if a new preset resolving to approvalMode:'auto_edit' is
    // added to DEFAULT_PERMISSION_PRESETS without being listed in the router set,
    // this fails — forcing the roster gate to keep covering every auto-edit preset.
    const canonicalAutoEdit = Object.values(DEFAULT_PERMISSION_PRESETS)
      .filter((preset) => preset.approvalMode === 'auto_edit')
      .map((preset) => preset.id)
      .sort()
    expect([...AUTO_EDIT_TIER_PRESET_IDS].sort()).toEqual(canonicalAutoEdit)
  })
})

/** Stub executor for router tests — captures method invocations + returns
 * configurable results. */
function makeStubExecutor(
  overrides: Partial<
    Record<keyof BridgeActionExecutor, () => Promise<BridgeActionExecutionResult>>
  > = {}
): { executor: BridgeActionExecutor; calls: Array<{ method: string; payload: unknown }> } {
  const calls: Array<{ method: string; payload: unknown }> = []
  const make = (method: keyof BridgeActionExecutor, defaultResult: BridgeActionExecutionResult) =>
    vi.fn(async (payload: unknown) => {
      calls.push({ method, payload })
      return (await overrides[method]?.()) ?? defaultResult
    })
  const executor: BridgeActionExecutor = {
    executeApprovalReply: make('executeApprovalReply', {
      executed: true,
      message: 'approvalReply done'
    }),
    executeQuestionReply: make('executeQuestionReply', {
      executed: true,
      message: 'questionReply done'
    }),
    executeQuestionReject: make('executeQuestionReject', {
      executed: true,
      message: 'questionReject done'
    }),
    executeComposerPrompt: make('executeComposerPrompt', {
      executed: true,
      message: 'composerPrompt done'
    }),
    executeComposerQueuePrompt: make('executeComposerQueuePrompt', {
      executed: true,
      message: 'composerQueuePrompt done'
    }),
    executeComposerQueueItem: make('executeComposerQueueItem', {
      executed: true,
      message: 'composerQueueItem done'
    }),
    executeCreateThread: make('executeCreateThread', {
      executed: true,
      message: 'createThread done'
    }),
    executeThreadRowExpand: make('executeThreadRowExpand', {
      executed: true,
      message: 'threadRowExpand done'
    }),
    executeThreadMediaFetch: make('executeThreadMediaFetch', {
      executed: true,
      message: 'threadMediaFetch done'
    }),
    executeThreadSnapshotRequest: make('executeThreadSnapshotRequest', {
      executed: true,
      message: 'threadSnapshotRequest done'
    }),
    executeWorkspaceFileList: make('executeWorkspaceFileList', {
      executed: true,
      message: 'workspaceFileList done'
    }),
    executeWorkspaceFileRead: make('executeWorkspaceFileRead', {
      executed: true,
      message: 'workspaceFileRead done'
    }),
    executeWorkspaceFileWrite: make('executeWorkspaceFileWrite', {
      executed: true,
      message: 'workspaceFileWrite done'
    }),
    executeWorkspaceFileDelete: make('executeWorkspaceFileDelete', {
      executed: true,
      message: 'workspaceFileDelete done'
    }),
    executeWorkspaceDiff: make('executeWorkspaceDiff', {
      executed: true,
      message: 'workspaceDiff done'
    }),
    executeGitSnapshot: make('executeGitSnapshot', {
      executed: true,
      message: 'gitSnapshot done'
    }),
    executeGitStageAll: make('executeGitStageAll', {
      executed: true,
      message: 'gitStageAll done'
    }),
    executeGitStagePaths: make('executeGitStagePaths', {
      executed: true,
      message: 'gitStagePaths done'
    }),
    executeGitUnstagePaths: make('executeGitUnstagePaths', {
      executed: true,
      message: 'gitUnstagePaths done'
    }),
    executeGitCommit: make('executeGitCommit', { executed: true, message: 'gitCommit done' }),
    executeGitPush: make('executeGitPush', { executed: true, message: 'gitPush done' }),
    executeGithubPrStatus: make('executeGithubPrStatus', {
      executed: true,
      message: 'githubPrStatus done'
    }),
    executeGithubPrReadiness: make('executeGithubPrReadiness', {
      executed: true,
      message: 'githubPrReadiness done'
    }),
    executeGithubCreatePr: make('executeGithubCreatePr', {
      executed: true,
      message: 'githubCreatePr done'
    }),
    executeCancelRun: make('executeCancelRun', { executed: true, message: 'cancelRun done' }),
    executeEnsembleCancelRound: make('executeEnsembleCancelRound', {
      executed: true,
      message: 'ensembleCancelRound done'
    }),
    executeEnsembleSkipActiveParticipant: make('executeEnsembleSkipActiveParticipant', {
      executed: true,
      message: 'ensembleSkipActiveParticipant done'
    }),
    executeEnsembleWakeNow: make('executeEnsembleWakeNow', {
      executed: true,
      message: 'ensembleWakeNow done'
    }),
    executeEnsembleCancelWakeup: make('executeEnsembleCancelWakeup', {
      executed: true,
      message: 'ensembleCancelWakeup done'
    }),
    executeEnsembleQueuePrompt: make('executeEnsembleQueuePrompt', {
      executed: true,
      message: 'ensembleQueuePrompt done'
    }),
    executeEnsembleSteer: make('executeEnsembleSteer', {
      executed: true,
      message: 'ensembleSteer done'
    }),
    executeEnsembleRosterUpdate: make('executeEnsembleRosterUpdate', {
      executed: true,
      message: 'ensembleSteer done'
    }),
    executeEnsembleSettingsUpdate: make('executeEnsembleSettingsUpdate', {
      executed: true,
      message: 'ensembleSettingsUpdate done'
    }),
    executeEnsembleQueueItem: make('executeEnsembleQueueItem', {
      executed: true,
      message: 'ensembleSteer done'
    }),
    executeCreateSideChat: make('executeCreateSideChat', {
      executed: true,
      message: 'ensembleSteer done'
    }),
    executeSetThreadNotes: make('executeSetThreadNotes', {
      executed: true,
      message: 'ensembleSteer done'
    }),
    executeSetThreadTitle: make('executeSetThreadTitle', {
      executed: true,
      message: 'setThreadTitle done'
    }),
    executeSetChatKind: make('executeSetChatKind', {
      executed: true,
      message: 'setChatKind done'
    }),
    executeGoalUpdate: make('executeGoalUpdate', {
      executed: true,
      message: 'goalUpdate done'
    }),
    executeToggleMessagePin: make('executeToggleMessagePin', {
      executed: true,
      message: 'ensembleSteer done'
    }),
    executeProposedPlanDecision: make('executeProposedPlanDecision', {
      executed: true,
      message: 'proposedPlanDecision done'
    }),
    executeCanvasAction: make('executeCanvasAction', {
      executed: true,
      message: 'canvasAction done'
    }),
    executeRegisterApnsToken: make('executeRegisterApnsToken', {
      executed: true,
      message: 'registerApnsToken done'
    }),
    executeEnsemblePresetMutate: make('executeEnsemblePresetMutate', {
      executed: true,
      message: 'ensemblePresetMutate done'
    }),
    executeDiscoverTailnetHosts: make('executeDiscoverTailnetHosts', {
      executed: true,
      message: 'discoverTailnetHosts done',
      data: { hosts: [] }
    }),
    executeSetYoloMode: make('executeSetYoloMode', { executed: true, message: 'setYoloMode done' }),
    executeTogglePinChat: make('executeTogglePinChat', {
      executed: true,
      message: 'togglePinChat done'
    }),
    executeTogglePinWorkspace: make('executeTogglePinWorkspace', {
      executed: true,
      message: 'togglePinWorkspace done'
    })
  }
  return { executor, calls }
}

function makeAuditLedger(): {
  ledger: RemoteDeviceAuditLedgerWriter
  records: RemoteDeviceAuditRecord[]
} {
  const records: RemoteDeviceAuditRecord[] = []
  const ledger: RemoteDeviceAuditLedgerWriter = {
    append: vi.fn(async (input: RemoteDeviceAuditRecordInput) => {
      const record: RemoteDeviceAuditRecord = {
        id: input.id || `audit-${records.length + 1}`,
        deviceId: input.deviceId,
        capability: input.capability,
        action: input.action,
        ...(input.chatId ? { chatId: input.chatId } : {}),
        decision: input.decision,
        ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
        reason: input.reason,
        ...(input.metadata
          ? { metadata: input.metadata as RemoteDeviceAuditRecord['metadata'] }
          : {}),
        timestamp: input.timestamp || '2026-05-31T21:00:00.000Z'
      }
      const existing = records.find((row) => row.id === record.id)
      if (existing) return existing
      records.push(record)
      return record
    })
  }
  return { ledger, records }
}

// Mutating actions now REQUIRE actionId + expiresAt (security review:
// optional replay/expiry controls were a no-ship finding). Wire fixtures
// spread these defaults; tests exercising specific metadata override them
// (their explicit values win — defaults are spread FIRST).
let replayMetaCounter = 0
const withReplayMeta = (payload: Record<string, unknown>): Record<string, unknown> => ({
  actionId: `test-action-${++replayMetaCounter}`,
  issuedAt: 1_700_000_000_000,
  expiresAt: Date.now() + 60_000,
  ...payload
})

describe('BridgeActionRouter', () => {
  describe('default deny-by-default policy', () => {
    it('denies bridge.requestActionAck with stable shape (unknown payload)', async () => {
      // Payload `{"hi": "world"}` decodes to BridgeUnknownAction (no `kind`),
      // which the router denies with a "unrecognized kind" message.
      const router = new BridgeActionRouter()
      const result = (await router.route('bridge.requestActionAck', {
        pairID: 'pair-1',
        payloadBytes: 42,
        payloadBase64: 'eyJoaSI6ICJ3b3JsZCJ9'
      })) as { accepted: boolean; scope?: string; message?: string }
      expect(result.accepted).toBe(false)
      expect(result.scope).toBe('once')
      expect(result.message).toMatch(/unrecognized action kind/i)
    })

    it('denies bridge.requestActionAck for a known payload with no allowlist', async () => {
      // With a real payload but no allowlist configured, the deny message
      // explicitly cites the missing allowlist.
      const router = new BridgeActionRouter()
      const wire = Buffer.from(
        JSON.stringify(withReplayMeta({
          kind: 'composerPrompt',
          workspaceId: 'ws-1',
          threadId: 't-1',
          provider: 'gemini',
          text: 'hi'
        })),
        'utf-8'
      ).toString('base64')
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(false)
      expect(result.message).toMatch(/no workspace allowlist/i)
    })

    it('denies bridge.requestPrepareStartTurnAck with stable shape', async () => {
      const router = new BridgeActionRouter()
      const result = (await router.route('bridge.requestPrepareStartTurnAck', {
        pairID: 'pair-1',
        prepareID: 'p1',
        workspaceID: 'ws-1',
        threadID: 't-1'
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(false)
      expect(result.message).toMatch(/not yet enabled|allowlist/i)
    })

    it('handles missing params dictionary without throwing', async () => {
      const router = new BridgeActionRouter()
      const r1 = await router.route('bridge.requestActionAck', null)
      const r2 = await router.route('bridge.requestActionAck', 'not-an-object')
      const r3 = await router.route('bridge.requestPrepareStartTurnAck', undefined)
      expect((r1 as { accepted: boolean }).accepted).toBe(false)
      expect((r2 as { accepted: boolean }).accepted).toBe(false)
      expect((r3 as { accepted: boolean }).accepted).toBe(false)
    })
  })

  describe('permissive-dev override', () => {
    it('accepts actionAck under permissive flag', async () => {
      const router = new BridgeActionRouter({ permissiveDev: true })
      const result = (await router.route('bridge.requestActionAck', {
        pairID: 'pair-1',
        payloadBytes: 0
      })) as { accepted: boolean; scope?: string; message?: string }
      expect(result.accepted).toBe(true)
      expect(result.scope).toBe('once')
      expect(result.message).toMatch(/permissive-dev/i)
    })

    it('accepts prepareStartTurn under permissive flag', async () => {
      const router = new BridgeActionRouter({ permissiveDev: true })
      const result = (await router.route('bridge.requestPrepareStartTurnAck', {
        workspaceID: 'ws-1'
      })) as { accepted: boolean }
      expect(result.accepted).toBe(true)
    })

    it('emits a single warning log when constructed in permissive mode', () => {
      const log = vi.fn()

      new BridgeActionRouter({ permissiveDev: true, log })
      expect(log).toHaveBeenCalledTimes(1)
      expect(log.mock.calls[0][0]).toMatch(/permissive-dev mode is ON/i)
    })

    it('does not warn when permissive mode is off', () => {
      const log = vi.fn()

      new BridgeActionRouter({ permissiveDev: false, log })
      expect(log).not.toHaveBeenCalled()
    })
  })

  describe('allowlist integration (Phase C4)', () => {
    const seedAllowlist = (clock = 1000) => {
      const allowlist = new RemoteWorkspaceAllowlist({ now: () => clock })
      allowlist.upsert({
        workspaceId: 'ws-allowed',
        path: '/Users/test/projects/a',
        mode: 'read-write',
        allowedProviders: ['gemini', 'codex'],
        allowedApprovalModes: ['default', 'plan']
      })
      return allowlist
    }

    it('accepts prepareStartTurn when workspace is allowlisted', async () => {
      const allowlist = seedAllowlist()
      const router = new BridgeActionRouter({ allowlist })
      const result = (await router.route('bridge.requestPrepareStartTurnAck', {
        pairID: 'pair-1',
        workspaceID: 'ws-allowed'
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(true)
      expect(result.message).toMatch(/read-write/i)
    })

    it('audits prepareStartTurn decisions by device id', async () => {
      const allowlist = seedAllowlist()
      const { ledger, records } = makeAuditLedger()
      const router = new BridgeActionRouter({ allowlist, auditLedger: ledger })

      const result = (await router.route('bridge.requestPrepareStartTurnAck', {
        pairID: 'ipad-1',
        workspaceID: 'ws-allowed',
        threadID: 'thread-1'
      })) as { accepted: boolean }

      expect(result.accepted).toBe(true)
      expect(records).toEqual([
        expect.objectContaining({
          deviceId: 'ipad-1',
          capability: 'startTurn',
          action: 'prepareStartTurn',
          chatId: 'thread-1',
          decision: 'allowed',
          reason: expect.stringMatching(/allowed/i)
        })
      ])
    })

    it('denies prepareStartTurn when workspace is not on allowlist', async () => {
      const allowlist = seedAllowlist()
      const router = new BridgeActionRouter({ allowlist })
      const result = (await router.route('bridge.requestPrepareStartTurnAck', {
        pairID: 'pair-1',
        workspaceID: 'ws-not-listed'
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(false)
      expect(result.message).toMatch(/not on the remote allowlist/i)
    })

    it('denies prepareStartTurn when provider is not allowed for the workspace', async () => {
      const allowlist = seedAllowlist()
      const router = new BridgeActionRouter({ allowlist })
      const result = (await router.route('bridge.requestPrepareStartTurnAck', {
        pairID: 'pair-1',
        workspaceID: 'ws-allowed',
        provider: 'claude'
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(false)
      expect(result.message).toMatch(/provider "claude"/i)
    })

    it('denies prepareStartTurn when approval mode is not allowed', async () => {
      const allowlist = seedAllowlist()
      const router = new BridgeActionRouter({ allowlist })
      const result = (await router.route('bridge.requestPrepareStartTurnAck', {
        pairID: 'pair-1',
        workspaceID: 'ws-allowed',
        approvalMode: 'allow-all'
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(false)
      expect(result.message).toMatch(/approval mode "allow-all"/i)
    })

    it('denies prepareStartTurn when allowlist entry has expired', async () => {
      let clock = 1000
      const allowlist = new RemoteWorkspaceAllowlist({ now: () => clock })
      allowlist.upsert({
        workspaceId: 'ws-expiring',
        path: '/Users/test/a',
        mode: 'read-write',
        allowedProviders: ['gemini'],
        allowedApprovalModes: ['default'],
        expiresAt: 5000
      })
      const router = new BridgeActionRouter({ allowlist })
      // Within window: accepted.
      clock = 4000
      let result = (await router.route('bridge.requestPrepareStartTurnAck', {
        workspaceID: 'ws-expiring'
      })) as { accepted: boolean }
      expect(result.accepted).toBe(true)
      // After expiry: denied.
      clock = 6000
      result = (await router.route('bridge.requestPrepareStartTurnAck', {
        workspaceID: 'ws-expiring'
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(false)
      if ('message' in result) {
        expect(result.message).toMatch(/expired/i)
      }
    })

    it('permissive-dev overrides the allowlist (accepts even when workspace is absent)', async () => {
      const allowlist = seedAllowlist()
      const router = new BridgeActionRouter({ allowlist, permissiveDev: true })
      const result = (await router.route('bridge.requestPrepareStartTurnAck', {
        workspaceID: 'ws-not-listed-anywhere'
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(true)
      expect(result.message).toMatch(/permissive-dev/i)
    })

    it('reacts to allowlist mutation between calls (per-action revalidation)', async () => {
      const allowlist = new RemoteWorkspaceAllowlist()
      const router = new BridgeActionRouter({ allowlist })

      // Initial deny — not on list.
      let result = (await router.route('bridge.requestPrepareStartTurnAck', {
        workspaceID: 'ws-late-add'
      })) as { accepted: boolean }
      expect(result.accepted).toBe(false)

      // Add it.
      allowlist.upsert({
        workspaceId: 'ws-late-add',
        path: '/Users/test/a',
        mode: 'read-write',
        allowedProviders: ['gemini'],
        allowedApprovalModes: ['default']
      })

      // Next call sees the new entry — no router restart needed.
      result = (await router.route('bridge.requestPrepareStartTurnAck', {
        workspaceID: 'ws-late-add'
      })) as { accepted: boolean }
      expect(result.accepted).toBe(true)

      // Remove it.
      allowlist.remove('ws-late-add')

      // Back to deny.
      result = (await router.route('bridge.requestPrepareStartTurnAck', {
        workspaceID: 'ws-late-add'
      })) as { accepted: boolean }
      expect(result.accepted).toBe(false)
    })

    it('actionAck with no allowlist denies even a well-formed payload', async () => {
      const router = new BridgeActionRouter()
      const wire = Buffer.from(
        JSON.stringify(withReplayMeta({
          kind: 'composerPrompt',
          workspaceId: 'ws-anything',
          threadId: 't-1',
          provider: 'gemini',
          text: 'hi'
        })),
        'utf-8'
      ).toString('base64')
      const result = (await router.route('bridge.requestActionAck', {
        pairID: 'pair-1',
        payloadBytes: 10,
        payloadBase64: wire
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(false)
      expect(result.message).toMatch(/no workspace allowlist/i)
    })

    it('actionAck accepts when payload targets an allowlisted workspace', async () => {
      const allowlist = seedAllowlist()
      const router = new BridgeActionRouter({ allowlist })
      const wire = Buffer.from(
        JSON.stringify(withReplayMeta({
          kind: 'composerPrompt',
          workspaceId: 'ws-allowed',
          threadId: 't-1',
          text: 'hello',
          provider: 'gemini',
          approvalMode: 'default'
        })),
        'utf-8'
      ).toString('base64')
      const result = (await router.route('bridge.requestActionAck', {
        pairID: 'pair-1',
        payloadBytes: 10,
        payloadBase64: wire
      })) as {
        accepted: boolean
        scope?: string
        message?: string
        v?: number
        reasonCode?: string
        actionKind?: string
        workspaceId?: string
        threadId?: string
      }
      expect(result.accepted).toBe(true)
      expect(result.v).toBe(1)
      expect(result.reasonCode).toBe('accepted')
      expect(result.actionKind).toBe('composerPrompt')
      expect(result.workspaceId).toBe('ws-allowed')
      expect(result.threadId).toBe('t-1')
      expect(result.scope).toBe('once')
      expect(result.message).toMatch(/composerPrompt|execution wiring pending/i)
    })

    it('audits accepted capability-gated actionAck decisions by device id', async () => {
      const allowlist = seedAllowlist()
      const { ledger, records } = makeAuditLedger()
      const router = new BridgeActionRouter({ allowlist, auditLedger: ledger })
      const wire = Buffer.from(
        JSON.stringify(withReplayMeta({
          kind: 'composerPrompt',
          workspaceId: 'ws-allowed',
          threadId: 't-1',
          text: 'hello',
          provider: 'gemini',
          approvalMode: 'default',
          actionId: 'compose-1'
        })),
        'utf-8'
      ).toString('base64')

      const result = (await router.route('bridge.requestActionAck', {
        pairID: 'iphone-1',
        payloadBase64: wire
      })) as { accepted: boolean }

      expect(result.accepted).toBe(true)
      expect(records).toEqual([
        expect.objectContaining({
          id: 'remote-action:iphone-1:compose-1:startTurn:allowed',
          deviceId: 'iphone-1',
          capability: 'startTurn',
          action: 'composerPrompt',
          chatId: 't-1',
          decision: 'allowed'
        })
      ])
    })

    it('actionAck denies a composerPrompt for an unlisted workspace', async () => {
      const allowlist = seedAllowlist()
      const router = new BridgeActionRouter({ allowlist })
      const wire = Buffer.from(
        JSON.stringify(withReplayMeta({
          kind: 'composerPrompt',
          workspaceId: 'ws-not-listed',
          threadId: 't-1',
          provider: 'gemini',
          text: 'hello'
        })),
        'utf-8'
      ).toString('base64')
      const result = (await router.route('bridge.requestActionAck', {
        pairID: 'pair-1',
        payloadBase64: wire
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(false)
      expect(result.message).toMatch(/not on the remote allowlist/i)
    })

    it('audits denied capability-gated actionAck decisions by device id', async () => {
      const allowlist = seedAllowlist()
      const { ledger, records } = makeAuditLedger()
      const router = new BridgeActionRouter({ allowlist, auditLedger: ledger })
      const wire = Buffer.from(
        JSON.stringify(withReplayMeta({
          kind: 'setYoloMode',
          workspaceId: 'ws-allowed',
          enabled: true,
          actionId: 'yolo-1'
        })),
        'utf-8'
      ).toString('base64')

      const result = (await router.route('bridge.requestActionAck', {
        pairID: 'iphone-1',
        payloadBase64: wire
      })) as { accepted: boolean; reasonCode?: string }

      expect(result.accepted).toBe(false)
      expect(result.reasonCode).toBe('capabilityDenied')
      expect(records).toEqual([
        expect.objectContaining({
          id: 'remote-action:iphone-1:yolo-1:yolo:denied',
          deviceId: 'iphone-1',
          capability: 'yolo',
          action: 'setYoloMode',
          decision: 'denied',
          reason: expect.stringMatching(/capability "yolo"/i)
        })
      ])
    })

    it('actionAck denies when provider is disallowed for the workspace', async () => {
      const allowlist = seedAllowlist()
      const router = new BridgeActionRouter({ allowlist })
      const wire = Buffer.from(
        JSON.stringify(withReplayMeta({
          kind: 'composerPrompt',
          workspaceId: 'ws-allowed',
          threadId: 't-1',
          text: 'hi',
          provider: 'claude' // not in allowed list (gemini, codex)
        })),
        'utf-8'
      ).toString('base64')
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(false)
      expect(result.message).toMatch(/provider "claude"/i)
    })

    it('actionAck denies malformed base64', async () => {
      const router = new BridgeActionRouter({ allowlist: seedAllowlist() })
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: '!!!not-base64!!!'
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(false)
      expect(result.message).toMatch(/malformed action payload/i)
    })

    it('audits malformed actionAck payloads as system denials with reason codes', async () => {
      const { ledger, records } = makeAuditLedger()
      const router = new BridgeActionRouter({ allowlist: seedAllowlist(), auditLedger: ledger })

      const result = (await router.route('bridge.requestActionAck', {
        pairID: 'iphone-malformed',
        payloadBytes: 999,
        payloadBase64: '!!!not-base64!!!'
      })) as { accepted: boolean; reasonCode?: string }

      expect(result.accepted).toBe(false)
      expect(result.reasonCode).toBe('malformedPayload')
      expect(records).toEqual([
        expect.objectContaining({
          deviceId: 'iphone-malformed',
          capability: 'system',
          action: 'actionAck',
          decision: 'denied',
          reasonCode: 'malformedPayload',
          metadata: expect.objectContaining({ decodeStage: 'base64', payloadBytes: 999 })
        })
      ])
    })

    it('actionAck denies malformed JSON inside valid base64', async () => {
      const router = new BridgeActionRouter({ allowlist: seedAllowlist() })
      const wire = Buffer.from('not json {', 'utf-8').toString('base64')
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(false)
      expect(result.message).toMatch(/malformed action payload \(json\)/i)
    })

    it('actionAck denies an unknown action kind with a clear message', async () => {
      const router = new BridgeActionRouter({ allowlist: seedAllowlist() })
      const wire = Buffer.from(
        JSON.stringify(withReplayMeta({
          kind: 'futureKind',
          workspaceId: 'ws-allowed',
          stuff: true
        })),
        'utf-8'
      ).toString('base64')
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(false)
      expect(result.message).toMatch(/unrecognized action kind "futureKind"/i)
    })

    it('audits unknown action kinds even though no capability can be derived', async () => {
      const { ledger, records } = makeAuditLedger()
      const router = new BridgeActionRouter({ allowlist: seedAllowlist(), auditLedger: ledger })
      const wire = Buffer.from(
        JSON.stringify(withReplayMeta({
          kind: 'futureKind',
          workspaceId: 'ws-allowed',
          stuff: true
        })),
        'utf-8'
      ).toString('base64')

      const result = (await router.route('bridge.requestActionAck', {
        pairID: 'iphone-unknown',
        payloadBase64: wire
      })) as { accepted: boolean; reasonCode?: string }

      expect(result.accepted).toBe(false)
      expect(result.reasonCode).toBe('unknownAction')
      expect(records).toEqual([
        expect.objectContaining({
          deviceId: 'iphone-unknown',
          capability: 'system',
          action: 'unknown',
          decision: 'denied',
          reasonCode: 'unknownAction',
          metadata: expect.objectContaining({ actionKind: 'unknown', rawKind: 'futureKind' })
        })
      ])
    })

    it('actionAck accepts approvalReply variant for an allowlisted workspace', async () => {
      const allowlist = seedAllowlist()
      const router = new BridgeActionRouter({ allowlist })
      const wire = Buffer.from(
        JSON.stringify(withReplayMeta({
          kind: 'approvalReply',
          workspaceId: 'ws-allowed',
          threadId: 't-1',
          toolCallId: 'tc-1',
          decision: 'acceptForSession'
        })),
        'utf-8'
      ).toString('base64')
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean; message?: string; scope?: string; approvalId?: string }
      expect(result.accepted).toBe(true)
      expect(result.scope).toBe('session')
      expect(result.approvalId).toBe('tc-1')
    })

    it('permissive-dev still bypasses payload decoding entirely', async () => {
      const allowlist = seedAllowlist()
      const router = new BridgeActionRouter({ allowlist, permissiveDev: true })
      const result = (await router.route('bridge.requestActionAck', {
        // Intentionally garbage; permissive-dev should still accept.
        payloadBase64: '!!!garbage!!!'
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(true)
      expect(result.message).toMatch(/permissive-dev/i)
    })
  })

  describe('action ack v1 stale and replay guards', () => {
    const seedAllowlist = () => {
      const allowlist = new RemoteWorkspaceAllowlist()
      allowlist.upsert({
        workspaceId: 'ws-allowed',
        path: '/a',
        mode: 'read-write',
        allowedProviders: ['gemini'],
        allowedApprovalModes: ['default']
      })
      return allowlist
    }

    const encodeAction = (overrides: Record<string, unknown> = {}) =>
      Buffer.from(
        JSON.stringify(withReplayMeta({
          kind: 'composerPrompt',
          workspaceId: 'ws-allowed',
          threadId: 't-1',
          provider: 'gemini',
          text: 'hi',
          ...overrides
        })),
        'utf-8'
      ).toString('base64')

    it('denies expired actions before allowlist or executor dispatch', async () => {
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({
        allowlist: seedAllowlist(),
        executor,
        now: () => 10_000
      })
      const result = (await router.route('bridge.requestActionAck', {
        pairID: 'pair-1',
        payloadBase64: encodeAction({ actionId: 'a-expired', expiresAt: 9999 })
      })) as { accepted: boolean; reasonCode?: string; actionId?: string; message?: string }
      expect(result.accepted).toBe(false)
      expect(result.reasonCode).toBe('actionExpired')
      expect(result.actionId).toBe('a-expired')
      expect(result.message).toMatch(/expired/i)
      expect(calls).toHaveLength(0)
    })

    it('denies replayed actionIds for the same pairID', async () => {
      const { executor, calls } = makeStubExecutor()
      const { ledger, records } = makeAuditLedger()
      const router = new BridgeActionRouter({
        allowlist: seedAllowlist(),
        executor,
        now: () => 10_000,
        auditLedger: ledger
      })
      const params = {
        pairID: 'pair-1',
        payloadBase64: encodeAction({ actionId: 'a-1', expiresAt: 20_000 })
      }

      const first = (await router.route('bridge.requestActionAck', params)) as {
        accepted: boolean
        reasonCode?: string
      }
      const second = (await router.route('bridge.requestActionAck', params)) as {
        accepted: boolean
        reasonCode?: string
        actionId?: string
      }

      expect(first.accepted).toBe(true)
      expect(first.reasonCode).toBe('accepted')
      expect(second.accepted).toBe(false)
      expect(second.reasonCode).toBe('actionReplayed')
      expect(second.actionId).toBe('a-1')
      expect(calls).toHaveLength(1)
      expect(records).toEqual([
        expect.objectContaining({
          id: 'remote-action:pair-1:a-1:startTurn:allowed',
          decision: 'allowed',
          reasonCode: 'accepted'
        }),
        expect.objectContaining({
          id: 'remote-action:pair-1:a-1:startTurn:denied',
          decision: 'denied',
          reasonCode: 'actionReplayed'
        })
      ])
    })

    it('scopes replay protection by pairID', async () => {
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({
        allowlist: seedAllowlist(),
        executor,
        now: () => 10_000
      })
      const payloadBase64 = encodeAction({ actionId: 'shared-action', expiresAt: 20_000 })

      const first = (await router.route('bridge.requestActionAck', {
        pairID: 'pair-a',
        payloadBase64
      })) as { accepted: boolean }
      const second = (await router.route('bridge.requestActionAck', {
        pairID: 'pair-b',
        payloadBase64
      })) as { accepted: boolean }

      expect(first.accepted).toBe(true)
      expect(second.accepted).toBe(true)
      expect(calls).toHaveLength(2)
    })
  })

  describe('executor dispatch on accept (Phase C-late)', () => {
    const seedAllowlist = () => {
      const allowlist = new RemoteWorkspaceAllowlist()
      allowlist.upsert({
        workspaceId: 'ws-allowed',
        path: '/a',
        mode: 'read-write',
        capabilities: [
          'monitor',
          'approve',
          'answer',
          'cancel',
          'startTurn',
          'diffReview',
          'steer',
          'pin',
          'yolo'
        ],
        allowedProviders: ['gemini', 'codex'],
        allowedApprovalModes: ['default', 'plan']
      })
      return allowlist
    }

    const composerPromptWire = (overrides: Record<string, unknown> = {}) =>
      Buffer.from(
        JSON.stringify(withReplayMeta({
          kind: 'composerPrompt',
          workspaceId: 'ws-allowed',
          threadId: 't-1',
          provider: 'gemini',
          text: 'hi',
          ...overrides
        })),
        'utf-8'
      ).toString('base64')

    it('dispatches accepted composerPrompt to executor.executeComposerPrompt', async () => {
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({ allowlist: seedAllowlist(), executor })
      const result = (await router.route('bridge.requestActionAck', {
        pairID: 'p',
        payloadBase64: composerPromptWire()
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(true)
      expect(result.message).toBe('composerPrompt done')
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('executeComposerPrompt')
    })

    it('surfaces run ids from executor data in the structured ack', async () => {
      const { executor } = makeStubExecutor({
        executeComposerPrompt: async () => ({
          executed: true,
          message: 'run dispatched',
          data: { appRunId: 'app-run-1', providerRunId: 'provider-run-1' }
        })
      })
      const router = new BridgeActionRouter({ allowlist: seedAllowlist(), executor })
      const result = (await router.route('bridge.requestActionAck', {
        pairID: 'p',
        payloadBase64: composerPromptWire({ actionId: 'compose-1' })
      })) as {
        accepted: boolean
        actionId?: string
        appRunId?: string
        providerRunId?: string
        data?: Record<string, unknown>
      }
      expect(result.accepted).toBe(true)
      expect(result.actionId).toBe('compose-1')
      expect(result.appRunId).toBe('app-run-1')
      expect(result.providerRunId).toBe('provider-run-1')
      expect(result.data).toMatchObject({
        appRunId: 'app-run-1',
        providerRunId: 'provider-run-1'
      })
    })

    it('dispatches threadMediaFetch through monitor-gated transcript reads', async () => {
      const { executor, calls } = makeStubExecutor({
        executeThreadMediaFetch: async () => ({
          executed: true,
          message: 'Fetched transcript media.',
          data: {
            mediaId: 'media-1',
            rowId: 'm7',
            threadId: 't-1',
            media: { id: 'media-1', mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' }
          }
        })
      })
      const router = new BridgeActionRouter({ allowlist: seedAllowlist(), executor })
      const wire = Buffer.from(
        JSON.stringify(withReplayMeta({
          kind: 'threadMediaFetch',
          workspaceId: 'ws-allowed',
          threadId: 't-1',
          rowId: 'm7',
          mediaId: 'media-1',
          variant: 'thumbnail',
          maxBytes: 512000
        })),
        'utf-8'
      ).toString('base64')
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean; data?: { mediaId?: string; media?: { id?: string } } }

      expect(result.accepted).toBe(true)
      expect(result.data?.mediaId).toBe('media-1')
      expect(result.data?.media?.id).toBe('media-1')
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('executeThreadMediaFetch')
    })

    it('dispatches cancelRun to executor.executeCancelRun', async () => {
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({ allowlist: seedAllowlist(), executor })
      const wire = Buffer.from(
        JSON.stringify(withReplayMeta({
          kind: 'cancelRun',
          workspaceId: 'ws-allowed',
          threadId: 't-1',
          provider: 'gemini',
          runId: 'run-1'
        })),
        'utf-8'
      ).toString('base64')
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(true)
      expect(result.message).toBe('cancelRun done')
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('executeCancelRun')
    })

    it('dispatches canvasAction to executor.executeCanvasAction', async () => {
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({ allowlist: seedAllowlist(), executor })
      const wire = Buffer.from(
        JSON.stringify(
          withReplayMeta({
            kind: 'canvasAction',
            workspaceId: 'ws-allowed',
            threadId: 't-1',
            canvasId: 'cv1',
            action: 'close'
          })
        ),
        'utf-8'
      ).toString('base64')
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(true)
      expect(result.message).toBe('canvasAction done')
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('executeCanvasAction')
    })

    it('dispatches ensembleSettingsUpdate to executor.executeEnsembleSettingsUpdate', async () => {
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({ allowlist: seedAllowlist(), executor })
      const wire = Buffer.from(
        JSON.stringify(
          withReplayMeta({
            kind: 'ensembleSettingsUpdate',
            workspaceId: 'ws-allowed',
            threadId: 't-1',
            orchestrationMode: 'continuous',
            maxContinuationHops: 9,
            fanoutPolicy: 'read_only',
            ensembleContextChars: 120_000
          })
        ),
        'utf-8'
      ).toString('base64')
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(true)
      expect(result.message).toBe('ensembleSettingsUpdate done')
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('executeEnsembleSettingsUpdate')
    })

    it('dispatches approvalReply to executor.executeApprovalReply', async () => {
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({ allowlist: seedAllowlist(), executor })
      const wire = Buffer.from(
        JSON.stringify(withReplayMeta({
          kind: 'approvalReply',
          workspaceId: 'ws-allowed',
          threadId: 't-1',
          toolCallId: 'tc-1',
          decision: 'acceptForSession'
        })),
        'utf-8'
      ).toString('base64')
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(true)
      expect(calls[0].method).toBe('executeApprovalReply')
    })

    it('forwards approval execution reason codes from the executor', async () => {
      const { executor } = makeStubExecutor({
        executeApprovalReply: async () => ({
          executed: false,
          reasonCode: 'approvalAlreadyResolved',
          message: 'No pending approval found'
        })
      })
      const router = new BridgeActionRouter({ allowlist: seedAllowlist(), executor })
      const wire = Buffer.from(
        JSON.stringify(withReplayMeta({
          kind: 'approvalReply',
          workspaceId: 'ws-allowed',
          threadId: 't-1',
          toolCallId: 'tc-1',
          decision: 'accept'
        })),
        'utf-8'
      ).toString('base64')
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean; executed?: boolean; reasonCode?: string; message?: string }
      expect(result.accepted).toBe(true)
      expect(result.executed).toBe(false)
      expect(result.reasonCode).toBe('approvalAlreadyResolved')
      expect(result.message).toBe('No pending approval found')
    })

    it('surfaces executor message when execution declines (not-yet-wired path)', async () => {
      const { executor } = makeStubExecutor({
        executeComposerPrompt: async () => ({
          executed: false,
          message: 'composerPrompt scaffolded'
        })
      })
      const router = new BridgeActionRouter({ allowlist: seedAllowlist(), executor })
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: composerPromptWire()
      })) as { accepted: boolean; message?: string }
      // Policy says yes; executor says "not yet wired". Router reports
      // accepted=true (policy decision) with the executor's message.
      expect(result.accepted).toBe(true)
      expect(result.message).toBe('composerPrompt scaffolded')
    })

    it('does not invoke the executor when allowlist denies', async () => {
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({ allowlist: seedAllowlist(), executor })
      const wire = composerPromptWire({ workspaceId: 'ws-not-listed' })
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean }
      expect(result.accepted).toBe(false)
      expect(calls).toHaveLength(0)
    })

    it('does not invoke the executor when payload is unknown', async () => {
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({ allowlist: seedAllowlist(), executor })
      const wire = Buffer.from(
        JSON.stringify(withReplayMeta({ kind: 'futureKind', workspaceId: 'ws-allowed' })),
        'utf-8'
      ).toString('base64')
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean }
      expect(result.accepted).toBe(false)
      expect(calls).toHaveLength(0)
    })

    it('defaults to NoopActionExecutor when none injected', async () => {
      const router = new BridgeActionRouter({ allowlist: seedAllowlist() })
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: composerPromptWire()
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(true)
      // NoopActionExecutor message ends with "execution not yet wired"
      expect(result.message).toMatch(/not yet wired/i)
    })

    it('returns the created side-chat id instead of the parent id', async () => {
      const { executor } = makeStubExecutor({
        executeCreateSideChat: async () => ({
          executed: true,
          message: 'Side chat created.',
          data: {
            actionKind: 'createSideChat',
            result: { ok: true, threadId: 'side-1' }
          }
        })
      })
      const router = new BridgeActionRouter({ allowlist: seedAllowlist(), executor })
      const wire = Buffer.from(
        JSON.stringify(withReplayMeta({
          kind: 'createSideChat',
          workspaceId: 'ws-allowed',
          threadId: 'parent-1',
          provider: 'codex'
        })),
        'utf-8'
      ).toString('base64')
      const result = (await router.route('bridge.requestActionAck', {
        pairID: 'pair-1',
        payloadBase64: wire
      })) as {
        accepted: boolean
        threadId?: string
        data?: { result?: { threadId?: string } }
      }
      expect(result.accepted).toBe(true)
      expect(result.threadId).toBe('side-1')
      expect(result.data?.result?.threadId).toBe('side-1')
    })

    it('registerApnsToken bypasses workspace allowlist (system action)', async () => {
      const { executor, calls } = makeStubExecutor()
      const { ledger, records } = makeAuditLedger()
      // No allowlist provided at all — workspace-gated actions would deny,
      // but registerApnsToken is a system action and accepts.
      const router = new BridgeActionRouter({ executor, auditLedger: ledger })
      const wire = Buffer.from(
        JSON.stringify(withReplayMeta({
          kind: 'registerApnsToken',
          pairID: 'pair-1',
          deviceToken: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          env: 'production'
        })),
        'utf-8'
      ).toString('base64')
      const result = (await router.route('bridge.requestActionAck', {
        pairID: 'pair-1',
        payloadBase64: wire
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(true)
      expect(result.message).toBe('registerApnsToken done')
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('executeRegisterApnsToken')
      expect(records).toEqual([
        expect.objectContaining({
          deviceId: 'pair-1',
          capability: 'system',
          action: 'registerApnsToken',
          decision: 'allowed',
          reasonCode: 'accepted',
          metadata: expect.objectContaining({ actionKind: 'registerApnsToken' })
        })
      ])
    })

    it('registerApnsToken still bypasses gating even with an allowlist present', async () => {
      const { executor } = makeStubExecutor()
      const router = new BridgeActionRouter({ allowlist: seedAllowlist(), executor })
      const wire = Buffer.from(
        JSON.stringify(withReplayMeta({
          kind: 'registerApnsToken',
          pairID: 'unaffiliated-pair',
          deviceToken: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          env: 'sandbox'
        })),
        'utf-8'
      ).toString('base64')
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean }
      expect(result.accepted).toBe(true)
    })

    it('setYoloMode requires a workspace allowlist entry before dispatch', async () => {
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({ allowlist: seedAllowlist(), executor })
      const wire = Buffer.from(
        JSON.stringify(withReplayMeta({
          kind: 'setYoloMode',
          workspaceId: 'ws-allowed',
          enabled: true
        })),
        'utf-8'
      ).toString('base64')
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean; message?: string; executed?: boolean }
      expect(result.accepted).toBe(true)
      expect(result.executed).toBe(true)
      expect(result.message).toBe('setYoloMode done')
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('executeSetYoloMode')
    })

    it('setYoloMode is denied without a workspace allowlist entry', async () => {
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({ allowlist: seedAllowlist(), executor })
      const wire = Buffer.from(
        JSON.stringify(withReplayMeta({
          kind: 'setYoloMode',
          workspaceId: 'ws-not-listed',
          enabled: true
        })),
        'utf-8'
      ).toString('base64')
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(false)
      expect(result.message).toMatch(/not on the remote allowlist/i)
      expect(calls).toHaveLength(0)
    })

    it('dispatches setThreadTitle to executor.executeSetThreadTitle', async () => {
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({ allowlist: seedAllowlist(), executor })
      const wire = Buffer.from(
        JSON.stringify(withReplayMeta({
          kind: 'setThreadTitle',
          workspaceId: 'ws-allowed',
          threadId: 'thread-1',
          title: 'Renamed from iOS'
        })),
        'utf-8'
      ).toString('base64')
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(true)
      expect(result.message).toBe('setThreadTitle done')
      expect(calls[0].method).toBe('executeSetThreadTitle')
    })

    it('dispatches setChatKind to executor.executeSetChatKind', async () => {
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({ allowlist: seedAllowlist(), executor })
      const wire = Buffer.from(
        JSON.stringify(withReplayMeta({
          kind: 'setChatKind',
          workspaceId: 'ws-allowed',
          threadId: 'thread-1',
          targetKind: 'ensemble',
          seedParticipant: {
            id: 'seed-1',
            provider: 'claude',
            enabled: true,
            role: 'Claude',
            instructions: '',
            order: 1
          }
        })),
        'utf-8'
      ).toString('base64')
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(true)
      expect(result.message).toBe('setChatKind done')
      expect(calls[0].method).toBe('executeSetChatKind')
    })

    it('dispatches togglePinChat to executor.executeTogglePinChat', async () => {
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({ allowlist: seedAllowlist(), executor })
      const wire = Buffer.from(
        JSON.stringify(withReplayMeta({
          kind: 'togglePinChat',
          workspaceId: 'ws-allowed',
          appChatId: 'chat-1',
          pinned: true
        })),
        'utf-8'
      ).toString('base64')
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(true)
      expect(result.message).toBe('togglePinChat done')
      expect(calls[0].method).toBe('executeTogglePinChat')
    })

    it('dispatches togglePinWorkspace to executor.executeTogglePinWorkspace', async () => {
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({ allowlist: seedAllowlist(), executor })
      const wire = Buffer.from(
        JSON.stringify(withReplayMeta({
          kind: 'togglePinWorkspace',
          workspaceId: 'ws-allowed',
          pinned: false
        })),
        'utf-8'
      ).toString('base64')
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(true)
      expect(result.message).toBe('togglePinWorkspace done')
      expect(calls[0].method).toBe('executeTogglePinWorkspace')
    })
  })

  describe('ensemble action policy', () => {
    const seedAllowlist = (capabilities: Array<'monitor' | 'approve' | 'cancel' | 'steer'>) => {
      const allowlist = new RemoteWorkspaceAllowlist()
      allowlist.upsert({
        workspaceId: 'ws-ensemble',
        path: '/ensemble',
        mode: 'read-write',
        capabilities,
        allowedProviders: ['gemini'],
        allowedApprovalModes: ['default']
      })
      return allowlist
    }

    const encodeAction = (action: Record<string, unknown>) =>
      Buffer.from(
        JSON.stringify(withReplayMeta({
          workspaceId: 'ws-ensemble',
          threadId: 'ensemble-thread',
          ...action
        })),
        'utf-8'
      ).toString('base64')

    it('maps round and wakeup cancellation controls to the cancel capability', async () => {
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({
        allowlist: seedAllowlist(['monitor', 'cancel']),
        executor
      })
      const cases = [
        {
          action: { kind: 'ensembleCancelRound', roundId: 'round-1', message: 'stop' },
          method: 'executeEnsembleCancelRound',
          descriptor: { roundId: 'round-1' }
        },
        {
          action: { kind: 'ensembleCancelWakeup', wakeupId: 'wakeup-1', message: 'cancel' },
          method: 'executeEnsembleCancelWakeup',
          descriptor: { wakeupId: 'wakeup-1' }
        }
      ]

      for (const testCase of cases) {
        const result = (await router.route('bridge.requestActionAck', {
          pairID: 'pair-1',
          payloadBase64: encodeAction(testCase.action)
        })) as {
          accepted: boolean
          reasonCode?: string
          actionKind?: string
          workspaceId?: string
          threadId?: string
          roundId?: string
          wakeupId?: string
        }
        expect(result.accepted).toBe(true)
        expect(result.reasonCode).toBe('accepted')
        expect(result.actionKind).toBe(testCase.action.kind)
        expect(result.workspaceId).toBe('ws-ensemble')
        expect(result.threadId).toBe('ensemble-thread')
        expect(result).toMatchObject(testCase.descriptor)
      }

      expect(calls.map((call) => call.method)).toEqual([
        'executeEnsembleCancelRound',
        'executeEnsembleCancelWakeup'
      ])
    })

    it('denies cancel controls when only steer capability is granted', async () => {
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({
        allowlist: seedAllowlist(['monitor', 'steer']),
        executor
      })
      for (const action of [
        { kind: 'ensembleCancelRound', roundId: 'round-1' },
        { kind: 'ensembleCancelWakeup', wakeupId: 'wakeup-1' }
      ]) {
        const result = (await router.route('bridge.requestActionAck', {
          payloadBase64: encodeAction(action)
        })) as { accepted: boolean; reasonCode?: string; message?: string }
        expect(result.accepted).toBe(false)
        expect(result.reasonCode).toBe('capabilityDenied')
        expect(result.message).toMatch(/capability "cancel"/i)
      }
      expect(calls).toHaveLength(0)
    })

    it('maps skip, wake-now, queue, and steer controls to the steer capability', async () => {
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({
        allowlist: seedAllowlist(['monitor', 'steer']),
        executor
      })
      const cases = [
        {
          action: {
            kind: 'ensembleSkipActiveParticipant',
            roundId: 'round-1',
            participantId: 'participant-1',
            message: 'skip'
          },
          method: 'executeEnsembleSkipActiveParticipant',
          descriptor: { roundId: 'round-1', participantId: 'participant-1' }
        },
        {
          action: { kind: 'ensembleWakeNow', wakeupId: 'wakeup-1', message: 'wake' },
          method: 'executeEnsembleWakeNow',
          descriptor: { wakeupId: 'wakeup-1' }
        },
        {
          action: { kind: 'ensembleQueuePrompt', text: 'continue with the next task' },
          method: 'executeEnsembleQueuePrompt',
          descriptor: {}
        },
        {
          action: { kind: 'ensembleSteer', text: 'focus on failing tests' },
          method: 'executeEnsembleSteer',
          descriptor: {}
        }
      ]

      for (const testCase of cases) {
        const result = (await router.route('bridge.requestActionAck', {
          pairID: 'pair-1',
          payloadBase64: encodeAction(testCase.action)
        })) as {
          accepted: boolean
          reasonCode?: string
          actionKind?: string
          workspaceId?: string
          threadId?: string
          roundId?: string
          participantId?: string
          wakeupId?: string
        }
        expect(result.accepted).toBe(true)
        expect(result.reasonCode).toBe('accepted')
        expect(result.actionKind).toBe(testCase.action.kind)
        expect(result.workspaceId).toBe('ws-ensemble')
        expect(result.threadId).toBe('ensemble-thread')
        expect(result).toMatchObject(testCase.descriptor)
      }

      expect(calls.map((call) => call.method)).toEqual([
        'executeEnsembleSkipActiveParticipant',
        'executeEnsembleWakeNow',
        'executeEnsembleQueuePrompt',
        'executeEnsembleSteer'
      ])
    })

    it('denies steer controls when only cancel capability is granted', async () => {
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({
        allowlist: seedAllowlist(['monitor', 'cancel']),
        executor
      })
      for (const action of [
        { kind: 'ensembleSkipActiveParticipant', participantId: 'participant-1' },
        { kind: 'ensembleWakeNow', wakeupId: 'wakeup-1' },
        { kind: 'ensembleQueuePrompt', text: 'queue this' },
        { kind: 'ensembleSteer', text: 'steer this' }
      ]) {
        const result = (await router.route('bridge.requestActionAck', {
          payloadBase64: encodeAction(action)
        })) as { accepted: boolean; reasonCode?: string; message?: string }
        expect(result.accepted).toBe(false)
        expect(result.reasonCode).toBe('capabilityDenied')
        expect(result.message).toMatch(/capability "steer"/i)
      }
      expect(calls).toHaveLength(0)
    })
  })

  describe('read-only mode enforcement (Phase C-late slice)', () => {
    /** Allowlist with one read-only entry for ws-readonly. */
    const seedReadOnly = () => {
      const allowlist = new RemoteWorkspaceAllowlist()
      allowlist.upsert({
        workspaceId: 'ws-readonly',
        path: '/a',
        mode: 'read-only',
        allowedProviders: ['gemini', 'codex'],
        allowedApprovalModes: ['default', 'plan']
      })
      allowlist.upsert({
        workspaceId: 'ws-readwrite',
        path: '/b',
        mode: 'read-write',
        allowedProviders: ['gemini', 'codex'],
        allowedApprovalModes: ['default', 'plan']
      })
      return allowlist
    }

    const encodeAction = (action: Record<string, unknown>) =>
      Buffer.from(JSON.stringify(withReplayMeta(action)), 'utf-8').toString('base64')

    it('denies prepareStartTurn against read-only workspace via startTurn capability', async () => {
      const router = new BridgeActionRouter({ allowlist: seedReadOnly() })
      const result = (await router.route('bridge.requestPrepareStartTurnAck', {
        pairID: 'pair-1',
        workspaceID: 'ws-readonly',
        threadID: 't-1'
      })) as {
        accepted: boolean
        reasonCode?: string
        actionKind?: string
        workspaceId?: string
        threadId?: string
        message?: string
      }
      expect(result.accepted).toBe(false)
      expect(result.reasonCode).toBe('capabilityDenied')
      expect(result.actionKind).toBe('prepareStartTurn')
      expect(result.workspaceId).toBe('ws-readonly')
      expect(result.threadId).toBe('t-1')
      expect(result.message).toMatch(/capability "startTurn"/i)
    })

    it('denies composerPrompt against read-only workspace', async () => {
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({ allowlist: seedReadOnly(), executor })
      const wire = encodeAction({
        kind: 'composerPrompt',
        workspaceId: 'ws-readonly',
        threadId: 't-1',
        provider: 'gemini',
        text: 'hi'
      })
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean; message?: string; reasonCode?: string }
      expect(result.accepted).toBe(false)
      expect(result.reasonCode).toBe('capabilityDenied')
      expect(result.message).toMatch(/capability "startTurn"/i)
      // Executor must NOT be invoked when policy denies.
      expect(calls).toHaveLength(0)
    })

    it('denies cancelRun against read-only workspace', async () => {
      const router = new BridgeActionRouter({ allowlist: seedReadOnly() })
      const wire = encodeAction({
        kind: 'cancelRun',
        workspaceId: 'ws-readonly',
        threadId: 't-1',
        provider: 'gemini',
        runId: 'r-1'
      })
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(false)
      expect(result.message).toMatch(/capability "cancel"/i)
    })

    it('denies questionReply against read-only workspace', async () => {
      const router = new BridgeActionRouter({ allowlist: seedReadOnly() })
      const wire = encodeAction({
        kind: 'questionReply',
        workspaceId: 'ws-readonly',
        threadId: 't-1',
        promptId: 'q-1',
        answer: 'yes'
      })
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(false)
      expect(result.message).toMatch(/capability "answer"/i)
    })

    it('denies pin changes against read-only workspace', async () => {
      const router = new BridgeActionRouter({ allowlist: seedReadOnly() })
      const wire = encodeAction({
        kind: 'togglePinChat',
        workspaceId: 'ws-readonly',
        appChatId: 'chat-1',
        pinned: true
      })
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(false)
      expect(result.message).toMatch(/capability "pin"/i)
    })

    it('denies yolo changes when explicit capabilities omit yolo', async () => {
      const allowlist = new RemoteWorkspaceAllowlist()
      allowlist.upsert({
        workspaceId: 'ws-custom',
        path: '/c',
        mode: 'read-write',
        capabilities: ['monitor', 'approve', 'startTurn'],
        allowedProviders: ['gemini'],
        allowedApprovalModes: ['default']
      })
      const router = new BridgeActionRouter({ allowlist })
      const wire = encodeAction({
        kind: 'setYoloMode',
        workspaceId: 'ws-custom',
        enabled: true
      })
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean; reasonCode?: string; message?: string }
      expect(result.accepted).toBe(false)
      expect(result.reasonCode).toBe('capabilityDenied')
      expect(result.message).toMatch(/capability "yolo"/i)
    })

    it('accepts approvalReply against read-only workspace (responding to desktop-initiated prompt)', async () => {
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({ allowlist: seedReadOnly(), executor })
      const wire = encodeAction({
        kind: 'approvalReply',
        workspaceId: 'ws-readonly',
        threadId: 't-1',
        toolCallId: 'tc-1',
        decision: 'accept'
      })
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean }
      expect(result.accepted).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('executeApprovalReply')
    })

    it('accepts questionReject against read-only workspace (declining is not mutating)', async () => {
      const router = new BridgeActionRouter({ allowlist: seedReadOnly() })
      const wire = encodeAction({
        kind: 'questionReject',
        workspaceId: 'ws-readonly',
        threadId: 't-1',
        promptId: 'q-1'
      })
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean }
      expect(result.accepted).toBe(true)
    })

    it('accepts threadMediaFetch against read-only workspace via monitor capability', async () => {
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({ allowlist: seedReadOnly(), executor })
      const wire = encodeAction({
        kind: 'threadMediaFetch',
        workspaceId: 'ws-readonly',
        threadId: 't-1',
        rowId: 'm7',
        mediaId: 'media-1'
      })
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(true)
      expect(result.message).toBe('threadMediaFetch done')
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('executeThreadMediaFetch')
    })

    it('still accepts composerPrompt against read-write workspace (regression guard)', async () => {
      const router = new BridgeActionRouter({ allowlist: seedReadOnly() })
      const wire = encodeAction({
        kind: 'composerPrompt',
        workspaceId: 'ws-readwrite',
        threadId: 't-1',
        provider: 'gemini',
        text: 'hi'
      })
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean }
      expect(result.accepted).toBe(true)
    })

    it('still denies pin and yolo against default read-write workspaces', async () => {
      const router = new BridgeActionRouter({ allowlist: seedReadOnly() })
      for (const action of [
        {
          kind: 'togglePinWorkspace',
          workspaceId: 'ws-readwrite',
          pinned: true
        },
        {
          kind: 'setYoloMode',
          workspaceId: 'ws-readwrite',
          enabled: true
        }
      ]) {
        const result = (await router.route('bridge.requestActionAck', {
          payloadBase64: encodeAction(action)
        })) as { accepted: boolean; reasonCode?: string; message?: string }
        expect(result.accepted).toBe(false)
        expect(result.reasonCode).toBe('capabilityDenied')
        expect(result.message).toMatch(/admin/i)
      }
    })

    it('accepts pin and yolo only when explicit admin capabilities are present', async () => {
      const { executor, calls } = makeStubExecutor()
      const allowlist = new RemoteWorkspaceAllowlist()
      allowlist.upsert({
        workspaceId: 'ws-admin',
        path: '/admin',
        mode: 'read-write',
        capabilities: ['monitor', 'approve', 'pin', 'yolo'],
        allowedProviders: ['gemini'],
        allowedApprovalModes: ['default']
      })
      const router = new BridgeActionRouter({ allowlist, executor })
      const pinResult = (await router.route('bridge.requestActionAck', {
        payloadBase64: encodeAction({
          kind: 'togglePinWorkspace',
          workspaceId: 'ws-admin',
          pinned: true
        })
      })) as { accepted: boolean; reasonCode?: string }
      const yoloResult = (await router.route('bridge.requestActionAck', {
        payloadBase64: encodeAction({
          kind: 'setYoloMode',
          workspaceId: 'ws-admin',
          enabled: true
        })
      })) as { accepted: boolean; reasonCode?: string }

      expect(pinResult).toMatchObject({ accepted: true, reasonCode: 'accepted' })
      expect(yoloResult).toMatchObject({ accepted: true, reasonCode: 'accepted' })
      expect(calls.map((call) => call.method)).toEqual([
        'executeTogglePinWorkspace',
        'executeSetYoloMode'
      ])
    })

    it('permissive-dev mode bypasses read-only enforcement', async () => {
      const router = new BridgeActionRouter({
        allowlist: seedReadOnly(),
        permissiveDev: true
      })
      const wire = encodeAction({
        kind: 'composerPrompt',
        workspaceId: 'ws-readonly',
        threadId: 't-1',
        provider: 'gemini',
        text: 'hi'
      })
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean; message?: string }
      expect(result.accepted).toBe(true)
      expect(result.message).toMatch(/permissive-dev/i)
    })

    it('read-only does not affect registerApnsToken (system action bypasses workspace gating entirely)', async () => {
      const router = new BridgeActionRouter({ allowlist: seedReadOnly() })
      const wire = encodeAction({
        kind: 'registerApnsToken',
        pairID: 'pair-1',
        deviceToken: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        env: 'production'
      })
      const result = (await router.route('bridge.requestActionAck', {
        payloadBase64: wire
      })) as { accepted: boolean }
      expect(result.accepted).toBe(true)
    })
  })

  describe('ownership validation seams', () => {
    const seedAllowlist = () => {
      const allowlist = new RemoteWorkspaceAllowlist()
      allowlist.upsert({
        workspaceId: 'ws-allowed',
        path: '/a',
        mode: 'read-write',
        allowedProviders: ['gemini'],
        allowedApprovalModes: ['default']
      })
      return allowlist
    }

    const encodeAction = (action: Record<string, unknown>) =>
      Buffer.from(JSON.stringify(withReplayMeta(action)), 'utf-8').toString('base64')

    it('denies action execution when ownership validator rejects target ids', async () => {
      const { executor, calls } = makeStubExecutor()
      const validateActionOwnership = vi.fn(() => ({
        allowed: false as const,
        reason: 'thread does not belong to workspace'
      }))
      const router = new BridgeActionRouter({
        allowlist: seedAllowlist(),
        executor,
        ownershipValidator: { validateActionOwnership }
      })
      const wire = encodeAction({
        kind: 'cancelRun',
        workspaceId: 'ws-allowed',
        threadId: 't-wrong',
        provider: 'gemini',
        runId: 'run-1',
        actionId: 'cancel-1'
      })

      const result = (await router.route('bridge.requestActionAck', {
        pairID: 'pair-1',
        payloadBase64: wire
      })) as { accepted: boolean; reasonCode?: string; runId?: string; actionId?: string }

      expect(result.accepted).toBe(false)
      expect(result.reasonCode).toBe('ownershipDenied')
      expect(result.runId).toBe('run-1')
      expect(result.actionId).toBe('cancel-1')
      expect(validateActionOwnership).toHaveBeenCalledWith(
        expect.objectContaining({
          pairID: 'pair-1',
          workspaceId: 'ws-allowed',
          threadId: 't-wrong',
          runId: 'run-1',
          actionId: 'cancel-1'
        })
      )
      expect(calls).toHaveLength(0)
    })

    it('denies prepareStartTurn when ownership validator rejects the thread', async () => {
      const validatePrepareStartTurnOwnership = vi.fn(() => ({
        allowed: false as const,
        reason: 'thread is archived'
      }))
      const router = new BridgeActionRouter({
        allowlist: seedAllowlist(),
        ownershipValidator: { validatePrepareStartTurnOwnership }
      })

      const result = (await router.route('bridge.requestPrepareStartTurnAck', {
        pairID: 'pair-1',
        workspaceID: 'ws-allowed',
        threadID: 'thread-archived',
        provider: 'gemini',
        approvalMode: 'default'
      })) as { accepted: boolean; reasonCode?: string; message?: string; threadId?: string }

      expect(result.accepted).toBe(false)
      expect(result.reasonCode).toBe('ownershipDenied')
      expect(result.threadId).toBe('thread-archived')
      expect(result.message).toMatch(/thread is archived/i)
      expect(validatePrepareStartTurnOwnership).toHaveBeenCalledWith(
        expect.objectContaining({
          pairID: 'pair-1',
          workspaceId: 'ws-allowed',
          threadId: 'thread-archived',
          provider: 'gemini',
          approvalMode: 'default'
        })
      )
    })
  })

  describe('workspace file action policy', () => {
    const encodeFileAction = (action: Record<string, unknown>) =>
      Buffer.from(
        JSON.stringify(withReplayMeta({
          workspaceId: 'ws-files',
          ...action
        })),
        'utf-8'
      ).toString('base64')

    it('allows file list/read/write and workspace diff for default read-write workspaces', async () => {
      const allowlist = new RemoteWorkspaceAllowlist()
      allowlist.upsert({
        workspaceId: 'ws-files',
        path: '/files',
        mode: 'read-write',
        allowedProviders: ['gemini'],
        allowedApprovalModes: ['default']
      })
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({ allowlist, executor })

      const actions = [
        { kind: 'workspaceFileList', method: 'executeWorkspaceFileList' },
        { kind: 'workspaceFileRead', path: 'README.md', method: 'executeWorkspaceFileRead' },
        {
          kind: 'workspaceFileWrite',
          path: 'README.md',
          content: 'hello',
          baseEtag: 'sha256:abc',
          method: 'executeWorkspaceFileWrite'
        },
        {
          kind: 'workspaceFileDelete',
          path: 'README.md',
          baseEtag: 'sha256:def',
          method: 'executeWorkspaceFileDelete'
        },
        { kind: 'workspaceDiff', method: 'executeWorkspaceDiff' }
      ]

      for (const action of actions) {
        const { method, ...payload } = action
        const result = (await router.route('bridge.requestActionAck', {
          pairID: `pair-${method}`,
          payloadBase64: encodeFileAction(payload)
        })) as { accepted: boolean; reasonCode?: string; message?: string }
        expect(result.accepted).toBe(true)
        expect(result.reasonCode).toBe('accepted')
        expect(calls[calls.length - 1]?.method).toBe(method)
      }
    })

    it('denies file writes when the fileWrite capability is absent', async () => {
      const allowlist = new RemoteWorkspaceAllowlist()
      allowlist.upsert({
        workspaceId: 'ws-files',
        path: '/files',
        mode: 'read-write',
        capabilities: ['monitor', 'fileBrowse', 'fileRead'],
        allowedProviders: ['gemini'],
        allowedApprovalModes: ['default']
      })
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({ allowlist, executor })

      const result = (await router.route('bridge.requestActionAck', {
        pairID: 'pair-files-deny',
        payloadBase64: encodeFileAction({
          kind: 'workspaceFileDelete',
          path: 'README.md',
          baseEtag: 'sha256:def',
        })
      })) as { accepted: boolean; reasonCode?: string; message?: string }

      expect(result.accepted).toBe(false)
      expect(result.reasonCode).toBe('capabilityDenied')
      expect(result.message).toMatch(/capability "fileWrite"/i)
      expect(calls).toHaveLength(0)
    })

    it('denies workspace diffs when the diffReview capability is absent', async () => {
      const allowlist = new RemoteWorkspaceAllowlist()
      allowlist.upsert({
        workspaceId: 'ws-files',
        path: '/files',
        mode: 'read-write',
        capabilities: ['monitor', 'fileBrowse', 'fileRead'],
        allowedProviders: ['gemini'],
        allowedApprovalModes: ['default']
      })
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({ allowlist, executor })

      const result = (await router.route('bridge.requestActionAck', {
        pairID: 'pair-diff-deny',
        payloadBase64: encodeFileAction({ kind: 'workspaceDiff' })
      })) as { accepted: boolean; reasonCode?: string; message?: string }

      expect(result.accepted).toBe(false)
      expect(result.reasonCode).toBe('capabilityDenied')
      expect(result.message).toMatch(/capability "diffReview"/i)
      expect(calls).toHaveLength(0)
    })
  })

  describe('git workflow action policy', () => {
    const encodeGitAction = (action: Record<string, unknown>) =>
      Buffer.from(
        JSON.stringify(
          withReplayMeta({
            workspaceId: 'ws-git',
            ...action
          })
        ),
        'utf-8'
      ).toString('base64')

    const upsertGitWorkspace = (
      allowlist: RemoteWorkspaceAllowlist,
      capabilities?: string[]
    ): void => {
      allowlist.upsert({
        workspaceId: 'ws-git',
        path: '/repo',
        mode: 'read-write',
        ...(capabilities ? { capabilities: capabilities as never } : {}),
        allowedProviders: ['gemini'],
        allowedApprovalModes: ['default']
      })
    }

    it('dispatches every git action kind to its executor method', async () => {
      const allowlist = new RemoteWorkspaceAllowlist()
      upsertGitWorkspace(allowlist, [
        'monitor',
        'diffReview',
        'fileBrowse',
        'fileRead',
        'fileWrite',
        'externalPublish'
      ])
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({ allowlist, executor })

      const actions = [
        { kind: 'gitSnapshot', method: 'executeGitSnapshot' },
        { kind: 'gitStageAll', method: 'executeGitStageAll' },
        { kind: 'gitStagePaths', paths: ['README.md'], method: 'executeGitStagePaths' },
        { kind: 'gitUnstagePaths', paths: ['README.md'], method: 'executeGitUnstagePaths' },
        { kind: 'gitCommit', message: 'phone commit', method: 'executeGitCommit' },
        { kind: 'gitPush', setUpstream: true, method: 'executeGitPush' },
        { kind: 'githubPrStatus', method: 'executeGithubPrStatus' },
        { kind: 'githubPrReadiness', method: 'executeGithubPrReadiness' },
        { kind: 'githubCreatePr', title: 'Phone PR', method: 'executeGithubCreatePr' }
      ]

      for (const action of actions) {
        const { method, ...payload } = action
        const result = (await router.route('bridge.requestActionAck', {
          pairID: `pair-${method}`,
          payloadBase64: encodeGitAction(payload)
        })) as { accepted: boolean; reasonCode?: string }
        expect(result.accepted).toBe(true)
        expect(result.reasonCode).toBe('accepted')
        expect(calls[calls.length - 1]?.method).toBe(method)
      }
    })

    it('denies git mutations when the fileWrite capability is absent', async () => {
      const allowlist = new RemoteWorkspaceAllowlist()
      upsertGitWorkspace(allowlist, ['monitor', 'diffReview', 'fileBrowse', 'fileRead'])
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({ allowlist, executor })

      const mutations = [
        { kind: 'gitStageAll' },
        { kind: 'gitStagePaths', paths: ['README.md'] },
        { kind: 'gitUnstagePaths', paths: ['README.md'] },
        { kind: 'gitCommit', message: 'phone commit' }
      ]
      for (const payload of mutations) {
        const result = (await router.route('bridge.requestActionAck', {
          pairID: `pair-git-deny-${payload.kind}`,
          payloadBase64: encodeGitAction(payload)
        })) as { accepted: boolean; reasonCode?: string; message?: string }
        expect(result.accepted).toBe(false)
        expect(result.reasonCode).toBe('capabilityDenied')
        expect(result.message).toMatch(/capability "fileWrite"/i)
      }
      expect(calls).toHaveLength(0)
    })

    it('denies external git publishing when externalPublish is absent', async () => {
      const allowlist = new RemoteWorkspaceAllowlist()
      upsertGitWorkspace(allowlist, [
        'monitor',
        'diffReview',
        'fileBrowse',
        'fileRead',
        'fileWrite'
      ])
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({ allowlist, executor })

      for (const payload of [{ kind: 'gitPush' }, { kind: 'githubCreatePr' }]) {
        const result = (await router.route('bridge.requestActionAck', {
          pairID: `pair-git-publish-deny-${payload.kind}`,
          payloadBase64: encodeGitAction(payload)
        })) as { accepted: boolean; reasonCode?: string; message?: string }
        expect(result.accepted).toBe(false)
        expect(result.reasonCode).toBe('capabilityDenied')
        expect(result.message).toMatch(/capability "externalPublish"/i)
      }
      expect(calls).toHaveLength(0)
    })

    it('audits external git publishing under the externalPublish capability', async () => {
      const allowlist = new RemoteWorkspaceAllowlist()
      upsertGitWorkspace(allowlist, [
        'monitor',
        'diffReview',
        'fileBrowse',
        'fileRead',
        'fileWrite',
        'externalPublish'
      ])
      const { executor } = makeStubExecutor()
      const { ledger, records } = makeAuditLedger()
      const router = new BridgeActionRouter({ allowlist, executor, auditLedger: ledger })

      const result = (await router.route('bridge.requestActionAck', {
        pairID: 'iphone-git',
        payloadBase64: encodeGitAction({ kind: 'gitPush', actionId: 'push-1' })
      })) as { accepted: boolean; reasonCode?: string }

      expect(result.accepted).toBe(true)
      expect(result.reasonCode).toBe('accepted')
      expect(records).toEqual([
        expect.objectContaining({
          id: 'remote-action:iphone-git:push-1:externalPublish:allowed',
          deviceId: 'iphone-git',
          capability: 'externalPublish',
          action: 'gitPush',
          decision: 'allowed'
        })
      ])
    })

    it('denies git reads when the diffReview capability is absent', async () => {
      const allowlist = new RemoteWorkspaceAllowlist()
      upsertGitWorkspace(allowlist, ['monitor', 'fileBrowse', 'fileRead', 'fileWrite'])
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({ allowlist, executor })

      for (const kind of ['gitSnapshot', 'githubPrStatus', 'githubPrReadiness']) {
        const result = (await router.route('bridge.requestActionAck', {
          pairID: `pair-git-read-deny-${kind}`,
          payloadBase64: encodeGitAction({ kind })
        })) as { accepted: boolean; reasonCode?: string; message?: string }
        expect(result.accepted).toBe(false)
        expect(result.reasonCode).toBe('capabilityDenied')
        expect(result.message).toMatch(/capability "diffReview"/i)
      }
      expect(calls).toHaveLength(0)
    })

    it('denies git actions for a non-allowlisted workspace', async () => {
      const allowlist = new RemoteWorkspaceAllowlist()
      const { executor, calls } = makeStubExecutor()
      const router = new BridgeActionRouter({ allowlist, executor })

      const result = (await router.route('bridge.requestActionAck', {
        pairID: 'pair-git-unlisted',
        payloadBase64: encodeGitAction({ kind: 'gitCommit', message: 'phone commit' })
      })) as { accepted: boolean; reasonCode?: string }
      expect(result.accepted).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  describe('unknown methods', () => {
    it('throws for an unrecognized method', async () => {
      const router = new BridgeActionRouter()
      await expect(router.route('bridge.somethingElse', {})).rejects.toThrow(/no handler/i)
    })

    it('audits unrecognized bridge methods before throwing', async () => {
      const { ledger, records } = makeAuditLedger()
      const router = new BridgeActionRouter({ auditLedger: ledger })

      await expect(
        router.route('bridge.somethingElse', { pairID: 'iphone-method' })
      ).rejects.toThrow(/no handler/i)

      expect(records).toEqual([
        expect.objectContaining({
          deviceId: 'iphone-method',
          capability: 'system',
          action: 'bridge.somethingElse',
          decision: 'denied',
          reasonCode: 'unknownAction',
          metadata: expect.objectContaining({ method: 'bridge.somethingElse' })
        })
      ])
    })
  })

  describe('fromEnvironment factory', () => {
    it('honors TASKWRAITH_BRIDGE_PERMISSIVE=1', async () => {
      const original = process.env.TASKWRAITH_BRIDGE_PERMISSIVE
      process.env.TASKWRAITH_BRIDGE_PERMISSIVE = '1'
      try {
        const router = BridgeActionRouter.fromEnvironment()
        const result = (await router.route('bridge.requestActionAck', {})) as { accepted: boolean }
        expect(result.accepted).toBe(true)
      } finally {
        if (original === undefined) {
          delete process.env.TASKWRAITH_BRIDGE_PERMISSIVE
        } else {
          process.env.TASKWRAITH_BRIDGE_PERMISSIVE = original
        }
      }
    })

    it('honors TASKWRAITH_BRIDGE_PERMISSIVE=true (string form)', async () => {
      const original = process.env.TASKWRAITH_BRIDGE_PERMISSIVE
      process.env.TASKWRAITH_BRIDGE_PERMISSIVE = 'true'
      try {
        const router = BridgeActionRouter.fromEnvironment()
        const result = (await router.route('bridge.requestActionAck', {})) as { accepted: boolean }
        expect(result.accepted).toBe(true)
      } finally {
        if (original === undefined) {
          delete process.env.TASKWRAITH_BRIDGE_PERMISSIVE
        } else {
          process.env.TASKWRAITH_BRIDGE_PERMISSIVE = original
        }
      }
    })

    it('defaults to deny when env var is absent', async () => {
      const original = process.env.TASKWRAITH_BRIDGE_PERMISSIVE
      delete process.env.TASKWRAITH_BRIDGE_PERMISSIVE
      try {
        const router = BridgeActionRouter.fromEnvironment()
        const result = (await router.route('bridge.requestActionAck', {})) as { accepted: boolean }
        expect(result.accepted).toBe(false)
      } finally {
        if (original !== undefined) {
          process.env.TASKWRAITH_BRIDGE_PERMISSIVE = original
        }
      }
    })
  })
})
