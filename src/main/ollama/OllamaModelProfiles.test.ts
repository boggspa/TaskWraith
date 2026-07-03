import { describe, expect, it } from 'vitest'
import {
  ollamaLocalToolSystemPrompt,
  ollamaModelFamilyPromptLines,
  ollamaScoutDelegateWorkflowHint,
  ollamaTierAwareWorkflowHint
} from './OllamaModelProfiles'

describe('ollamaModelFamilyPromptLines', () => {
  it('adds Qwen-specific search-first guidance', () => {
    const lines = ollamaModelFamilyPromptLines('qwen3.5:9b')
    expect(lines.join(' ')).toContain('workspace_search')
    expect(lines.join(' ')).toContain('multi-file')
  })

  it('flips tiny-model guidance from hand-off (read-only) to direct edits (edit tiers)', () => {
    const qwenReadOnly = ollamaModelFamilyPromptLines('qwen3:4b', 'workspace', 'read_only').join(' ')
    expect(qwenReadOnly).toContain('edit-capable tier')
    const qwenEdits = ollamaModelFamilyPromptLines('qwen3:4b', 'workspace', 'provider_parity').join(
      ' '
    )
    expect(qwenEdits).toContain('make small, localized, verified edits directly')
    expect(qwenEdits).not.toContain('hand to a larger model')

    const graniteReadOnly = ollamaModelFamilyPromptLines(
      'granite4.1:3b',
      'workspace',
      'read_only'
    ).join(' ')
    expect(graniteReadOnly).toContain('hand off a short plan')
    const graniteEdits = ollamaModelFamilyPromptLines(
      'granite4.1:3b',
      'workspace',
      'approved_edits'
    ).join(' ')
    expect(graniteEdits).toContain('make small, localized edits directly')
    expect(graniteEdits).not.toContain('hand off a short plan')
  })

  it('adds GPT-OSS tool-call emphasis', () => {
    const lines = ollamaModelFamilyPromptLines('gpt-oss:latest')
    expect(lines.join(' ')).toContain('tool-intent stub')
    expect(lines.join(' ')).toContain('escape backslashes')
  })

  it('adds Ornith agentic-coding guidance', () => {
    const lines = ollamaModelFamilyPromptLines('ornith:35b')
    expect(lines.join(' ')).toContain('agentic coding')
    expect(lines.join(' ')).toContain('verification gaps')
  })

  it('adds LFM 2.5 long-context tool guidance', () => {
    const lines = ollamaModelFamilyPromptLines('lfm2.5:8b')
    expect(lines.join(' ')).toContain('long-context')
    expect(lines.join(' ')).toContain('tool-chaining')
  })

  it('keeps only tool-call discipline for conversational GPT-OSS turns', () => {
    const lines = ollamaModelFamilyPromptLines('gpt-oss:latest', 'conversational')
    expect(lines.join(' ')).toContain('tool-intent stub')
    expect(lines.join(' ')).not.toContain('harness checklist')
    expect(lines.join(' ')).not.toContain('Worked trajectories')
  })

  it('drops workflow scaffolding for conversational turns on other families', () => {
    expect(ollamaModelFamilyPromptLines('qwen3.5:9b', 'conversational')).toEqual([])
    expect(ollamaModelFamilyPromptLines('ornith:35b', 'conversational')).toEqual([])
  })
})

describe('ollamaLocalToolSystemPrompt', () => {
  it('includes family profile lines when a model id is provided', () => {
    const prompt = ollamaLocalToolSystemPrompt('read_only', 'qwen3.5:9b')
    expect(prompt).toContain('Model profile (Qwen 3.5 9B)')
    expect(prompt).toContain('workspace_search')
  })

  it('opens with a model-naming identity envelope', () => {
    // Identity envelope: name the actual model so the seat knows who it is.
    const prompt = ollamaLocalToolSystemPrompt('read_only', 'qwen3.5:9b')
    expect(prompt.startsWith('You are the local "qwen3.5:9b" model running through Ollama')).toBe(
      true
    )
    // No model id → generic, still an identity line, no crash.
    expect(ollamaLocalToolSystemPrompt('read_only').startsWith('You are a local model running')).toBe(
      true
    )
  })

  it('advertises the curated ~22-tool working set, not the full catalog', () => {
    const prompt = ollamaLocalToolSystemPrompt('read_only', 'qwen3.5:9b')
    // Detailed inline: only the protocol-critical few.
    expect(prompt).toContain('- read_file:')
    expect(prompt).toContain('- write_file:')
    // Advertised by name.
    expect(prompt).toContain('run_task')
    // Tail tools are NOT advertised (reachable via tool_help).
    expect(prompt).not.toContain('creative_blender_python')
    expect(prompt).not.toContain('browser_screenshot')
    expect(prompt).not.toContain('git_push')
  })

  it('tells conversational turns to answer directly without the checklist ritual', () => {
    const prompt = ollamaLocalToolSystemPrompt('approved_edits', 'gpt-oss:latest', {
      intent: 'conversational'
    })
    expect(prompt).toContain('Answer it directly in friendly prose')
    expect(prompt).not.toContain('harness checklist')
    expect(prompt).not.toContain('Worked trajectories')
  })

  it('keeps the workspace scaffold by default', () => {
    const prompt = ollamaLocalToolSystemPrompt('approved_edits', 'gpt-oss:latest')
    expect(prompt).toContain('Use todo_write only for multi-step work')
    expect(prompt).toContain('Approved patch profile')
    expect(prompt).not.toContain('The current user message is conversational')
  })

  it('name-lists advertised coordination tools and keeps the lifecycle mutators in the tool_help tail', () => {
    const prompt = ollamaLocalToolSystemPrompt('provider_parity', 'ornith:9b')
    // Curated taxonomy (2026-07): goal_read is advertised (name-listed); the goal
    // lifecycle MUTATORS (goal_update/complete/blocked) are NOT advertised — they
    // are the tool_help tail, reachable on demand but out of the preamble.
    expect(prompt).toContain('goal_read')
    expect(prompt).not.toContain('goal_update')
    expect(prompt).not.toContain('goal_complete')
    expect(prompt).not.toContain('goal_blocked')
    // Ornith family delegation guidance still rides along.
    expect(prompt).toContain('instead of defaulting to another provider')
  })

  it('advertises ask_user_question by name but keeps tail tools (git_blame) out of the preamble', () => {
    const prompt = ollamaLocalToolSystemPrompt('read_only', 'qwen3.5:9b')
    expect(prompt).toContain('ask_user_question')
    // git_blame is not in the curated advertised set — it lives in the tool_help tail.
    expect(prompt).not.toContain('git_blame')
  })
})

describe('workflow hints', () => {
  it('documents scout escalation without defaulting to cloud implementation', () => {
    expect(ollamaScoutDelegateWorkflowHint('qwen3.5:9b', 'plan')).toContain('continue locally')
    expect(ollamaScoutDelegateWorkflowHint('ornith:35b', 'plan')).toContain('higher tier/profile')
    expect(ollamaScoutDelegateWorkflowHint('lfm2.5:8b', 'plan')).toContain('continue locally')
    expect(ollamaScoutDelegateWorkflowHint('ornith:35b', 'plan')).not.toContain('Codex or Claude')
    // Default stays the plan variant so intent-unaware callers keep behavior.
    expect(ollamaScoutDelegateWorkflowHint('qwen3.5:9b')).toContain(
      'TaskWraith local-scout workflow'
    )
  })

  it('emits a findings-shaped recon variant that never asks the model to draft a plan', () => {
    for (const model of ['qwen3.5:9b', 'ornith:35b', 'some-unknown-model']) {
      const hint = ollamaScoutDelegateWorkflowHint(model, 'recon')
      expect(hint).toContain('TaskWraith local-recon workflow')
      expect(hint).toContain('read-only review turn, not a planning turn')
      expect(hint).not.toContain('implementation plan.')
      expect(hint).not.toContain('When the plan is ready')
      expect(hint).not.toContain('ask the user whether to continue')
    }
    // Non-read_only tiers ignore the intent entirely.
    expect(ollamaTierAwareWorkflowHint('gpt-oss:20b', 'approved_edits', 'recon')).toContain(
      'approved-patcher workflow'
    )
  })

  it('documents approved patcher behavior without default delegation', () => {
    expect(ollamaTierAwareWorkflowHint('gpt-oss:20b', 'approved_edits')).toContain(
      'approved-patcher workflow'
    )
    expect(ollamaTierAwareWorkflowHint('ornith:9b', 'provider_parity')).toContain(
      'Ornith should attempt scoped coding work locally first'
    )
  })
})
