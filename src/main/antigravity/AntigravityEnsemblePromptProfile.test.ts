import { describe, expect, it } from 'vitest'
import {
  ANTIGRAVITY_OFFICIAL_AGY_PROMPT_MAX_CHARS,
  buildAntigravityOfficialAgyPromptCapsule,
  resolveEnsemblePromptTransportProfile
} from './AntigravityEnsemblePromptProfile'

describe('AntiGravity official-agy ensemble prompt profile', () => {
  it('distinguishes official agy from the Gemini API transport', () => {
    expect(resolveEnsemblePromptTransportProfile('antigravity', 'gemini-3.1-pro-high')).toBe(
      'antigravity-official-agy'
    )
    expect(
      resolveEnsemblePromptTransportProfile('antigravity', 'gemini-api:gemini-2.5-flash')
    ).toBe('default')
    expect(resolveEnsemblePromptTransportProfile('codex', 'gpt-5.5')).toBe('default')
  })

  it('keeps the official-agy capsule bounded and truthful about its tool surface', () => {
    const prompt = buildAntigravityOfficialAgyPromptCapsule({
      participantLabel: 'AntiGravity / GemProWork #p7',
      roundId: 'round-1',
      stageRole: 'worker',
      roleInstructions: 'Review the requested changes and report concrete evidence.',
      currentPrompt: 'Current assignment '.repeat(500),
      roster: '1. AntiGravity / GemProWork\n2. Codex / Worker',
      authorityLines: ['Boss/Captain checkpoint: preserve the assigned scope.'],
      roleBoundaryLines: ['Leave peer-owned implementation to the worker seat.'],
      roundPolicy: 'Turn-bound round.',
      parallelPolicy: 'Read-only fan-out may run concurrently.',
      dynamicState: 'Active goal: keep the workspace lock boundary intact.',
      workspaceStanza: 'Round subject: /workspace/project',
      workspaceChurnStanza: 'Workspace churn: scripts/work-guard.cjs changed.',
      scoutBriefs: 'Scout brief: the exact provider route is official agy.',
      blackboardSnapshot: 'In-scope host-owned Blackboard entries:\ndecision: use the broker.',
      seatSummary: 'Prior seat summary: no prior output.',
      transcript: '[Codex / Worker]\n' + 'recent context '.repeat(500),
      permissionRule: 'Use only the tools listed by this run.',
      yieldExecutionCheck: 'Lifecycle handoff check: use only a listed tool.'
    })

    expect(prompt.length).toBeLessThanOrEqual(ANTIGRAVITY_OFFICIAL_AGY_PROMPT_MAX_CHARS)
    expect(prompt).toContain('Current assignment:')
    expect(prompt).toContain('Host-owned Blackboard snapshot:')
    expect(prompt).toContain('read_file is listed')
    expect(prompt).toContain('outside-workspace path requires an explicit host grant/approval')
    expect(prompt).not.toContain('call blackboard_read')
    expect(prompt).not.toContain('Recent tagged transcript:')
  })
})
