import { describe, expect, it } from 'vitest'
import {
  ollamaLocalToolSystemPrompt,
  ollamaModelFamilyPromptLines,
  ollamaScoutDelegateWorkflowHint,
  ollamaStruggleHandoffMessage,
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
    expect(qwenReadOnly).toContain('hand to a larger model')
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

  it('includes ask_user_question in the safe read-only local tool tier', () => {
    const prompt = ollamaLocalToolSystemPrompt('read_only', 'qwen3.5:9b')
    expect(prompt).toContain('ask_user_question')
    expect(prompt).toContain('pause and ask the user for clarification')
  })
})

describe('workflow hints', () => {
  it('documents scout-then-delegate workflow', () => {
    expect(ollamaScoutDelegateWorkflowHint('qwen3.5:9b')).toContain('delegate implementation')
    expect(ollamaScoutDelegateWorkflowHint('ornith:35b')).toContain('delegate implementation')
  })

  it('documents approved patcher behavior without default delegation', () => {
    expect(ollamaTierAwareWorkflowHint('gpt-oss:20b', 'approved_edits')).toContain(
      'approved-patcher workflow'
    )
  })

  it('suggests cloud handoff after struggle', () => {
    expect(ollamaStruggleHandoffMessage('Qwen 3.5 (9B Param)')).toContain('Codex or Claude')
  })
})
