import { normalize, relative, resolve } from 'node:path'
import type { OllamaToolControlTier } from '../store/types'
import {
  ollamaEnforcesRetrievalFirst,
  ollamaReadFileExemptFromRetrievalFirst
} from './OllamaRetrievalFirst'
import { appendOllamaStickyAskRemnant } from './OllamaStickyAsk'
import {
  OLLAMA_FILE_EDIT_TOOL_NAMES,
  ollamaToolNamesForTier,
  type OllamaToolName
} from './OllamaToolTiers'

export type OllamaHarnessPhase = 'explore' | 'read' | 'edit' | 'verify'

export interface OllamaHarnessRunState {
  hasExplored: boolean
  readPaths: Set<string>
  publishedTodos: boolean
  /** One-shot: the todo_write tip has already ridden on a tool result. */
  todoAdvisoryIssued: boolean
  activePhase?: OllamaHarnessPhase
}

export interface OllamaHarnessTodoScaffoldItem {
  id: string
  content: string
  status: 'pending' | 'in_progress'
}

export function createOllamaHarnessRunState(): OllamaHarnessRunState {
  return {
    hasExplored: false,
    readPaths: new Set<string>(),
    publishedTodos: false,
    todoAdvisoryIssued: false
  }
}

export function normalizeOllamaHarnessPath(
  pathValue: unknown,
  workspacePath?: string | null
): string {
  const raw = String(pathValue || '').trim()
  if (!raw) return ''
  const slashPath = raw.replace(/\\/g, '/')
  if (workspacePath && workspacePath.trim()) {
    const workspaceRoot = resolve(workspacePath)
    const targetPath = resolve(workspaceRoot, slashPath)
    return relative(workspaceRoot, targetPath).replace(/\\/g, '/') || '.'
  }
  return normalize(slashPath).replace(/\\/g, '/').replace(/^\/+/, '')
}

export function ollamaHarnessEnforced(modelId?: string | null): boolean {
  return Boolean(String(modelId || '').trim()) || ollamaEnforcesRetrievalFirst(modelId)
}

export function ollamaHarnessDefaultTodos(): OllamaHarnessTodoScaffoldItem[] {
  return [
    {
      id: 'explore',
      content: 'Explore workspace (search or list directories)',
      status: 'in_progress'
    },
    { id: 'read', content: 'Read only the files needed for the task', status: 'pending' },
    { id: 'edit', content: 'Apply localized edits one file at a time', status: 'pending' },
    { id: 'verify', content: 'Verify changes against the original request', status: 'pending' }
  ]
}

export function ollamaHarnessTodoWriteArguments(): Record<string, unknown> {
  return {
    merge: true,
    todos: ollamaHarnessDefaultTodos()
  }
}

export function ollamaHarnessKickoffPrompt(
  tier: OllamaToolControlTier | string | undefined | null
): string {
  const tools = ollamaToolNamesForTier(tier)
  // Anchor the workflow to the request that precedes this message — without
  // it, small models treat this kickoff as the task and go hunting for work.
  const anchor =
    'Your task is the user request in the previous message — keep every step anchored to that request, and answer it in prose when the steps are done.'
  if (!tools.includes('todo_write')) {
    return [
      'Workspace coding task: start by grounding in the repo.',
      'Call workspace_search or list_directory before read_file on unfamiliar paths.',
      'Read a file before replace/write_file/apply_patch on it.',
      anchor
    ].join(' ')
  }
  return [
    'Workspace coding task: start by grounding in the repo.',
    'Use todo_write only if the task needs a visible multi-step checklist.',
    'Explore with workspace_search or list_directory, read only what you need, and edit one file at a time.',
    `Suggested todos: ${JSON.stringify(ollamaHarnessDefaultTodos())}`,
    anchor
  ].join(' ')
}

export function ollamaEnsembleHarnessKickoffPrompt(
  tier: OllamaToolControlTier | string | undefined | null
): string {
  const tools = ollamaToolNamesForTier(tier)
  return [
    'Ensemble workspace task: start from the Current user request at the top of the previous capsule.',
    'Stay in your local Ollama seat and role; do not invent peers from workspace fixture files.',
    'If your posture is Ask/read-only, gather evidence and report; otherwise do the workspace work your slice needs.',
    tools.includes('todo_write')
      ? 'Use todo_write only if your assigned slice genuinely needs a visible checklist.'
      : 'Ground with workspace_search or list_directory before reading unfamiliar paths.',
    'Use blackboard only for durable shared facts; do not re-post the same key in a loop.'
  ].join(' ')
}

function isEditTool(toolName: string): boolean {
  return OLLAMA_FILE_EDIT_TOOL_NAMES.includes(
    toolName as (typeof OLLAMA_FILE_EDIT_TOOL_NAMES)[number]
  )
}

function pathsFromApplyPatch(patchValue: unknown, workspacePath?: string | null): string[] {
  const patch = String(patchValue || '')
  if (!patch.trim()) return []
  const paths = new Set<string>()
  for (const line of patch.split(/\r?\n/)) {
    const match = line.match(/^(?:---|\+\+\+)\s+(?:[ab]\/)?(.+)$/)
    if (!match) continue
    if (match[1].trim() === '/dev/null' || match[1].trim() === 'dev/null') continue
    const normalized = normalizeOllamaHarnessPath(match[1], workspacePath)
    if (normalized && normalized !== 'dev/null') paths.add(normalized)
  }
  return [...paths]
}

export function ollamaHarnessTargetPaths(
  toolName: OllamaToolName | string,
  args: Record<string, unknown>,
  workspacePath?: string | null
): string[] {
  if (toolName === 'apply_patch') {
    return pathsFromApplyPatch(args.patch, workspacePath)
  }
  const path = normalizeOllamaHarnessPath(args.path || args.file_path, workspacePath)
  return path ? [path] : []
}

export function ollamaHarnessReadBlockedMessage(pathValue: string): string {
  const query =
    pathValue
      .split('/')
      .pop()
      ?.replace(/\.[^.]+$/, '') || pathValue
  return [
    'Harness explore gate: run workspace_search or list_directory before read_file on unfamiliar paths.',
    `Suggested: workspace_search({"query":"${query}","path":".","maxResults":25,"contextLines":1})`,
    'Then read only the highest-ranked file you actually need.'
  ].join(' ')
}

export function ollamaHarnessEditBlockedMessage(paths: string[]): string {
  const listed = paths.length ? paths.join(', ') : 'the target file'
  return [
    `Harness edit gate: read ${listed} with read_file in this run before replace/write_file/apply_patch.`,
    'Search first if you do not know where to look, then read the exact region you will patch.'
  ].join(' ')
}

/**
 * One-shot todo encouragement, taken (not read) so it can only ever fire once
 * per run. This replaces the retired `requireTodoScaffold` hard block, which
 * refused EVERY tool until todos were published and dictated a canned
 * checklist — the exact intent-override the local-model un-nerf removed. The
 * tip rides on the first clean tool result instead: by then the model has its
 * own first evidence in hand, and whether the task deserves a checklist is its
 * call, with its own steps in its own words.
 *
 * Returns null (and stamps nothing) when the run has already published todos,
 * when the tier has no todo_write, or for todo_write's own result.
 */
export function takeOllamaHarnessTodoAdvisory(
  state: OllamaHarnessRunState,
  tier: OllamaToolControlTier | string | undefined | null,
  toolName: OllamaToolName | string
): string | null {
  if (state.todoAdvisoryIssued || state.publishedTodos) return null
  if (toolName === 'todo_write') return null
  if (!ollamaToolNamesForTier(tier).includes('todo_write')) return null
  state.todoAdvisoryIssued = true
  return [
    'One-time tip: if this task needs several steps, publish a short checklist now with todo_write (merge:true) — your own steps, in your own words — to keep the remaining turns focused.',
    'Skip it if the task is a single step.'
  ].join(' ')
}

export interface OllamaHarnessGateInput {
  modelId?: string | null
  workspacePath?: string | null
  tier: OllamaToolControlTier | string | undefined | null
  state: OllamaHarnessRunState
  toolName: OllamaToolName | string
  args: Record<string, unknown>
}

export function evaluateOllamaHarnessGate(input: OllamaHarnessGateInput): {
  blocked: boolean
  message?: string
} {
  const { modelId, state, toolName, args } = input
  const needsRetrievalFirst = ollamaEnforcesRetrievalFirst(modelId)

  // Retrieve-first policy: explore before read, read before edit
  if (needsRetrievalFirst) {
    // Must explore before reading
    if (toolName === 'read_file') {
      if (!state.hasExplored) {
        return {
          blocked: true,
          message: ollamaHarnessReadBlockedMessage(String(args.path || args.file_path))
        }
      }
    }

    // Must read before editing
    if (isEditTool(toolName)) {
      const paths = ollamaHarnessTargetPaths(toolName, args, input.workspacePath)
      const missingReads = paths.filter(
        (p) => !state.readPaths.has(p) && !ollamaReadFileExemptFromRetrievalFirst(p)
      )
      if (missingReads.length > 0) {
        return {
          blocked: true,
          message: ollamaHarnessEditBlockedMessage(missingReads)
        }
      }
    }
  }

  // Todo encouragement is deliberately NOT a gate: it rides on the first tool
  // RESULT as a one-shot tip (takeOllamaHarnessTodoAdvisory). The old
  // requireTodoScaffold refusal blocked every tool until todos were published,
  // which re-nerfed every model regardless of the retrieval-first membership.
  return { blocked: false }
}

export function recordOllamaHarnessToolResult(
  state: OllamaHarnessRunState,
  toolName: OllamaToolName | string,
  args: Record<string, unknown>,
  ok: boolean,
  workspacePath?: string | null
): OllamaHarnessRunState {
  if (!ok) return state

  if (
    toolName === 'workspace_search' ||
    toolName === 'list_directory' ||
    toolName === 'find_files' ||
    toolName === 'workspace_symbols'
  ) {
    state.hasExplored = true
    state.activePhase = 'explore'
  }

  if (toolName === 'read_file') {
    const path = normalizeOllamaHarnessPath(args.path || args.file_path, workspacePath)
    if (path) {
      state.readPaths.add(path)
      state.activePhase = 'read'
    }
  }

  if (toolName === 'todo_write') {
    state.publishedTodos = true
  }

  if (isEditTool(toolName)) {
    state.activePhase = 'edit'
    for (const path of ollamaHarnessTargetPaths(toolName, args, workspacePath)) {
      state.readPaths.delete(path)
    }
  }

  return state
}

export function ollamaHarnessToolFollowUpPrompt(input: {
  toolName: OllamaToolName | string
  output: string
  ok: boolean
  state: OllamaHarnessRunState
  tier: OllamaToolControlTier | string | undefined | null
  ensembleRun?: boolean
  currentRequestExcerpt?: string
}): string {
  const base = [
    `TaskWraith executed ${input.toolName}.`,
    input.ok ? 'Tool status: success.' : 'Tool status: error.',
    'Tool result:',
    input.output,
    ''
  ]

  const guidance: string[] = []
  if (input.ensembleRun) {
    guidance.push(
      "Keep following your assigned local seat and stay inside your role / authority boundary from the capsule; do not invent peers or broaden into another participant's slice."
    )
  }
  if (input.ok) {
    if (
      input.toolName === 'workspace_search' ||
      input.toolName === 'list_directory' ||
      input.toolName === 'find_files' ||
      input.toolName === 'workspace_symbols'
    ) {
      guidance.push(
        'Pick the best match from these results and read_file that path only — do not read whole directories blindly.'
      )
      if (ollamaToolNamesForTier(input.tier).includes('todo_write') && input.state.publishedTodos) {
        guidance.push(
          'Mark the explore todo completed and set read to in_progress when you start reading.'
        )
      }
    } else if (input.toolName === 'read_file') {
      guidance.push(
        'If you need to edit, use replace with an exact old_string copied from this file content — one file per turn.',
        'If the edit target is elsewhere or hard to pin down, run workspace_search (ripgrep) with a distinctive literal from the code to locate the exact lines first.'
      )
      if (ollamaToolNamesForTier(input.tier).includes('todo_write') && input.state.publishedTodos) {
        guidance.push('Advance the harness todos: read in_progress or completed before editing.')
      }
    } else if (isEditTool(input.toolName)) {
      guidance.push(
        input.ensembleRun
          ? 'Re-read the file if you need another edit. Summarize what changed and whether your assigned ensemble slice is satisfied.'
          : 'Re-read the file if you need another edit. Summarize what changed and whether the original user request is satisfied.'
      )
      if (ollamaToolNamesForTier(input.tier).includes('todo_write') && input.state.publishedTodos) {
        guidance.push(
          'Mark edit completed and move verify to in_progress before you claim the task is done.'
        )
      }
    } else if (input.toolName === 'todo_write') {
      guidance.push(
        'Follow the harness checklist in order: explore → read → edit → verify. Call the next tool for the active step.'
      )
    } else {
      guidance.push(
        'Continue the task using this result. Call another TaskWraith tool only if strictly required, then answer in prose when done.'
      )
    }
  } else {
    guidance.push(
      'The tool failed. If this was bad or missing arguments, re-issue the same tool with corrected args from the error. Otherwise follow the harness gate message, try a different allowed tool, or explain the limitation.'
    )
  }

  const body = [...base, guidance.join(' ')].join('\n')
  if (!input.ok) {
    return appendOllamaStickyAskRemnant(body, input.currentRequestExcerpt)
  }
  return body
}
