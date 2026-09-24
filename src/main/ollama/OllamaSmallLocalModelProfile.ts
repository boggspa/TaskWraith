/**
 * Lightweight working directive for the SMALLEST local Ollama models.
 *
 * A 1.5B-4B local model is handed the same 47-tool gateway direct set as a
 * 400B cloud model. The schema alone can outweigh the task in its context
 * window, and the breadth of choice is itself a failure mode: it picks an
 * exotic tool, reads a 4,000-line file end to end, and runs out of window
 * before it has made a single edit.
 *
 * This module narrows what those models are SHOWN and supplies efficient
 * default arguments. It deliberately does NOT narrow what they may DO:
 *
 *   - The write/shell tools stay advertised and executable. Mutation is the
 *     point; a small model that cannot edit is useless, not safe.
 *   - Every hidden tool stays reachable through capability_search /
 *     capability_invoke / tool_help exactly as before. This is a context
 *     BUDGET, not a capability wall — the tail is one lookup away.
 *   - The argument hooks only ADD defaults and CLAMP runaway values. None of
 *     them can refuse a call.
 *
 * That last constraint is load-bearing. The retired retrieval-first gate
 * (see OllamaRetrievalFirst.ts) failed precisely because it REFUSED calls:
 * a blocked call costs the model a turn and teaches it nothing, and small
 * models looped against it. Guidance that survives is guidance the model can
 * act on, plus defaults it never has to think about. Nothing here may grow
 * into a refusal, and nothing here may tell a model to hand its work back.
 *
 * Scope is deliberately narrow: LOCAL models only (never Ollama Cloud), and
 * only at or below OLLAMA_SMALL_LOCAL_MODEL_MAX_BILLIONS. A 7B+ local model is
 * untouched and keeps the full surface.
 */

import type { TaskWraithMcpToolName } from '../TaskWraithMcpTools'
import { isOllamaCloudModelId } from '../../shared/ollamaModelAvailability'

/**
 * Parameter ceiling for the small-model directive, in billions.
 *
 * 4.9 rather than 4.0 because a nominal "4B" tag routinely reports more than
 * four billion actual parameters — `gemma3:4b` measures 4.3B — and the next
 * real size tier up is 7-8B. The gap between 4.3 and 7 is wide enough that the
 * exact ceiling inside it does not matter; picking 4.0 would have excluded the
 * very models this targets.
 */
export const OLLAMA_SMALL_LOCAL_MODEL_MAX_BILLIONS = 4.9

/**
 * Size tokens in a model id or a reported `parameter_size`, in billions.
 *
 * Matching is BOUNDARY-ANCHORED, not substring. That is the whole point of
 * this function: `granite4_1_3b` (3B, small) and `granite4_1_30b` (30B, not
 * small) differ by one character, and a substring test for "3b" matches both.
 * The retired retrieval-first gate used substring matching and this is the
 * exact bug it shipped.
 *
 * Rules that fall out of the anchoring:
 *   - The digits must NOT be preceded by an alphanumeric, so the version digit
 *     in `qwen3`/`llama3.2` is never read as a size.
 *   - The unit must NOT be followed by an alphanumeric, so `30b` is 30 while
 *     `30b-a3b` still yields only 30 (`a3b` is preceded by `a`, so the active
 *     -parameter count of an MoE tag can never be mistaken for its real size).
 *   - `m` is accepted as millions, so `smollm2:135m` resolves to 0.135 rather
 *     than falling through as unknown.
 *
 * Returns the LARGEST token found: when a tag carries more than one number the
 * bigger one is the model's real size, and over-estimating keeps a large model
 * out of this profile.
 */
export function parseOllamaModelSizeBillions(value?: string | null): number | null {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
  if (!raw) return null
  const pattern = /(?:^|[^a-z0-9])(\d+(?:\.\d+)?)\s*([bm])(?![a-z0-9.])/g
  let largest: number | null = null
  for (const match of raw.matchAll(pattern)) {
    const magnitude = Number(match[1])
    if (!Number.isFinite(magnitude) || magnitude <= 0) continue
    const billions = match[2] === 'm' ? magnitude / 1_000 : magnitude
    if (largest === null || billions > largest) largest = billions
  }
  return largest
}

/** Structural view of the daemon's model record; avoids importing the provider. */
export interface OllamaSmallModelSizeSource {
  readonly parameterSize?: string | null
  readonly isCloud?: boolean | null
}

/**
 * Best available parameter count for a model, in billions, or null when
 * nothing trustworthy says.
 *
 * The daemon's reported `parameter_size` and the size token in the tag are both
 * consulted and the LARGER wins. Disagreement means one of the two is stale or
 * mis-parsed, and resolving upward fails toward the full tool surface — the
 * safe direction, since the cost of missing a small model is a slightly noisier
 * prompt while the cost of catching a large one is a needlessly narrow schema.
 */
export function resolveOllamaModelSizeBillions(
  modelId?: string | null,
  modelInfo?: OllamaSmallModelSizeSource | null
): number | null {
  const fromInfo = parseOllamaModelSizeBillions(modelInfo?.parameterSize)
  const fromId = parseOllamaModelSizeBillions(modelId)
  if (fromInfo === null) return fromId
  if (fromId === null) return fromInfo
  return Math.max(fromInfo, fromId)
}

/**
 * Does this run target a LOCAL model small enough for the lightweight
 * directive? Signature mirrors the `(modelId, modelInfo)` shape of the other
 * model-shape predicates in OllamaModelProtocol.
 *
 * False for anything on Ollama Cloud, and false when the size is unknown — an
 * unrecognised tag keeps the full surface rather than being guessed into a
 * narrower one.
 */
export function isOllamaSmallLocalModel(
  modelId?: string | null,
  modelInfo?: OllamaSmallModelSizeSource | null
): boolean {
  if (modelInfo?.isCloud === true || isOllamaCloudModelId(modelId)) return false
  const billions = resolveOllamaModelSizeBillions(modelId, modelInfo)
  return billions !== null && billions <= OLLAMA_SMALL_LOCAL_MODEL_MAX_BILLIONS
}

/**
 * The direct tool surface a small local model is SHOWN, in the order it should
 * reach for them: find, read, change, verify, coordinate.
 *
 * Every entry is a member of the gateway direct set, so this only ever narrows
 * — it can never advertise something the posture filters would have removed.
 * The write and shell verbs are here on purpose.
 *
 * What is left out is left out of the SCHEMA, not out of reach: ensemble,
 * canvas, delegation, scheduling, blackboard and the rest stay executable via
 * capability_invoke. A model that genuinely needs one asks capability_search
 * and gets its exact schema, which costs one turn instead of ~36 tool
 * definitions on every single turn of the run.
 */
export const OLLAMA_SMALL_LOCAL_MODEL_DIRECT_TOOLS = Object.freeze([
  // Find
  'workspace_search',
  'find_files',
  'list_directory',
  // Read
  'read_file',
  // Change
  'replace',
  'write_file',
  // Verify
  'run_shell_command',
  'git_status',
  'git_diff',
  // Coordinate
  'todo_write',
  'ask_user_question'
] as const satisfies readonly TaskWraithMcpToolName[])

const OLLAMA_SMALL_LOCAL_MODEL_DIRECT_TOOL_SET = new Set<string>(
  OLLAMA_SMALL_LOCAL_MODEL_DIRECT_TOOLS
)

/** Is this tool part of the narrowed small-model direct surface? */
export function isOllamaSmallLocalModelDirectTool(toolName: string): boolean {
  return OLLAMA_SMALL_LOCAL_MODEL_DIRECT_TOOL_SET.has(toolName)
}

/**
 * The directive appended to the local tool system prompt for a small model.
 *
 * Short on purpose — every line spends the window it is trying to protect. It
 * covers the three things that actually decide whether a 1.5B model finishes:
 * one call at a time, read line ranges instead of whole files, and edit in
 * small slices.
 *
 * The "do the work" line is not filler. It is the counterweight to a directive
 * about being economical, which a small model can otherwise read as permission
 * to stop early. Advising a handoff is exactly the behaviour that was stripped
 * from these prompts in 2026-08 and must not come back.
 */
export function ollamaSmallLocalModelPromptLines(): string[] {
  return [
    'Working directive (short context — spend it on the task, not on scanning):',
    '- One tool call per turn. Read its result before choosing the next call.',
    '- Search before you open. Use workspace_search to locate code, then read_file with startLine/endLine to read only the ~80 lines around the hit. Do not read a large file end to end.',
    '- Change in small slices. Prefer replace with a short unique old_string over rewriting a file with write_file. One file, one change, then check it.',
    '- You have edit and shell tools and you are expected to use them. Make the change yourself; do not stop to hand the work back or ask for a larger model.',
    '- Copy paths exactly as search and list printed them. Paths are workspace-relative.',
    '- After an edit, confirm it with git_diff or one short run_shell_command, then move to the next slice.',
    '- When the task is done, stop calling tools and answer in plain prose.',
    'Typical shape: {"taskwraith_tool":{"name":"workspace_search","arguments":{"query":"resolveThing","path":"src"}}} then {"taskwraith_tool":{"name":"read_file","arguments":{"path":"src/x.ts","startLine":40,"endLine":120}}} then {"taskwraith_tool":{"name":"replace","arguments":{"path":"src/x.ts","old_string":"exact text","new_string":"new text","intent":"why"}}}'
  ]
}

const READ_FILE_DEFAULT_MAX_LINES = 200
const READ_FILE_CEILING_LINES = 400
const SEARCH_DEFAULT_MAX_RESULTS = 20
const SEARCH_CEILING_MAX_RESULTS = 50
const SEARCH_DEFAULT_CONTEXT_LINES = 2
const SEARCH_CEILING_CONTEXT_LINES = 4
const FIND_DEFAULT_MAX_RESULTS = 30
const FIND_CEILING_MAX_RESULTS = 60

function positiveInteger(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  return Math.trunc(numeric)
}

/**
 * Per-tool argument hook applied just before validation and execution, for
 * small local models only.
 *
 * Two jobs, both additive:
 *   - Supply the economical default the model did not think to pass. The
 *     compact native schemas omit `maxResults`/`contextLines` entirely, so a
 *     small model cannot ask for them even when they would help; filling them
 *     in here is strictly cheaper than spending schema tokens teaching them.
 *   - Clamp a value that would flood the window. A clamp still RETURNS the
 *     tool's real result, so the model learns from a smaller answer rather
 *     than losing the turn to a refusal.
 *
 * This never removes a caller's argument, never rejects a call, and never
 * touches the mutation tools' arguments — a bounded `write_file` or a
 * second-guessed `replace` would silently corrupt the user's file, and
 * `intent` must stay the model's own words so `assertOllamaMutationIntent`
 * keeps meaning something.
 */
export function applyOllamaSmallLocalModelToolArguments(
  toolName: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  if (!isOllamaSmallLocalModelDirectTool(toolName)) return args

  if (toolName === 'read_file') {
    const startLine = positiveInteger(args.startLine)
    const endLine = positiveInteger(args.endLine)
    const maxLines = positiveInteger(args.maxLines)
    // An explicit range the model chose is honoured, only capped.
    if (startLine !== null && endLine !== null && endLine >= startLine) {
      return endLine - startLine + 1 > READ_FILE_CEILING_LINES
        ? { ...args, endLine: startLine + READ_FILE_CEILING_LINES - 1 }
        : args
    }
    if (maxLines !== null) {
      return maxLines > READ_FILE_CEILING_LINES
        ? { ...args, maxLines: READ_FILE_CEILING_LINES }
        : args
    }
    // No range at all: the whole-file read that empties a short window.
    return { ...args, maxLines: READ_FILE_DEFAULT_MAX_LINES }
  }

  if (toolName === 'workspace_search') {
    const maxResults = positiveInteger(args.maxResults)
    const contextLines = positiveInteger(args.contextLines)
    return {
      ...args,
      maxResults:
        maxResults === null
          ? SEARCH_DEFAULT_MAX_RESULTS
          : Math.min(maxResults, SEARCH_CEILING_MAX_RESULTS),
      contextLines:
        contextLines === null
          ? SEARCH_DEFAULT_CONTEXT_LINES
          : Math.min(contextLines, SEARCH_CEILING_CONTEXT_LINES)
    }
  }

  if (toolName === 'find_files') {
    const maxResults = positiveInteger(args.maxResults)
    return {
      ...args,
      maxResults:
        maxResults === null
          ? FIND_DEFAULT_MAX_RESULTS
          : Math.min(maxResults, FIND_CEILING_MAX_RESULTS)
    }
  }

  if (toolName === 'list_directory') {
    // `path` is required by the schema; a small model routinely omits it when
    // it means the workspace root. Defaulting beats a validation bounce that
    // costs a turn and teaches nothing.
    const path = typeof args.path === 'string' ? args.path.trim() : ''
    return path ? args : { ...args, path: '.' }
  }

  return args
}
