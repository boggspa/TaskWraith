import { describe, expect, it } from 'vitest'
import type { RosterEditParticipantInput } from '../EnsembleRosterMutation'
import type { EnsembleParticipant, PermissionOverrides } from '../store/types'
import {
  applySeatChangePatch,
  ensembleSeatSnapshot,
  hasSeatChangePatch,
  participantSeatChangeValue,
  participantSeatSelectionUnchanged,
  participantSeatValue,
  roundParticipantDisplayFields,
  roundParticipantStateFromParticipant,
  seatChangeSeatState
} from './EnsembleSeatChangeHelpers'

function participant(overrides: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id: 'seat-1',
    provider: 'codex',
    enabled: true,
    role: 'Worker',
    instructions: 'Implement the assigned slice.',
    order: 2,
    model: 'original-model',
    linkedProviderSessionId: 'session-1',
    promptShellVersion: 'shell-1',
    promptDynamicStateVersion: 'dynamic-1',
    taskWraithMcpProfileReceipt: {
      schemaVersion: 1,
      profileId: 'taskwraith-core-v1',
      provider: 'codex',
      providerSessionId: 'session-1',
      pinnedAt: '2026-09-05T00:00:00.000Z'
    },
    ...overrides
  }
}

describe('seat snapshots and display values', () => {
  it('records explicit false and zero values while preserving missing-field fallbacks', () => {
    expect(
      seatChangeSeatState(
        participant({
          model: undefined,
          role: '',
          order: 0,
          thinkingEnabled: false
        }),
        0
      )
    ).toEqual({
      provider: 'codex',
      model: '',
      thinkingEnabled: false,
      permissionPresetId: 'default',
      grantsCount: 0
    })
    expect(seatChangeSeatState(participant())).not.toHaveProperty('grantsCount')
  })

  it('captures stage, authority, reasoning and the configured permission tier', () => {
    expect(
      seatChangeSeatState(
        participant({
          stageRole: 'reviewer',
          reasoningEffort: 'high',
          permissionPresetId: 'read_only'
        }),
        3,
        'captain'
      )
    ).toEqual({
      provider: 'codex',
      model: 'original-model',
      role: 'Worker',
      seatNumber: 2,
      stageRole: 'reviewer',
      authority: 'captain',
      reasoningEffort: 'high',
      permissionPresetId: 'read_only',
      grantsCount: 3
    })
  })

  it('retains provider, model, role, stage and disabled-label composition', () => {
    expect(participantSeatValue(participant({ stageRole: 'worker', enabled: false }))).toBe(
      'Codex / original-model (Worker) [worker] [disabled]'
    )
    expect(participantSeatValue(participant({ model: '', role: '' }))).toBe('Codex')
  })

  it('defaults only Kimi thinking to true and retains explicit false settings', () => {
    expect(ensembleSeatSnapshot(participant({ provider: 'kimi' })).thinkingEnabled).toBe(true)
    expect(ensembleSeatSnapshot(participant())).not.toHaveProperty('thinkingEnabled')
    expect(
      ensembleSeatSnapshot(
        participant({
          provider: 'kimi',
          reasoningEffort: '',
          thinkingEnabled: false,
          fastModeEnabled: false,
          serviceTier: 'priority',
          permissionPresetId: 'read_only'
        })
      )
    ).toEqual({
      schemaVersion: 1,
      provider: 'kimi',
      model: 'original-model',
      reasoningEffort: '',
      thinkingEnabled: false,
      fastModeEnabled: false,
      serviceTier: 'priority',
      configuredPermissionPresetId: 'read_only'
    })
  })

  it('projects round fields and an independent initial snapshot without session receipts', () => {
    const seat = participant({ thinkingEnabled: false, fastModeEnabled: true })
    const state = roundParticipantStateFromParticipant(seat, 'idle')
    expect(state).toEqual({
      participantId: seat.id,
      ...roundParticipantDisplayFields(seat),
      initialSeatSnapshot: {
        schemaVersion: 1,
        provider: 'codex',
        model: 'original-model',
        thinkingEnabled: false,
        fastModeEnabled: true,
        configuredPermissionPresetId: 'default'
      },
      status: 'idle'
    })
    expect(state).not.toHaveProperty('linkedProviderSessionId')
    expect(state).not.toHaveProperty('promptShellVersion')
    seat.model = 'later-model'
    expect(state.model).toBe('original-model')
    expect(state.initialSeatSnapshot?.model).toBe('original-model')
  })

  it('uses a compact brief preview only when the visible seat selection is unchanged', () => {
    const before = participant({ instructions: 'before' })
    const after = participant({ instructions: '  new\n\t brief  ' })
    expect(participantSeatChangeValue(before, after, after)).toBe('Brief / Goal: new brief')
    expect(
      participantSeatChangeValue(
        before,
        participant({ instructions: ' ' }),
        participant({
          instructions: ' '
        })
      )
    ).toBe('Brief / Goal: (empty)')
    const long = participant({ instructions: 'x'.repeat(161) })
    expect(participantSeatChangeValue(before, long, long)).toBe(
      'Brief / Goal: ' + 'x'.repeat(157) + '...'
    )
    const modelChange = participant({ model: 'new-model', instructions: 'different brief' })
    expect(participantSeatChangeValue(before, modelChange, modelChange)).toBe(
      'Codex / new-model (Worker)'
    )
  })
})

describe('seat patch detection and equality', () => {
  it('recognizes all own patch fields, including explicit undefined values', () => {
    const fields: Array<keyof RosterEditParticipantInput> = [
      'provider',
      'enabled',
      'model',
      'runtimeProfileId',
      'geminiAuthProfileId',
      'ollamaRunProfile',
      'role',
      'instructions',
      'reasoningEffort',
      'fastModeEnabled',
      'thinkingEnabled',
      'serviceTier',
      'permissionPresetId',
      'permissionOverrides',
      'stageRole',
      'linkedProviderSessionId'
    ]
    for (const field of fields) {
      expect(hasSeatChangePatch({ [field]: undefined })).toBe(true)
    }
    expect(hasSeatChangePatch(undefined)).toBe(false)
    expect(hasSeatChangePatch(null)).toBe(false)
    expect(hasSeatChangePatch({})).toBe(false)
    expect(hasSeatChangePatch(Object.create({ model: 'inherited' }))).toBe(false)
    const unrelated: RosterEditParticipantInput = {}
    Object.assign(unrelated, { extra: true })
    expect(hasSeatChangePatch(unrelated)).toBe(false)
  })

  it('ignores session and receipt side effects when suppressing duplicate seat selections', () => {
    const before = participant()
    const after = applySeatChangePatch(before, { provider: before.provider })
    expect(after.linkedProviderSessionId).toBeNull()
    expect(after).not.toHaveProperty('promptShellVersion')
    expect(after).not.toHaveProperty('taskWraithMcpProfileReceipt')
    expect(participantSeatSelectionUnchanged(before, after)).toBe(true)
  })

  it('equates absent and empty text, absent and false booleans, and equal JSON values', () => {
    expect(
      participantSeatSelectionUnchanged(
        participant({ model: undefined }),
        participant({ model: '', fastModeEnabled: false, thinkingEnabled: false })
      )
    ).toBe(true)
    expect(
      participantSeatSelectionUnchanged(
        participant({ permissionOverrides: { approvalMode: 'default' } }),
        participant({ permissionOverrides: { approvalMode: 'default' } })
      )
    ).toBe(true)
  })

  it('detects changes to every user-facing seat field', () => {
    const patches: RosterEditParticipantInput[] = [
      { provider: 'claude' },
      { enabled: false },
      { model: 'new-model' },
      { role: 'Reviewer' },
      { instructions: 'New brief' },
      { stageRole: 'reviewer' },
      { reasoningEffort: 'high' },
      { serviceTier: 'priority' },
      { permissionPresetId: 'read_only' },
      { runtimeProfileId: 'runtime-1' },
      { geminiAuthProfileId: 'auth-1' },
      { fastModeEnabled: true },
      { thinkingEnabled: true },
      { permissionOverrides: { approvalMode: 'plan' } },
      { ollamaRunProfile: 'local_scout' }
    ]
    const before = participant()
    for (const patch of patches) {
      expect(participantSeatSelectionUnchanged(before, applySeatChangePatch(before, patch))).toBe(
        false
      )
    }
  })

  it('keeps the original stringify fallback for malformed cyclic override values', () => {
    const overrides: PermissionOverrides & { self?: unknown } = {}
    overrides.self = overrides
    expect(
      participantSeatSelectionUnchanged(
        participant({ permissionOverrides: overrides }),
        participant({ permissionOverrides: overrides })
      )
    ).toBe(true)
  })
})

describe('applySeatChangePatch', () => {
  it('returns a new seat and never mutates the target or its existing receipts', () => {
    const before = participant()
    const snapshot = structuredClone(before)
    const after = applySeatChangePatch(before, { model: 'changed' })
    expect(after).not.toBe(before)
    expect(before).toEqual(snapshot)
    expect(after.model).toBe('changed')
  })

  it('invalidates both prompt and MCP receipts for any explicit nonempty provider', () => {
    for (const provider of ['codex', 'claude'] as const) {
      const after = applySeatChangePatch(participant(), { provider })
      expect(after.provider).toBe(provider)
      expect(after.linkedProviderSessionId).toBeNull()
      expect(after).not.toHaveProperty('promptShellVersion')
      expect(after).not.toHaveProperty('promptDynamicStateVersion')
      expect(after).not.toHaveProperty('taskWraithMcpProfileReceipt')
    }
  })

  it('invalidates only prompt receipts when the model changes or is cleared', () => {
    const before = participant()
    for (const model of ['new-model', null, undefined]) {
      const after = applySeatChangePatch(before, { model })
      expect(after).not.toHaveProperty('promptShellVersion')
      expect(after).not.toHaveProperty('promptDynamicStateVersion')
      expect(after.taskWraithMcpProfileReceipt).toBe(before.taskWraithMcpProfileReceipt)
      expect(after.linkedProviderSessionId).toBe('session-1')
      if (model) expect(after.model).toBe(model)
      else expect(after).not.toHaveProperty('model')
    }
    expect(applySeatChangePatch(before, { model: before.model })).toEqual(before)
  })

  it('clears both receipt kinds only when the linked session identity changes', () => {
    const before = participant()
    for (const linkedProviderSessionId of ['session-2', null, undefined]) {
      const after = applySeatChangePatch(before, { linkedProviderSessionId })
      expect(after).not.toHaveProperty('promptShellVersion')
      expect(after).not.toHaveProperty('promptDynamicStateVersion')
      expect(after).not.toHaveProperty('taskWraithMcpProfileReceipt')
      if (linkedProviderSessionId === undefined) {
        expect(after).not.toHaveProperty('linkedProviderSessionId')
      } else {
        expect(after.linkedProviderSessionId).toBe(linkedProviderSessionId)
      }
    }
    expect(applySeatChangePatch(before, { linkedProviderSessionId: 'session-1' })).toEqual(before)
  })

  it('lets an explicit session override the provider reset without retaining invalid receipts', () => {
    const after = applySeatChangePatch(participant(), {
      provider: 'claude',
      linkedProviderSessionId: 'replacement-session'
    })
    expect(after.linkedProviderSessionId).toBe('replacement-session')
    expect(after).not.toHaveProperty('promptShellVersion')
    expect(after).not.toHaveProperty('taskWraithMcpProfileReceipt')
  })

  it('preserves receipts for non-session edits and accepts explicit false booleans', () => {
    const before = participant({ fastModeEnabled: true, thinkingEnabled: true })
    const overrides: PermissionOverrides = { approvalMode: 'plan' }
    const after = applySeatChangePatch(before, {
      enabled: false,
      role: '',
      instructions: '',
      runtimeProfileId: 'runtime-2',
      geminiAuthProfileId: 'auth-2',
      ollamaRunProfile: 'local_scout',
      reasoningEffort: 'high',
      fastModeEnabled: false,
      thinkingEnabled: false,
      serviceTier: 'priority',
      permissionPresetId: 'read_only',
      permissionOverrides: overrides,
      stageRole: 'background'
    })
    expect(after).toMatchObject({
      enabled: false,
      role: '',
      instructions: '',
      runtimeProfileId: 'runtime-2',
      geminiAuthProfileId: 'auth-2',
      ollamaRunProfile: 'local_scout',
      reasoningEffort: 'high',
      fastModeEnabled: false,
      thinkingEnabled: false,
      serviceTier: 'priority',
      permissionPresetId: 'read_only',
      stageRole: 'background',
      linkedProviderSessionId: 'session-1',
      promptShellVersion: 'shell-1',
      promptDynamicStateVersion: 'dynamic-1'
    })
    expect(after.permissionOverrides).toBe(overrides)
    expect(after.taskWraithMcpProfileReceipt).toBe(before.taskWraithMcpProfileReceipt)
  })

  it('removes cleared optional settings, retains null auth IDs and ignores empty preset/provider', () => {
    const before = participant({
      runtimeProfileId: 'runtime-1',
      geminiAuthProfileId: 'auth-1',
      ollamaRunProfile: 'local_scout',
      reasoningEffort: 'high',
      serviceTier: 'priority',
      permissionPresetId: 'read_only',
      permissionOverrides: { approvalMode: 'plan' },
      stageRole: 'worker'
    })
    const after = applySeatChangePatch(before, {
      runtimeProfileId: null,
      geminiAuthProfileId: null,
      ollamaRunProfile: null,
      reasoningEffort: null,
      serviceTier: null,
      permissionOverrides: null,
      stageRole: null,
      provider: '',
      permissionPresetId: ''
    })
    for (const field of [
      'runtimeProfileId',
      'ollamaRunProfile',
      'reasoningEffort',
      'serviceTier',
      'permissionOverrides',
      'stageRole'
    ]) {
      expect(after).not.toHaveProperty(field)
    }
    expect(after.geminiAuthProfileId).toBeNull()
    expect(after.provider).toBe(before.provider)
    expect(after.permissionPresetId).toBe(before.permissionPresetId)
    expect(after.promptShellVersion).toBe(before.promptShellVersion)
    expect(applySeatChangePatch(before, { geminiAuthProfileId: undefined })).not.toHaveProperty(
      'geminiAuthProfileId'
    )
  })

  it('accepts the four existing stage roles and removes an invalid stage', () => {
    for (const stageRole of ['scout', 'worker', 'reviewer', 'background']) {
      expect(applySeatChangePatch(participant(), { stageRole }).stageRole).toBe(stageRole)
    }
    expect(
      applySeatChangePatch(participant({ stageRole: 'worker' }), { stageRole: 'invalid' })
    ).not.toHaveProperty('stageRole')
  })

  it('ignores inherited changes and rejects incorrectly typed boolean or text fields', () => {
    const before = participant({ fastModeEnabled: true, thinkingEnabled: true })
    expect(
      applySeatChangePatch(before, Object.create({ provider: 'claude', model: 'inherited' }))
    ).toEqual(before)
    const invalid = {
      provider: 42,
      enabled: 'false',
      role: 42,
      instructions: null,
      fastModeEnabled: 0,
      thinkingEnabled: 0
    } as unknown as RosterEditParticipantInput
    expect(applySeatChangePatch(before, invalid)).toEqual(before)
  })
})
