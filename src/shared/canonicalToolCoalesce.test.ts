import { describe, expect, it } from 'vitest'
import {
  catalogToolAgenticService,
  catalogToolAgenticServiceForDisplay,
  catalogToolAgenticServiceForRawName,
  catalogToolOperationCategory,
  compactToolIdentifier,
  isCatalogFileEditTool,
  resolveCanonicalToolName,
  resolveCatalogToolName,
  resolveProviderNativeToolForDisplay,
  resolveStrictProviderNativeToolAction,
  resolveStrictProviderToolAction,
  stripToolNamespace
} from './canonicalToolCoalesce'

describe('canonicalToolCoalesce', () => {
  it('strips broker namespaces before alias lookup', () => {
    expect(stripToolNamespace('mcp__TaskWraith__read_file')).toBe('read_file')
    expect(stripToolNamespace('taskwraith-broker__write_file')).toBe('write_file')
  })

  it('maps Cursor-native PascalCase tools to catalog names', () => {
    expect(resolveCatalogToolName('Shell')).toBe('run_shell_command')
    expect(resolveCatalogToolName('Write')).toBe('write_file')
    expect(resolveCatalogToolName('StrReplace')).toBe('replace')
    expect(resolveCatalogToolName('Glob')).toBe('find_files')
    expect(resolveCatalogToolName('Grep')).toBe('workspace_search')
    expect(resolveCatalogToolName('ReadLints')).toBe('get_diagnostics')
    expect(resolveCatalogToolName('todoWrite')).toBe('todo_write')
    expect(resolveCatalogToolName('WebSearch')).toBe('web_search')
  })

  it('maps legacy Codex / Claude native names to catalog names', () => {
    expect(resolveCatalogToolName('edit_file')).toBe('replace')
    expect(resolveCatalogToolName('create_file')).toBe('write_file')
    expect(resolveCatalogToolName('delete_file')).toBe('delete_path')
    expect(resolveCatalogToolName('run_terminal_command')).toBe('run_shell_command')
  })

  it('preserves explicit TaskWraith catalog names', () => {
    expect(resolveCanonicalToolName('mcp__taskwraith__apply_patch')).toBe('apply_patch')
    expect(resolveCatalogToolName('workspace_search')).toBe('workspace_search')
  })

  it('classifies agentic services through the shared map', () => {
    expect(catalogToolAgenticService('write_file')).toBe('fileChanges')
    expect(catalogToolAgenticService('run_shell_command')).toBe('shellCommands')
    expect(catalogToolAgenticService('ensemble_yield')).toBe('mcpTools')
    expect(catalogToolAgenticServiceForRawName('Shell')).toBe('shellCommands')
    expect(catalogToolAgenticServiceForRawName('Read')).toBe('mcpTools')
  })

  it('derives operation categories for native aliases', () => {
    expect(catalogToolOperationCategory('Read')).toBe('read_file')
    expect(catalogToolOperationCategory('StrReplace')).toBe('edit_file')
    expect(catalogToolOperationCategory('Glob')).toBe('search')
    expect(catalogToolOperationCategory('Shell')).toBe('shell')
  })

  it('detects file-edit tools for run summaries', () => {
    expect(isCatalogFileEditTool('Write')).toBe(true)
    expect(isCatalogFileEditTool('apply_patch')).toBe(true)
    expect(isCatalogFileEditTool('read_file')).toBe(false)
  })

  it('compactToolIdentifier normalizes separators', () => {
    expect(compactToolIdentifier('run_terminal_command')).toBe('runterminalcommand')
    expect(compactToolIdentifier('WebSearch')).toBe('websearch')
  })

  it('keeps permissive display normalization separate from strict provider resolution', () => {
    expect(resolveCanonicalToolName('FutureProviderThing')).toBe('futureproviderthing')
    expect(resolveProviderNativeToolForDisplay('pi', 'edit')).toBe('replace')
    expect(resolveStrictProviderNativeToolAction('pi', 'edit')).toMatchObject({
      ok: false,
      denied: true,
      code: 'native_action_not_declared'
    })
    expect(resolveStrictProviderNativeToolAction('codex', 'fileChange')).toMatchObject({
      ok: true,
      catalogTool: 'apply_patch',
      action: 'workspace.mutate'
    })
    expect(resolveStrictProviderNativeToolAction('claude', 'MultiEdit')).toMatchObject({
      ok: false,
      code: 'native_surface_closed'
    })
  })

  it('strictly denies an undeclared provider action instead of assigning generic policy', () => {
    expect(resolveStrictProviderToolAction('claude', 'TeleportRepository')).toMatchObject({
      ok: false,
      denied: true,
      code: 'native_surface_closed',
      provider: 'claude'
    })
  })
})

// WS-C: catalogToolAgenticService is now the ONE source of truth for the runtime
// approval gate (NativeApprovalPolicy.taskWraithToolAgenticService) and the
// Settings policy chip (SettingsPanel.inferMcpPolicyKey). These assertions pin
// parity with the buckets those consumers' own suites assert so the three
// collapsed ladders can never silently drift apart again.
describe('catalogToolAgenticService — security-gate parity', () => {
  it('routes shell-class tools to shellCommands', () => {
    for (const tool of [
      'run_shell_command',
      'run_task',
      'start_background_process',
      'kill_background_process',
      'get_diagnostics',
      'launch_start',
      'launch_stop'
    ]) {
      expect(catalogToolAgenticService(tool)).toBe('shellCommands')
    }
    // launch reads stay on the softer bucket
    expect(catalogToolAgenticService('launch_list_targets')).toBe('mcpTools')
    expect(catalogToolAgenticService('launch_status')).toBe('mcpTools')
  })

  it('routes external publication to the non-grantable externalPublish bucket', () => {
    expect(catalogToolAgenticService('git_push')).toBe('externalPublish')
    expect(catalogToolAgenticService('git_create_pr')).toBe('externalPublish')
  })

  it('routes file mutations + staged git to fileChanges', () => {
    for (const tool of [
      'write_file',
      'replace',
      'create_directory',
      'delete_path',
      'move_path',
      'rename_path',
      'apply_patch',
      'git_stage',
      'git_commit'
    ]) {
      expect(catalogToolAgenticService(tool)).toBe('fileChanges')
    }
  })

  it('routes audio/video media tools to the dedicated mediaEditing bucket', () => {
    expect(catalogToolAgenticService('transcode_audio')).toBe('mediaEditing')
    expect(catalogToolAgenticService('audio_mix')).toBe('mediaEditing')
    expect(catalogToolAgenticService('video_decode_frame')).toBe('mediaEditing')
  })

  it('keeps web Canvas, Sketch mutation, eval, and recall in dedicated buckets', () => {
    expect(catalogToolAgenticService('canvas_click')).toBe('canvasInteraction')
    expect(catalogToolAgenticService('canvas_fill')).toBe('canvasInteraction')
    expect(catalogToolAgenticService('canvas_sketch_update')).toBe('sketchCanvas')
    expect(catalogToolAgenticService('canvas_sketch_update')).not.toBe('canvasInteraction')
    // reads stay on mcpTools
    expect(catalogToolAgenticService('canvas_sketch_open')).toBe('mcpTools')
    expect(catalogToolAgenticService('canvas_sketch_get')).toBe('mcpTools')
    expect(catalogToolAgenticService('canvas_snapshot')).toBe('mcpTools')
    expect(catalogToolAgenticService('canvas_open_launch')).toBe('mcpTools')
    // eval is its own stricter bucket, never canvasInteraction
    expect(catalogToolAgenticService('canvas_eval')).toBe('canvasEval')
    expect(catalogToolAgenticService('canvas_eval')).not.toBe('canvasInteraction')
    // sub-thread + cross-thread recall
    expect(catalogToolAgenticService('delegate_to_subthread')).toBe('subThreadDelegation')
    expect(catalogToolAgenticService('cancel_subthread')).toBe('subThreadDelegation')
    expect(catalogToolAgenticService('simulator_status')).toBe('mcpTools')
    expect(catalogToolAgenticService('simulator_open')).toBe('simulatorCanvas')
    expect(catalogToolAgenticService('simulator_boot')).toBe('simulatorCanvas')
    expect(catalogToolAgenticService('simulator_install')).toBe('simulatorCanvas')
    expect(catalogToolAgenticService('simulator_launch')).toBe('simulatorCanvas')
    expect(catalogToolAgenticService('simulator_screenshot')).toBe('simulatorCanvas')
    expect(catalogToolAgenticService('simulator_terminate')).toBe('simulatorCanvas')
    for (const tool of ['tw_recall_find', 'tw_recall_read', 'tw_recall_read_events']) {
      expect(catalogToolAgenticService(tool)).toBe('crossThreadRead')
    }
  })

  it('does NOT reclassify creative_* import/dispatch tools as fileChanges', () => {
    // The only catalog tools containing "import"/"dispatch" are creative_*; the
    // canonical ladder is exact-name based, so they correctly stay on mcpTools
    // (audited via their own creative-app approvals) — never fileChanges.
    expect(catalogToolAgenticService('creative_timeline_import')).toBe('mcpTools')
    expect(catalogToolAgenticService('creative_applescript_dispatch')).toBe('mcpTools')
    expect(catalogToolAgenticService('creative_midi_dispatch')).toBe('mcpTools')
  })

  it('keeps unknown fallback display-only while typed orchestration stays explicit', () => {
    expect(catalogToolAgenticService('ensemble_yield')).toBe('mcpTools')
    expect(catalogToolAgenticService('list_active_runs')).toBe('mcpTools')
    expect(catalogToolAgenticServiceForDisplay('some_other_tool')).toBe('mcpTools')
    expect(catalogToolAgenticServiceForRawName('some_other_tool')).toBeNull()
  })
})
