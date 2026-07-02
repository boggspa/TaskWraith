import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnsembleConfig, ExternalPathGrant } from '../../../main/store/types'

// Install a Map-backed fake `window`/`localStorage` BEFORE the module under
// test imports — the storage-backed primitives use `window.localStorage` and
// the cross-window refresh bridge binds a `storage` listener lazily on first
// subscribe. `vi.hoisted` runs before the import below. The node test env has
// no DOM, so we provide the minimal surface the module touches.
const fake = vi.hoisted(() => {
  const store = new Map<string, string>()
  const listeners: Record<string, Array<(event: unknown) => void>> = {}
  const localStorage = {
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    }
  }
  const fakeWindow = {
    localStorage,
    addEventListener: (type: string, cb: (event: unknown) => void) => {
      ;(listeners[type] ||= []).push(cb)
    },
    removeEventListener: (type: string, cb: (event: unknown) => void) => {
      listeners[type] = (listeners[type] || []).filter((fn) => fn !== cb)
    }
  }
  ;(globalThis as unknown as { window: unknown }).window = fakeWindow
  return { store, listeners, localStorage }
})

import {
  buildEnsembleRosterPresetFromConfig,
  createEmptyEnsembleRosterPreset,
  duplicateEnsembleRosterPreset,
  getEnsembleRosterPreset,
  listEnsembleRosterPresets,
  materializeParticipantsFromPreset,
  materializeParticipantsFromPresetWithBossman,
  snapshotParticipantsForPreset,
  subscribeEnsembleRosterPresets,
  upsertEnsembleRosterPreset,
  MIN_ROSTER_PRESET_PARTICIPANTS
} from './ensembleRosterPresets'
import { buildProviderChangeParticipantPatch } from './ensembleProviderDefaults'

const STORAGE_KEY = 'taskwraith-ensemble-roster-presets'

beforeEach(() => {
  fake.store.clear()
})

function sampleEnsemble(): EnsembleConfig {
  return {
    enabled: true,
    maxParticipants: 4,
    orchestrationMode: 'continuous',
    maxContinuationHops: 12,
    concurrentModeEnabled: true,
    participants: [
      {
        id: 'ensemble-participant-1',
        provider: 'claude',
        enabled: true,
        role: 'Planner',
        instructions: 'Plan the work.',
        order: 2,
        model: 'claude-sonnet-4-7',
        linkedProviderSessionId: 'session-abc'
      },
      {
        id: 'ensemble-participant-2',
        provider: 'codex',
        enabled: false,
        role: 'Builder',
        instructions: 'Implement the plan.',
        order: 1,
        model: 'gpt-5.4-medium'
      }
    ]
  }
}

function grant(path: string): ExternalPathGrant {
  return {
    id: `grant-${path}`,
    provider: 'codex',
    path,
    kind: 'directory',
    access: 'write',
    duration: 'workspace',
    createdAt: '2026-06-01T00:00:00.000Z'
  }
}

function ensembleWithGrants(): EnsembleConfig {
  return {
    enabled: true,
    maxParticipants: 4,
    orchestrationMode: 'turn_bound',
    participants: [
      {
        id: 'ensemble-participant-1',
        provider: 'codex',
        enabled: true,
        role: 'Builder',
        instructions: 'Build it.',
        order: 1,
        model: 'gpt-5.5',
        reasoningEffort: 'high',
        fastModeEnabled: true,
        serviceTier: 'fast',
        runtimeProfileId: 'approved_patcher',
        permissionPresetId: 'custom',
        permissionOverrides: {
          approvalMode: 'auto_edit',
          agenticServices: { fileChanges: 'allow', shellCommands: 'workspace' },
          networkAccess: 'deny',
          externalPathGrants: [grant('/tmp/a'), grant('/tmp/b')]
        }
      },
      {
        id: 'ensemble-participant-2',
        provider: 'claude',
        enabled: true,
        role: 'Reviewer',
        instructions: 'Review it.',
        order: 2
      }
    ]
  }
}

describe('ensembleRosterPresets — capture + materialize', () => {
  it('captures roster order and settings without runtime session ids', () => {
    const preset = buildEnsembleRosterPresetFromConfig('Review panel', sampleEnsemble(), 1_700_000_000_000)
    expect(preset.name).toBe('Review panel')
    expect(preset.orchestrationMode).toBe('continuous')
    expect(preset.maxContinuationHops).toBe(12)
    expect(preset.fanoutPolicy).toBe('read_only')
    expect(preset.concurrentModeEnabled).toBe(true)
    expect(preset.participants.map((participant) => participant.role)).toEqual(['Builder', 'Planner'])
    expect(preset.participants[0]).toMatchObject({
      provider: 'codex',
      enabled: false,
      model: 'gpt-5.4-medium'
    })
    expect(preset.participants[0]).not.toHaveProperty('linkedProviderSessionId')
  })

  it('captures explicit fan-out policy over the legacy boolean', () => {
    const preset = buildEnsembleRosterPresetFromConfig(
      'Writer panel',
      {
        ...sampleEnsemble(),
        fanoutPolicy: 'locked_writers_with_boss',
        concurrentModeEnabled: false
      },
      1_700_000_000_000
    )
    expect(preset.fanoutPolicy).toBe('locked_writers_with_boss')
    expect(preset.concurrentModeEnabled).toBe(false)
  })

  it('materializes fresh participant ids while preserving order', () => {
    const preset = buildEnsembleRosterPresetFromConfig('Review panel', sampleEnsemble(), 1_700_000_000_000)
    const participants = materializeParticipantsFromPreset(preset.participants)
    expect(participants).toHaveLength(2)
    expect(participants.map((participant) => participant.role)).toEqual(['Builder', 'Planner'])
    expect(participants.map((participant) => participant.order)).toEqual([1, 2])
    expect(participants.every((participant) => participant.id.startsWith('ensemble-participant-'))).toBe(
      true
    )
    expect(participants.every((participant) => participant.linkedProviderSessionId === null)).toBe(
      true
    )
  })

  it('round-trips exactly one Boss marker through snapshot materialization', () => {
    const preset = buildEnsembleRosterPresetFromConfig(
      'Boss panel',
      {
        ...sampleEnsemble(),
        bossmanParticipantId: 'ensemble-participant-1',
        secondInCommandParticipantId: 'ensemble-participant-2'
      },
      1_700_000_000_000
    )
    expect(preset.participants.map((participant) => participant.isBossman === true)).toEqual([
      false,
      true
    ])
    expect(preset.participants.map((participant) => participant.isSecondInCommand === true)).toEqual([
      true,
      false
    ])
    const materialized = materializeParticipantsFromPresetWithBossman(preset.participants)
    expect(materialized.bossmanParticipantId).toBe(materialized.participants[1].id)
    expect(materialized.secondInCommandParticipantId).toBe(materialized.participants[0].id)
    const resnapshot = snapshotParticipantsForPreset(
      materialized.participants,
      materialized.bossmanParticipantId,
      materialized.secondInCommandParticipantId
    )
    expect(resnapshot.filter((participant) => participant.isBossman === true)).toHaveLength(1)
    expect(resnapshot.filter((participant) => participant.isSecondInCommand === true)).toHaveLength(1)
    expect(resnapshot[1].isBossman).toBe(true)
    expect(resnapshot[0].isSecondInCommand).toBe(true)
  })
})

describe('ensembleRosterPresets — round-trip fidelity + isolation', () => {
  it('preserves every optional field across build → materialize → snapshot', () => {
    const preset = buildEnsembleRosterPresetFromConfig('Rich', ensembleWithGrants(), 1)
    const round = snapshotParticipantsForPreset(materializeParticipantsFromPreset(preset.participants))
    // Builder (order 1) carries all the optional config.
    expect(round[0]).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.5',
      reasoningEffort: 'high',
      fastModeEnabled: true,
      serviceTier: 'fast',
      runtimeProfileId: 'approved_patcher',
      permissionPresetId: 'custom'
    })
    expect(round[0].permissionOverrides).toEqual({
      approvalMode: 'auto_edit',
      agenticServices: { fileChanges: 'allow', shellCommands: 'workspace' },
      networkAccess: 'deny',
      externalPathGrants: [grant('/tmp/a'), grant('/tmp/b')]
    })
  })

  it('deep-clones externalPathGrants elements — mutating a working copy never aliases the source', () => {
    const preset = buildEnsembleRosterPresetFromConfig('Rich', ensembleWithGrants(), 1)
    const sourceGrants = preset.participants[0].permissionOverrides!.externalPathGrants!
    const materialized = materializeParticipantsFromPreset(preset.participants)
    const workingGrants = materialized[0].permissionOverrides!.externalPathGrants!
    workingGrants[0].path = '/hacked'
    expect(sourceGrants[0].path).toBe('/tmp/a') // source untouched (fails with a bare [...arr] clone)
  })

  it('keeps a retired gemini participant intact across materialize → snapshot → upsert → read', () => {
    const preset = buildEnsembleRosterPresetFromConfig(
      'Legacy',
      {
        enabled: true,
        maxParticipants: 2,
        orchestrationMode: 'turn_bound',
        participants: [
          {
            id: 'ensemble-participant-1',
            provider: 'gemini',
            enabled: true,
            role: 'Gemini',
            instructions: 'Legacy member.',
            order: 1,
            geminiAuthProfileId: 'auth-xyz'
          },
          {
            id: 'ensemble-participant-2',
            provider: 'claude',
            enabled: true,
            role: 'Claude',
            instructions: '',
            order: 2
          }
        ]
      },
      5
    )
    const reSnapshot = snapshotParticipantsForPreset(materializeParticipantsFromPreset(preset.participants))
    upsertEnsembleRosterPreset({ ...preset, participants: reSnapshot })
    const stored = getEnsembleRosterPreset(preset.id)!
    expect(stored.participants[0]).toMatchObject({
      provider: 'gemini',
      geminiAuthProfileId: 'auth-xyz'
    })
  })

  it('snapshotParticipantsForPreset renumbers order densely 1..N', () => {
    const participants = materializeParticipantsFromPreset([
      { provider: 'claude', enabled: true, role: 'A', instructions: '', order: 5 },
      { provider: 'codex', enabled: true, role: 'B', instructions: '', order: 2 }
    ])
    const snaps = snapshotParticipantsForPreset(participants)
    expect(snaps.map((s) => s.order)).toEqual([1, 2])
    expect(snaps.map((s) => s.role)).toEqual(['B', 'A'])
  })
})

describe('ensembleRosterPresets — editor primitives', () => {
  it('createEmpty persists a valid preset at the 2-participant floor', () => {
    const created = createEmptyEnsembleRosterPreset('My panel')
    expect(created.participants.length).toBeGreaterThanOrEqual(MIN_ROSTER_PRESET_PARTICIPANTS)
    // Survives a re-read (i.e. passes isEnsembleRosterPreset; not filtered out).
    expect(listEnsembleRosterPresets().find((p) => p.id === created.id)?.name).toBe('My panel')
  })

  it('createEmpty rejects an empty name', () => {
    expect(() => createEmptyEnsembleRosterPreset('   ')).toThrow()
  })

  it('duplicate mints a fresh id + timestamps + " copy" name and deep-clones', () => {
    const base = upsertEnsembleRosterPreset(buildEnsembleRosterPresetFromConfig('Base', ensembleWithGrants(), 1))
    const copy = duplicateEnsembleRosterPreset(base.id)!
    expect(copy.id).not.toBe(base.id)
    expect(copy.name).toBe('Base copy')
    expect(copy.createdAt).not.toBe(base.createdAt)
    // Editing the copy's nested grant must not reach back through to the in-memory base.
    copy.participants[0].permissionOverrides!.externalPathGrants![0].path = '/hacked'
    expect(base.participants[0].permissionOverrides!.externalPathGrants![0].path).toBe('/tmp/a')
  })

  it('duplicate returns null for an unknown id', () => {
    expect(duplicateEnsembleRosterPreset('nope')).toBeNull()
  })

  it('upsert is clobber-safe — a concurrent edit to a DIFFERENT preset survives', () => {
    const p1 = upsertEnsembleRosterPreset(buildEnsembleRosterPresetFromConfig('P1', sampleEnsemble(), 1))
    const p2 = buildEnsembleRosterPresetFromConfig('P2', sampleEnsemble(), 2)
    p2.id = `${p1.id}-two`
    upsertEnsembleRosterPreset(p2)
    // "Window B" persists an edit to p2.
    upsertEnsembleRosterPreset({ ...p2, name: 'P2 edited', updatedAt: 3 })
    // "Window A" upserts a stale p1 (captured before p2's edit). Because upsert
    // fresh-reads + splices only p1, p2's edit is preserved.
    upsertEnsembleRosterPreset({ ...p1, name: 'P1 edited', updatedAt: 4 })
    expect(getEnsembleRosterPreset(p2.id)?.name).toBe('P2 edited')
    expect(getEnsembleRosterPreset(p1.id)?.name).toBe('P1 edited')
  })

  it('upsert throws on an invalid preset rather than silently dropping it', () => {
    expect(() =>
      upsertEnsembleRosterPreset({
        id: 'x',
        name: '',
        createdAt: 1,
        updatedAt: 1,
        orchestrationMode: 'turn_bound',
        maxParticipants: 2,
        participants: []
      })
    ).toThrow()
  })
})

describe('ensembleRosterPresets — cross-surface subscription', () => {
  it('notifies same-window subscribers on write and stops after unsubscribe', () => {
    const cb = vi.fn()
    const unsub = subscribeEnsembleRosterPresets(cb)
    createEmptyEnsembleRosterPreset('x')
    expect(cb).toHaveBeenCalled()
    unsub()
    cb.mockClear()
    createEmptyEnsembleRosterPreset('y')
    expect(cb).not.toHaveBeenCalled()
  })

  it('refreshes on a cross-window storage event for the preset key only', () => {
    const cb = vi.fn()
    const unsub = subscribeEnsembleRosterPresets(cb)
    const handlers = fake.listeners['storage'] || []
    expect(handlers.length).toBeGreaterThan(0)
    const emit = (key: string, newValue: string | null): void => {
      handlers.forEach((h) => h({ key, newValue, storageArea: fake.localStorage }))
    }
    cb.mockClear()
    emit(STORAGE_KEY, '[]')
    expect(cb).toHaveBeenCalledTimes(1)
    cb.mockClear()
    emit('some-other-key', 'v') // wrong key ignored
    emit(STORAGE_KEY, null) // clear ignored
    expect(cb).not.toHaveBeenCalled()
    unsub()
  })
})

describe('buildProviderChangeParticipantPatch', () => {
  it('clears stale cross-provider grants + runtime profile (keys present for shallow-merge clear)', () => {
    const patch = buildProviderChangeParticipantPatch('claude')
    expect(patch.provider).toBe('claude')
    expect(patch.permissionPresetId).toBe('read_only') // claude default
    expect(patch.permissionOverrides).toBeUndefined()
    expect(patch.runtimeProfileId).toBeUndefined()
    expect('permissionOverrides' in patch).toBe(true)
    expect('runtimeProfileId' in patch).toBe(true)
    expect(patch.linkedProviderSessionId).toBeNull()
  })
})
