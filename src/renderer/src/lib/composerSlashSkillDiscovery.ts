/**
 * Live slash-palette skill discovery.
 *
 * Loads effective skills through the Skills Settings IPC facade and maps them
 * to prompt-template slash commands. Failures degrade to an empty list so the
 * composer palette stays usable offline / without preload wiring.
 */

import type { EffectiveSkill, SkillRecord } from '../../../shared/skills/SkillTypes'
import { skillPromptTemplatesFromSkills, type PromptTemplateCommand } from './ComposerSlashCommands'
import { getSkillsHooksSettingsApi, type SkillsIpcApi } from './skillsHooksSettingsApi'

function toEffective(skill: SkillRecord, source: SkillRecord['scope']): EffectiveSkill {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    body: skill.body,
    ...(skill.relativePath ? { relativePath: skill.relativePath } : {}),
    scope: skill.scope,
    ...(skill.workspaceId ? { workspaceId: skill.workspaceId } : {}),
    updatedAt: skill.updatedAt,
    source
  }
}

/**
 * Workspace-over-user merge matching {@link SkillsStore.resolveEffectiveSkills}:
 * disabled user skills are omitted; a disabled workspace skill removes the id.
 */
export function mergeEffectiveSkillsFromRecords(
  userSkills: readonly SkillRecord[],
  workspaceSkills: readonly SkillRecord[] = []
): EffectiveSkill[] {
  const byId = new Map<string, EffectiveSkill>()
  for (const skill of userSkills) {
    if (!skill.enabled) continue
    byId.set(skill.id, toEffective(skill, 'user'))
  }
  for (const skill of workspaceSkills) {
    if (!skill.enabled) {
      byId.delete(skill.id)
      continue
    }
    byId.set(skill.id, toEffective(skill, 'workspace'))
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

async function loadEffectiveSkillsViaLists(
  api: SkillsIpcApi,
  workspacePath?: string | null,
  workspaceId?: string | null
): Promise<EffectiveSkill[]> {
  if (!api.listUserSkills) return []
  const user = await api.listUserSkills()
  if (!workspacePath || !api.listWorkspaceSkills) {
    return mergeEffectiveSkillsFromRecords(user)
  }
  const workspace = await api.listWorkspaceSkills({
    workspacePath,
    ...(workspaceId ? { workspaceId } : {})
  })
  return mergeEffectiveSkillsFromRecords(user, workspace)
}

/** Resolve enabled effective skills for the active workspace. Never throws. */
export async function loadEffectiveSkillsForComposer(
  api: SkillsIpcApi | undefined,
  workspacePath?: string | null,
  workspaceId?: string | null
): Promise<EffectiveSkill[]> {
  try {
    if (!api) return []
    if (workspacePath && typeof api.listEffectiveSkills === 'function') {
      try {
        return await api.listEffectiveSkills({
          workspacePath,
          ...(workspaceId ? { workspaceId } : {})
        })
      } catch {
        // Fall through to listUser + listWorkspace merge.
      }
    }
    return await loadEffectiveSkillsViaLists(api, workspacePath, workspaceId)
  } catch {
    return []
  }
}

/** Load skill prompt-template slash commands for the composer palette. */
export async function loadComposerSkillSlashPromptTemplates(
  api: SkillsIpcApi | undefined = getSkillsHooksSettingsApi(),
  workspacePath?: string | null,
  workspaceId?: string | null
): Promise<PromptTemplateCommand[]> {
  const skills = await loadEffectiveSkillsForComposer(api, workspacePath, workspaceId)
  return skillPromptTemplatesFromSkills(skills)
}
