export const SKILL_LIBRARY_SCHEMA_VERSION = 1 as const

export type SkillScope = 'user' | 'workspace'

/** Optional YAML frontmatter keys accepted in SKILL.md. */
export interface SkillFrontmatterFields {
  name?: string
  description?: string
  enabled?: boolean
}

export interface SkillRecord {
  id: string
  name: string
  description: string
  /** Markdown body after optional frontmatter (or inline content). */
  body: string
  /** Path relative to the skill directory; typically `SKILL.md`. */
  relativePath?: string
  enabled: boolean
  scope: SkillScope
  workspaceId?: string
  updatedAt: string
}

export interface SkillLibrarySnapshot {
  schemaVersion: typeof SKILL_LIBRARY_SCHEMA_VERSION
  generatedAt: string
  userSkills: SkillRecord[]
  workspaceSkills: SkillRecord[]
}

/** Enabled skill after workspace-over-user merge. */
export interface EffectiveSkill {
  id: string
  name: string
  description: string
  body: string
  relativePath?: string
  scope: SkillScope
  workspaceId?: string
  updatedAt: string
  /** Which library won for this id. */
  source: SkillScope
}

export interface UpsertSkillInput {
  id?: string
  name: string
  description?: string
  body?: string
  enabled?: boolean
}
