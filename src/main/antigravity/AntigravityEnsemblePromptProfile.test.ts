import { describe, expect, it } from 'vitest'
import {
  ANTIGRAVITY_OFFICIAL_AGY_PROMPT_MAX_CHARS,
  buildAntigravityOfficialAgyPromptCapsule,
  buildAntigravityOfficialAgyPromptCapsuleProjection,
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

  it('preserves row identity through keep-tail and outer capsule bounds', () => {
    const repeatedRow = '[User]\nIDENTICAL STEERING TEXT'
    const filler = 'older context '.repeat(500)
    const transcript = `${repeatedRow}\n\n${filler}\n\n${repeatedRow}`
    const newerStart = transcript.length - repeatedRow.length
    const projection = buildAntigravityOfficialAgyPromptCapsuleProjection(
      {
        participantLabel: 'AntiGravity / GemProWork #p7',
        roundId: 'round-identity',
        roleInstructions: 'Review the exact request.',
        currentPrompt: 'CURRENT '.repeat(500),
        roster: '1. AntiGravity / GemProWork',
        authorityLines: [],
        roleBoundaryLines: [],
        roundPolicy: 'Turn-bound round.',
        parallelPolicy: 'Read-only fan-out may run concurrently.',
        dynamicState: 'Active goal: preserve exact delivery identity.',
        transcript,
        permissionRule: 'Use only the tools listed by this run.',
        yieldExecutionCheck: 'Use only a listed lifecycle handoff.'
      },
      {
        currentPromptMessageId: 'current-too-long',
        transcriptRows: [
          { messageId: 'older-identical', start: 0, end: repeatedRow.length },
          {
            messageId: 'newer-identical',
            start: newerStart,
            end: newerStart + repeatedRow.length
          }
        ]
      }
    )

    expect(projection.prompt).toContain(repeatedRow)
    expect(projection.suppliedMessageIds).toEqual(['newer-identical'])
    expect(projection.suppliedMessageIds).not.toContain('current-too-long')
  })

  it('places the advisory boundary immediately before the lifecycle response tail', () => {
    const prompt = buildAntigravityOfficialAgyPromptCapsule({
      participantLabel: 'AntiGravity / Reviewer #p7',
      roundId: 'round-advisory',
      stageRole: 'reviewer',
      roleInstructions: 'Review and report evidence.',
      currentPrompt: 'Review the current implementation.',
      roster: '1. AntiGravity / Reviewer\n2. Codex / Worker',
      authorityLines: [],
      roleBoundaryLines: [],
      turnBoundary:
        'Advisory turn boundary (Review; host guidance): Do not edit files or complete the goal. Fallback takeover is NOT AVAILABLE.',
      roundPolicy: 'Turn-bound round.',
      parallelPolicy: 'Use normal panel rotation.',
      dynamicState: 'Active goal: verify the implementation.',
      transcript: '[Codex / Worker]\nImplementation landed.',
      permissionRule: 'Use only the tools listed by this run.',
      yieldExecutionCheck: 'Lifecycle handoff check: use only a listed tool.'
    })

    const boundaryAt = prompt.indexOf('Advisory turn boundary')
    const lifecycleAt = prompt.indexOf('Lifecycle handoff check')
    expect(boundaryAt).toBeGreaterThan(prompt.indexOf('Current assignment:'))
    expect(lifecycleAt).toBeGreaterThan(boundaryAt)
    expect(prompt).toContain('Fallback takeover is NOT AVAILABLE')
  })

  it('drops evidence for a row cut by the outer capsule budget', () => {
    const row = '[User]\nLATEST STEER AT TRANSCRIPT TAIL'
    const transcript = `${'old transcript '.repeat(400)}\n\n${row}`
    const rowStart = transcript.length - row.length
    const projection = buildAntigravityOfficialAgyPromptCapsuleProjection(
      {
        participantLabel: 'AntiGravity / GemProWork #p7',
        roundId: 'round-outer-bound',
        stageRole: 'Z'.repeat(4_000),
        roleInstructions: 'R'.repeat(1_000),
        currentPrompt: 'C'.repeat(3_000),
        roster: 'O'.repeat(1_200),
        authorityLines: ['A'.repeat(1_200)],
        roleBoundaryLines: [],
        roundPolicy: 'P'.repeat(900),
        parallelPolicy: 'L'.repeat(700),
        dynamicState: 'D'.repeat(1_800),
        workspaceStanza: 'W'.repeat(600),
        workspaceChurnStanza: 'H'.repeat(900),
        scoutBriefs: 'S'.repeat(1_200),
        blackboardSnapshot: 'B'.repeat(2_200),
        seatSummary: 'E'.repeat(800),
        transcript,
        permissionRule: 'M'.repeat(900),
        yieldExecutionCheck: 'Y'.repeat(700)
      },
      {
        currentPromptMessageId: 'current-retained',
        transcriptRows: [
          { messageId: 'tail-cut-by-outer-cap', start: rowStart, end: transcript.length }
        ]
      }
    )

    expect(projection.prompt.length).toBeLessThanOrEqual(ANTIGRAVITY_OFFICIAL_AGY_PROMPT_MAX_CHARS)
    expect(projection.suppliedMessageIds).toContain('current-retained')
    expect(projection.suppliedMessageIds).not.toContain('tail-cut-by-outer-cap')
  })
})
