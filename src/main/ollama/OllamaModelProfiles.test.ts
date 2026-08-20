import { describe, expect, it } from 'vitest'
import {
  ollamaLocalToolSystemPrompt,
  ollamaModelFamilyPromptLines,
  ollamaModelFamilyTemperature,
  ollamaScoutDelegateWorkflowHint,
  ollamaTierAwareWorkflowHint
} from './OllamaModelProfiles'

describe('ollamaModelFamilyPromptLines', () => {
  it('adds Qwen-specific search-first guidance', () => {
    const lines = ollamaModelFamilyPromptLines('qwen3.5:9b')
    expect(lines.join(' ')).toContain('workspace_search')
    expect(lines.join(' ')).toContain('multi-file')
  })

  it('states the real permission on read-only and never hedges on edit tiers', () => {
    const qwenReadOnly = ollamaModelFamilyPromptLines('qwen3:4b', 'workspace', 'read_only').join(' ')
    // Read-only text describes the tier's actual permission, which is honest.
    expect(qwenReadOnly).toContain('no edit tools')
    const qwenEdits = ollamaModelFamilyPromptLines('qwen3:4b', 'workspace', 'provider_parity').join(
      ' '
    )
    expect(qwenEdits).toContain('make the edits the task needs')
    // An edit-capable tier must never be told to defer, shrink, or hand off the
    // user's task — that overrode user intent and made local models unusable.
    for (const nerf of [
      'hand to a larger model',
      'hand off',
      'suggest delegation',
      'Avoid wide refactors',
      'instead of guessing'
    ]) {
      expect(qwenEdits).not.toContain(nerf)
    }

    const graniteReadOnly = ollamaModelFamilyPromptLines(
      'granite4.1:3b',
      'workspace',
      'read_only'
    ).join(' ')
    expect(graniteReadOnly).toContain('no edit tools')
    const graniteEdits = ollamaModelFamilyPromptLines(
      'granite4.1:3b',
      'workspace',
      'approved_edits'
    ).join(' ')
    expect(graniteEdits).toContain('the changes the task needs')
    expect(graniteEdits).not.toContain('hand off a short plan')
    expect(graniteEdits).not.toContain('suggest delegation')
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

    const ornith15 = ollamaModelFamilyPromptLines('ornith-1.5:35b')
    expect(ornith15.join(' ')).toContain('Ornith 1.5 35B')
    expect(ornith15.join(' ')).toContain('agentic coding')
  })

  it('adds LFM 2.5 long-context tool guidance', () => {
    const lines = ollamaModelFamilyPromptLines('lfm2.5:8b')
    expect(lines.join(' ')).toContain('long-context')
    expect(lines.join(' ')).toContain('tool-chaining')
  })

  it('adds Laguna XS Poolside guidance', () => {
    const lines = ollamaModelFamilyPromptLines('laguna-xs-2.1:q8_0')
    expect(lines.join(' ')).toContain('Poolside')
    expect(lines.join(' ')).toContain('thinking support')
  })

  it('adds Devstral agentic-coding and Ministral scout guidance', () => {
    const devstral = ollamaModelFamilyPromptLines('devstral-small-2:24b').join(' ')
    expect(devstral).toContain('Devstral Small 2 24B')
    expect(devstral).toContain('agentic coding')
    expect(devstral).toContain('verification notes')

    const ministralReadOnly = ollamaModelFamilyPromptLines(
      'ministral-3:14b',
      'workspace',
      'read_only'
    ).join(' ')
    expect(ministralReadOnly).toContain('Ministral 3 14B')
    expect(ministralReadOnly).toContain('no edit tools')
    const ministralEdits = ollamaModelFamilyPromptLines(
      'ministral-3:14b',
      'workspace',
      'approved_edits'
    ).join(' ')
    expect(ministralEdits).toContain('the edits the task needs')
    expect(ministralEdits).not.toContain('short plan')
    expect(ministralEdits).not.toContain('slice anything multi-file')
  })

  it('adds Muse Glimmer agentic tool and verification guidance', () => {
    const lines = ollamaModelFamilyPromptLines('muse-glimmer:30b-mlx').join(' ')
    expect(lines).toContain('Muse Glimmer 30B')
    expect(lines).toContain('failure-recovery')
    expect(lines).toContain('explicit verification')
  })

  it('adds Nemotron Lightning sustained-agent and checkpoint guidance', () => {
    const lines = ollamaModelFamilyPromptLines('nemotron-3.5-lightning:30b-mlx').join(' ')
    expect(lines).toContain('Nemotron 3.5 Lightning 30B-A3B')
    expect(lines).toContain('always-on agent')
    expect(lines).toContain('checkpoint state')
  })

  it('adds Qwen 3.8 multimodal thinking and verification guidance', () => {
    const lines = ollamaModelFamilyPromptLines('qwen3.8:27b-mlx').join(' ')
    expect(lines).toContain('Qwen 3.8 27B')
    expect(lines).toContain('configurable thinking')
    expect(lines).toContain('explicit')
  })

  it('gives the 3.5 4B tag its own lightweight profile, not the unknown fallback', () => {
    const lines = ollamaModelFamilyPromptLines('qwen3.5:4b').join(' ')
    expect(lines).toContain('Qwen 3.5 4B')
    expect(lines).toContain('stay lightweight')
    expect(lines).not.toContain('Model profile (local)')
  })

  it('gives all six new tags family-specific tool guidance', () => {
    const expected = new Map([
      ['llama3.1:8b', 'Llama 3.1 8B'],
      ['deepseek-r1:8b', 'DeepSeek R1 8B'],
      ['rnj-1', 'Rnj-1 8B'],
      ['glm-4.7-flash:q4_K_M', 'GLM-4.7-Flash 30B-A3B'],
      ['north-mini-code-1.0:q4_K_M', 'North Mini Code 1.0 30B-A3B'],
      ['llama3.2:3b', 'Llama 3.2 3B']
    ])
    for (const [modelId, marker] of expected) {
      const lines = ollamaModelFamilyPromptLines(modelId).join(' ')
      expect(lines).toContain(marker)
      expect(lines).not.toContain('Model profile (local)')
    }
    expect(ollamaModelFamilyPromptLines('north-mini-code-1.0:q4_K_M').join(' ')).toContain(
      'Carry supplied thinking content between turns'
    )
  })

  it('gives every lightweight tag a size-correct profile', () => {
    const expected = new Map([
      ['ministral-3:3b', 'Ministral 3 3B'],
      ['granite4:3b', 'Granite 4.0 3B'],
      ['qwen3.5:2b', 'Qwen 3.5 2B'],
      ['deepseek-r1:1.5b', 'DeepSeek R1 1.5B'],
      ['nemotron-3-nano:4b', 'Nemotron 3 Nano 4B'],
      ['lfm2.5-thinking:1.2b', 'LFM 2.5 Thinking 1.2B'],
      ['gemma3:4b', 'Gemma 3 4B']
    ])
    for (const [modelId, marker] of expected) {
      const lines = ollamaModelFamilyPromptLines(modelId).join(' ')
      expect(lines).toContain(marker)
      expect(lines).not.toContain('Model profile (local)')
    }
    expect(ollamaModelFamilyTemperature('qwen3.5:2b')).toBe(0.25)
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
  it('gives local models an explicit workspace-relative path contract', () => {
    const prompt = ollamaLocalToolSystemPrompt('approved_edits', 'ministral-3:3b')

    expect(prompt).toContain('tool paths are workspace-relative')
    expect(prompt).toContain('Copy paths exactly from search/list results')
    expect(prompt).toContain('do not prepend the absolute workspace path')
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

  it('advertises the immutable gateway working set, not the full catalog', () => {
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

  it('name-lists the gateway profile goal lifecycle tools', () => {
    const prompt = ollamaLocalToolSystemPrompt('provider_parity', 'ornith:9b')
    // Exact gateway-v9 membership includes the lifecycle mutators required by
    // long-horizon work; the older goal_update alias remains in the tail.
    expect(prompt).toContain('goal_read')
    expect(prompt).toContain('update_goal')
    expect(prompt).toContain('goal_complete')
    expect(prompt).toContain('goal_blocked')
    expect(prompt).not.toContain('goal_update')
    // Ornith family delegation guidance still rides along.
    expect(prompt).toContain('instead of defaulting to another provider')
  })

  it('advertises ask_user_question by name but keeps tail tools (git_blame) out of the preamble', () => {
    const prompt = ollamaLocalToolSystemPrompt('read_only', 'qwen3.5:9b')
    expect(prompt).toContain('ask_user_question')
    // git_blame is not in the gateway direct set — it lives in the discovered tail.
    expect(prompt).not.toContain('git_blame')
  })

  it('drops file-edit + shell tools from the advertisement under a read-only posture', () => {
    // The `readOnly` OPTION (a real posture) is distinct from the inert `tier`
    // first-arg: a read-only seat hard-denies edits+shell, so advertising them
    // just wastes a weak model's tool budget.
    const readOnly = ollamaLocalToolSystemPrompt('read_only', 'qwen3.5:9b', { readOnly: true })
    expect(readOnly).not.toContain('write_file')
    expect(readOnly).not.toContain('run_shell_command')
    expect(readOnly).not.toContain('run_task')
    // Reads/search/web stay available and the seat is told writes are unavailable.
    expect(readOnly).toContain('read_file')
    expect(readOnly).toContain('workspace_search')
    expect(readOnly).toContain('canvas_sketch_open')
    expect(readOnly).toContain('canvas_sketch_get')
    expect(readOnly).not.toContain('canvas_sketch_update')
    expect(readOnly).toContain('This run is READ-ONLY')
    // Default (writable) posture still advertises the edit + shell tools.
    const writable = ollamaLocalToolSystemPrompt('read_only', 'qwen3.5:9b')
    expect(writable).toContain('write_file')
    expect(writable).toContain('run_shell_command')
    expect(writable).not.toContain('This run is READ-ONLY')
  })

  it('tells Plan seats that Sketch mutation pauses for approval', () => {
    const plan = ollamaLocalToolSystemPrompt('read_only', 'qwen3.5:9b', {
      readOnly: true,
      plan: true
    })
    expect(plan).toContain('canvas_sketch_open')
    expect(plan).toContain('canvas_sketch_get')
    expect(plan).toContain('canvas_sketch_update')
    expect(plan).not.toContain('write_file')
    expect(plan).not.toContain('run_shell_command')
    expect(plan).toContain('This run is PLAN-scoped')
    expect(plan).toContain('approval modal')
  })
})

describe('workflow hints', () => {
  it('documents scout escalation without defaulting to cloud implementation', () => {
    expect(ollamaScoutDelegateWorkflowHint('qwen3.5:9b', 'plan')).toContain('continue locally')
    expect(ollamaScoutDelegateWorkflowHint('ornith:35b', 'plan')).toContain('higher tier/profile')
    expect(ollamaScoutDelegateWorkflowHint('laguna-xs-2.1:q8_0', 'plan')).toContain(
      'continue locally'
    )
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
