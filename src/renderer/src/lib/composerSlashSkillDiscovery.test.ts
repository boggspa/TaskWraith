import { describe, expect, it, vi } from 'vitest'
import { buildComposerSlashCommandRegistry, CODEX_PALETTE_CORE } from './ComposerSlashCommands'
import {
  loadComposerSkillSlashPromptTemplates,
  mergeEffectiveSkillsFromRecords
} from './composerSlashSkillDiscovery'
import type { SkillsIpcApi } from './skillsHooksSettingsApi'
import type { SkillRecord } from '../../../shared/skills/SkillTypes'

function skill(partial: Partial<SkillRecord> & Pick<SkillRecord, 'id' | 'scope'>): SkillRecord {
  return {
    name: partial.name ?? partial.id,
    description: partial.description ?? '',
    body: partial.body ?? '',
    enabled: partial.enabled ?? true,
    updatedAt: partial.updatedAt ?? '2026-08-08T00:00:00.000Z',
    ...partial
  }
}

describe('composerSlashSkillDiscovery', () => {
  describe('mergeEffectiveSkillsFromRecords', () => {
    it('keeps enabled user skills and lets workspace override by id', () => {
      const effective = mergeEffectiveSkillsFromRecords(
        [
          skill({ id: 'review', scope: 'user', name: 'User Review', body: 'user body' }),
          skill({ id: 'disabled-user', scope: 'user', enabled: false })
        ],
        [
          skill({
            id: 'review',
            scope: 'workspace',
            name: 'WS Review',
            body: 'ws body',
            workspaceId: 'w1'
          }),
          skill({ id: 'ws-only', scope: 'workspace', name: 'WS Only', body: 'only' })
        ]
      )

      expect(effective.map((entry) => entry.id)).toEqual(['review', 'ws-only'])
      expect(effective[0]).toMatchObject({
        id: 'review',
        name: 'WS Review',
        body: 'ws body',
        source: 'workspace'
      })
      expect(effective[1].source).toBe('workspace')
    })

    it('removes a user skill when the workspace copy is disabled', () => {
      const effective = mergeEffectiveSkillsFromRecords(
        [skill({ id: 'review', scope: 'user' })],
        [skill({ id: 'review', scope: 'workspace', enabled: false })]
      )
      expect(effective).toEqual([])
    })
  })

  describe('loadComposerSkillSlashPromptTemplates', () => {
    it('prefers listEffectiveSkills when present', async () => {
      const api: SkillsIpcApi = {
        listEffectiveSkills: vi.fn(async () => [
          {
            id: 'demo',
            name: 'Demo',
            description: 'Demo skill',
            body: 'Do the demo.',
            scope: 'user' as const,
            updatedAt: '2026-08-08T00:00:00.000Z',
            source: 'user' as const
          }
        ]),
        listUserSkills: vi.fn(async () => {
          throw new Error('should not call listUserSkills')
        })
      }

      const commands = await loadComposerSkillSlashPromptTemplates(api, '/tmp/ws', 'w1')
      expect(api.listEffectiveSkills).toHaveBeenCalledWith({
        workspacePath: '/tmp/ws',
        workspaceId: 'w1'
      })
      expect(commands).toHaveLength(1)
      expect(commands[0]).toMatchObject({
        kind: 'prompt-template',
        command: '/skill-demo',
        template: 'Do the demo.'
      })
    })

    it('falls back to listUserSkills + listWorkspaceSkills merge', async () => {
      const api: SkillsIpcApi = {
        listUserSkills: vi.fn(async () => [
          skill({ id: 'user-skill', scope: 'user', body: 'from user' })
        ]),
        listWorkspaceSkills: vi.fn(async () => [
          skill({ id: 'ws-skill', scope: 'workspace', body: 'from workspace' })
        ])
      }

      const commands = await loadComposerSkillSlashPromptTemplates(api, '/tmp/ws', 'w1')
      expect(api.listWorkspaceSkills).toHaveBeenCalledWith({
        workspacePath: '/tmp/ws',
        workspaceId: 'w1'
      })
      expect(commands.map((c) => c.command).sort()).toEqual([
        '/skill-user-skill',
        '/skill-ws-skill'
      ])
    })

    it('returns [] when IPC is missing or throws', async () => {
      await expect(loadComposerSkillSlashPromptTemplates(undefined, '/tmp/ws')).resolves.toEqual([])
      await expect(
        loadComposerSkillSlashPromptTemplates(
          {
            listUserSkills: vi.fn(async () => {
              throw new Error('boom')
            })
          },
          '/tmp/ws'
        )
      ).resolves.toEqual([])
    })

    it('merges into the slash registry as Discovery prompt-templates', async () => {
      const extras = await loadComposerSkillSlashPromptTemplates(
        {
          listUserSkills: async () => [
            skill({
              id: 'ship-check',
              scope: 'user',
              name: 'Ship Check',
              description: 'Preflight',
              body: 'Run the ship check.'
            })
          ]
        },
        null
      )
      const registry = buildComposerSlashCommandRegistry({
        provider: 'codex',
        paletteItems: CODEX_PALETTE_CORE,
        extraCommands: extras
      })
      const skillEntry = registry.find((entry) => entry.command === '/skill-ship-check')
      expect(skillEntry).toMatchObject({
        kind: 'prompt-template',
        label: 'Ship Check',
        group: 'Discovery',
        template: 'Run the ship check.'
      })
    })
  })
})
