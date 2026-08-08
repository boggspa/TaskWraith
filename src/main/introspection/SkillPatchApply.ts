/*
 * Skill Patch Manager — apply approved skill_patch proposals to TaskWraith
 * skill roots only (userData/skills and workspace .taskwraith/skills).
 *
 * Writes go through SkillsStore upsert APIs. Each successful apply records a
 * rollback snapshot on the proposal receipt. There is no MCP apply path.
 */

import type {
  MemoryProposal,
  MemoryProposalApplyReceipt,
  MemoryProposalPack,
  MemoryProposalSkillRollbackSnapshot
} from '../store/types'
import type { SkillRecord, SkillScope, UpsertSkillInput } from '../../shared/skills/SkillTypes'
import type { SkillsStore } from '../skills/SkillsStore'

const SKILL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const SKILL_RELATIVE_PATH = 'SKILL.md'

export type SkillPatchApplyBlockReason =
  | 'skill_patch_invalid_target'
  | 'skill_patch_path_escape'
  | 'skills_store_unavailable'
  | 'workspace_path_required'

export interface SkillPatchDiffSpec {
  skillId?: string
  skillScope?: SkillScope
  name?: string
  description?: string
  body?: string
}

export interface ResolvedSkillPatchTarget {
  skillId: string
  skillScope: SkillScope
  name: string
  description: string
  body: string
}

export interface SkillPatchApplyDeps {
  skillsStore: Pick<
    SkillsStore,
    | 'listUserSkills'
    | 'listWorkspaceSkills'
    | 'upsertUserSkill'
    | 'upsertWorkspaceSkill'
    | 'deleteUserSkill'
    | 'deleteWorkspaceSkill'
  >
  proposal: MemoryProposal
  pack: MemoryProposalPack
  nowIso: string
}

export type ApplySkillPatchResult =
  | {
      ok: true
      skillId: string
      applyReceipt: MemoryProposalApplyReceipt
    }
  | { ok: false; blocked: SkillPatchApplyBlockReason; error?: string }

export type RollbackSkillPatchResult =
  | { ok: true }
  | { ok: false; blocked: SkillPatchApplyBlockReason; error?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function optionalTrimmedString(value: unknown, max = 500_000): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}

export function parseSkillPatchDiff(raw: unknown): SkillPatchDiffSpec | null {
  if (raw == null) return null
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return null
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown
        if (isRecord(parsed)) {
          return {
            ...(optionalTrimmedString(parsed.skillId, 128)
              ? { skillId: optionalTrimmedString(parsed.skillId, 128) }
              : {}),
            ...(parsed.skillScope === 'user' || parsed.skillScope === 'workspace'
              ? { skillScope: parsed.skillScope }
              : {}),
            ...(optionalTrimmedString(parsed.name, 200)
              ? { name: optionalTrimmedString(parsed.name, 200) }
              : {}),
            ...(optionalTrimmedString(parsed.description, 2000)
              ? { description: optionalTrimmedString(parsed.description, 2000) }
              : {}),
            ...(typeof parsed.body === 'string'
              ? { body: parsed.body }
              : optionalTrimmedString(parsed.body)
                ? { body: optionalTrimmedString(parsed.body) }
                : {})
          }
        }
      } catch {
        // Fall through — treat as plain body text.
      }
    }
    return { body: trimmed.slice(0, 500_000) }
  }
  if (isRecord(raw)) {
    return parseSkillPatchDiff(JSON.stringify(raw))
  }
  return null
}

export function sanitizeSkillIdCandidate(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (
    !SKILL_ID_RE.test(trimmed) ||
    trimmed.includes('..') ||
    trimmed.includes('/') ||
    trimmed.includes('\\')
  ) {
    return null
  }
  return trimmed
}

export function skillIdForProposal(proposalId: string): string {
  const cleaned = proposalId
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
  const base = cleaned || 'proposal'
  const candidate = `intro-${base}`
  return sanitizeSkillIdCandidate(candidate) ?? `intro-${base.replace(/[^a-zA-Z0-9]/g, '').slice(0, 100) || 'skill'}`
}

function defaultSkillScope(pack: MemoryProposalPack): SkillScope {
  return pack.workspacePath?.trim() ? 'workspace' : 'user'
}

export function resolveSkillPatchTarget(
  proposal: MemoryProposal,
  pack: MemoryProposalPack
):
  | { ok: true; target: ResolvedSkillPatchTarget }
  | { ok: false; blocked: SkillPatchApplyBlockReason } {
  const parsed = parseSkillPatchDiff(proposal.skillPatchDiff)
  const body =
    optionalTrimmedString(parsed?.body, 500_000) ||
    optionalTrimmedString(proposal.lesson, 500) ||
    ''
  if (!body) {
    return { ok: false, blocked: 'skill_patch_invalid_target' }
  }

  const requestedId = parsed?.skillId?.trim()
  if (requestedId) {
    if (!sanitizeSkillIdCandidate(requestedId)) {
      return { ok: false, blocked: 'skill_patch_path_escape' }
    }
  }

  const skillId = requestedId
    ? (sanitizeSkillIdCandidate(requestedId) as string)
    : skillIdForProposal(proposal.id)
  const skillScope = parsed?.skillScope ?? defaultSkillScope(pack)
  if (skillScope === 'workspace' && !pack.workspacePath?.trim()) {
    return { ok: false, blocked: 'workspace_path_required' }
  }

  const name =
    optionalTrimmedString(parsed?.name, 200) ||
    optionalTrimmedString(proposal.title, 200) ||
    skillId
  const description =
    optionalTrimmedString(parsed?.description, 2000) ||
    optionalTrimmedString(proposal.lesson, 500) ||
    ''

  return {
    ok: true,
    target: {
      skillId,
      skillScope,
      name,
      description,
      body
    }
  }
}

function findExistingSkill(
  skillsStore: SkillPatchApplyDeps['skillsStore'],
  skillScope: SkillScope,
  skillId: string,
  pack: MemoryProposalPack
): SkillRecord | null {
  const list =
    skillScope === 'user'
      ? skillsStore.listUserSkills()
      : skillsStore.listWorkspaceSkills(pack.workspacePath || '', pack.workspaceId)
  return list.find((item) => item.id === skillId) ?? null
}

function buildRollbackSnapshot(existing: SkillRecord | null): MemoryProposalSkillRollbackSnapshot {
  if (!existing) {
    return { previousBody: null }
  }
  return {
    previousBody: existing.body,
    previousName: existing.name,
    previousDescription: existing.description,
    previousEnabled: existing.enabled
  }
}

function upsertSkill(
  skillsStore: SkillPatchApplyDeps['skillsStore'],
  target: ResolvedSkillPatchTarget,
  pack: MemoryProposalPack,
  input: UpsertSkillInput
): SkillRecord {
  if (target.skillScope === 'user') {
    return skillsStore.upsertUserSkill(input)
  }
  const workspacePath = pack.workspacePath?.trim()
  if (!workspacePath) {
    throw new Error('Workspace path is required for workspace skill apply.')
  }
  return skillsStore.upsertWorkspaceSkill(workspacePath, input, pack.workspaceId)
}

export function applySkillPatch(deps: SkillPatchApplyDeps): ApplySkillPatchResult {
  if (!deps.skillsStore) {
    return { ok: false, blocked: 'skills_store_unavailable' }
  }

  const resolved = resolveSkillPatchTarget(deps.proposal, deps.pack)
  if (!resolved.ok) {
    return { ok: false, blocked: resolved.blocked }
  }

  const { target } = resolved
  let existing: SkillRecord | null
  try {
    existing = findExistingSkill(deps.skillsStore, target.skillScope, target.skillId, deps.pack)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/escape|Invalid skill id/i.test(message)) {
      return { ok: false, blocked: 'skill_patch_path_escape', error: message }
    }
    return { ok: false, blocked: 'skill_patch_invalid_target', error: message }
  }

  const rollbackSnapshot = buildRollbackSnapshot(existing)
  const upsertInput: UpsertSkillInput = {
    id: target.skillId,
    name: target.name,
    description: target.description,
    body: target.body,
    enabled: existing?.enabled !== false
  }

  try {
    upsertSkill(deps.skillsStore, target, deps.pack, upsertInput)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/escape|Invalid skill id/i.test(message)) {
      return { ok: false, blocked: 'skill_patch_path_escape', error: message }
    }
    return { ok: false, blocked: 'skill_patch_invalid_target', error: message }
  }

  const applyReceipt: MemoryProposalApplyReceipt = {
    appliedAt: deps.nowIso,
    target: 'TaskWraithSkill',
    skillId: target.skillId,
    skillScope: target.skillScope,
    skillRelativePath: SKILL_RELATIVE_PATH,
    rollbackSnapshot,
    packId: deps.pack.id,
    proposalId: deps.proposal.id
  }

  return {
    ok: true,
    skillId: target.skillId,
    applyReceipt
  }
}

export function rollbackSkillPatch(input: {
  skillsStore: SkillPatchApplyDeps['skillsStore']
  applyReceipt: MemoryProposalApplyReceipt
  workspacePath?: string
  workspaceId?: string
}): RollbackSkillPatchResult {
  const { applyReceipt, skillsStore } = input
  if (applyReceipt.target !== 'TaskWraithSkill') {
    return { ok: false, blocked: 'skill_patch_invalid_target' }
  }
  const skillId = applyReceipt.skillId?.trim()
  const skillScope = applyReceipt.skillScope
  if (!skillId || (skillScope !== 'user' && skillScope !== 'workspace')) {
    return { ok: false, blocked: 'skill_patch_invalid_target' }
  }
  if (!sanitizeSkillIdCandidate(skillId)) {
    return { ok: false, blocked: 'skill_patch_path_escape' }
  }

  const snapshot = applyReceipt.rollbackSnapshot
  try {
    if (!snapshot || snapshot.previousBody == null) {
      if (skillScope === 'user') {
        skillsStore.deleteUserSkill(skillId)
      } else {
        const workspacePath = input.workspacePath?.trim()
        if (!workspacePath) {
          return { ok: false, blocked: 'workspace_path_required' }
        }
        skillsStore.deleteWorkspaceSkill(workspacePath, skillId)
      }
      return { ok: true }
    }

    const upsertInput: UpsertSkillInput = {
      id: skillId,
      name: snapshot.previousName?.trim() || skillId,
      description: snapshot.previousDescription ?? '',
      body: snapshot.previousBody,
      enabled: snapshot.previousEnabled !== false
    }
    if (skillScope === 'user') {
      skillsStore.upsertUserSkill(upsertInput)
    } else {
      const workspacePath = input.workspacePath?.trim()
      if (!workspacePath) {
        return { ok: false, blocked: 'workspace_path_required' }
      }
      skillsStore.upsertWorkspaceSkill(workspacePath, upsertInput, input.workspaceId)
    }
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/escape|Invalid skill id/i.test(message)) {
      return { ok: false, blocked: 'skill_patch_path_escape', error: message }
    }
    return { ok: false, blocked: 'skill_patch_invalid_target', error: message }
  }
}

export function buildSkillPatchDiffForProposal(input: {
  proposalId: string
  title: string
  lesson: string
  skillScope?: SkillScope
}): string {
  const skillId = skillIdForProposal(input.proposalId)
  const body = input.lesson.trim() || input.title.trim()
  return JSON.stringify(
    {
      skillId,
      skillScope: input.skillScope ?? 'user',
      name: input.title.trim().slice(0, 200) || skillId,
      description: body.slice(0, 2000),
      body
    },
    null,
    2
  )
}
