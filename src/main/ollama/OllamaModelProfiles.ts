import { ollamaGptOssFewShotTrajectories } from './OllamaModelProtocol'
import { resolveOllamaModelFamily } from './OllamaModelPreflight'
import type { OllamaPromptIntent } from './OllamaPromptIntent'
import type { OllamaToolControlTier, TaskWraithMcpProfileId } from '../store/types'
import {
  normalizeOllamaToolControlTier,
  ollamaAdvertisedToolNames,
  type OllamaToolName
} from './OllamaToolTiers'

/** Family-specific lines appended to the local tool system prompt.
 *
 * Conversational turns keep only the tool-call discipline lines (the failure
 * modes they guard are universal); the explore/read/edit workflow, checklist
 * ritual, and worked trajectories are workspace-task scaffolding that some
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
          ? 'Avoid wide refactors; prefer a short plan the user can run with an edit-capable tier or a wider local profile.'
          : 'You have edit tools in this tier — make small, localized, verified edits directly rather than only planning. For broad multi-file refactors, summarize progress and suggest delegation instead of guessing.'
      ]
    case 'qwen3_5_2b':
      return [
        'Model profile (Qwen 3.5 2B): ultra-light local model; keep context compact, search first, and take one concrete step at a time.',
        normalizedTier === 'read_only'
          ? 'Prefer chat, quick lookups, and targeted reads; hand off a short plan when the task becomes multi-file.'
          : 'Make only small localized edits and verify each one; summarize instead of entering a long autonomous loop.'
      ]
    case 'qwen3_5_4b':
      return [
        'Model profile (Qwen 3.5 4B): stay lightweight — search first, read one file at a time, answer concisely.',
        normalizedTier === 'read_only'
          ? 'Avoid wide refactors; hand off a short plan when the task grows past a couple of files.'
          : 'You have edit tools in this tier — make small, localized, verified edits. Summarize progress instead of guessing on broad multi-file refactors.'
      ]
    case 'devstral_small_2_24b':
      return [
        'Model profile (Devstral Small 2 24B): agentic coding model; search for the target, read it, then make a focused edit with explicit verification notes.',
        'Keep tool payloads compact and take one concrete step per turn rather than chaining speculative calls.',
        'For broad refactors, claim a clear slice and state what is left instead of attempting the whole pass at once.'
      ]
    case 'ministral_3_3b':
      return [
        'Model profile (Ministral 3 3B): edge-sized multimodal model; search with a concrete query, read one target at a time, then act.',
        normalizedTier === 'read_only'
          ? 'Use it for chat, visual checks, and concise findings rather than broad changes.'
          : 'Make one small localized edit at a time and state what you verified.'
      ]
    case 'ministral_3_14b':
      return [
        'Model profile (Ministral 3 14B): compact tool-capable model; search with a concrete query, read targeted files, then act.',
        normalizedTier === 'read_only'
          ? 'Report findings and a short plan rather than attempting broad changes.'
          : 'Make small localized edits directly and note what you verified; slice anything multi-file.'
      ]
    case 'llama3_1_8b':
      return [
        'Model profile (Llama 3.1 8B): general tool-capable local model; search before reading and keep tool payloads focused.',
        'Use the long context for grounded review, but split broad implementation into small verified edits.'
      ]
    case 'deepseek_r1_1_5b':
      return [
        'Model profile (DeepSeek R1 1.5B): tiny distilled reasoning model; keep prompts and tool results compact and take one concrete step at a time.',
        'Use it for private chat, narrow analysis, and short tool calls; stop with a concise handoff before multi-file execution.'
      ]
    case 'deepseek_r1_8b':
      return [
        'Model profile (DeepSeek R1 8B): compact reasoning model with native tools and thinking support; search/read before acting.',
        'Keep each tool step concrete and preserve supplied thinking content across turns rather than restarting the reasoning trace.'
      ]
    case 'rnj_1_8b':
      return [
        'Model profile (Rnj-1 8B): agentic-coding model; search for the target, read the relevant file, then make a focused verified edit.',
        'Its context window is 32K, so keep tool results compact and slice multi-file work explicitly.'
      ]
    case 'glm_4_7_flash':
      return [
        'Model profile (GLM-4.7-Flash 30B-A3B): long-context reasoning model with native tools and thinking support.',
        'Use its context for grounded review, keep each tool payload focused, and state verification gaps before release-sensitive edits.'
      ]
    case 'north_mini_code_1_0':
      return [
        'Model profile (North Mini Code 1.0 30B-A3B): agentic software-engineering model with native tools and interleaved thinking.',
        'Carry supplied thinking content between turns, search before reading, and tie every tool action to the current implementation step.'
      ]
    case 'llama3_2_3b':
      return [
        'Model profile (Llama 3.2 3B): lightweight tool-capable local model; search first, read one relevant file at a time, and answer concisely.',
        normalizedTier === 'read_only'
          ? 'Avoid broad edits; hand off a short plan when the task grows beyond targeted local investigation.'
          : 'Make small localized edits directly and summarize progress instead of guessing across broad refactors.'
      ]
    case 'minicpm_v45_8b':
      return [
        'Model profile (MiniCPM-V 4.5 8B): stay scoped; search/read with a concrete intent and use native tools when available.',
        'For code edits, prefer a concise plan or a single localized patch rather than broad autonomous changes.'
      ]
    case 'gemma3_4b':
      return [
        'Model profile (Gemma 3 4B): lightweight multimodal model; use it for chat, image understanding, and focused analysis.',
        'Search before reading workspace files and avoid long speculative tool chains.'
      ]
    case 'gemma4_12b':
      return [
        'Model profile (Gemma 4 12B): search with a concrete query, then read targeted files before editing.',
        'Use one tool at a time and summarize results instead of chaining many speculative calls.'
      ]
    case 'ornith_9b':
      return [
        'Model profile (Ornith 1.0 9B): agentic coding model; search first, then make focused edits with explicit verification notes.',
        'Keep tool payloads compact. When the task becomes broad, claim a clear local slice or ask the user which part should land first instead of defaulting to another provider.'
      ]
    case 'ornith_35b':
      return [
        'Model profile (Ornith 1.0 35B): agentic coding model; use its larger coding context for deeper review and focused implementation.',
        'Read targeted files before editing, keep each tool call concrete, and call out verification gaps before release-sensitive changes.',
        'Stay local for scoped coding work; prefer a smaller concrete next step over a delegation handoff.'
      ]
    case 'laguna_xs_2_1':
      return [
        'Model profile (Laguna XS 2.1): long-context Poolside local model with native tools and thinking support.',
        'Search/read before editing, keep tool payloads focused, and use its context for grounded review rather than broad speculative changes.',
        'For release-critical edits, state verification gaps and run targeted checks when the selected tier allows it.'
      ]
    case 'lfm2_5_thinking_1_2b':
      return [
        'Model profile (LFM 2.5 Thinking 1.2B): ultra-light reasoning model; keep context and tool outputs compact.',
        'Use one short tool step at a time and stop with a concise handoff when the task becomes broad.'
      ]
    case 'lfm2_5_8b':
      return [
        'Model profile (LFM 2.5 8B-A1B): long-context local model with tool-chaining training; search/read before editing and keep each tool step concrete.',
        'Use the long context for grounded local review, but keep broad implementation work sliced with explicit verification notes.'
      ]
    case 'granite4_3b':
      return [
        'Model profile (Granite 4.0 3B): lightweight tool model; list/search first and read only the files relevant to the task.',
        normalizedTier === 'read_only'
          ? 'Use it for chat, retrieval, and concise findings rather than broad edits.'
          : 'Make small structured changes directly; avoid long edit-and-test loops.'
      ]
    case 'granite4_1_3b':
      return [
        'Model profile (Granite 4.1 3B): use it as a fast local scout; list/search first and read the files relevant to the task.',
        normalizedTier === 'read_only'
          ? 'Avoid broad edits or long shell/test loops; hand off a short plan when the task grows.'
          : 'You have edit tools in this tier — make small, localized edits directly. For broad changes or long shell/test loops, summarize and suggest delegation rather than looping alone.'
      ]
    case 'granite4_1_30b':
      return [
        'Model profile (Granite 4.1 30B): strong for local review, RAG-style search, and structured tool use.',
        'Read targeted files before editing and summarize any assumptions before broad changes.'
      ]
    case 'nemotron3_nano_4b':
      return [
        'Model profile (Nemotron 3 Nano 4B): small reasoning model with native tools and configurable thinking.',
        'Keep each tool call narrow, preserve supplied thinking across turns, and make verification gaps explicit.'
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
        'Model profile (local): search first, read the relevant files, and keep tool payloads purposeful.',
        'Stop with a concise plan when the requested scope exceeds the selected tier, context window, or available tools.'
      ]
  }
}

export function ollamaModelFamilyTemperature(modelId: string): number | undefined {
  const family = resolveOllamaModelFamily(modelId)
  if (family === 'gpt_oss_20b') return 0.15
  if (family === 'qwen3_4b' || family === 'qwen3_5_2b' || family === 'qwen3_5_4b') {
    return 0.25
  }
  return undefined
}

// Ollama gets the compact gateway surface and only needs the handful it actually
// drives spelled out. The preamble
// details ONLY these ~7 protocol-critical tools inline (concrete JSON arg shapes
// the text protocol's first moves depend on); every other advertised tool is
// name-listed, and hidden schemas come from capability_search/tool_help on demand —
// so the inline block does not re-duplicate what tool_help already serves.
const OLLAMA_PREAMBLE_DETAILED_TOOLS = new Set<OllamaToolName>([
  'read_file',
  'list_directory',
  'workspace_search',
  'write_file',
  'replace',
  'run_shell_command'
])

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
  if (toolName === 'git_log') {
    return '- git_log: {"path":"relative/path.txt","maxCount":20} — inspect recent commit history, optionally scoped to a path.'
  }
  if (toolName === 'git_show') {
    return '- git_show: {"ref":"HEAD","path":"relative/path.txt","includePatch":false} — inspect one commit/ref without changing files.'
  }
  if (toolName === 'git_blame') {
    return '- git_blame: {"path":"relative/path.txt","startLine":1,"maxLines":80} — inspect who last changed a bounded line range.'
  }
  if (toolName === 'git_push') {
    return '- git_push: {"intent":"publish approved branch"} — push the current branch through TaskWraith approval policy.'
  }
  if (toolName === 'git_create_pr') {
    return '- git_create_pr: {"title":"Short title","body":"Summary","draft":true,"intent":"open review PR"} — create a GitHub PR through TaskWraith approval policy.'
  }
  if (toolName === 'github_ci_status') {
    return '- github_ci_status: {"includeFailedLogs":true,"maxRepairPushes":3} — inspect GitHub CI state for the current PR/branch before deciding whether to repair and push.'
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
  if (toolName === 'create_directory') {
    return '- create_directory: {"path":"relative/new-dir","intent":"short reason before changing files"}'
  }
  if (toolName === 'delete_path') {
    return '- delete_path: {"path":"relative/file-or-empty-dir","intent":"short reason before deleting"}'
  }
  if (toolName === 'move_path') {
    return '- move_path: {"from":"relative/source","to":"relative/destination","intent":"short reason before moving"}'
  }
  if (toolName === 'rename_path') {
    return '- rename_path: {"path":"relative/source","newName":"new-name.ext","intent":"short reason before renaming"}'
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
  if (toolName === 'get_diagnostics') {
    return '- get_diagnostics: {"source":"typescript","path":"src","intent":"check focused diagnostics"} — run fixed workspace diagnostics through TaskWraith policy.'
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
  options: {
    intent?: OllamaPromptIntent
    networkAccess?: string | null
    readOnly?: boolean
    plan?: boolean
    taskWraithMcpProfileId?: TaskWraithMcpProfileId | null
  } = {}
): string {
  const intent = options.intent ?? 'workspace'
  const normalizedTier = normalizeOllamaToolControlTier(tier)
  // Advertise the immutable gateway-v9 direct set, not the full catalogue. The
  // tail stays executable through capability_invoke and is reachable through
  // progressive discovery or legacy tool_help. Read-only receives the shared
  // safe set; Plan additionally receives its approval-gated instruments.
  const tools = ollamaAdvertisedToolNames({
    networkAccess: options.networkAccess,
    readOnly: options.readOnly,
    plan: options.plan,
    taskWraithMcpProfileId: options.taskWraithMcpProfileId
  })
  const hasWebTools = tools.includes('web_search') || tools.includes('web_fetch')
  const familyLines = modelId?.trim()
    ? ollamaModelFamilyPromptLines(modelId, intent, normalizedTier)
    : []
  // Detail ONLY the ~7 protocol-critical tools inline (concrete JSON arg shapes);
  // name-list the rest of the advertised set. Hidden schemas come from
  // capability_search/tool_help, so the inline block does not duplicate them.
  const detailed: string[] = []
  const named: string[] = []
  for (const toolName of tools) {
    if (OLLAMA_PREAMBLE_DETAILED_TOOLS.has(toolName)) {
      const line = describeTool(toolName)
      if (line) detailed.push(line)
    } else {
      named.push(toolName)
    }
  }
  // Hard identity envelope: name the actual model so the seat knows who it is and
  // never adopts a stronger-sounding provider label from the transcript. The
  // ensemble prompt adds the "you are NOT Claude/Codex/Gemini" anchor where peers
  // are actually named (see EnsemblePrompt.ts).
  const modelLabel = modelId?.trim() ? `the local "${modelId.trim()}" model` : 'a local model'
  const lines = [
    `You are ${modelLabel} running through Ollama inside TaskWraith — a real workspace agent with the tools below. Call them instead of saying you lack a capability.`,
    'To use a tool, either emit a native tool/function call, or reply with ONLY a JSON object in this exact shape:',
    '{"taskwraith_tool":{"name":"read_file","arguments":{"path":"README.md"}}}',
    'Do NOT announce or describe a tool call in prose. Either issue the call now, or give your final answer in normal prose — describing a tool without calling it does nothing.',
    ...(intent === 'conversational'
      ? [
          'The current user message is conversational (a greeting, thanks, or general question — not a coding task). Answer it directly in friendly prose. Do not call tools, explore the workspace, or publish todo checklists unless the question genuinely needs live web data or workspace facts — and then call at most one tool before answering.'
        ]
      : []),
    ...familyLines,
    'Common tools:',
    ...detailed,
    ...(named.length
      ? [`Also ready (same JSON shape): ${named.join(', ')}.`]
      : [])
  ]
  if (hasWebTools) {
    lines.push(
      'For current events, weather, prices, or anything outside your knowledge: web_search to find sources, then web_fetch a chosen URL and summarize its readable text.'
    )
  }
  lines.push(
    'More TaskWraith tools exist beyond these. Use capability_search with a short task query to get the best exact schemas, then capability_invoke with the returned tool name and arguments. Legacy tool_help can still fetch one exact schema (or list names) with {"taskwraith_tool":{"name":"tool_help","arguments":{"name":"<tool or empty to list>"}}}, but hidden tools must be executed through capability_invoke.',
    'Paths must stay inside the active workspace.',
    options.readOnly
      ? options.plan
        ? 'This run is PLAN-scoped: general file edits, shell, and publishing are unavailable. Listed visual/media instruments may pause for a user approval modal; request them only when they advance the plan.'
        : 'This run is READ-ONLY: file edits, shell, and publishing are unavailable and not listed above. Do not attempt them — read, search, and answer, and say plainly if the task would require a write you cannot make.'
      : 'File edits, shell, and publishing are governed by the run\'s permission role: TaskWraith either shows the user an approval modal or blocks the tool. If a tool is blocked, say so and continue with what you can do.',
    'Use ask_user_question when the request is too ambiguous to continue safely or when a mid-task choice belongs to the user.',
    'After a tool result returns, answer normally or request one more tool with the same JSON shape. Do not invent file contents or workspace facts when a tool result is needed.'
  )
  return lines.join('\n')
}

/**
 * Which flavor of the read-only-tier workflow hint to emit.
 *
 *   - 'plan'  — legacy local-scout hint: search/read, then DRAFT A PLAN and
 *     ask the user how to proceed. Correct only when the run is genuinely in
 *     Plan workflow (or, in an ensemble, when this seat is the designated
 *     plan owner of a plan-workflow chat).
 *   - 'recon' — findings-shaped hint: search/read, then report findings in
 *     place. Correct for Ask posture, which is review posture,
 *     not plan ownership (spike 2 of
 *     docs/ensemble-posture-fanout-preamble-design.md — the plan-drafting
 *     hint on read-only tiers was TaskWraith's own self-inflicted source of
 *     plan-shaped recon output for local models).
 *
 * Defaults to 'plan' so callers that have not been made intent-aware keep
 * their existing behavior. Tiers other than read_only ignore the intent.
 */
export type OllamaWorkflowHintIntent = 'plan' | 'recon'

export function ollamaScoutDelegateWorkflowHint(
  modelId?: string | null,
  intent: OllamaWorkflowHintIntent = 'plan'
): string {
  return ollamaTierAwareWorkflowHint(modelId, 'read_only', intent)
}

export function ollamaTierAwareWorkflowHint(
  modelId?: string | null,
  tier: OllamaToolControlTier | string | undefined | null = 'read_only',
  intent: OllamaWorkflowHintIntent = 'plan'
): string {
  const normalizedTier = normalizeOllamaToolControlTier(tier)
  const family = resolveOllamaModelFamily(modelId || '')
  if (normalizedTier === 'approved_edits') {
    return [
      'TaskWraith approved-patcher workflow:',
      'Search or list before reading unfamiliar files, read the exact target, then make a localized edit.',
      'Keep the patch bounded; when the task becomes multi-file or ambiguous, summarize the partial result and ask for explicit scope or a reviewer.'
    ].join(' ')
  }
  if (normalizedTier === 'approved_shell') {
    return [
      'TaskWraith verify-with-shell workflow:',
      'Search/list, read, patch only scoped files, then run a targeted approved verification command when it adds confidence.',
      'Do not attempt unbounded full-suite repair loops; summarize failures and confirm the next scope when the loop expands.'
    ].join(' ')
  }
  if (normalizedTier === 'provider_parity') {
    if (family === 'ornith_9b' || family === 'ornith_35b') {
      return [
        'TaskWraith provider-parity workflow:',
        'Use the full tool surface sparingly and stay anchored to the user request.',
        'Ornith should attempt scoped coding work locally first. Do not recommend or use delegation as the default recovery path; if the task is too broad, claim a clear local slice or explain the exact blocker.'
      ].join(' ')
    }
    return [
      'TaskWraith provider-parity workflow:',
      'Use the full tool surface sparingly and stay anchored to the user request.',
      'Delegation is available only through TaskWraith tools in this tier; use it for broad refactors or long autonomous loops, not as a default.'
    ].join(' ')
  }
  const capableScoutFamily =
    family === 'qwen3_5_9b' ||
    family === 'qwen3_6_35b' ||
    family === 'qwen3_4b' ||
    family === 'qwen3_5_2b' ||
    family === 'minicpm_v45_8b' ||
    family === 'gemma3_4b' ||
    family === 'gemma4_12b' ||
    family === 'ornith_9b' ||
    family === 'ornith_35b' ||
    family === 'laguna_xs_2_1' ||
    family === 'lfm2_5_thinking_1_2b' ||
    family === 'lfm2_5_8b' ||
    family === 'granite4_3b' ||
    family === 'granite4_1_3b' ||
    family === 'granite4_1_30b' ||
    family === 'nemotron3_nano_4b' ||
    family === 'nemotron3_33b' ||
    family === 'qwen3_5_4b' ||
    family === 'devstral_small_2_24b' ||
    family === 'ministral_3_3b' ||
    family === 'ministral_3_14b' ||
    family === 'deepseek_r1_1_5b'
  if (intent === 'recon') {
    return [
      'TaskWraith local-recon workflow:',
      capableScoutFamily
        ? 'Use this Ollama thread to search, read the relevant files, and report your findings directly.'
        : 'Use this local thread to explore the workspace and report what you find.',
      'This is a read-only review turn, not a planning turn: answer in place with findings, evidence, and risks, plus handoff-worthy next steps only when they are genuinely useful. Do not draft an implementation plan and do not stop to ask whether to proceed.',
      'Do not attempt repo-wide refactors or full test-suite repair loops without confirming scope, tier, context, and verification path.'
    ].join(' ')
  }
  const scout = capableScoutFamily
    ? 'Use this Ollama thread to search, read the relevant files, and draft a short implementation plan.'
    : 'Use this local thread to explore the workspace and outline the next steps.'
  return [
    'TaskWraith local-scout workflow:',
    scout,
    'When the plan is ready, ask the user whether to continue locally with a higher tier/profile, assign another participant, or delegate the prepared plan.',
    'Do not attempt repo-wide refactors or full test-suite repair loops without confirming scope, tier, context, and verification path.'
  ].join(' ')
}
