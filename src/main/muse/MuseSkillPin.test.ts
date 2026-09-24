import { describe, expect, it } from 'vitest'
import {
  MUSE_LISTABLE_BUNDLED_SKILL_NAMES,
  MUSE_NON_LISTABLE_BUNDLED_SKILL_NAMES,
  MUSE_PINNED_OFF_BUNDLED_SKILL_NAMES,
  assertMuseEnabledBundledSkillsEmpty,
  assertMuseListableBundledSkillRatchet,
  buildMuseSkillPinSettings,
  expectedMuseBundledSkillDirectoryNames,
  museBundledSkillUri,
  serializeMuseSkillPinSettings
} from './MuseSkillPin'

describe('MuseSkillPin', () => {
  it('pins exactly ten listable bundled skills plus create-plugin off', () => {
    expect(MUSE_LISTABLE_BUNDLED_SKILL_NAMES).toHaveLength(10)
    expect(MUSE_NON_LISTABLE_BUNDLED_SKILL_NAMES).toEqual(['create-plugin'])
    expect(MUSE_PINNED_OFF_BUNDLED_SKILL_NAMES).toHaveLength(11)

    const settings = buildMuseSkillPinSettings('off')
    expect(settings.schema_version).toBe(1)
    const bundled = settings.skills.activation.bundled
    expect(Object.keys(bundled)).toHaveLength(11)

    for (const name of MUSE_PINNED_OFF_BUNDLED_SKILL_NAMES) {
      expect(bundled[museBundledSkillUri(name)]).toBe('off')
    }

    const serialized = serializeMuseSkillPinSettings(settings)
    expect(serialized).toContain('bundled://muse-core/skills/create-plugin/SKILL.md')
    expect(serialized).toContain('bundled://muse-core/skills/import/SKILL.md')
    expect(
      JSON.parse(serialized).skills.activation.bundled[
        'bundled://muse-core/skills/create-plugin/SKILL.md'
      ]
    ).toBe('off')
  })

  it('ratchets when Muse adds or removes a listable bundled skill', () => {
    expect(assertMuseListableBundledSkillRatchet([...MUSE_LISTABLE_BUNDLED_SKILL_NAMES])).toEqual({
      ok: true
    })

    const withExtra = assertMuseListableBundledSkillRatchet([
      ...MUSE_LISTABLE_BUNDLED_SKILL_NAMES,
      'new-danger'
    ])
    expect(withExtra.ok).toBe(false)
    if (!withExtra.ok) {
      expect(withExtra.unexpected).toEqual(['new-danger'])
      expect(withExtra.missing).toEqual([])
    }

    const missingOne = assertMuseListableBundledSkillRatchet(
      MUSE_LISTABLE_BUNDLED_SKILL_NAMES.filter((name) => name !== 'import')
    )
    expect(missingOne.ok).toBe(false)
    if (!missingOne.ok) {
      expect(missingOne.missing).toEqual(['import'])
    }
  })

  it('requires the enabled bundled set to be empty after seeding', () => {
    expect(
      assertMuseEnabledBundledSkillsEmpty(
        MUSE_LISTABLE_BUNDLED_SKILL_NAMES.map((name) => ({
          name,
          id: `bundled:${name}`,
          activation: 'off'
        }))
      )
    ).toEqual({ ok: true })

    const stillOn = assertMuseEnabledBundledSkillsEmpty([
      { name: 'git', activation: 'on' },
      { name: 'plan', activation: 'off' }
    ])
    expect(stillOn.ok).toBe(false)
    if (!stillOn.ok) {
      expect(stillOn.unexpected).toEqual(['git'])
      expect(stillOn.expected).toEqual([])
    }
  })

  it('enables Muse-native delegation only for signed UltraTask consent', () => {
    const ordinary = buildMuseSkillPinSettings('off')
    expect(ordinary.run).toBeUndefined()
    expect(serializeMuseSkillPinSettings(ordinary)).not.toContain('subagent_delegation_mode')

    const ultraTask = buildMuseSkillPinSettings('off', {
      ultraTaskDelegationAutoAllow: true
    })
    expect(ultraTask.run).toEqual({ subagent_delegation_mode: 'auto' })
    expect(JSON.parse(serializeMuseSkillPinSettings(ultraTask))).toMatchObject({
      schema_version: 1,
      run: { subagent_delegation_mode: 'auto' },
      skills: ordinary.skills
    })
  })

  it('expects on-disk inventory to include listable skills plus create-plugin', () => {
    const dirs = expectedMuseBundledSkillDirectoryNames()
    expect(dirs).toContain('create-plugin')
    expect(dirs).toContain('git')
    expect(dirs).toHaveLength(11)
    expect([...dirs]).toEqual([...dirs].sort((a, b) => a.localeCompare(b)))
  })
})
