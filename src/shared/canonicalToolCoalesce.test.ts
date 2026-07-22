import { describe, expect, it } from 'vitest'
import {
  catalogToolAgenticService,
  catalogToolAgenticServiceForRawName,
  catalogToolOperationCategory,
  compactToolIdentifier,
  isCatalogFileEditTool,
  resolveCanonicalToolName,
  resolveCatalogToolName,
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
})
