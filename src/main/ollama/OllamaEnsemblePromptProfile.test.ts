import { describe, expect, it } from 'vitest'
import {
  OLLAMA_ENSEMBLE_PROMPT_MAX_CHARS,
  buildOllamaEnsemblePromptCapsule,
  buildOllamaEnsemblePromptCapsuleProjection
} from './OllamaEnsemblePromptProfile'

const BASE = {
  participantLabel: 'Alibaba / Qwen3 #p1',
  modelLabel: 'qwen3:4b-instruct',
  selfToken: 'p1',
  roundId: 'round-1',
  stageRole: 'worker' as const,
  roleInstructions: 'Implement the request.',
  currentPrompt: 'Write a bad-code examples file in Test 1.',
  roster:
    '1. Alibaba / Qwen3 #p1 — address with @Qwen3\n2. Cohere / North #p17 — address with @North',
  authorityLines: [] as string[],
  roleBoundaryLines: [] as string[],
  roundPolicy: 'Turn-bound round: answer this assignment once.',
  parallelPolicy: 'Use normal panel rotation.',
  transcript: '[User]\nPrior note about Cursor seats #p7.',
  permissionRule: 'Use the tools listed for this run; Ask/read-only seats gather evidence only.'
}

describe('Ollama ensemble prompt capsule', () => {
  it('puts the current request before identity and keeps the capsule bounded', () => {
    const prompt = buildOllamaEnsemblePromptCapsule({
      ...BASE,
      currentPrompt: 'CURRENT_REQUEST_MARKER do the work',
      dynamicState: 'Active goal: ship the slice.',
      blackboardSnapshot: 'fact / jokes-count: 0'
    })

    expect(prompt.length).toBeLessThanOrEqual(OLLAMA_ENSEMBLE_PROMPT_MAX_CHARS)
    expect(prompt).toContain('Ollama context capsule')
    const requestAt = prompt.indexOf('CURRENT_REQUEST_MARKER')
    const identityAt = prompt.indexOf('You are a LOCAL model running through Ollama')
    expect(requestAt).toBeGreaterThanOrEqual(0)
    expect(identityAt).toBeGreaterThan(requestAt)
    expect(prompt).not.toContain('Rules:')
    expect(prompt).not.toContain('@Farmer')
    expect(prompt).not.toContain('ensemble_fanout')
    expect(prompt).toContain('tool-tests/')
    expect(prompt).toContain('ask_user_question only when')
    expect(prompt).toContain('blackboard_delete')
    expect(prompt).toContain('re-issue that same tool once with corrected args')
  })

  it('preserves transcript row identity through keep-tail truncation', () => {
    const repeatedRow = '[User]\nIDENTICAL STEERING TEXT'
    const filler = 'older context '.repeat(400)
    const transcript = `${repeatedRow}\n\n${filler}\n\n${repeatedRow}`
    const newerStart = transcript.length - repeatedRow.length
    const projection = buildOllamaEnsemblePromptCapsuleProjection(
      {
        ...BASE,
        currentPrompt: 'CURRENT '.repeat(200),
        transcript
      },
      {
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
    expect(projection.suppliedMessageIds).toContain('newer-identical')
    expect(projection.suppliedMessageIds).not.toContain('older-identical')
  })

  it('replaces the generic edit nudge with a late advisory-seat boundary', () => {
    const prompt = buildOllamaEnsemblePromptCapsule({
      ...BASE,
      stageRole: 'scout',
      roleInstructions: 'Investigate and report evidence.',
      turnBoundary:
        'Advisory turn boundary (Scout/Recon; host guidance): Do not edit files or complete the goal. Fallback takeover is NOT AVAILABLE.'
    })

    expect(prompt.indexOf('Advisory turn boundary')).toBeGreaterThan(
      prompt.indexOf('Do this turn:')
    )
    expect(prompt).toContain('Prefer one concrete read/search check')
    expect(prompt).not.toContain('small edit, or shell')
  })

  it('accepts a complete checkpoint inside the capsule after the current request', () => {
    const continuityCheckpoint = [
      '<taskwraith_private_continuity_checkpoint>',
      'CHECKPOINT_BODY '.repeat(60),
      '</taskwraith_private_continuity_checkpoint>'
    ].join('\n')
    const projection = buildOllamaEnsemblePromptCapsuleProjection({
      ...BASE,
      currentPrompt: 'CURRENT_ASSIGNMENT stays first.',
      continuityCheckpoint
    })

    expect(projection.prompt.length).toBeLessThanOrEqual(OLLAMA_ENSEMBLE_PROMPT_MAX_CHARS)
    expect(projection.continuityCheckpointIncluded).toBe(true)
    expect(projection.prompt).toContain(continuityCheckpoint)
    expect(projection.prompt.indexOf('CURRENT_ASSIGNMENT')).toBeLessThan(
      projection.prompt.indexOf(continuityCheckpoint)
    )
    expect(projection.prompt.indexOf('You are a LOCAL model running through Ollama')).toBeLessThan(
      projection.prompt.indexOf(continuityCheckpoint)
    )
    expect(projection.prompt.indexOf('Do this turn:')).toBeLessThan(
      projection.prompt.indexOf(continuityCheckpoint)
    )
  })

  it('omits an entire checkpoint that would overflow and emits no delivery proof', () => {
    const transcript = `TRANSCRIPT_START\n${'T'.repeat(4_000)}\nTRANSCRIPT_END`
    const crowded = {
      ...BASE,
      currentPrompt: `CURRENT_ASSIGNMENT ${'C'.repeat(2_500)}`,
      roleInstructions: 'R'.repeat(1_200),
      roster: 'O'.repeat(1_800),
      authorityLines: ['A'.repeat(1_200)],
      roleBoundaryLines: ['B'.repeat(1_200)],
      dynamicState: 'D'.repeat(1_400),
      workspaceStanza: 'W'.repeat(900),
      workspaceChurnStanza: 'H'.repeat(1_000),
      scoutBriefs: 'S'.repeat(1_200),
      blackboardSnapshot: 'K'.repeat(1_600),
      seatSummary: 'E'.repeat(900),
      transcript,
      permissionRule: 'P'.repeat(800),
      workflowHint: 'F'.repeat(700)
    }
    const transcriptTail = 'TRANSCRIPT_END'
    const evidence = {
      currentPromptMessageId: 'current',
      transcriptRows: [
        {
          messageId: 'transcript-tail',
          start: transcript.length - transcriptTail.length,
          end: transcript.length
        }
      ]
    }
    const baseline = buildOllamaEnsemblePromptCapsuleProjection(crowded, evidence)
    expect(baseline.prompt).toHaveLength(OLLAMA_ENSEMBLE_PROMPT_MAX_CHARS)
    const checkpoint = `<checkpoint>${'X'.repeat(2_300)}</checkpoint>`
    const attempted = buildOllamaEnsemblePromptCapsuleProjection(
      { ...crowded, continuityCheckpoint: checkpoint },
      evidence
    )

    expect(attempted.prompt).toBe(baseline.prompt)
    expect(attempted.suppliedMessageIds).toEqual(baseline.suppliedMessageIds)
    expect(attempted).not.toHaveProperty('continuityCheckpointIncluded')
    expect(attempted.continuityCheckpointOmitted).toBe(
      'required-contract-and-checkpoint-exceed-budget'
    )
    expect(attempted.prompt).not.toContain('<checkpoint>')
    expect(attempted.prompt.length).toBeLessThanOrEqual(OLLAMA_ENSEMBLE_PROMPT_MAX_CHARS)
    expect(attempted.prompt).toContain('CURRENT_ASSIGNMENT')
  })

  it('funds a complete checkpoint in a saturated capsule by displacing transcript evidence', () => {
    const transcriptRow = '[User]\nLATEST_TRANSCRIPT_ROW'
    const transcript = `${'old transcript '.repeat(350)}\n${transcriptRow}`
    const saturated = {
      ...BASE,
      currentPrompt: 'CURRENT_ASSIGNMENT remains first.',
      dynamicState: 'D'.repeat(1_000),
      workspaceStanza: 'Round subject: /workspace/project',
      workspaceChurnStanza: 'H'.repeat(700),
      scoutBriefs: 'S'.repeat(800),
      blackboardSnapshot: 'B'.repeat(1_200),
      seatSummary: 'E'.repeat(600),
      transcript
    }
    const rowStart = transcript.length - transcriptRow.length
    const evidence = {
      currentPromptMessageId: 'current-assignment',
      transcriptRows: [
        { messageId: 'displaced-transcript-row', start: rowStart, end: transcript.length }
      ]
    }
    const baseline = buildOllamaEnsemblePromptCapsuleProjection(saturated, evidence)
    expect(baseline.prompt).toHaveLength(OLLAMA_ENSEMBLE_PROMPT_MAX_CHARS)
    const continuityCheckpoint = `<checkpoint>${'Q'.repeat(1_560)}</checkpoint>`
    const recovered = buildOllamaEnsemblePromptCapsuleProjection(
      { ...saturated, continuityCheckpoint },
      evidence
    )

    expect(recovered.prompt.length).toBeLessThanOrEqual(OLLAMA_ENSEMBLE_PROMPT_MAX_CHARS)
    expect(recovered.continuityCheckpointIncluded).toBe(true)
    expect(recovered).not.toHaveProperty('continuityCheckpointOmitted')
    expect(recovered.prompt).toContain(continuityCheckpoint)
    expect(recovered.prompt.indexOf('CURRENT_ASSIGNMENT')).toBeLessThan(
      recovered.prompt.indexOf(continuityCheckpoint)
    )
    expect(recovered.prompt.indexOf('Do this turn:')).toBeLessThan(
      recovered.prompt.indexOf(continuityCheckpoint)
    )
    expect(recovered.prompt.indexOf('Round subject: /workspace/project')).toBeLessThan(
      recovered.prompt.indexOf(continuityCheckpoint)
    )
    expect(recovered.prompt).not.toContain('LATEST_TRANSCRIPT_ROW')
    expect(recovered.suppliedMessageIds).toContain('current-assignment')
    expect(recovered.suppliedMessageIds).not.toContain('displaced-transcript-row')
  })
})
