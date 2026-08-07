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
})
