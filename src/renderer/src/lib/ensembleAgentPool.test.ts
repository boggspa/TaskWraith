import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnsembleParticipant, ExternalPathGrant } from '../../../main/store/types'

// Map-backed fake window/localStorage installed BEFORE the modules under test
// import (mirrors ensembleRosterPresets.test.ts). Both the pool store and the
// preset store it propagates into read `window.localStorage` and bind a lazy
// `storage` bridge on first subscribe.
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
  accentFromHue,
  applyPooledAgentToParticipant,
  createPooledAgentFromParticipant,
  DEFAULT_POOL_ICON_BRIGHTNESS,
  DEFAULT_POOL_ICON_SATURATION,
  getPooledAgent,
  hueForSeed,
  isPooledAgentId,
  listPooledAgents,
  normalizeHexColor,
  normalizePoolIconBrightness,
  normalizePoolIconSaturation,
  participantSnapshotToPooledAgentConfig,
  parsePoolColorInput,
  pickNextPoolNickname,
  pooledAgentIconProps,
  pooledAgentIdentitySnapshot,
  pooledAgentToParticipantSnapshot,
  pooledIconColor,
  POOL_ICON_NEUTRAL,
  POOLED_AGENT_STORAGE_KEY,
  propagatePooledAgentToPresets,
  registerParticipantInAgentPool,
  rgbStringFromHexColor,
  removePooledAgent,
  subscribeEnsembleAgentPool,
  upsertPooledAgent,
  type PooledAgent
} from './ensembleAgentPool'
import {
  getEnsembleRosterPreset,
  upsertEnsembleRosterPreset,
  type EnsembleRosterParticipantSnapshot,
  type EnsembleRosterPreset
} from './ensembleRosterPresets'
import { NAMED_AGENT_IDENTICONS } from './agentIdentityCatalog'

const PRESET_KEY = 'taskwraith-ensemble-roster-presets'

beforeEach(() => {
  fake.store.clear()
})

function sampleParticipant(overrides: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id: 'ensemble-participant-1',
    provider: 'claude',
    enabled: true,
    role: 'Reviewer',
    instructions: 'Review carefully',
    order: 1,
    model: 'claude-opus-4-8',
    geminiAuthProfileId: null,
    permissionPresetId: 'default',
    reasoningEffort: 'high',
    ...overrides
  }
}

function fire(type: string, event: unknown): void {
  for (const cb of fake.listeners[type] || []) cb(event)
}

describe('createPooledAgentFromParticipant', () => {
  it('mints a pooled-agent id, seeds nickname from role, and persists', () => {
    const agent = createPooledAgentFromParticipant(sampleParticipant())
    expect(isPooledAgentId(agent.agentId)).toBe(true)
    expect(agent.schemaVersion).toBe(1)
    expect(agent.identity.nickname).toBe('Reviewer')
    expect(agent.identity.iconKind).toBe('seed')
    expect(agent.identity.seed).toBe(agent.agentId)
    expect(agent.identity.hue).toBe(hueForSeed(agent.agentId))
    expect(agent.config.provider).toBe('claude')
    expect(agent.config.model).toBe('claude-opus-4-8')
    expect(getPooledAgent(agent.agentId)).toEqual(agent)
  })

  it('avoids nickname collisions across the pool', () => {
    const a = createPooledAgentFromParticipant(sampleParticipant({ role: 'Reviewer' }))
    const b = createPooledAgentFromParticipant(sampleParticipant({ role: 'Reviewer' }))
    expect(a.identity.nickname).toBe('Reviewer')
    expect(b.identity.nickname).not.toBe('Reviewer')
  })

  it('does not write a pooledAgentId into the config', () => {
    const agent = createPooledAgentFromParticipant(
      sampleParticipant({ pooledAgentId: 'pooled-agent-source' })
    )
    expect((agent.config as Record<string, unknown>).pooledAgentId).toBeUndefined()
  })
})

describe('registerParticipantInAgentPool', () => {
  it('coalesces an equivalent role/config despite role casing', () => {
    const existing = createPooledAgentFromParticipant(sampleParticipant({ role: 'Reviewer' }))
    const result = registerParticipantInAgentPool(sampleParticipant({ role: ' reviewer ' }))

    expect(result.mode).toBe('coalesced')
    expect(result.agent.agentId).toBe(existing.agentId)
    expect(listPooledAgents()).toHaveLength(1)
  })

  it('diverges a same-role participant whose configuration differs', () => {
    const existing = createPooledAgentFromParticipant(sampleParticipant({ role: 'Reviewer' }))
    const result = registerParticipantInAgentPool(
      sampleParticipant({ role: 'Reviewer', instructions: 'Review only TypeScript.' })
    )

    expect(result.mode).toBe('created')
    expect(result.agent.agentId).not.toBe(existing.agentId)
    expect(listPooledAgents()).toHaveLength(2)
  })

  it('updates an explicitly linked Agent in place', () => {
    const existing = createPooledAgentFromParticipant(sampleParticipant())
    const result = registerParticipantInAgentPool(
      sampleParticipant({ pooledAgentId: existing.agentId, instructions: 'Review carefully and report.' })
    )

    expect(result.mode).toBe('updated')
    expect(result.agent.agentId).toBe(existing.agentId)
    expect(getPooledAgent(existing.agentId)?.config.instructions).toBe('Review carefully and report.')
  })

  it('creates a fresh Agent when a participant link is orphaned', () => {
    const result = registerParticipantInAgentPool(
      sampleParticipant({ pooledAgentId: 'pooled-agent-no-longer-present' })
    )

    expect(result.mode).toBe('created')
    expect(result.agent.agentId).not.toBe('pooled-agent-no-longer-present')
  })

  it('rejects a missing or overlong role instead of truncating it', () => {
    expect(() => registerParticipantInAgentPool(sampleParticipant({ role: '  ' }))).toThrow(/assigned role/i)
    expect(registerParticipantInAgentPool(sampleParticipant({ role: '🙂'.repeat(50) })).agent.config.role).toBe(
      '🙂'.repeat(50)
    )
    expect(() =>
      registerParticipantInAgentPool(sampleParticipant({ role: '🙂'.repeat(51) }))
    ).toThrow(/at most 50/i)
  })
})

describe('upsertPooledAgent', () => {
  it('edits in place: same agentId, bumped updatedAt', () => {
    const agent = createPooledAgentFromParticipant(sampleParticipant())
    const edited: PooledAgent = {
      ...agent,
      identity: { ...agent.identity, nickname: 'Critic' },
      updatedAt: agent.updatedAt - 1
    }
    const saved = upsertPooledAgent(edited)
    expect(saved.agentId).toBe(agent.agentId)
    expect(saved.identity.nickname).toBe('Critic')
    expect(saved.updatedAt).toBeGreaterThanOrEqual(agent.updatedAt)
    expect(listPooledAgents()).toHaveLength(1)
  })

  it('is clobber-safe: a concurrent write to a different agent survives', () => {
    const a = createPooledAgentFromParticipant(sampleParticipant({ role: 'A' }))
    const b = createPooledAgentFromParticipant(sampleParticipant({ role: 'B' }))
    // Simulate another window editing `a` between our read and write by editing
    // `b` while holding a stale copy of `a`.
    upsertPooledAgent({ ...a, identity: { ...a.identity, nickname: 'A2' } })
    expect(getPooledAgent(b.agentId)?.identity.nickname).toBe('B')
    expect(getPooledAgent(a.agentId)?.identity.nickname).toBe('A2')
  })

  it('rejects an invalid agent', () => {
    expect(() => upsertPooledAgent({ agentId: 'nope' } as unknown as PooledAgent)).toThrow()
  })
})

describe('hue toggle', () => {
  it('pooledIconColor returns the accent when tinting is on or unset', () => {
    expect(pooledIconColor('#FF0000', 120, true)).toBe('#FF0000')
    expect(pooledIconColor('#FF0000', 120, undefined)).toBe('#FF0000')
    expect(pooledIconColor(undefined, 120, undefined)).toBe(accentFromHue(120))
    expect(pooledIconColor(undefined, 120, true, 42)).toBe(accentFromHue(120, 42))
    expect(pooledIconColor(undefined, 120, true, 42, 80)).toBe(accentFromHue(120, 42, 80))
  })

  it('pooledIconColor collapses to neutral when tinting is off, regardless of accent/hue', () => {
    expect(pooledIconColor('#FF0000', 120, false)).toBe(POOL_ICON_NEUTRAL)
    expect(pooledIconColor(undefined, 300, false)).toBe(POOL_ICON_NEUTRAL)
  })

  it('snapshot carries hueEnabled when set false, and omits it when absent (back-compat)', () => {
    const agent = createPooledAgentFromParticipant(sampleParticipant())
    // Absent by default ⇒ key omitted so existing snapshots round-trip unchanged.
    expect('hueEnabled' in pooledAgentIdentitySnapshot(agent)).toBe(false)
    const untinted = { ...agent, identity: { ...agent.identity, hueEnabled: false } }
    expect(pooledAgentIdentitySnapshot(untinted).hueEnabled).toBe(false)
  })

  it('snapshot carries normalized brightness when set', () => {
    const agent = createPooledAgentFromParticipant(sampleParticipant())
    const bright = { ...agent, identity: { ...agent.identity, brightness: 72.4 } }
    expect(pooledAgentIdentitySnapshot(bright).brightness).toBe(72)
  })

  it('snapshot carries normalized saturation when set', () => {
    const agent = createPooledAgentFromParticipant(sampleParticipant())
    const saturated = { ...agent, identity: { ...agent.identity, saturation: 83.7 } }
    expect(pooledAgentIdentitySnapshot(saturated).saturation).toBe(84)
  })
})

describe('converters', () => {
  it('pooledAgentToParticipantSnapshot adds enabled/isBossman/pooledAgentId', () => {
    const agent = createPooledAgentFromParticipant(sampleParticipant())
    const snap = pooledAgentToParticipantSnapshot(agent, 3)
    expect(snap.order).toBe(3)
    expect(snap.enabled).toBe(true)
    expect(snap.isBossman).toBeUndefined()
    expect(snap.pooledAgentId).toBe(agent.agentId)
    expect(snap.pooledAgentIdentity).toEqual(pooledAgentIdentitySnapshot(agent))
    expect(snap.provider).toBe('claude')
    expect(snap.model).toBe('claude-opus-4-8')
  })

  it('participantSnapshotToPooledAgentConfig strips positional + link fields', () => {
    const snap: EnsembleRosterParticipantSnapshot = {
      provider: 'codex',
      enabled: false,
      role: 'Planner',
      instructions: 'Plan',
      order: 2,
      isBossman: true,
      pooledAgentId: 'pooled-agent-x',
      pooledAgentIdentity: {
        schemaVersion: 1,
        agentId: 'pooled-agent-x',
        nickname: 'Pool X',
        iconKind: 'seed',
        seed: 'pool-x',
        hue: 120
      },
      model: 'gpt-5.1'
    }
    const config = participantSnapshotToPooledAgentConfig(snap)
    expect(config).toEqual({ provider: 'codex', role: 'Planner', instructions: 'Plan', model: 'gpt-5.1' })
    expect((config as Record<string, unknown>).order).toBeUndefined()
    expect((config as Record<string, unknown>).isBossman).toBeUndefined()
    expect((config as Record<string, unknown>).enabled).toBeUndefined()
    expect((config as Record<string, unknown>).pooledAgentId).toBeUndefined()
    expect((config as Record<string, unknown>).pooledAgentIdentity).toBeUndefined()
  })

  it('deep-clones permissionOverrides so the Agent never aliases a preset grant', () => {
    const grant: ExternalPathGrant = {
      id: 'grant-1',
      provider: 'claude',
      path: '/tmp/x',
      kind: 'directory',
      access: 'write',
      duration: 'workspace',
      createdAt: '2026-01-01T00:00:00.000Z'
    }
    const participant = sampleParticipant({
      permissionPresetId: 'custom',
      permissionOverrides: { approvalMode: 'never', externalPathGrants: [grant] }
    })
    const agent = createPooledAgentFromParticipant(participant)
    const overrides = agent.config.permissionOverrides
    expect(overrides?.externalPathGrants?.[0]).not.toBe(grant)
    // Mutating the original grant must not bleed into the stored Agent.
    grant.path = '/tmp/MUTATED'
    expect(getPooledAgent(agent.agentId)?.config.permissionOverrides?.externalPathGrants?.[0].path).toBe(
      '/tmp/x'
    )
  })
})

describe('identity helpers', () => {
  it('accentFromHue returns a valid uppercase hex color', () => {
    for (const hue of [0, 45, 120, 200, 300, 359]) {
      expect(accentFromHue(hue)).toMatch(/^#[0-9A-F]{6}$/)
    }
  })

  it('accentFromHue preserves the legacy default and responds to tone controls', () => {
    expect(accentFromHue(210)).toBe(accentFromHue(210, DEFAULT_POOL_ICON_BRIGHTNESS))
    expect(accentFromHue(210)).toBe(
      accentFromHue(210, DEFAULT_POOL_ICON_BRIGHTNESS, DEFAULT_POOL_ICON_SATURATION)
    )
    expect(accentFromHue(210, 35)).not.toBe(accentFromHue(210, 75))
    expect(accentFromHue(210, 58, 15)).not.toBe(accentFromHue(210, 58, 85))
    expect(normalizePoolIconBrightness(-5)).toBe(0)
    expect(normalizePoolIconBrightness(140)).toBe(100)
    expect(normalizePoolIconBrightness(undefined)).toBe(DEFAULT_POOL_ICON_BRIGHTNESS)
    expect(normalizePoolIconSaturation(-5)).toBe(0)
    expect(normalizePoolIconSaturation(140)).toBe(100)
    expect(normalizePoolIconSaturation(undefined)).toBe(DEFAULT_POOL_ICON_SATURATION)
  })

  it('normalizes hex and rgb color input for manual color fields', () => {
    expect(normalizeHexColor('abc')).toBe('#AABBCC')
    expect(normalizeHexColor(' #00aaFF ')).toBe('#00AAFF')
    expect(rgbStringFromHexColor('#00AAFF')).toBe('0, 170, 255')
    expect(parsePoolColorInput('#00aaff')).toEqual({
      accent: '#00AAFF',
      hue: 200,
      saturation: 100,
      brightness: 50
    })
    expect(parsePoolColorInput('rgb(255, 0, 128)')).toEqual({
      accent: '#FF0080',
      hue: 330,
      saturation: 100,
      brightness: 50
    })
    expect(parsePoolColorInput('255, 0, 128')).toEqual({
      accent: '#FF0080',
      hue: 330,
      saturation: 100,
      brightness: 50
    })
    expect(parsePoolColorInput('not-a-color')).toBeUndefined()
  })

  it('hueForSeed is stable and in range', () => {
    const h = hueForSeed('pooled-agent-abc')
    expect(h).toBe(hueForSeed('pooled-agent-abc'))
    expect(h).toBeGreaterThanOrEqual(0)
    expect(h).toBeLessThan(360)
  })

  it('isPooledAgentId only accepts prefixed non-empty ids', () => {
    expect(isPooledAgentId('pooled-agent-123')).toBe(true)
    expect(isPooledAgentId('pooled-agent-')).toBe(false)
    expect(isPooledAgentId('ensemble-participant-1')).toBe(false)
    expect(isPooledAgentId(undefined)).toBe(false)
  })

  it('pickNextPoolNickname prefers an unused role, else walks the pool', () => {
    expect(pickNextPoolNickname(new Set(), 'Reviewer')).toBe('Reviewer')
    expect(pickNextPoolNickname(new Set(['Reviewer']), 'Reviewer')).not.toBe('Reviewer')
    expect(pickNextPoolNickname(new Set(), '')).toBeTruthy()
  })

  it('pooledAgentIconProps resolves a named slug, else falls back to procedural', () => {
    const named = NAMED_AGENT_IDENTICONS[0]
    const agent = createPooledAgentFromParticipant(sampleParticipant())
    const namedAgent: PooledAgent = {
      ...agent,
      identity: {
        ...agent.identity,
        iconKind: 'named',
        slug: named.slug,
        hue: 22,
        saturation: 81,
        brightness: 44
      }
    }
    expect(pooledAgentIconProps(namedAgent).name).toBe(named.name)
    expect(pooledAgentIconProps(namedAgent).color).toBe(accentFromHue(22, 44, 81))

    const danglingAgent: PooledAgent = {
      ...agent,
      identity: { ...agent.identity, iconKind: 'named', slug: 'not-a-real-slug-xyz' }
    }
    const props = pooledAgentIconProps(danglingAgent)
    expect(props.name).toBeUndefined()
    expect(props.seed).toBe(agent.agentId)
    expect(props.color).toMatch(/^#[0-9A-F]{6}$/)
  })
})

describe('storage bridge', () => {
  it('notifies on the pool key but ignores other keys', () => {
    const listener = vi.fn()
    const unsub = subscribeEnsembleAgentPool(listener)
    fire('storage', { key: PRESET_KEY, newValue: '[]', storageArea: fake.localStorage })
    expect(listener).not.toHaveBeenCalled()
    fire('storage', { key: POOLED_AGENT_STORAGE_KEY, newValue: '[]', storageArea: fake.localStorage })
    expect(listener).toHaveBeenCalledTimes(1)
    unsub()
  })

  it('synchronously fans out same-window writes', () => {
    const listener = vi.fn()
    const unsub = subscribeEnsembleAgentPool(listener)
    createPooledAgentFromParticipant(sampleParticipant())
    expect(listener).toHaveBeenCalled()
    unsub()
  })
})

describe('linked propagation to presets', () => {
  function presetWithLinkedParticipant(
    agentId: string,
    authority: 'boss' | 'captain' = 'boss'
  ): EnsembleRosterPreset {
    const linked: EnsembleRosterParticipantSnapshot = {
      provider: 'claude',
      enabled: false,
      role: 'OLD ROLE',
      instructions: 'old',
      order: 2,
      ...(authority === 'boss' ? { isBossman: true } : { isSecondInCommand: true }),
      pooledAgentId: agentId,
      model: 'old-model'
    }
    const other: EnsembleRosterParticipantSnapshot = {
      provider: 'codex',
      enabled: true,
      role: 'Unlinked',
      instructions: 'untouched',
      order: 1,
      ...(authority === 'captain' ? { isBossman: true } : {})
    }
    return upsertEnsembleRosterPreset({
      id: 'preset-1',
      name: 'P1',
      createdAt: 1,
      updatedAt: 1,
      orchestrationMode: 'turn_bound',
      maxParticipants: 6,
      participants: [other, linked]
    })
  }

  it('overwrites linked config but preserves order/isBossman/enabled', () => {
    const agent = createPooledAgentFromParticipant(
      sampleParticipant({ role: 'Reviewer', instructions: 'NEW GOAL', model: 'claude-opus-4-8' })
    )
    presetWithLinkedParticipant(agent.agentId)

    propagatePooledAgentToPresets(agent)

    const preset = getEnsembleRosterPreset('preset-1')!
    const linked = preset.participants.find((p) => p.pooledAgentId === agent.agentId)!
    // Config fields updated from the Agent:
    expect(linked.role).toBe('Reviewer')
    expect(linked.instructions).toBe('NEW GOAL')
    expect(linked.model).toBe('claude-opus-4-8')
    expect(linked.pooledAgentIdentity).toEqual(pooledAgentIdentitySnapshot(agent))
    // Positional fields preserved:
    expect(linked.order).toBe(2)
    expect(linked.isBossman).toBe(true)
    expect(linked.enabled).toBe(false)
    // Unlinked participant untouched:
    const unlinked = preset.participants.find((p) => p.role === 'Unlinked')!
    expect(unlinked.instructions).toBe('untouched')
  })

  it('preserves a linked Captain marker during pooled-agent propagation', () => {
    const agent = createPooledAgentFromParticipant(
      sampleParticipant({ role: 'Captain', instructions: 'NEW CAPTAIN GOAL' })
    )
    presetWithLinkedParticipant(agent.agentId, 'captain')

    propagatePooledAgentToPresets(agent)

    const linked = getEnsembleRosterPreset('preset-1')!.participants.find(
      (participant) => participant.pooledAgentId === agent.agentId
    )!
    expect(linked.isBossman).toBeUndefined()
    expect(linked.isSecondInCommand).toBe(true)
  })

  it('upsertPooledAgent auto-propagates by default', () => {
    const agent = createPooledAgentFromParticipant(sampleParticipant({ role: 'Reviewer' }))
    presetWithLinkedParticipant(agent.agentId)
    upsertPooledAgent({ ...agent, config: { ...agent.config, role: 'Auditor' } })
    const linked = getEnsembleRosterPreset('preset-1')!.participants.find(
      (p) => p.pooledAgentId === agent.agentId
    )!
    expect(linked.role).toBe('Auditor')
    expect(linked.pooledAgentIdentity).toEqual(
      pooledAgentIdentitySnapshot({ ...agent, config: { ...agent.config, role: 'Auditor' } })
    )
  })

  it('upsertPooledAgent propagates identity snapshots by default', () => {
    const agent = createPooledAgentFromParticipant(sampleParticipant({ role: 'Reviewer' }))
    presetWithLinkedParticipant(agent.agentId)
    const updated = {
      ...agent,
      identity: { ...agent.identity, nickname: 'Circuit Cactus', accent: '#41F27A' }
    }
    upsertPooledAgent(updated)
    const linked = getEnsembleRosterPreset('preset-1')!.participants.find(
      (p) => p.pooledAgentId === agent.agentId
    )!
    expect(linked.pooledAgentIdentity).toEqual(pooledAgentIdentitySnapshot(updated))
  })

  it('removePooledAgent leaves linked preset copies intact (orphaned, not deleted)', () => {
    const agent = createPooledAgentFromParticipant(sampleParticipant({ role: 'Reviewer' }))
    presetWithLinkedParticipant(agent.agentId)
    removePooledAgent(agent.agentId)
    const linked = getEnsembleRosterPreset('preset-1')!.participants.find(
      (p) => p.pooledAgentId === agent.agentId
    )
    expect(linked).toBeDefined()
  })
})

describe('applyPooledAgentToParticipant (open-editor reconcile)', () => {
  it('returns the same reference when unlinked or unchanged', () => {
    const plain = sampleParticipant({ pooledAgentId: undefined })
    expect(applyPooledAgentToParticipant(plain)).toBe(plain)

    const agent = createPooledAgentFromParticipant(sampleParticipant({ role: 'Reviewer' }))
    const linked = sampleParticipant({
      pooledAgentId: agent.agentId,
      pooledAgentIdentity: pooledAgentIdentitySnapshot(agent),
      role: 'Reviewer',
      model: 'claude-opus-4-8'
    })
    // Config already matches the agent → same reference (no needless patch).
    expect(applyPooledAgentToParticipant(linked)).toBe(linked)
  })

  it('overwrites config from the agent but preserves id/order/enabled/link', () => {
    const agent = createPooledAgentFromParticipant(
      sampleParticipant({ role: 'Reviewer', instructions: 'orig' })
    )
    upsertPooledAgent({ ...agent, config: { ...agent.config, role: 'Auditor', instructions: 'NEW' } })
    const stale = sampleParticipant({
      id: 'ensemble-participant-7',
      pooledAgentId: agent.agentId,
      role: 'Reviewer',
      instructions: 'orig',
      order: 4,
      enabled: false
    })
    const reconciled = applyPooledAgentToParticipant(stale)
    expect(reconciled).not.toBe(stale)
    expect(reconciled.role).toBe('Auditor')
    expect(reconciled.instructions).toBe('NEW')
    expect(reconciled.id).toBe('ensemble-participant-7')
    expect(reconciled.order).toBe(4)
    expect(reconciled.enabled).toBe(false)
    expect(reconciled.pooledAgentId).toBe(agent.agentId)
  })

  it('returns same reference when the linked agent no longer exists', () => {
    const orphan = sampleParticipant({ pooledAgentId: 'pooled-agent-gone' })
    expect(applyPooledAgentToParticipant(orphan)).toBe(orphan)
  })

  it('does not spuriously change when only permission-grant key ORDER differs', () => {
    // The agent's overrides and the participant's overrides are structurally
    // identical but with different key insertion order — must compare equal.
    const agent = createPooledAgentFromParticipant(
      sampleParticipant({
        role: 'R',
        permissionPresetId: 'custom',
        permissionOverrides: {
          approvalMode: 'never',
          agenticServices: { shellCommands: 'allow', fileChanges: 'deny' }
        }
      })
    )
    const linked = sampleParticipant({
      pooledAgentId: agent.agentId,
      pooledAgentIdentity: pooledAgentIdentitySnapshot(agent),
      role: 'R',
      permissionPresetId: 'custom',
      permissionOverrides: {
        agenticServices: { fileChanges: 'deny', shellCommands: 'allow' },
        approvalMode: 'never'
      }
    })
    expect(applyPooledAgentToParticipant(linked)).toBe(linked)
  })
})
