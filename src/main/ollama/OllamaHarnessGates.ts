import type { OllamaToolControlTier } from '../store/types'
import { ollamaEnforcesRetrievalFirst, ollamaReadFileExemptFromRetrievalFirst } from './OllamaRetrievalFirst'
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
    publishedTodos: false
  }
}

export function normalizeOllamaHarnessPath(pathValue: unknown): string {
  const raw = String(pathValue || '').trim()
  if (!raw) return ''
  return raw.replace(/\\/g, '/').replace(/^\/+/, '')
}

export function ollamaHarnessEnforced(modelId?: string | null): boolean {
  return Boolean(String(modelId || '').trim()) || ollamaEnforcesRetrievalFirst(modelId)
}

export function ollamaHarnessDefaultTodos(): OllamaHarnessTodoScaffoldItem[] {
  return [
    { id: 'explore', content: 'Explore workspace (search or list directories)', status: 'in_progress' },
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

export function ollamaHarnessWorkflowSystemLine(
  tier: OllamaToolControlTier | string | undefined | null
): string {
  const tools = ollamaToolNamesForTier(tier)
  const hasTodos = tools.includes('todo_write')
  const hasEdits = OLLAMA_FILE_EDIT_TOOL_NAMES.some((tool) => tools.includes(tool))
  if (!hasEdits) {
    return 'Harness workflow: explore the workspace with workspace_search or list_directory before read_file on unfamiliar paths.'
  }
  return [
    'Harness workflow: explore (workspace_search or list_directory) → read one target file → localized edit.',
    hasTodos
      ? 'Use todo_write for complex multi-step work, then advance steps as you go.'
      : 'Do not edit files you have not read in this run.'
  ].join(' ')
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
    'Ensemble workspace task: the previous message is the complete TaskWraith Ensemble instruction block, not just the raw user request.',
    'Follow your participant identity, role instructions, Role boundary contract, Boss/Bossman/Lead authority rules, turn position, and current user request exactly as written.',
    'If your assigned role or permission posture is read-only/recon, gather evidence and report findings; do not take implementation work unless assigned.',
    tools.includes('todo_write')
      ? 'Use todo_write only if your assigned ensemble slice genuinely needs a visible checklist.'
      : 'Ground with workspace_search or list_directory before reading unfamiliar paths.'
  ].join(' ')
}

function isEditTool(toolName: string): boolean {
  return OLLAMA_FILE_EDIT_TOOL_NAMES.includes(toolName as (typeof OLLAMA_FILE_EDIT_TOOL_NAMES)[number])
}

function pathsFromApplyPatch(patchValue: unknown): string[] {
  const patch = String(patchValue || '')
  if (!patch.trim()) return []
  const paths = new Set<string>()
  for (const line of patch.split(/\r?\n/)) {
    const match = line.match(/^(?:---|\+\+\+)\s+(?:[ab]\/)?(.+)$/)
    if (!match) continue
    if (match[1].trim() === '/dev/null' || match[1].trim() === 'dev/null') continue
    const normalized = normalizeOllamaHarnessPath(match[1])
    if (normalized && normalized !== 'dev/null') paths.add(normalized)
  }
  return [...paths]
}

export function ollamaHarnessTargetPaths(
  toolName: OllamaToolName | string,
  args: Record<string, unknown>
): string[] {
  if (toolName === 'apply_patch') {
    return pathsFromApplyPatch(args.patch)
  }
  const path = normalizeOllamaHarnessPath(args.path || args.file_path)
  return path ? [path] : []
}

export function ollamaHarnessReadBlockedMessage(pathValue: string): string {
  const query = pathValue.split('/').pop()?.replace(/\.[^.]+$/, '') || pathValue
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

export function ollamaHarnessTodoBlockedMessage(): string {
  return [
    'Harness scheduling: publish the checklist with todo_write before other tools on workspace coding tasks.',
    `Call todo_write with merge:true and todos: ${JSON.stringify(ollamaHarnessDefaultTodos())}`
  ].join(' ')
}

export interface OllamaHarnessGateInput {
  modelId?: string | null
  tier: OllamaToolControlTier | string | undefined | null
  state: OllamaHarnessRunState
  toolName: OllamaToolName | string
  args: Record<string, unknown>
  requireTodoScaffold?: boolean
}

export function evaluateOllamaHarnessGate(input: OllamaHarnessGateInput): {
  blocked: boolean
  message?: string
} {
  const { modelId, state, toolName, args } = input
  if (!ollamaHarnessEnforced(modelId)) return { blocked: false }

  if (toolName === 'read_file') {
    const readPath = normalizeOllamaHarnessPath(args.path || args.file_path)
    if (!state.hasExplored && readPath && !ollamaReadFileExemptFromRetrievalFirst(readPath)) {
      return { blocked: true, message: ollamaHarnessReadBlockedMessage(readPath) }
    }
    return { blocked: false }
  }

  if (isEditTool(toolName)) {
    if (!state.hasExplored) {
      return {
        blocked: true,
        message:
          'Harness explore gate: run workspace_search or list_directory before editing workspace files.'
      }
    }
    const targets = ollamaHarnessTargetPaths(toolName, args)
    if (targets.length === 0) {
      if (state.readPaths.size === 0) {
        return { blocked: true, message: ollamaHarnessEditBlockedMessage([]) }
      }
      return { blocked: false }
    }
    const unread = targets.filter((target) => !state.readPaths.has(target))
    if (unread.length > 0) {
      return { blocked: true, message: ollamaHarnessEditBlockedMessage(unread) }
    }
  }

  return { blocked: false }
}

export function recordOllamaHarnessToolResult(
  state: OllamaHarnessRunState,
  toolName: OllamaToolName | string,
  args: Record<string, unknown>,
  ok: boolean
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
    const path = normalizeOllamaHarnessPath(args.path || args.file_path)
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
    for (const path of ollamaHarnessTargetPaths(toolName, args)) {
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
}): string {
  const base = [
    `TaskWraith executed ${input.toolName}.`,
    input.ok ? 'Tool status: success.' : 'Tool status: error.',
    'Tool result:',
    input.output,
    ''
  ]

  const guidance: string[] = []
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
        guidance.push('Mark the explore todo completed and set read to in_progress when you start reading.')
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
        'Re-read the file if you need another edit. Summarize what changed and whether the original user request is satisfied.'
      )
      if (ollamaToolNamesForTier(input.tier).includes('todo_write') && input.state.publishedTodos) {
        guidance.push('Mark edit completed and move verify to in_progress before you claim the task is done.')
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
      'The tool failed. Follow the harness gate message, try a different allowed tool, or explain the limitation.'
    )
  }

  return [...base, guidance.join(' ')].join('\n')
}
