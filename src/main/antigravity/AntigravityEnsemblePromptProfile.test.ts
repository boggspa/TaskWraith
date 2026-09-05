import { describe, expect, it } from 'vitest'
import { buildAgentWorkContract } from '../../host-shared/AgentWorkContract'
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
    expect(prompt).toContain('attempt `read_file` when listed')
    expect(prompt).toContain('dot-prefixed children such as `.local-only`')
    expect(prompt).toContain('received an explicit denied/error tool result')
    expect(prompt).toContain('No tool attempt, an unavailable tool, or an absolute path spelling')
    expect(prompt).not.toContain('call blackboard_read')
    expect(prompt).not.toContain('Recent tagged transcript:')
  })

  it('describes the MCP tool surface conditionally, never as flatly absent', () => {
    // TaskWraith now registers its MCP server into agy's global config for the
    // duration of a run, so the old flat denial ("blackboard_read and other
    // TaskWraith tools are not available on this transport") would send a seat
    // that HAS the tools off to delegate its work to a peer — the exact
    // behaviour that surfaced this whole defect. The registration is still
    // best-effort, so the capsule must not promise them either.
    const prompt = buildAntigravityOfficialAgyPromptCapsule({
      participantLabel: 'AntiGravity / Work3 #p8',
      roundId: 'round-2',
      roleInstructions: 'Seal the borders.',
      currentPrompt: 'Stitch the eastern gate.',
      roster: '1. AntiGravity / Work3',
      authorityLines: [],
      roleBoundaryLines: [],
      roundPolicy: 'Turn-bound round.',
      parallelPolicy: 'Serial.',
      dynamicState: 'Active goal: seal the borders.',
      blackboardSnapshot: 'decision: route3-east is the left gate.',
      transcript: '[Codex / Worker] prior context',
      permissionRule: 'Use only the tools listed by this run.',
      yieldExecutionCheck: 'Lifecycle handoff check: use only a listed tool.'
    })

    expect(prompt).not.toContain('are not available on this transport')
    expect(prompt).not.toContain('has no TaskWraith MCP bridge')
    expect(prompt).toContain('when the registration is live')
    expect(prompt).toContain('only if your runtime actually lists them')
  })

  it('recombines split work and dynamic state without changing a no-checkpoint prompt', () => {
    const workContract = 'NEW_USER_GOAL: preserve the accepted request.'
    const dynamicState = 'Optional dynamic snapshot.'
    const base = {
      participantLabel: 'AntiGravity / Work3 #p8',
      roundId: 'round-split-state',
      roleInstructions: 'Seal the borders.',
      currentPrompt: 'Stitch the eastern gate.',
      roster: '1. AntiGravity / Work3',
      authorityLines: [] as string[],
      roleBoundaryLines: [] as string[],
      roundPolicy: 'Review once.',
      parallelPolicy: 'Serial.',
      transcript: '[Codex / Worker] prior context',
      permissionRule: 'Use only the tools listed by this run.',
      yieldExecutionCheck: 'Return a bounded result.'
    }
    const legacy = buildAntigravityOfficialAgyPromptCapsuleProjection({
      ...base,
      dynamicState: `${workContract}\n\n${dynamicState}`
    })
    const split = buildAntigravityOfficialAgyPromptCapsuleProjection({
      ...base,
      workContract,
      dynamicState
    })

    expect(split).toEqual(legacy)
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
    expect(prompt).not.toContain('The Workspace subject above is host-authoritative')
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

  it('accepts a complete hint-free checkpoint after the current assignment', () => {
    const continuityCheckpoint = [
      '<taskwraith_private_continuity_checkpoint>',
      'OFFICIAL_AGY_CHECKPOINT '.repeat(70),
      '</taskwraith_private_continuity_checkpoint>'
    ].join('\n')
    const projection = buildAntigravityOfficialAgyPromptCapsuleProjection({
      participantLabel: 'AntiGravity / Reviewer #p7',
      roundId: 'round-continuity',
      stageRole: 'reviewer',
      roleInstructions: 'Review the current implementation.',
      currentPrompt: 'CURRENT_ASSIGNMENT remains ahead of recovery context.',
      roster: '1. AntiGravity / Reviewer\n2. Codex / Worker',
      authorityLines: [],
      roleBoundaryLines: [],
      roundPolicy: 'Review once.',
      parallelPolicy: 'Use normal panel rotation.',
      dynamicState: 'Active goal: verify continuity delivery.',
      continuityCheckpoint,
      transcript: '[Codex / Worker]\nImplementation landed.',
      permissionRule: 'Use only tools listed by this run.',
      yieldExecutionCheck: 'Return a bounded review.'
    })

    expect(projection.prompt.length).toBeLessThanOrEqual(ANTIGRAVITY_OFFICIAL_AGY_PROMPT_MAX_CHARS)
    expect(projection.continuityCheckpointIncluded).toBe(true)
    expect(projection.prompt).toContain(continuityCheckpoint)
    expect(projection.prompt.indexOf('CURRENT_ASSIGNMENT')).toBeLessThan(
      projection.prompt.indexOf(continuityCheckpoint)
    )
    expect(projection.prompt.indexOf('Permission and native-tool boundary:')).toBeLessThan(
      projection.prompt.indexOf(continuityCheckpoint)
    )
    expect(projection.prompt.indexOf('Return a bounded review.')).toBeLessThan(
      projection.prompt.indexOf(continuityCheckpoint)
    )
    expect(projection.prompt).not.toMatch(/tw_checkpoint|tw_history_(?:search|read)/)
  })

  it('funds a complete checkpoint in a saturated capsule by displacing transcript evidence', () => {
    const row = '[User]\nLATEST STEER AT TRANSCRIPT TAIL'
    const transcript = `${'T'.repeat(3_000 - row.length)}${row}`
    const rowStart = transcript.length - row.length
    const workContract = buildAgentWorkContract({
      activeGoal: {
        id: 'current-goal',
        objective: 'NEW_USER_GOAL',
        status: 'active',
        mode: 'taskwraith_steered',
        specification: {
          kind: 'approved_plan',
          acceptanceCriteria: [`Keep the current goal binding. ${'A'.repeat(1_300)}`]
        }
      },
      assignment: {
        id: 'current-assignment',
        objective: 'CURRENT_ASSIGNMENT',
        status: 'in_progress'
      },
      completionAuthority: 'assignment'
    })
    expect(workContract.length).toBeGreaterThan(1_800)
    const crowded = {
      participantLabel: 'P',
      roundId: 'r',
      stageRole: 'Z'.repeat(4_400),
      roleInstructions: 'R'.repeat(400),
      currentPrompt: `CURRENT_ASSIGNMENT ${'C'.repeat(1_000)}`,
      roster: 'O'.repeat(500),
      authorityLines: ['A'.repeat(300)],
      roleBoundaryLines: [] as string[],
      roundPolicy: 'P'.repeat(400),
      parallelPolicy: 'L'.repeat(300),
      workContract,
      dynamicState: 'OPTIONAL_DYNAMIC_SNAPSHOT '.repeat(90),
      workspaceStanza: 'W'.repeat(300),
      workspaceChurnStanza: 'H'.repeat(900),
      scoutBriefs: 'S'.repeat(1_200),
      blackboardSnapshot: 'B'.repeat(2_200),
      seatSummary: 'E'.repeat(800),
      transcript,
      permissionRule: 'M'.repeat(400),
      yieldExecutionCheck: 'Y'.repeat(300)
    }
    const evidence = {
      currentPromptMessageId: 'current-retained',
      transcriptRows: [
        { messageId: 'tail-cut-by-outer-cap', start: rowStart, end: transcript.length }
      ]
    }
    const baseline = buildAntigravityOfficialAgyPromptCapsuleProjection(crowded, evidence)
    expect(baseline.prompt).toHaveLength(ANTIGRAVITY_OFFICIAL_AGY_PROMPT_MAX_CHARS)
    const continuityCheckpoint = `<checkpoint>OLDER_CHECKPOINT_GOAL ${'X'.repeat(1_537)}</checkpoint>`
    const recovered = buildAntigravityOfficialAgyPromptCapsuleProjection(
      {
        ...crowded,
        continuityCheckpoint
      },
      evidence
    )

    expect(recovered.prompt.length).toBeLessThanOrEqual(ANTIGRAVITY_OFFICIAL_AGY_PROMPT_MAX_CHARS)
    expect(recovered.continuityCheckpointIncluded).toBe(true)
    expect(recovered).not.toHaveProperty('continuityCheckpointOmitted')
    expect(recovered.prompt).toContain(continuityCheckpoint)
    expect(recovered.prompt).toContain(workContract)
    expect(recovered.prompt).toContain('NEW_USER_GOAL')
    expect(recovered.prompt).toContain('OLDER_CHECKPOINT_GOAL')
    expect(recovered.prompt.indexOf('CURRENT_ASSIGNMENT')).toBeLessThan(
      recovered.prompt.indexOf(continuityCheckpoint)
    )
    expect(recovered.prompt.indexOf('Permission and native-tool boundary:')).toBeLessThan(
      recovered.prompt.indexOf(continuityCheckpoint)
    )
    expect(recovered.suppliedMessageIds).toContain('current-retained')
    expect(recovered.suppliedMessageIds).not.toContain('tail-cut-by-outer-cap')
  })

  it('reports why a checkpoint cannot fit beside the required contract', () => {
    const requiredHeavy = {
      participantLabel: 'AntiGravity / Reviewer #p7',
      roundId: 'round-required-overflow',
      stageRole: 'Z'.repeat(18_000),
      roleInstructions: 'Review the current implementation.',
      currentPrompt: 'CURRENT_ASSIGNMENT remains first.',
      roster: '1. AntiGravity / Reviewer',
      authorityLines: [] as string[],
      roleBoundaryLines: [] as string[],
      roundPolicy: 'Review once.',
      parallelPolicy: 'Serial.',
      dynamicState: '',
      transcript: '',
      permissionRule: 'Use only tools listed by this run.',
      yieldExecutionCheck: 'Return a bounded review.'
    }
    const baseline = buildAntigravityOfficialAgyPromptCapsuleProjection(requiredHeavy)
    const attempted = buildAntigravityOfficialAgyPromptCapsuleProjection({
      ...requiredHeavy,
      continuityCheckpoint: `<checkpoint>${'X'.repeat(1_560)}</checkpoint>`
    })

    expect(attempted.prompt).toBe(baseline.prompt)
    expect(attempted.suppliedMessageIds).toEqual(baseline.suppliedMessageIds)
    expect(attempted).not.toHaveProperty('continuityCheckpointIncluded')
    expect(attempted.continuityCheckpointOmitted).toBe(
      'required-contract-and-checkpoint-exceed-budget'
    )
    expect(attempted.prompt).not.toContain('<checkpoint>')
  })
})
