import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import {
  SKILL_LIBRARY_SCHEMA_VERSION,
  type EffectiveSkill,
  type SkillLibrarySnapshot,
  type SkillRecord,
  type SkillScope,
  type UpsertSkillInput
} from '../../shared/skills/SkillTypes'

const SKILL_FILE = 'SKILL.md'
const META_FILE = 'meta.json'
const SKILL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/

export interface SkillsStoreDeps {
  userDataPath: string
  now?: () => Date
  uuid?: () => string
}

interface SkillMetaFile {
  id?: string
  updatedAt?: string
  enabled?: boolean
  name?: string
  description?: string
}

function pathWithinRoot(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate)
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

function assertSafeSkillId(id: string): string {
  const trimmed = id.trim()
  if (
    !SKILL_ID_RE.test(trimmed) ||
    trimmed.includes('..') ||
    trimmed.includes('/') ||
    trimmed.includes('\\')
  ) {
    throw new Error(`Invalid skill id: ${id}`)
  }
  return trimmed
}

function requireAbsoluteWorkspacePath(workspacePath: unknown): string {
  if (typeof workspacePath !== 'string' || !workspacePath.trim()) {
    throw new Error('A workspace path is required.')
  }
  const trimmed = workspacePath.trim()
  if (!path.isAbsolute(trimmed)) {
    throw new Error('Workspace path must be absolute.')
  }
  return path.resolve(trimmed)
}

function yamlScalar(raw: string): string | boolean | undefined {
  const value = raw.trim()
  if (!value) return ''
  if (value === 'true') return true
  if (value === 'false') return false
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

export function parseSkillMarkdown(raw: string): {
  name?: string
  description?: string
  enabled?: boolean
  body: string
} {
  const normalized = raw.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n') && normalized !== '---') {
    return { body: normalized.replace(/\n$/, '') }
  }
  const end = normalized.indexOf('\n---\n', 4)
  if (end < 0) {
    return { body: normalized.replace(/\n$/, '') }
  }
  const front = normalized.slice(4, end)
  const body = normalized
    .slice(end + '\n---\n'.length)
    .replace(/^\n/, '')
    .replace(/\n$/, '')
  let name: string | undefined
  let description: string | undefined
  let enabled: boolean | undefined
  for (const line of front.split('\n')) {
    const match = /^(name|description|enabled)\s*:\s*(.*)$/.exec(line.trim())
    if (!match) continue
    const key = match[1]
    const parsed = yamlScalar(match[2] ?? '')
    if (key === 'enabled' && typeof parsed === 'boolean') enabled = parsed
    if (key === 'name' && typeof parsed === 'string') name = parsed
    if (key === 'description' && typeof parsed === 'string') description = parsed
  }
  return { name, description, enabled, body }
}

function renderSkillMarkdown(input: {
  name: string
  description: string
  enabled: boolean
  body: string
}): string {
  const escapeYaml = (value: string): string => {
    if (/[:#{}[\],&*?|>!<%@`]/.test(value) || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    }
    return value
  }
  const lines = [
    '---',
    `name: ${escapeYaml(input.name)}`,
    `description: ${escapeYaml(input.description)}`,
    `enabled: ${input.enabled ? 'true' : 'false'}`,
    '---',
    '',
    input.body.replace(/\n$/, '')
  ]
  return `${lines.join('\n')}\n`
}

function readMeta(metaPath: string): SkillMetaFile | null {
  try {
    if (!fs.existsSync(metaPath)) return null
    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as SkillMetaFile
    return raw && typeof raw === 'object' ? raw : null
  } catch {
    return null
  }
}

export class SkillsStore {
  private readonly now: () => Date
  private readonly uuid: () => string

  constructor(private readonly deps: SkillsStoreDeps) {
    this.now = deps.now ?? (() => new Date())
    this.uuid = deps.uuid ?? randomUUID
  }

  userSkillsRoot(): string {
    return path.resolve(this.deps.userDataPath, 'skills')
  }

  workspaceSkillsRoot(workspacePath: string): string {
    const root = requireAbsoluteWorkspacePath(workspacePath)
    return path.join(root, '.taskwraith', 'skills')
  }

  resolveSkillDirectory(root: string, id: string): string {
    const safeId = assertSafeSkillId(id)
    const resolvedRoot = path.resolve(root)
    const candidate = path.resolve(resolvedRoot, safeId)
    if (!pathWithinRoot(candidate, resolvedRoot)) {
      throw new Error(`Skill path escapes root: ${id}`)
    }
    return candidate
  }

  listUserSkills(): SkillRecord[] {
    return this.listSkillsInRoot(this.userSkillsRoot(), 'user')
  }

  listWorkspaceSkills(workspacePath: string, workspaceId?: string): SkillRecord[] {
    return this.listSkillsInRoot(this.workspaceSkillsRoot(workspacePath), 'workspace', workspaceId)
  }

  resolveEffectiveSkills(workspacePath: string, workspaceId?: string): EffectiveSkill[] {
    const byId = new Map<string, EffectiveSkill>()
    for (const skill of this.listUserSkills()) {
      if (!skill.enabled) continue
      byId.set(skill.id, this.toEffective(skill, 'user'))
    }
    for (const skill of this.listWorkspaceSkills(workspacePath, workspaceId)) {
      if (!skill.enabled) {
        byId.delete(skill.id)
        continue
      }
      byId.set(skill.id, this.toEffective(skill, 'workspace'))
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  getLibrarySnapshot(workspacePath?: string, workspaceId?: string): SkillLibrarySnapshot {
    return {
      schemaVersion: SKILL_LIBRARY_SCHEMA_VERSION,
      generatedAt: this.now().toISOString(),
      userSkills: this.listUserSkills(),
      workspaceSkills: workspacePath ? this.listWorkspaceSkills(workspacePath, workspaceId) : []
    }
  }

  upsertUserSkill(input: UpsertSkillInput): SkillRecord {
    return this.upsertInRoot(this.userSkillsRoot(), 'user', input)
  }

  upsertWorkspaceSkill(
    workspacePath: string,
    input: UpsertSkillInput,
    workspaceId?: string
  ): SkillRecord {
    return this.upsertInRoot(
      this.workspaceSkillsRoot(workspacePath),
      'workspace',
      input,
      workspaceId
    )
  }

  deleteUserSkill(id: string): boolean {
    return this.deleteInRoot(this.userSkillsRoot(), id)
  }

  deleteWorkspaceSkill(workspacePath: string, id: string): boolean {
    return this.deleteInRoot(this.workspaceSkillsRoot(workspacePath), id)
  }

  setUserSkillEnabled(id: string, enabled: boolean): SkillRecord {
    return this.setEnabledInRoot(this.userSkillsRoot(), 'user', id, enabled)
  }

  setWorkspaceSkillEnabled(
    workspacePath: string,
    id: string,
    enabled: boolean,
    workspaceId?: string
  ): SkillRecord {
    return this.setEnabledInRoot(
      this.workspaceSkillsRoot(workspacePath),
      'workspace',
      id,
      enabled,
      workspaceId
    )
  }

  private toEffective(skill: SkillRecord, source: SkillScope): EffectiveSkill {
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

  private ensureRoot(root: string): void {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  }

  private listSkillsInRoot(root: string, scope: SkillScope, workspaceId?: string): SkillRecord[] {
    const resolvedRoot = path.resolve(root)
    if (!fs.existsSync(resolvedRoot)) return []
    const entries = fs.readdirSync(resolvedRoot, { withFileTypes: true })
    const skills: SkillRecord[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        const record = this.readSkillRecord(
          this.resolveSkillDirectory(resolvedRoot, entry.name),
          entry.name,
          scope,
          workspaceId
        )
        if (record) skills.push(record)
      } catch {
        // Skip unsafe or unreadable entries.
      }
    }
    return skills.sort((a, b) => a.id.localeCompare(b.id))
  }

  private readSkillRecord(
    skillDir: string,
    id: string,
    scope: SkillScope,
    workspaceId?: string
  ): SkillRecord | null {
    const skillPath = path.join(skillDir, SKILL_FILE)
    if (!fs.existsSync(skillPath)) return null
    const raw = fs.readFileSync(skillPath, 'utf8')
    const parsed = parseSkillMarkdown(raw)
    const meta = readMeta(path.join(skillDir, META_FILE))
    const stats = fs.statSync(skillPath)
    const updatedAt =
      (typeof meta?.updatedAt === 'string' && meta.updatedAt) || stats.mtime.toISOString()
    const enabled =
      typeof meta?.enabled === 'boolean'
        ? meta.enabled
        : typeof parsed.enabled === 'boolean'
          ? parsed.enabled
          : true
    const name = (typeof meta?.name === 'string' && meta.name.trim()) || parsed.name?.trim() || id
    const description =
      (typeof meta?.description === 'string' && meta.description) || parsed.description || ''
    return {
      id,
      name,
      description,
      body: parsed.body,
      relativePath: SKILL_FILE,
      enabled,
      scope,
      ...(scope === 'workspace' && workspaceId ? { workspaceId } : {}),
      updatedAt
    }
  }

  private upsertInRoot(
    root: string,
    scope: SkillScope,
    input: UpsertSkillInput,
    workspaceId?: string
  ): SkillRecord {
    const id = assertSafeSkillId(input.id?.trim() || this.uuid())
    const name = (input.name || '').trim()
    if (!name) throw new Error('Skill name is required.')
    const description = (input.description ?? '').trim()
    const body = input.body ?? ''
    const enabled = input.enabled !== false
    const updatedAt = this.now().toISOString()

    this.ensureRoot(root)
    const skillDir = this.resolveSkillDirectory(root, id)
    fs.mkdirSync(skillDir, { recursive: true, mode: 0o700 })

    const markdown = renderSkillMarkdown({ name, description, enabled, body })
    const skillPath = path.join(skillDir, SKILL_FILE)
    if (!pathWithinRoot(skillPath, path.resolve(root))) {
      throw new Error(`Skill path escapes root: ${id}`)
    }
    fs.writeFileSync(skillPath, markdown, 'utf8')
    const meta: SkillMetaFile = {
      id,
      updatedAt,
      enabled,
      name,
      description
    }
    fs.writeFileSync(path.join(skillDir, META_FILE), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')

    return {
      id,
      name,
      description,
      body,
      relativePath: SKILL_FILE,
      enabled,
      scope,
      ...(scope === 'workspace' && workspaceId ? { workspaceId } : {}),
      updatedAt
    }
  }

  private deleteInRoot(root: string, id: string): boolean {
    const skillDir = this.resolveSkillDirectory(root, id)
    if (!fs.existsSync(skillDir)) return false
    fs.rmSync(skillDir, { recursive: true, force: true })
    return true
  }

  private setEnabledInRoot(
    root: string,
    scope: SkillScope,
    id: string,
    enabled: boolean,
    workspaceId?: string
  ): SkillRecord {
    const existing = this.readSkillRecord(
      this.resolveSkillDirectory(root, id),
      assertSafeSkillId(id),
      scope,
      workspaceId
    )
    if (!existing) throw new Error(`Skill not found: ${id}`)
    return this.upsertInRoot(
      root,
      scope,
      {
        id: existing.id,
        name: existing.name,
        description: existing.description,
        body: existing.body,
        enabled
      },
      workspaceId
    )
  }
}
