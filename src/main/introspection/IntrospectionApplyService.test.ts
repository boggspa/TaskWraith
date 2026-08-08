import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyMemoryProposal } from './IntrospectionApplyService'
import { SkillsStore } from '../skills/SkillsStore'
import type {
  MemoryProposal,
  MemoryProposalPack,
  RepoConventionIndexSnapshot
} from '../store/types'

let skillUserDataPath = ''
let skillWorkspacePath = ''

beforeEach(() => {
  skillUserDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-apply-skills-user-'))
  skillWorkspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-apply-skills-ws-'))
})

afterEach(() => {
  if (skillUserDataPath) fs.rmSync(skillUserDataPath, { recursive: true, force: true })
  if (skillWorkspacePath) fs.rmSync(skillWorkspacePath, { recursive: true, force: true })
  skillUserDataPath = ''
  skillWorkspacePath = ''
})

const NOW = '2026-07-05T18:00:00.000Z'

function proposal(over: Partial<MemoryProposal> = {}): MemoryProposal {
  return {
    id: 'prop-1',
    kind: 'repo_convention',
    scope: 'workspace',
    status: 'approved',
    title: 'Avoid repo-wide Prettier',
    lesson: 'Do not run repo-wide Prettier.',
    confidence: 0.9,
    evidenceRefs: [
      {
        chatId: 'chat-1',
        timestamp: '2026-07-05T12:00:00.000Z',
        summary: 'User corrected assistant'
      }
    ],
    dedupKey: 'repo-prettier',
    requiresReview: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...over
  }
}

function pack(over: Partial<MemoryProposalPack> = {}): MemoryProposalPack {
  return {
    schemaVersion: 1,
    id: 'pack-1',
    introspectionRunId: 'run-1',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    windowStart: '2026-07-05T00:00:00.000Z',
    windowEnd: '2026-07-05T23:59:59.999Z',
    proposals: [proposal()],
    evidenceItemCount: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...over
  }
}

function makeStore(seed: {
  pack?: MemoryProposalPack | null
  conventionIndexes?: RepoConventionIndexSnapshot[]
}) {
  const conventionIndexes = [...(seed.conventionIndexes || [])]
  let currentPack = seed.pack === undefined ? pack() : seed.pack

  return {
    getMemoryProposalPack: vi.fn(() => currentPack),
    updateMemoryProposal: vi.fn((packId: string, proposalId: string, partial: Partial<MemoryProposal>) => {
      if (!currentPack || currentPack.id !== packId) return null
      const proposals = currentPack.proposals.map((item) =>
        item.id === proposalId ? { ...item, ...partial, id: proposalId, updatedAt: NOW } : item
      )
      currentPack = { ...currentPack, proposals, updatedAt: NOW }
      return currentPack
    }),
    getRepoConventionIndexes: vi.fn(() => conventionIndexes),
    saveRepoConventionIndex: vi.fn((snapshot: Partial<RepoConventionIndexSnapshot>) => {
      const saved: RepoConventionIndexSnapshot = {
        schemaVersion: 1,
        workspaceId: snapshot.workspaceId || 'ws-1',
        generatedAt: snapshot.generatedAt || NOW,
        entries: snapshot.entries || []
      }
      const index = conventionIndexes.findIndex((item) => item.workspaceId === saved.workspaceId)
      if (index >= 0) conventionIndexes[index] = saved
      else conventionIndexes.push(saved)
      return saved
    }),
    conventionIndexes,
    get currentPack() {
      return currentPack
    }
  }
}

describe('applyMemoryProposal', () => {
  it('applies an approved repo_convention proposal into RepoConventionIndex', () => {
    const store = makeStore({})
    const result = applyMemoryProposal({ store, now: () => NOW }, 'pack-1', 'prop-1')

    expect(result.ok).toBe(true)
    expect(result.conventionEntryId).toBe('intro-prop-1')
    expect(store.saveRepoConventionIndex).toHaveBeenCalledTimes(1)
    expect(store.conventionIndexes[0]?.entries).toEqual([
      expect.objectContaining({
        id: 'intro-prop-1',
        kind: 'decision',
        title: 'Avoid repo-wide Prettier',
        description: 'Do not run repo-wide Prettier.',
        provenance: 'introspection'
      })
    ])
    expect(store.updateMemoryProposal).toHaveBeenCalledWith(
      'pack-1',
      'prop-1',
      expect.objectContaining({
        status: 'applied',
        appliedAt: NOW,
        applyReceipt: expect.objectContaining({
          target: 'RepoConventionIndex',
          conventionEntryId: 'intro-prop-1'
        })
      })
    )
    expect(result.pack?.proposals[0]?.status).toBe('applied')
  })

  it('blocks unapproved proposals', () => {
    const store = makeStore({
      pack: pack({ proposals: [proposal({ status: 'proposed' })] })
    })
    const result = applyMemoryProposal({ store, now: () => NOW }, 'pack-1', 'prop-1')

    expect(result).toEqual({ ok: false, blocked: 'proposal_not_approved' })
    expect(store.saveRepoConventionIndex).not.toHaveBeenCalled()
    expect(store.updateMemoryProposal).not.toHaveBeenCalled()
  })

  it('applies an approved skill_patch into TaskWraith skill roots with rollback snapshot', () => {
    const skillsStore = new SkillsStore({
      userDataPath: skillUserDataPath,
      now: () => new Date(NOW)
    })
    const store = makeStore({
      pack: pack({
        workspacePath: skillWorkspacePath,
        proposals: [
          proposal({
            kind: 'skill_patch',
            scope: 'skill',
            skillPatchDiff: JSON.stringify({
              skillId: 'intro-rule',
              skillScope: 'workspace',
              name: 'Intro Rule',
              body: 'Always stage by explicit path.'
            })
          })
        ]
      })
    })
    const result = applyMemoryProposal(
      { store, skillsStore, now: () => NOW },
      'pack-1',
      'prop-1'
    )

    expect(result.ok).toBe(true)
    expect(result.skillId).toBe('intro-rule')
    expect(store.saveRepoConventionIndex).not.toHaveBeenCalled()
    expect(store.updateMemoryProposal).toHaveBeenCalledWith(
      'pack-1',
      'prop-1',
      expect.objectContaining({
        status: 'applied',
        applyReceipt: expect.objectContaining({
          target: 'TaskWraithSkill',
          skillId: 'intro-rule',
          skillScope: 'workspace',
          rollbackSnapshot: expect.objectContaining({ previousBody: null })
        })
      })
    )
    expect(
      skillsStore.listWorkspaceSkills(skillWorkspacePath, 'ws-1').map((s) => s.body)
    ).toEqual(['Always stage by explicit path.'])
  })

  it('blocks skill_patch when the skill id escapes the TaskWraith skill root', () => {
    const skillsStore = new SkillsStore({
      userDataPath: skillUserDataPath,
      now: () => new Date(NOW)
    })
    const store = makeStore({
      pack: pack({
        workspacePath: skillWorkspacePath,
        proposals: [
          proposal({
            kind: 'skill_patch',
            scope: 'skill',
            skillPatchDiff: JSON.stringify({
              skillId: '../escape',
              skillScope: 'user',
              body: 'nope'
            })
          })
        ]
      })
    })
    const result = applyMemoryProposal(
      { store, skillsStore, now: () => NOW },
      'pack-1',
      'prop-1'
    )
    expect(result).toEqual({ ok: false, blocked: 'skill_patch_path_escape' })
    expect(store.updateMemoryProposal).not.toHaveBeenCalled()
  })

  it('blocks workspace skill_patch when pack workspacePath is relative', () => {
    const skillsStore = new SkillsStore({
      userDataPath: skillUserDataPath,
      now: () => new Date(NOW)
    })
    const store = makeStore({
      pack: pack({
        workspacePath: path.join('relative', 'workspace'),
        proposals: [
          proposal({
            kind: 'skill_patch',
            scope: 'skill',
            skillPatchDiff: JSON.stringify({
              skillId: 'rel-blocked',
              skillScope: 'workspace',
              body: 'nope'
            })
          })
        ]
      })
    })
    const result = applyMemoryProposal(
      { store, skillsStore, now: () => NOW },
      'pack-1',
      'prop-1'
    )
    expect(result).toEqual({ ok: false, blocked: 'workspace_path_required' })
    expect(store.updateMemoryProposal).not.toHaveBeenCalled()
  })

  it('forwards assertWorkspacePath into skill_patch apply', () => {
    const skillsStore = new SkillsStore({
      userDataPath: skillUserDataPath,
      now: () => new Date(NOW)
    })
    const store = makeStore({
      pack: pack({
        workspacePath: skillWorkspacePath,
        proposals: [
          proposal({
            kind: 'skill_patch',
            scope: 'skill',
            skillPatchDiff: JSON.stringify({
              skillId: 'assert-forward',
              skillScope: 'workspace',
              name: 'Assert Forward',
              body: 'forwarded'
            })
          })
        ]
      })
    })
    const assertWorkspacePath = vi.fn((raw: string) => {
      expect(raw).toBe(skillWorkspacePath)
      return skillWorkspacePath
    })
    const result = applyMemoryProposal(
      { store, skillsStore, now: () => NOW, assertWorkspacePath },
      'pack-1',
      'prop-1'
    )
    expect(result.ok).toBe(true)
    expect(assertWorkspacePath).toHaveBeenCalledTimes(1)
  })

  it('is idempotent when the proposal is already applied', () => {
    const appliedPack = pack({
      proposals: [
        proposal({
          status: 'applied',
          appliedAt: NOW,
          applyReceipt: {
            appliedAt: NOW,
            target: 'RepoConventionIndex',
            conventionEntryId: 'intro-prop-1',
            packId: 'pack-1',
            proposalId: 'prop-1'
          }
        })
      ]
    })
    const store = makeStore({
      pack: appliedPack,
      conventionIndexes: [
        {
          schemaVersion: 1,
          workspaceId: 'ws-1',
          generatedAt: NOW,
          entries: [
            {
              id: 'intro-prop-1',
              kind: 'decision',
              title: 'Avoid repo-wide Prettier',
              provenance: 'introspection',
              updatedAt: NOW
            }
          ]
        }
      ]
    })

    const result = applyMemoryProposal({ store, now: () => NOW }, 'pack-1', 'prop-1')

    expect(result.ok).toBe(true)
    expect(result.conventionEntryId).toBe('intro-prop-1')
    expect(store.saveRepoConventionIndex).not.toHaveBeenCalled()
    expect(store.updateMemoryProposal).not.toHaveBeenCalled()
    expect(store.conventionIndexes[0]?.entries).toHaveLength(1)
  })
})