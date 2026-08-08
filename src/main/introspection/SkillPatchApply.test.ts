import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SkillsStore } from '../skills/SkillsStore'
import {
  applySkillPatch,
  parseSkillPatchDiff,
  rollbackSkillPatch,
  resolveSkillPatchTarget
} from './SkillPatchApply'
import type { MemoryProposal, MemoryProposalPack } from '../store/types'

const NOW = '2026-08-08T14:00:00.000Z'

let userDataPath = ''
let workspacePath = ''

beforeEach(() => {
  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-skill-patch-user-'))
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-skill-patch-ws-'))
})

afterEach(() => {
  if (userDataPath) fs.rmSync(userDataPath, { recursive: true, force: true })
  if (workspacePath) fs.rmSync(workspacePath, { recursive: true, force: true })
  userDataPath = ''
  workspacePath = ''
})

function proposal(over: Partial<MemoryProposal> = {}): MemoryProposal {
  return {
    id: 'prop-skill-1',
    kind: 'skill_patch',
    scope: 'skill',
    status: 'approved',
    title: 'Skill patch: scoped Prettier',
    lesson: 'Prefer scoped Prettier over repo-wide format.',
    confidence: 0.7,
    evidenceRefs: [
      {
        chatId: 'chat-1',
        timestamp: NOW,
        summary: 'User corrected format habit'
      }
    ],
    dedupKey: 'skill:prettier',
    requiresReview: true,
    createdAt: NOW,
    updatedAt: NOW,
    suggestedApplyTarget: 'taskwraith_skill',
    ...over
  }
}

function pack(over: Partial<MemoryProposalPack> = {}): MemoryProposalPack {
  return {
    schemaVersion: 1,
    id: 'pack-1',
    introspectionRunId: 'run-1',
    workspaceId: 'ws-1',
    workspacePath,
    windowStart: NOW,
    windowEnd: NOW,
    proposals: [proposal()],
    evidenceItemCount: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...over
  }
}

describe('SkillPatchApply', () => {
  it('parses structured skillPatchDiff and synthesizes from lesson when absent', () => {
    expect(
      parseSkillPatchDiff({
        skillId: 'prettier-scope',
        skillScope: 'workspace',
        body: 'Use scoped Prettier only.'
      })
    ).toEqual({
      skillId: 'prettier-scope',
      skillScope: 'workspace',
      body: 'Use scoped Prettier only.'
    })

    const synthesized = resolveSkillPatchTarget(
      proposal({ skillPatchDiff: undefined }),
      pack()
    )
    expect(synthesized.ok).toBe(true)
    if (!synthesized.ok) return
    expect(synthesized.target.skillId).toBe('intro-prop-skill-1')
    expect(synthesized.target.body).toContain('Prefer scoped Prettier')
    expect(synthesized.target.skillScope).toBe('workspace')
  })

  it('writes an approved skill_patch into the workspace TaskWraith skill root', () => {
    const skillsStore = new SkillsStore({
      userDataPath,
      now: () => new Date(NOW)
    })
    const prop = proposal({
      skillPatchDiff: JSON.stringify({
        skillId: 'scoped-prettier',
        skillScope: 'workspace',
        name: 'Scoped Prettier',
        description: 'From introspection',
        body: 'Never run repo-wide Prettier.'
      })
    })
    const memoryPack = pack({ proposals: [prop] })

    const result = applySkillPatch({
      skillsStore,
      proposal: prop,
      pack: memoryPack,
      nowIso: NOW
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.skillId).toBe('scoped-prettier')
    expect(result.applyReceipt.target).toBe('TaskWraithSkill')
    expect(result.applyReceipt.rollbackSnapshot?.previousBody).toBeNull()

    const written = skillsStore.listWorkspaceSkills(workspacePath, 'ws-1')
    expect(written).toEqual([
      expect.objectContaining({
        id: 'scoped-prettier',
        name: 'Scoped Prettier',
        body: 'Never run repo-wide Prettier.',
        scope: 'workspace'
      })
    ])
    expect(
      fs.existsSync(path.join(workspacePath, '.taskwraith', 'skills', 'scoped-prettier', 'SKILL.md'))
    ).toBe(true)
  })

  it('rejects path-escaping skill ids', () => {
    const skillsStore = new SkillsStore({
      userDataPath,
      now: () => new Date(NOW)
    })
    const prop = proposal({
      skillPatchDiff: JSON.stringify({
        skillId: '../escape',
        skillScope: 'user',
        body: 'bad'
      })
    })
    const result = applySkillPatch({
      skillsStore,
      proposal: prop,
      pack: pack({ proposals: [prop] }),
      nowIso: NOW
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.blocked).toBe('skill_patch_path_escape')
    expect(fs.existsSync(path.join(userDataPath, 'outside.txt'))).toBe(false)
    expect(skillsStore.listUserSkills()).toHaveLength(0)
  })

  it('rollback restores the previous skill body from the apply receipt snapshot', () => {
    const skillsStore = new SkillsStore({
      userDataPath,
      now: () => new Date(NOW)
    })
    skillsStore.upsertUserSkill({
      id: 'keep-short',
      name: 'Keep Short',
      description: 'prior',
      body: 'original body',
      enabled: true
    })

    const prop = proposal({
      skillPatchDiff: JSON.stringify({
        skillId: 'keep-short',
        skillScope: 'user',
        name: 'Keep Short',
        description: 'updated',
        body: 'patched body'
      })
    })
    const applied = applySkillPatch({
      skillsStore,
      proposal: prop,
      pack: pack({ proposals: [prop], workspacePath: undefined, workspaceId: undefined }),
      nowIso: NOW
    })
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    expect(skillsStore.listUserSkills()[0]?.body).toBe('patched body')
    expect(applied.applyReceipt.rollbackSnapshot?.previousBody).toBe('original body')

    const rolled = rollbackSkillPatch({
      skillsStore,
      applyReceipt: applied.applyReceipt,
      workspacePath: undefined
    })
    expect(rolled.ok).toBe(true)
    expect(skillsStore.listUserSkills()[0]?.body).toBe('original body')
    expect(skillsStore.listUserSkills()[0]?.description).toBe('prior')
  })
})
