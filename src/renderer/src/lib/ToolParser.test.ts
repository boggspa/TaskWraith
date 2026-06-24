import { describe, it, expect } from 'vitest'
import {
  extractToolName,
  extractToolId,
  extractParameters,
  extractToolKind,
  extractResultOutput,
  extractStatus,
  getToolCategory,
  isReasoningToolName,
  mapToolKindToCategory,
  getToolDisplayName,
  isWriteLikeToolName,
  estimateLineChanges,
  deriveToolDiffSummary,
  parseUnifiedDiffSummary,
  createToolActivity,
  pairToolResult,
  isToolUseEvent,
  isToolResultEvent,
  unwrapMcpEnvelope,
  extractMcpImageBlocks,
  prettyPrintJson
} from './ToolParser'

describe('ToolParser', () => {
  describe('extractToolName', () => {
    it('extracts tool_name', () => {
      expect(extractToolName({ tool_name: 'read_file' })).toBe('read_file')
    })
    it('extracts toolName', () => {
      expect(extractToolName({ toolName: 'writeFile' })).toBe('writeFile')
    })
    it('extracts name', () => {
      expect(extractToolName({ name: 'search' })).toBe('search')
    })
    it('extracts function.name', () => {
      expect(extractToolName({ function: { name: 'replace' } })).toBe('replace')
    })
    it('falls back to unknown', () => {
      expect(extractToolName({})).toBe('unknown')
      expect(extractToolName(null)).toBe('unknown')
    })
  })

  describe('extractToolId', () => {
    it('extracts tool_id', () => {
      expect(extractToolId({ tool_id: 'abc' })).toBe('abc')
    })
    it('extracts toolId', () => {
      expect(extractToolId({ toolId: 'def' })).toBe('def')
    })
    it('extracts id', () => {
      expect(extractToolId({ id: 'ghi' })).toBe('ghi')
    })
    it('extracts call_id', () => {
      expect(extractToolId({ call_id: 'jkl' })).toBe('jkl')
    })
    it('generates fallback with timestamp', () => {
      expect(extractToolId({})).toMatch(/^unknown-\d+/)
    })
  })

  describe('extractParameters', () => {
    it('extracts parameters', () => {
      expect(extractParameters({ parameters: { a: 1 } })).toEqual({ a: 1 })
    })
    it('extracts params', () => {
      expect(extractParameters({ params: { b: 2 } })).toEqual({ b: 2 })
    })
    it('extracts args', () => {
      expect(extractParameters({ args: { c: 3 } })).toEqual({ c: 3 })
    })
    it('extracts input', () => {
      expect(extractParameters({ input: { d: 4 } })).toEqual({ d: 4 })
    })
    it('extracts payload', () => {
      expect(extractParameters({ payload: { e: 5 } })).toEqual({ e: 5 })
    })
    it('returns empty object for missing params', () => {
      expect(extractParameters({})).toEqual({})
    })
  })

  describe('extractResultOutput', () => {
    it('extracts output string', () => {
      expect(extractResultOutput({ output: 'hello' })).toBe('hello')
    })
    it('extracts result string', () => {
      expect(extractResultOutput({ result: 'world' })).toBe('world')
    })
    it('extracts content string', () => {
      expect(extractResultOutput({ content: 'foo' })).toBe('foo')
    })
    it('extracts summary string', () => {
      expect(extractResultOutput({ summary: 'visible update' })).toBe('visible update')
    })
    it('extracts result.output', () => {
      expect(extractResultOutput({ result: { output: 'bar' } })).toBe('bar')
    })
    it('stringifies result object', () => {
      expect(extractResultOutput({ result: { x: 1 } })).toBe('{"x":1}')
    })
    it('returns empty string for missing output', () => {
      expect(extractResultOutput({})).toBe('')
    })
  })

  describe('extractStatus', () => {
    it('returns error when error present', () => {
      expect(extractStatus({ error: 'fail' })).toBe('error')
    })
    it('returns error when status is error', () => {
      expect(extractStatus({ status: 'error' })).toBe('error')
    })
    it('returns warning when status is warning', () => {
      expect(extractStatus({ status: 'warning' })).toBe('warning')
    })
    it('returns success by default', () => {
      expect(extractStatus({})).toBe('success')
    })
  })

  describe('isReasoningToolName', () => {
    it('recognises provider-specific and generic reasoning channels', () => {
      expect(isReasoningToolName('codex_reasoning')).toBe(true)
      expect(isReasoningToolName('kimi_thinking')).toBe(true)
      expect(isReasoningToolName('ollama_thinking')).toBe(true)
      expect(isReasoningToolName('thinking')).toBe(true)
      expect(isReasoningToolName('mcp__taskwraith__gemini_reasoning')).toBe(true)
    })

    it('does not match ordinary tools', () => {
      expect(isReasoningToolName('read_file')).toBe(false)
      expect(isReasoningToolName('run_shell_command')).toBe(false)
      expect(isReasoningToolName('')).toBe(false)
    })
  })

  describe('getToolCategory', () => {
    it('maps update_topic to task', () => {
      expect(getToolCategory('update_topic')).toBe('task')
    })
    it('maps invoke_agent and summary to task', () => {
      expect(getToolCategory('invoke_agent')).toBe('task')
      expect(getToolCategory('summary')).toBe('task')
    })
    it('maps Kimi thinking to task', () => {
      expect(getToolCategory('kimi_thinking')).toBe('task')
      expect(getToolCategory('ollama_thinking')).toBe('task')
      expect(getToolCategory('grok_thinking')).toBe('task')
      expect(getToolCategory('mcp__taskwraith__claude_reasoning')).toBe('task')
      expect(getToolDisplayName('kimi_thinking', {})).toBe('Kimi thinking')
    })
    it('maps read_file to read', () => {
      expect(getToolCategory('read_file')).toBe('read')
    })
    it('maps list_directory to read', () => {
      expect(getToolCategory('list_directory')).toBe('read')
    })
    it('maps replace to write', () => {
      expect(getToolCategory('replace')).toBe('write')
    })
    it('maps write_file to write', () => {
      expect(getToolCategory('write_file')).toBe('write')
    })
    it('maps write-like provider variants to write', () => {
      expect(getToolCategory('apply_patch')).toBe('write')
      expect(getToolCategory('Edit')).toBe('write')
      expect(getToolCategory('MultiEdit')).toBe('write')
      expect(getToolCategory('str_replace')).toBe('write')
      expect(getToolCategory('TaskWraith__write_file')).toBe('write')
    })
    it('maps create_file to write', () => {
      expect(getToolCategory('create_file')).toBe('write')
    })
    it('maps grep_search to search', () => {
      expect(getToolCategory('grep_search')).toBe('search')
    })
    it('maps run_shell_command to shell', () => {
      expect(getToolCategory('run_shell_command')).toBe('shell')
    })
    it('maps unknown to unknown', () => {
      expect(getToolCategory('magic')).toBe('unknown')
    })
    // 1.0.4-AA — Kimi + some MCP wrappers strip underscores
    // from tool names. These no-separator variants used to fall
    // through to 'unknown' and render as "Used readfile" / no icon.
    it('maps no-separator readfile to read', () => {
      expect(getToolCategory('readfile')).toBe('read')
      expect(getToolCategory('ReadFile')).toBe('read')
    })
    it('maps no-separator listdirectory + list_dir variants to read', () => {
      expect(getToolCategory('listdirectory')).toBe('read')
      expect(getToolCategory('list_dir')).toBe('read')
      expect(getToolCategory('listdir')).toBe('read')
    })
    it('maps no-separator writefile + variants to write', () => {
      expect(getToolCategory('writefile')).toBe('write')
      expect(getToolCategory('editfile')).toBe('write')
      expect(getToolCategory('createfile')).toBe('write')
      expect(getToolCategory('deletefile')).toBe('write')
      expect(getToolCategory('applypatch')).toBe('write')
      expect(getToolCategory('strreplace')).toBe('write')
    })
    it('maps exit_plan_mode + exitplanmode variants to task', () => {
      expect(getToolCategory('exit_plan_mode')).toBe('task')
      expect(getToolCategory('exitplanmode')).toBe('task')
      expect(getToolCategory('ExitPlanMode')).toBe('task')
    })
    it('maps ask_user_question + askuserquestion to task', () => {
      expect(getToolCategory('ask_user_question')).toBe('task')
      expect(getToolCategory('askuserquestion')).toBe('task')
    })
    // Cursor / Grok-ACP machine tool names that previously fell through to the
    // generic dot when they reached name-based resolution.
    it('maps run_terminal_command + variants to shell', () => {
      expect(getToolCategory('run_terminal_command')).toBe('shell')
      expect(getToolCategory('runterminalcommand')).toBe('shell')
      expect(getToolCategory('terminal')).toBe('shell')
    })
    it('maps search_replace to write', () => {
      expect(getToolCategory('search_replace')).toBe('write')
      expect(getToolCategory('searchreplace')).toBe('write')
    })
    it('maps todo_write + update_todo_list variants to task', () => {
      expect(getToolCategory('todo_write')).toBe('task')
      expect(getToolCategory('todowrite')).toBe('task')
      expect(getToolCategory('update_todo_list')).toBe('task')
    })
  })

  describe('mapToolKindToCategory', () => {
    it('maps canonical ACP kinds onto activity categories', () => {
      expect(mapToolKindToCategory('read')).toBe('read')
      expect(mapToolKindToCategory('edit')).toBe('write')
      expect(mapToolKindToCategory('delete')).toBe('write')
      expect(mapToolKindToCategory('move')).toBe('write')
      expect(mapToolKindToCategory('search')).toBe('search')
      expect(mapToolKindToCategory('fetch')).toBe('search')
      expect(mapToolKindToCategory('execute')).toBe('shell')
      expect(mapToolKindToCategory('think')).toBe('task')
    })
    it('is case- and whitespace-insensitive', () => {
      expect(mapToolKindToCategory('  Edit ')).toBe('write')
      expect(mapToolKindToCategory('EXECUTE')).toBe('shell')
    })
    it('returns undefined for other / unknown / empty so name-based wins', () => {
      expect(mapToolKindToCategory('other')).toBeUndefined()
      expect(mapToolKindToCategory('magic')).toBeUndefined()
      expect(mapToolKindToCategory('')).toBeUndefined()
      expect(mapToolKindToCategory(null)).toBeUndefined()
      expect(mapToolKindToCategory(undefined)).toBeUndefined()
    })
  })

  describe('extractToolKind', () => {
    it('reads tool_kind / toolKind / kind, lowercased + trimmed', () => {
      expect(extractToolKind({ tool_kind: 'Edit' })).toBe('edit')
      expect(extractToolKind({ toolKind: ' EXECUTE ' })).toBe('execute')
      expect(extractToolKind({ kind: 'read' })).toBe('read')
    })
    it('returns empty string when absent or non-string', () => {
      expect(extractToolKind({})).toBe('')
      expect(extractToolKind({ kind: 42 })).toBe('')
      expect(extractToolKind(null)).toBe('')
    })
  })

  describe('isWriteLikeToolName', () => {
    it('recognizes unqualified and MCP-qualified write tools', () => {
      expect(isWriteLikeToolName('apply_patch')).toBe(true)
      expect(isWriteLikeToolName('mcp__TaskWraith__replace')).toBe(true)
      expect(isWriteLikeToolName('TaskWraith__write_file')).toBe(true)
      expect(isWriteLikeToolName('run_shell_command')).toBe(false)
    })
  })

  describe('getToolDisplayName', () => {
    it('shows task title', () => {
      expect(getToolDisplayName('update_topic', { title: 'Planning' })).toBe(
        'Topic update: Planning'
      )
    })
    it('humanises ensemble yield tools through MCP namespace variants', () => {
      expect(getToolDisplayName('mcp_TaskWraith_ensemble_yield', { target: 'Reviewer' })).toBe(
        'Yielding to Reviewer'
      )
      expect(getToolDisplayName('mcp__TaskWraith__ensemble_yield', {})).toBe('Yielding')
    })
    it('shows delegated task title', () => {
      expect(getToolDisplayName('invoke_agent', { title: 'Metal harness' })).toBe('Metal harness')
    })
    it('labels the image tools (SVG cased, past-tense), across MCP namespaces', () => {
      expect(getToolDisplayName('image_edit', {})).toBe('Edited image')
      expect(getToolDisplayName('svg_rasterize', {})).toBe('Rasterized SVG')
      expect(getToolDisplayName('image_generate', {})).toBe('Generated image')
      expect(getToolDisplayName('mcp__TaskWraith__svg_rasterize', {})).toBe('Rasterized SVG')
    })
    it('shows Read file with path', () => {
      expect(getToolDisplayName('read_file', { file_path: 'README.md' })).toBe('Read README.md')
    })
    it('shows Edited file for replace', () => {
      expect(getToolDisplayName('replace', { file_path: 'README.md' })).toBe('Edited README.md')
    })
    it('shows Created file for create_file', () => {
      expect(getToolDisplayName('create_file', { file_path: 'test.swift' })).toBe(
        'Created test.swift'
      )
    })
    it('shows Wrote file for write_file', () => {
      expect(getToolDisplayName('write_file', { file_path: 'out.txt' })).toBe('Wrote out.txt')
    })
    // 1.0.4-AA — the new no-separator variants need to surface
    // the same friendly verb + path label as their snake_case
    // canonicals.
    it('shows Read for no-separator readfile', () => {
      expect(getToolDisplayName('readfile', { file_path: 'lib.ts' })).toBe('Read lib.ts')
    })
    it('shows Listed for no-separator listdirectory + list_dir', () => {
      expect(getToolDisplayName('listdirectory', { path: 'src' })).toBe('Listed src')
      expect(getToolDisplayName('list_dir', { path: 'src' })).toBe('Listed src')
    })
    it('shows Wrote for no-separator writefile', () => {
      expect(getToolDisplayName('writefile', { file_path: 'out.txt' })).toBe('Wrote out.txt')
    })
    it('shows Edited for no-separator editfile + applypatch + strreplace', () => {
      expect(getToolDisplayName('editfile', { file_path: 'a.ts' })).toBe('Edited a.ts')
      expect(getToolDisplayName('applypatch', { file_path: 'a.ts' })).toBe('Edited a.ts')
      expect(getToolDisplayName('strreplace', { file_path: 'a.ts' })).toBe('Edited a.ts')
    })
    it('shows Created for no-separator createfile', () => {
      expect(getToolDisplayName('createfile', { file_path: 'new.ts' })).toBe('Created new.ts')
    })
    it('shows Deleted for no-separator deletefile', () => {
      expect(getToolDisplayName('deletefile', { file_path: 'old.ts' })).toBe('Deleted old.ts')
    })
    it('shows Exited plan mode for exit_plan_mode + exitplanmode', () => {
      expect(getToolDisplayName('exit_plan_mode', {})).toBe('Exited plan mode')
      expect(getToolDisplayName('exitplanmode', {})).toBe('Exited plan mode')
      expect(getToolDisplayName('ExitPlanMode', {})).toBe('Exited plan mode')
    })
    it('shows Asked user for ask_user_question variants', () => {
      expect(getToolDisplayName('ask_user_question', {})).toBe('Asked user')
      expect(getToolDisplayName('askuserquestion', {})).toBe('Asked user')
    })
    it('shows a generic Searched label when the target is unknown', () => {
      expect(getToolDisplayName('grep_search', {})).toBe('Searched')
    })
    it('labels searches by their target deterministically', () => {
      expect(getToolDisplayName('web_search', { query: 'M4 Ultra price' })).toBe(
        'Searched the web for M4 Ultra price'
      )
      expect(getToolDisplayName('web_search', {})).toBe('Searched the web')
      expect(getToolDisplayName('workspace_search', { query: 'foo' })).toBe(
        'Searched the workspace for foo'
      )
      expect(getToolDisplayName('tw_recall_find', { taskQuery: 'M3 Ultra' })).toBe(
        'Searched past threads for M3 Ultra'
      )
      expect(getToolDisplayName('mcp__TaskWraith__tw_recall_find', {})).toBe('Searched past threads')
    })
    it('shows Shell command', () => {
      expect(getToolDisplayName('run_shell_command', {})).toBe('Shell command')
    })
    it('shows creative tool names instead of raw identifiers', () => {
      expect(getToolDisplayName('creative_app_status', {})).toBe('Creative app status')
      expect(getToolDisplayName('TaskWraith__creative_app_capabilities', {})).toBe(
        'Creative app capabilities'
      )
      expect(
        getToolDisplayName('mcp__TaskWraith__creative_project_snapshot', { path: 'edit.fcpxml' })
      ).toBe('Creative project snapshot edit.fcpxml')
      expect(getToolDisplayName('creative_timeline_validate', { path: 'edit.fcpxml' })).toBe(
        'Validate timeline edit.fcpxml'
      )
      expect(getToolDisplayName('creative_timeline_ir', { path: 'edit.fcpxml' })).toBe(
        'Timeline IR edit.fcpxml'
      )
      expect(
        getToolDisplayName('creative_timeline_diff', {
          beforePath: 'original.fcpxml',
          afterPath: 'draft.fcpxml'
        })
      ).toBe('Timeline diff original.fcpxml -> draft.fcpxml')
    })
    it('humanises snake_case tool names through the title-case fallback', () => {
      expect(getToolDisplayName('magic_tool', {})).toBe('Used Magic Tool')
    })
    it('shows Used unknown when no name', () => {
      expect(getToolDisplayName('', {})).toBe('Used unknown')
    })
    it('uses the ToolDisplayNames dictionary for delegate_to_subthread', () => {
      expect(getToolDisplayName('delegate_to_subthread', {})).toBe('Delegated to sub-thread')
    })
    it('uses the dictionary through provider namespace prefixes', () => {
      expect(getToolDisplayName('mcp__TaskWraith__delegate_to_subthread', {})).toBe(
        'Delegated to sub-thread'
      )
      expect(getToolDisplayName('taskwraith__attached_window_capture', {})).toBe(
        'Captured attached window'
      )
    })
    it('uses the dictionary for editor / IDE transport tools', () => {
      expect(getToolDisplayName('reveal_in_finder', {})).toBe('Revealed in Finder')
      expect(getToolDisplayName('open_in_ide_at_position', {})).toBe('Opened in IDE at position')
    })
    it('uses the dictionary for AppWatch and browser monitoring tools', () => {
      expect(getToolDisplayName('appwatch_latest_frame', {})).toBe('Latest AppWatch frame')
      expect(getToolDisplayName('appwatch_frames', {})).toBe('AppWatch frames')
      expect(getToolDisplayName('browser_navigate', {})).toBe('Navigated browser')
      expect(getToolDisplayName('mcp__TaskWraith__browser_snapshot', {})).toBe('Browser snapshot')
    })
    it('uses the dictionary for handoff and collaboration fallbacks', () => {
      expect(getToolDisplayName('get_handoff_cards', {})).toBe('Handoff cards')
      expect(getToolDisplayName('collabToolCall', {})).toBe('Collaboration tool call')
    })
  })

  describe('estimateLineChanges', () => {
    it('estimates from old_string/new_string', () => {
      const result = estimateLineChanges({ old_string: 'a\nb', new_string: 'c\nd\ne' })
      expect(result.additions).toBe(3)
      expect(result.deletions).toBe(2)
    })
    it('returns empty object for missing params', () => {
      expect(estimateLineChanges({})).toEqual({})
    })
  })

  describe('createToolActivity', () => {
    it('creates a running activity with correct fields', () => {
      const activity = createToolActivity({
        type: 'tool_use',
        tool_name: 'read_file',
        tool_id: 't1',
        parameters: { file_path: 'README.md' }
      })
      expect(activity.id).toBe('t1')
      expect(activity.toolName).toBe('read_file')
      expect(activity.displayName).toBe('Read README.md')
      expect(activity.category).toBe('read')
      expect(activity.status).toBe('running')
      expect(activity.parameters).toEqual({ file_path: 'README.md' })
      expect(activity.filePath).toBe('README.md')
      expect(activity.rawUseEvent).toBeDefined()
    })
    // The Grok ACP transport labels tool calls with a freeform human title
    // (toolName) plus a canonical `tool_kind`. The kind must drive the category
    // icon so an "edit" call gets the write icon instead of the generic dot.
    it('prefers a canonical tool_kind over a non-resolvable title for the category', () => {
      const activity = createToolActivity({
        type: 'tool_use',
        tool_name: 'Write `package.json`',
        tool_kind: 'edit',
        tool_id: 'call-1',
        parameters: { path: 'package.json' }
      })
      expect(activity.category).toBe('write')
      // Human title is preserved as the label (not forced to a generic name).
      expect(activity.toolName).toBe('Write `package.json`')
    })
    it('maps ACP execute kind to the shell category', () => {
      const activity = createToolActivity({
        type: 'tool_use',
        tool_name: 'Run terminal command',
        tool_kind: 'execute',
        tool_id: 'call-2'
      })
      expect(activity.category).toBe('shell')
    })
    it('falls back to name-based category when tool_kind is other/absent', () => {
      expect(
        createToolActivity({ type: 'tool_use', tool_name: 'read_file', tool_kind: 'other' })
          .category
      ).toBe('read')
      expect(
        createToolActivity({ type: 'tool_use', tool_name: 'run_shell_command' }).category
      ).toBe('shell')
    })
  })

  describe('pairToolResult', () => {
    it('pairs result with use and updates status', () => {
      const use = createToolActivity({
        type: 'tool_use',
        tool_name: 'read_file',
        tool_id: 't1',
        parameters: { file_path: 'README.md' }
      })
      use.startedAt = new Date(Date.now() - 100).toISOString()
      const result = pairToolResult(use, {
        type: 'tool_result',
        tool_id: 't1',
        output: 'file content here'
      })
      expect(result.status).toBe('success')
      expect(result.resultSummary).toBe('file content here')
      expect(result.endedAt).toBeDefined()
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })
    it('truncates long output', () => {
      const use = createToolActivity({ type: 'tool_use', tool_name: 'x', tool_id: 't1' })
      const longOutput = 'a'.repeat(600)
      const result = pairToolResult(use, { output: longOutput })
      expect(result.resultSummary).toMatch(/\.\.\.$/)
      expect(result.resultSummary!.length).toBeLessThanOrEqual(503)
    })
    it('keeps reasoning / thinking traces in full (no preview cap)', () => {
      const use = createToolActivity({
        type: 'tool_use',
        tool_name: 'grok_thinking',
        tool_id: 't1',
        parameters: { kind: 'reasoning' }
      })
      const longTrace = 'reasoning '.repeat(200) // ~2000 chars, well over the 500 cap
      const result = pairToolResult(use, { output: longTrace })
      expect(result.resultSummary).toBe(longTrace)
      expect(result.resultSummary!.length).toBeGreaterThan(500)
      expect(result.resultSummary).not.toMatch(/\.\.\.$/)
    })
  })

  describe('diff telemetry', () => {
    it('extracts exact stats from Codex changes first', () => {
      const summary = deriveToolDiffSummary('edit_file', {
        changes: [
          { path: 'src/App.tsx', kind: 'modify', additions: 12, deletions: 3 },
          { path: 'src/main.css', kind: 'modify', added: 4, deleted: 1 }
        ],
        patchPreview: 'not a unified diff'
      })

      expect(summary?.source).toBe('codex_changes')
      expect(summary?.confidence).toBe('exact')
      expect(summary?.additions).toBe(16)
      expect(summary?.deletions).toBe(4)
      expect(summary?.files).toHaveLength(2)
    })

    it('parses unified diffs when changes do not carry stats', () => {
      const summary = parseUnifiedDiffSummary(
        [
          'diff --git a/a.ts b/a.ts',
          '--- a/a.ts',
          '+++ b/a.ts',
          '@@ -1,2 +1,3 @@',
          ' line',
          '-old',
          '+new',
          '+next'
        ].join('\n')
      )

      expect(summary?.source).toBe('patch_preview')
      expect(summary?.additions).toBe(2)
      expect(summary?.deletions).toBe(1)
      expect(summary?.files?.[0].path).toBe('a.ts')
    })

    it('uses the parameter path when patch-like output has hunks but no file header', () => {
      const summary = deriveToolDiffSummary('edit_file', {
        path: 'Sources/Game.swift',
        patchPreview: ['@@ -1,2 +1,3 @@', ' context', '-old', '+new', '+next'].join('\n')
      })

      expect(summary?.additions).toBe(2)
      expect(summary?.deletions).toBe(1)
      expect(summary?.files?.[0].path).toBe('Sources/Game.swift')
    })

    it('falls back to estimated replace/content stats and tolerates old activities', () => {
      expect(
        deriveToolDiffSummary('replace', {
          path: 'a.ts',
          old_string: 'a\nb',
          new_string: 'a\nb\nc'
        })?.confidence
      ).toBe('estimated')
      expect(
        deriveToolDiffSummary('run_shell_command', { command: 'sed -i s/a/b/g a.ts' })
      ).toBeUndefined()
    })

    it('does NOT treat prose with leading +/- lines as a diff (no hunk structure)', () => {
      // Free-form text — e.g. a reasoning trace or assistant message — frequently
      // contains markdown bullets ("- item") or "+something". Without a real hunk
      // header / diff --git / +++ --- pair it must NOT be counted as a diff.
      expect(
        parseUnifiedDiffSummary(
          [
            "Sure! Here's the plan:",
            '- Minimal comment-only files (JokeComment*)',
            '- A Metal shader one',
            '+ extra idea'
          ].join('\n')
        )
      ).toBeUndefined()
    })

    it('regression: a thinking trace with a "- bullet" never yields a phantom +0 -1', () => {
      // The exact shape that produced the bogus "+0 -1" on the Grok Thinking card.
      const thinking =
        'The user wants test files.\n- Minimal comment-only files (JokeComment*)\nNow I will start.'
      expect(
        deriveToolDiffSummary('grok_thinking', { kind: 'reasoning' }, thinking)
      ).toBeUndefined()
      // Even without the reasoning hint, a *_thinking pseudo-tool never diffs.
      expect(deriveToolDiffSummary('kimi_thinking', {}, thinking)).toBeUndefined()
      // And a non-thinking tool whose result is plain prose is also clean now.
      expect(deriveToolDiffSummary('some_tool', {}, thinking)).toBeUndefined()
    })
  })

  describe('unwrapMcpEnvelope', () => {
    it('returns the empty / non-string input untouched (no-op)', () => {
      expect(unwrapMcpEnvelope('')).toBe('')
      expect(unwrapMcpEnvelope(null)).toBe('')
      expect(unwrapMcpEnvelope(undefined)).toBe('')
    })

    it('passes through plain (non-JSON) strings', () => {
      expect(unwrapMcpEnvelope('Exit code: 0\nstdout: hello')).toBe('Exit code: 0\nstdout: hello')
      expect(unwrapMcpEnvelope('  not JSON either  ')).toBe('  not JSON either  ')
    })

    it('unwraps a single-text MCP envelope', () => {
      const envelope =
        '{"content":[{"type":"text","text":"Exit code: 0\\nstdout:\\ntotal 22552\\n"}]}'
      expect(unwrapMcpEnvelope(envelope)).toBe('Exit code: 0\nstdout:\ntotal 22552\n')
    })

    it('concatenates multiple text parts in order', () => {
      const envelope = JSON.stringify({
        content: [
          { type: 'text', text: 'first chunk\n' },
          { type: 'text', text: 'second chunk' }
        ]
      })
      expect(unwrapMcpEnvelope(envelope)).toBe('first chunk\nsecond chunk')
    })

    it('skips non-text parts (image / resource_link) but keeps text', () => {
      const envelope = JSON.stringify({
        content: [
          { type: 'text', text: 'hello\n' },
          { type: 'image', data: '<base64>', mimeType: 'image/png' },
          { type: 'text', text: 'world' }
        ]
      })
      expect(unwrapMcpEnvelope(envelope)).toBe('hello\nworld')
    })

    it('passes through valid JSON that is not an MCP envelope', () => {
      const json = '{"status":"ok","count":42}'
      expect(unwrapMcpEnvelope(json)).toBe(json)
    })

    it('passes through malformed JSON without throwing', () => {
      const broken = '{"content":[{"type":"text"'
      expect(unwrapMcpEnvelope(broken)).toBe(broken)
    })

    it('passes through arrays at top level (not envelope-shaped)', () => {
      const arr = '[{"type":"text","text":"loose"}]'
      expect(unwrapMcpEnvelope(arr)).toBe(arr)
    })
  })

  describe('extractMcpImageBlocks', () => {
    it('extracts image blocks from parsed MCP envelopes', () => {
      const blocks = extractMcpImageBlocks({
        content: [
          { type: 'text', text: 'metadata' },
          { type: 'image', mimeType: 'image/png', data: 'abc123' }
        ]
      })

      expect(blocks).toEqual([expect.objectContaining({ mimeType: 'image/png', data: 'abc123' })])
    })

    it('extracts image blocks from stringified MCP envelopes', () => {
      const blocks = extractMcpImageBlocks(
        JSON.stringify({
          content: [
            { type: 'image', mimeType: 'image/jpeg', data: 'jpeg-base64' },
            { type: 'resource_link', uri: 'file:///tmp/frame.jpg' }
          ]
        })
      )

      expect(blocks).toHaveLength(1)
      expect(blocks[0]).toMatchObject({ mimeType: 'image/jpeg', data: 'jpeg-base64' })
    })

    it('extracts image blocks from nested result envelopes', () => {
      const blocks = extractMcpImageBlocks({
        output: 'summary',
        result: {
          content: [{ type: 'image', mime_type: 'image/png', data: 'nested-png' }]
        }
      })

      expect(blocks).toEqual([
        expect.objectContaining({ mimeType: 'image/png', data: 'nested-png' })
      ])
    })

    it('ignores malformed and duplicate image blocks', () => {
      const blocks = extractMcpImageBlocks({
        content: [
          { type: 'image', mimeType: 'text/plain', data: 'nope' },
          { type: 'image', mimeType: 'image/png', data: '' },
          { type: 'image', mimeType: 'image/png', data: 'same' },
          { type: 'image', mimeType: 'image/png', data: 'same' }
        ]
      })

      expect(blocks).toHaveLength(1)
      expect(blocks[0]).toMatchObject({ mimeType: 'image/png', data: 'same' })
    })
  })

  describe('prettyPrintJson', () => {
    it('returns empty / non-string input untouched', () => {
      expect(prettyPrintJson('')).toBe('')
      expect(prettyPrintJson(null)).toBe('')
      expect(prettyPrintJson(undefined)).toBe('')
    })

    it('passes through plain non-JSON strings', () => {
      expect(prettyPrintJson('hello world')).toBe('hello world')
      expect(prettyPrintJson('Exit code: 0')).toBe('Exit code: 0')
    })

    it('pretty-prints one-liner JSON objects with 2-space indent', () => {
      const out = prettyPrintJson('{"a":1,"b":[2,3]}')
      expect(out).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}')
    })

    it('leaves already-pretty JSON untouched', () => {
      const pretty = '{\n  "a": 1\n}'
      expect(prettyPrintJson(pretty)).toBe(pretty)
    })

    it('passes through malformed JSON gracefully', () => {
      expect(prettyPrintJson('{"a":')).toBe('{"a":')
    })
  })

  describe('extractResultOutput — Phase L5 MCP envelope integration', () => {
    it('unwraps an MCP envelope passed as evt.result (object form)', () => {
      const out = extractResultOutput({
        result: { content: [{ type: 'text', text: 'unwrapped from result' }] }
      })
      expect(out).toBe('unwrapped from result')
    })

    it('unwraps an MCP envelope passed as evt.output (object form)', () => {
      const out = extractResultOutput({
        output: { content: [{ type: 'text', text: 'unwrapped from output' }] }
      })
      expect(out).toBe('unwrapped from output')
    })

    it('unwraps when the whole event IS the envelope', () => {
      const out = extractResultOutput({
        content: [{ type: 'text', text: 'whole event is the envelope' }]
      })
      expect(out).toBe('whole event is the envelope')
    })

    it('unwraps an MCP envelope passed as a stringified evt.output', () => {
      const out = extractResultOutput({
        output: '{"content":[{"type":"text","text":"stringified envelope"}]}'
      })
      expect(out).toBe('stringified envelope')
    })

    it('passes plain string output through unchanged (no false-positive unwrap)', () => {
      expect(extractResultOutput({ output: 'plain stdout' })).toBe('plain stdout')
    })
  })

  describe('isToolUseEvent / isToolResultEvent', () => {
    it('detects tool_use', () => {
      expect(isToolUseEvent({ type: 'tool_use' })).toBe(true)
      expect(isToolUseEvent({ type: 'tool_call' })).toBe(true)
      expect(isToolUseEvent({ type: 'other' })).toBe(false)
    })
    it('detects tool_result', () => {
      expect(isToolResultEvent({ type: 'tool_result' })).toBe(true)
      expect(isToolResultEvent({ type: 'tool_output' })).toBe(true)
      expect(isToolResultEvent({ type: 'other' })).toBe(false)
    })
  })
})
