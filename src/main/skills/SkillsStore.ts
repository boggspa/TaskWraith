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

function realpathNative(input: string): string {
  return typeof fs.realpathSync.native === 'function'
    ? fs.realpathSync.native(input)
    : fs.realpathSync(input)
}

/**
 * Lexical + realpath containment under an intended skills root.
 * Rejects skill-dir symlink escapes that leave the root after resolution.
 */
function assertContainedUnderSkillsRoot(candidate: string, root: string, label: string): string {
  const resolvedRoot = path.resolve(root)
  const resolvedCandidate = path.resolve(candidate)
  if (!pathWithinRoot(resolvedCandidate, resolvedRoot)) {
    throw new Error(`Skill path escapes root: ${label}`)
  }

  let realRoot: string
  try {
    realRoot = realpathNative(resolvedRoot)
  } catch {
    // Root does not exist yet — only the lexical check is available.
    return resolvedCandidate
  }

  if (fs.existsSync(resolvedCandidate)) {
    let realCandidate: string
    try {
      realCandidate = realpathNative(resolvedCandidate)
    } catch {
      throw new Error(`Skill path escapes root: ${label}`)
    }
    if (!pathWithinRoot(realCandidate, realRoot)) {
      throw new Error(`Skill path escapes root: ${label}`)
    }
    return realCandidate
  }

  // Missing leaf: ensure the deepest existing ancestor stays under the real root
  // (blocks intermediate symlink hops that leave the skills root).
  let cursor = resolvedCandidate
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  if (fs.existsSync(cursor)) {
    let realAncestor: string
    try {
      realAncestor = realpathNative(cursor)
    } catch {
      throw new Error(`Skill path escapes root: ${label}`)
    }
    if (!pathWithinRoot(realAncestor, realRoot)) {
      throw new Error(`Skill path escapes root: ${label}`)
    }
  }
  return resolvedCandidate
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
    return assertContainedUnderSkillsRoot(candidate, resolvedRoot, safeId)
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
    let containedRoot: string
    try {
      containedRoot = assertContainedUnderSkillsRoot(resolvedRoot, resolvedRoot, 'skills-root')
    } catch {
      return []
    }
    const entries = fs.readdirSync(containedRoot, { withFileTypes: true })
    const skills: SkillRecord[] = []
    for (const entry of entries) {
      // Dirent.isDirectory() follows symlinks; also accept symlink entries and
      // let resolveSkillDirectory reject escapes after realpath.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      try {
        const record = this.readSkillRecord(
          this.resolveSkillDirectory(containedRoot, entry.name),
          entry.name,
          scope,
          workspaceId,
          containedRoot
        )
        if (record) skills.push(record)
      } catch {
        // Skip unsafe or unreadable entries (including symlink escapes).
      }
    }
    return skills.sort((a, b) => a.id.localeCompare(b.id))
  }

  private readSkillRecord(
    skillDir: string,
    id: string,
    scope: SkillScope,
    workspaceId?: string,
    skillsRoot?: string
  ): SkillRecord | null {
    const root = skillsRoot ?? path.dirname(skillDir)
    const containedDir = assertContainedUnderSkillsRoot(skillDir, root, id)
    const skillPath = path.join(containedDir, SKILL_FILE)
    if (!fs.existsSync(skillPath)) return null
    const containedSkillPath = assertContainedUnderSkillsRoot(skillPath, root, id)
    const raw = fs.readFileSync(containedSkillPath, 'utf8')
    const parsed = parseSkillMarkdown(raw)
    const meta = readMeta(path.join(containedDir, META_FILE))
    const stats = fs.statSync(containedSkillPath)
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
    const containedRoot = assertContainedUnderSkillsRoot(root, root, 'skills-root')
    // Reject pre-existing symlink escapes before mkdir/write can follow them.
    const skillDir = this.resolveSkillDirectory(containedRoot, id)
    fs.mkdirSync(skillDir, { recursive: true, mode: 0o700 })
    const containedDir = assertContainedUnderSkillsRoot(skillDir, containedRoot, id)

    const markdown = renderSkillMarkdown({ name, description, enabled, body })
    const skillPath = path.join(containedDir, SKILL_FILE)
    const containedSkillPath = assertContainedUnderSkillsRoot(skillPath, containedRoot, id)
    fs.writeFileSync(containedSkillPath, markdown, 'utf8')
    const meta: SkillMetaFile = {
      id,
      updatedAt,
      enabled,
      name,
      description
    }
    const metaPath = assertContainedUnderSkillsRoot(
      path.join(containedDir, META_FILE),
      containedRoot,
      id
    )
    fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')

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
    const containedRoot = fs.existsSync(root)
      ? assertContainedUnderSkillsRoot(root, root, 'skills-root')
      : path.resolve(root)
    const skillDir = this.resolveSkillDirectory(containedRoot, id)
    if (!fs.existsSync(skillDir)) return false
    // Refuse to delete through a symlink that escapes the skills root.
    const containedDir = assertContainedUnderSkillsRoot(skillDir, containedRoot, id)
    const lstat = fs.lstatSync(skillDir)
    if (lstat.isSymbolicLink()) {
      // Contained symlink only: remove the link inode, not a followed target tree.
      fs.unlinkSync(skillDir)
      return true
    }
    fs.rmSync(containedDir, { recursive: true, force: true })
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
