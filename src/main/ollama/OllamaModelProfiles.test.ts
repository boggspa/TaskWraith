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

  it('details goal_read inline and name-lists the goal lifecycle mutators', () => {
    const prompt = ollamaLocalToolSystemPrompt('provider_parity', 'ornith:9b')
    // Tier retirement / preamble slim (2026-07): goal_read is a core tool spelled
    // out inline; goal_update/complete/blocked are discoverable by name in the
    // "Also available" list rather than each getting a paragraph.
    expect(prompt).toContain('read the active TaskWraith thread goal only')
    expect(prompt).toContain('goal_update')
    expect(prompt).toContain('goal_complete')
    expect(prompt).toContain('goal_blocked')
    // Ornith family delegation guidance still rides along.
    expect(prompt).toContain('instead of defaulting to another provider')
  })

  it('includes ask_user_question in the safe read-only local tool tier', () => {
    const prompt = ollamaLocalToolSystemPrompt('read_only', 'qwen3.5:9b')
    expect(prompt).toContain('ask_user_question')
    expect(prompt).toContain('pause and ask the user for clarification')
    expect(prompt).toContain('git_blame')
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
