import { ollamaGptOssFewShotTrajectories } from './OllamaModelProtocol'
import { resolveOllamaModelFamily } from './OllamaModelPreflight'
import type { OllamaPromptIntent } from './OllamaPromptIntent'
import type { OllamaToolControlTier } from '../store/types'
import {
  normalizeOllamaToolControlTier,
  ollamaTierLabel,
  ollamaToolNamesForTier,
  type OllamaToolName
} from './OllamaToolTiers'

/** Family-specific lines appended to the local tool system prompt.
 *
 * Conversational turns keep only the tool-call discipline lines (the failure
 * modes they guard are universal); the explore/read/edit workflow, checklist
 * ritual, and worked trajectories are workspace-task scaffolding that small
 * models otherwise apply to "hi, how are you?". */
export function ollamaModelFamilyPromptLines(
  modelId: string,
  intent: OllamaPromptIntent = 'workspace',
  tier: OllamaToolControlTier | string | undefined | null = 'read_only'
): string[] {
  const normalizedTier = normalizeOllamaToolControlTier(tier)
  const family = resolveOllamaModelFamily(modelId)
  if (intent === 'conversational') {
    if (family === 'gpt_oss_20b') {
      return [
        'Model profile (GPT OSS): you may reason internally, but you MUST emit a real tool call or a final answer — never stop on a tool-intent stub.',
        'Prefer native tool/function calls over describing tools in prose.',
        'Call exactly one TaskWraith tool per turn.'
      ]
    }
    return []
  }
  switch (family) {
    case 'qwen3_5_9b':
      return [
        'Model profile (Qwen 3.5 9B): prefer workspace_search before read_file; read only the files you need.',
        'Keep tool arguments compact — do not paste large file bodies into JSON string fields.',
        'For multi-file refactors or long test-fix loops, summarize your plan and stop rather than guessing.'
      ]
    case 'qwen3_6_35b':
      return [
        'Model profile (Qwen 3.6 35B): use its larger local context for deeper review, but still search before reading unfamiliar files.',
        'Prefer native tool calls and keep each tool payload focused on the next concrete step.',
        'For release-critical edits, summarize verification gaps and ask for a second-provider review when useful.'
      ]
    case 'qwen3_4b':
      return [
        'Model profile (Qwen 3 4B): stay lightweight — search first, read one file at a time, answer concisely.',
        normalizedTier === 'read_only'
          ? 'Avoid wide refactors; prefer a short plan the user can hand to a larger model.'
          : 'You have edit tools in this tier — make small, localized, verified edits directly rather than only planning. For broad multi-file refactors, summarize progress and suggest delegation instead of guessing.'
      ]
    case 'minicpm_v45_8b':
      return [
        'Model profile (MiniCPM-V 4.5 8B): stay scoped; search/read narrowly and use native tools when available.',
        'For code edits, prefer a concise plan or a single localized patch rather than broad autonomous changes.'
      ]
    case 'gemma4_12b':
      return [
        'Model profile (Gemma 4 12B): search narrowly, then read targeted files before editing.',
        'Use one tool at a time and summarize results instead of chaining many speculative calls.'
      ]
    case 'ornith_9b':
      return [
        'Model profile (Ornith 1.0 9B): agentic coding model; search first, then make focused edits with explicit verification notes.',
        'Keep tool payloads compact. When the task becomes broad, ask the user which smaller local slice to tackle first instead of defaulting to another provider.'
      ]
    case 'ornith_35b':
      return [
        'Model profile (Ornith 1.0 35B): agentic coding model; use its larger coding context for deeper review and focused implementation.',
        'Read targeted files before editing, keep each tool call concrete, and call out verification gaps before release-sensitive changes.',
        'Stay local for scoped coding work; prefer a smaller concrete next step over a delegation handoff.'
      ]
    case 'granite4_1_3b':
      return [
        'Model profile (Granite 4.1 3B): use it as a fast local scout; list/search first and keep reads small.',
        normalizedTier === 'read_only'
          ? 'Avoid broad edits or long shell/test loops; hand off a short plan when the task grows.'
          : 'You have edit tools in this tier — make small, localized edits directly. For broad changes or long shell/test loops, summarize and suggest delegation rather than looping alone.'
      ]
    case 'granite4_1_30b':
      return [
        'Model profile (Granite 4.1 30B): strong for local review, RAG-style search, and structured tool use.',
        'Read targeted files before editing and summarize any assumptions before broad changes.'
      ]
    case 'nemotron3_33b':
      return [
        'Model profile (Nemotron 3 33B): use its multimodal reasoning profile for deeper local analysis, but keep workspace tools scoped.',
        'Prefer native tool calls and make verification gaps explicit before release-sensitive changes.'
      ]
    case 'gpt_oss_20b':
      return [
        'Model profile (GPT OSS): you may reason internally, but you MUST emit a real tool call or a final answer — never stop on a tool-intent stub.',
        'When embedding code in JSON tool args, escape backslashes correctly (Swift \\(…), Windows paths).',
        'Prefer native tool/function calls over describing tools in prose.',
        'Call exactly one TaskWraith tool per turn.',
        normalizedTier === 'read_only'
          ? 'Read-only profile: act as a scout. Search/list first, read narrow ranges, then report findings and handoff-worthy next steps.'
          : normalizedTier === 'approved_edits'
            ? 'Approved patch profile: make bounded, localized edits only after search/list and read_file. Stop and summarize when the task becomes broad.'
            : normalizedTier === 'approved_shell'
              ? 'Approved shell profile: after a scoped edit, run a targeted verification command when useful and approved.'
              : 'Provider parity profile: use the broader TaskWraith surface only when it is directly relevant; prefer the smallest governed tool that solves the request.',
        'Use todo_write only for multi-step work where a visible checklist genuinely helps; it is not required as the first tool.',
        'Worked trajectories:',
        ...ollamaGptOssFewShotTrajectories()
      ]
    default:
      return [
        'Model profile (local): search first, read narrowly, and keep tool payloads small.',
        'Stop with a concise plan when the task outgrows local model reliability.'
      ]
  }
}

export function ollamaModelFamilyTemperature(modelId: string): number | undefined {
  const family = resolveOllamaModelFamily(modelId)
  if (family === 'gpt_oss_20b') return 0.15
  if (family === 'qwen3_4b') return 0.25
  return undefined
}

function describeTool(toolName: OllamaToolName): string | null {
  if (toolName === 'list_directory') return '- list_directory: {"path":"."}'
  if (toolName === 'find_files') {
    return '- find_files: {"pattern":"**/*.test.ts","path":".","maxResults":50} — locate files by filename/path glob before reading or editing.'
  }
  if (toolName === 'read_file') return '- read_file: {"path":"relative/path.txt"}'
  if (toolName === 'workspace_search') {
    return '- workspace_search: {"query":"text or regex","path":".","maxResults":50,"contextLines":1} — ripgrep over the workspace; search a distinctive literal string to pinpoint the exact file and line you will read or edit.'
  }
  if (toolName === 'workspace_symbols') {
    return '- workspace_symbols: {"query":"symbol or function name","path":"src"} — language-aware symbol lookup for definitions before reading or editing.'
  }
  if (toolName === 'git_status') return '- git_status: {} — inspect current git state without changing files.'
  if (toolName === 'git_diff') {
    return '- git_diff: {"path":"relative/path.txt"} — inspect unstaged changes or a focused path diff without changing files.'
  }
  if (toolName === 'web_search') {
    return '- web_search: {"query":"current information to search for"} — returns a ranked list of result titles and URLs from the live web.'
  }
  if (toolName === 'web_fetch') {
    return '- web_fetch: {"url":"https://example.com/page"} — downloads a page and returns its readable text (HTML markup is stripped), ready for you to read and summarize.'
  }
  if (toolName === 'ask_user_question') {
    return '- ask_user_question: {"question":"What should I do next?","options":["Option A","Option B"],"context":"Why this decision matters"} — pause and ask the user for clarification when the prompt is ambiguous or you hit a real decision fork. Omit options for free text.'
  }
  if (toolName === 'goal_read') {
    return '- goal_read: {} — read the active TaskWraith thread goal only. If there is no active goal, continue with the user request using ordinary workspace tools.'
  }
  if (toolName === 'goal_update') {
    return '- goal_update: {"status":"active|paused|blocked|completed","reason":"optional reason"} — lifecycle status for an existing active TaskWraith goal only. Do NOT use it for planning, progress notes, or todo/checklist updates.'
  }
  if (toolName === 'goal_complete') {
    return '- goal_complete: {"reason":"optional completion summary"} — mark an existing active TaskWraith goal complete only after the objective is genuinely achieved.'
  }
  if (toolName === 'goal_blocked') {
    return '- goal_blocked: {"reason":"blocker detail"} — mark an existing active TaskWraith goal blocked only after a real blocker prevents progress.'
  }
  if (toolName === 'write_file') {
    return '- write_file: {"path":"relative/path.txt","content":"...","intent":"short reason before changing files"}'
  }
  if (toolName === 'replace') {
    return '- replace: {"path":"relative/path.txt","old_string":"...","new_string":"...","intent":"short reason before changing files"}'
  }
  if (toolName === 'apply_patch') {
    return '- apply_patch: {"patch":"unified diff","intent":"short reason before changing files"}'
  }
  if (toolName === 'run_shell_command') {
    return '- run_shell_command: {"command":"exact command","intent":"short reason before running it"}'
  }
  if (toolName === 'run_task') {
    return '- run_task: {"task":"test","intent":"verify the focused change"} — run a configured task/test through TaskWraith policy.'
  }
  if (toolName === 'test_result_summary') {
    return '- test_result_summary: {"path":"optional/result/path"} — summarize available test output without editing files.'
  }
  if (toolName === 'todo_write') {
    return '- todo_write: {"merge":true,"todos":[{"id":"1","content":"short step label","status":"in_progress"}]} — publish goal steps the user sees as a checklist; keep one item in_progress.'
  }
  return `- ${toolName}: use the TaskWraith MCP argument schema for this tool.`
}

/** Baseline + per-family tuning for the Ollama local tool system prompt. */
export function ollamaLocalToolSystemPrompt(
  tier: OllamaToolControlTier | string | undefined | null = 'read_only',
  modelId?: string | null,
  options: { intent?: OllamaPromptIntent } = {}
): string {
  const intent = options.intent ?? 'workspace'
  const normalizedTier = normalizeOllamaToolControlTier(tier)
  const tools = ollamaToolNamesForTier(normalizedTier)
  const hasWebTools = tools.includes('web_search') || tools.includes('web_fetch')
  const familyLines = modelId?.trim()
    ? ollamaModelFamilyPromptLines(modelId, intent, normalizedTier)
    : []
  const lines = [
    'You are running inside TaskWraith through local Ollama.',
    'You do not have direct shell or filesystem access, but TaskWraith DOES give you working tools (listed below) that you can call right now. Use them instead of telling the user you lack a capability.',
    ...(hasWebTools
      ? [
          'You CAN access the live internet through the web_search and web_fetch tools below. When the user asks about current events, weather, prices, or anything you cannot answer from memory, use web_search to find sources, then web_fetch to read a chosen page. web_fetch returns the readable text of the page, so you can summarize it directly.'
        ]
      : []),
    'To request a tool, either emit a native tool/function call, or reply with ONLY a JSON object in this exact shape:',
    '{"taskwraith_tool":{"name":"read_file","arguments":{"path":"README.md"}}}',
    'Do NOT announce or describe a tool call in prose (for example, "we need to use web_search" or "let\'s do web_search"). Either actually issue the tool call now, or give your final answer in normal prose. Describing a tool without calling it does nothing.',
    `Current Ollama tool-control tier: ${ollamaTierLabel(normalizedTier)}.`,
    ...(intent === 'conversational'
      ? [
          'The current user message is conversational (a greeting, thanks, or general question — not a coding task). Answer it directly in friendly prose. Do not call tools, explore the workspace, or publish todo checklists unless the question genuinely needs live web data or workspace facts — and then call at most one tool before answering.'
        ]
      : []),
    ...familyLines,
    ...(normalizedTier === 'provider_parity' && tools.includes('delegate_to_subthread')
      ? [
          'Provider parity includes delegation tools in this workspace. Use delegate_to_subthread only for work that clearly exceeds the local model or needs another provider; otherwise keep the run local and scoped.'
        ]
      : []),
    'Available tools:'
  ]
  for (const toolName of tools) {
    const line = describeTool(toolName)
    if (line) lines.push(line)
  }
  lines.push(
    'Paths must stay inside the active workspace.',
    'Use ask_user_question when the request is too ambiguous to continue safely or when a mid-task choice belongs to the user. After the answer returns, continue the task and summarize the chosen path.',
    'web_search and web_fetch are read-only network tools routed through TaskWraith policy. A typical flow is: web_search for the topic, pick the most relevant result, then web_fetch that URL and summarize its readable text for the user.',
    'Mutating tools require an intent or summary. TaskWraith will show a modal approval before running approved-edit and approved-shell tools.',
    'After TaskWraith returns a tool result, answer normally or request one more tool with the same JSON shape.',
    'Do not invent file contents or workspace facts when a tool result is needed.'
  )
  return lines.join('\n')
}

export function ollamaScoutDelegateWorkflowHint(modelId?: string | null): string {
  return ollamaTierAwareWorkflowHint(modelId, 'read_only')
}

export function ollamaTierAwareWorkflowHint(
  modelId?: string | null,
  tier: OllamaToolControlTier | string | undefined | null = 'read_only'
): string {
  const normalizedTier = normalizeOllamaToolControlTier(tier)
  const family = resolveOllamaModelFamily(modelId || '')
  if (normalizedTier === 'approved_edits') {
    return [
      'TaskWraith approved-patcher workflow:',
      'Search or list before reading unfamiliar files, read the exact target, then make a localized edit.',
      'Keep the patch bounded; when the task becomes multi-file or ambiguous, summarize the partial result and ask for delegation or a stronger provider.'
    ].join(' ')
  }
  if (normalizedTier === 'approved_shell') {
    return [
      'TaskWraith verify-with-shell workflow:',
      'Search/list, read, patch only scoped files, then run a targeted approved verification command when it adds confidence.',
      'Do not attempt full-suite repair loops alone; summarize failures and recommend delegation when the loop expands.'
    ].join(' ')
  }
  if (normalizedTier === 'provider_parity') {
    if (family === 'ornith_9b' || family === 'ornith_35b') {
      return [
        'TaskWraith provider-parity workflow:',
        'Use the full tool surface sparingly and stay anchored to the user request.',
        'Ornith should attempt scoped coding work locally first. Do not recommend or use delegation as the default recovery path; if the task is too broad, ask the user for a smaller local slice or explain the exact blocker.'
      ].join(' ')
    }
    return [
      'TaskWraith provider-parity workflow:',
      'Use the full tool surface sparingly and stay anchored to the user request.',
      'Delegation is available only through TaskWraith tools in this tier; use it for broad refactors or long autonomous loops, not as a default.'
    ].join(' ')
  }
  const scout =
    family === 'qwen3_5_9b' ||
    family === 'qwen3_6_35b' ||
    family === 'qwen3_4b' ||
    family === 'minicpm_v45_8b' ||
    family === 'gemma4_12b' ||
    family === 'ornith_9b' ||
    family === 'ornith_35b' ||
    family === 'granite4_1_3b' ||
    family === 'granite4_1_30b' ||
    family === 'nemotron3_33b'
      ? 'Use this Ollama thread to search, read narrowly, and draft a short implementation plan.'
      : 'Use this local thread to explore the workspace and outline the next steps.'
  return [
    'TaskWraith local-scout workflow:',
    scout,
    'When the plan is ready, ask the user to delegate implementation to Codex or Claude (↪ delegate on this chat) and attach the plan in the delegation prompt.',
    'Do not attempt repo-wide refactors or full test-suite repair loops alone on a local model.'
  ].join(' ')
}
