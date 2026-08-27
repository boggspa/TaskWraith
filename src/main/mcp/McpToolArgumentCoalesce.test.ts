import { describe, expect, it } from 'vitest'
import { createTaskWraithMcpToolDefinitions } from '../McpToolCatalog'
import {
  TOOL_ARGUMENT_ALIAS_GROUPS,
  canonicalArgumentKeysForTool,
  coalesceCapabilityInvokeArguments,
  coalesceToolArguments
} from './McpToolArgumentCoalesce'

/**
 * Representative tool + surrounding arguments for each alias group. Every group
 * in the shipped table MUST have a fixture, so a newly added group cannot dodge
 * behavioural coverage.
 */
const GROUP_FIXTURES: Record<
  string,
  { tool: string; base: Record<string, unknown>; value: unknown }
> = {
  command: { tool: 'run_shell_command', base: {}, value: 'npm run test' },
  cwd: { tool: 'run_shell_command', base: { command: 'npm run test' }, value: 'src/main' },
  path: { tool: 'list_directory', base: {}, value: 'src/main' },
  content: { tool: 'write_file', base: { path: 'notes.txt' }, value: 'hello world' },
  old_string: { tool: 'replace', base: { path: 'a.ts', new_string: 'after' }, value: 'before' },
  new_string: { tool: 'replace', base: { path: 'a.ts', old_string: 'before' }, value: 'after' },
  replace_all: {
    tool: 'replace',
    base: { path: 'a.ts', old_string: 'before', new_string: 'after' },
    value: true
  },
  patch: { tool: 'apply_patch', base: {}, value: 'diff --git a/a.ts b/a.ts' }
}

function groupFor(canonicalKey: string): { aliases: readonly string[] } {
  const group = TOOL_ARGUMENT_ALIAS_GROUPS.find((entry) => entry.canonicalKey === canonicalKey)
  if (!group) throw new Error(`No alias group declared for '${canonicalKey}'`)
  return group
}

describe('TOOL_ARGUMENT_ALIAS_GROUPS', () => {
  it('pins the provider-native spellings the panel evidence recorded', () => {
    expect(groupFor('command').aliases).toEqual([
      'cmd',
      'CommandLine',
      'commandLine',
      'command_line',
      'script',
      'shell_command',
      'exec'
    ])
    expect(groupFor('cwd').aliases).toEqual([
      'Cwd',
      'working_directory',
      'workingDirectory',
      'workdir'
    ])
    expect(groupFor('path').aliases).toEqual([
      'file_path',
      'filePath',
      'FilePath',
      'TargetFile',
      'target_file',
      'targetFile',
      'AbsolutePath',
      'absolute_path',
      'absolutePath',
      'Path',
      'filename',
      'fileName',
      'file',
      'target_directory',
      'list_dir',
      'directory'
    ])
    expect(groupFor('content').aliases).toEqual([
      'contents',
      'CodeContent',
      'codeContent',
      'code_content',
      'Content',
      'file_text',
      'fileText',
      'text'
    ])
    expect(groupFor('old_string').aliases).toEqual([
      'oldString',
      'old_str',
      'old_text',
      'oldText',
      'TargetContent',
      'target_content'
    ])
    expect(groupFor('new_string').aliases).toEqual([
      'newString',
      'new_str',
      'new_text',
      'newText',
      'ReplacementContent',
      'replacement_content'
    ])
    expect(groupFor('replace_all').aliases).toEqual(['replaceAll'])
    expect(groupFor('patch').aliases).toEqual(['Patch', 'diff', 'unifiedDiff', 'unified_diff'])
  })

  it('declares no alias twice and never aliases one canonical key to another', () => {
    const canonicalKeys = new Set(TOOL_ARGUMENT_ALIAS_GROUPS.map((group) => group.canonicalKey))
    expect(canonicalKeys.size).toBe(TOOL_ARGUMENT_ALIAS_GROUPS.length)
    const seen = new Set<string>()
    for (const group of TOOL_ARGUMENT_ALIAS_GROUPS) {
      for (const alias of group.aliases) {
        expect(seen.has(alias), `alias '${alias}' is declared twice`).toBe(false)
        expect(canonicalKeys.has(alias), `alias '${alias}' is also a canonical key`).toBe(false)
        seen.add(alias)
      }
    }
  })

  it('keeps a behavioural fixture for every declared group', () => {
    for (const group of TOOL_ARGUMENT_ALIAS_GROUPS) {
      expect(
        GROUP_FIXTURES[group.canonicalKey],
        `add a GROUP_FIXTURES entry for '${group.canonicalKey}'`
      ).toBeTruthy()
    }
  })
})

describe('coalesceToolArguments — alias mapping', () => {
  it('maps every declared alias onto its canonical key', () => {
    for (const group of TOOL_ARGUMENT_ALIAS_GROUPS) {
      const fixture = GROUP_FIXTURES[group.canonicalKey]
      for (const alias of group.aliases) {
        const result = coalesceToolArguments(fixture.tool, {
          ...fixture.base,
          [alias]: fixture.value
        })
        expect(result.ok, `${fixture.tool} rejected alias '${alias}'`).toBe(true)
        if (!result.ok) continue
        expect(result.arguments, `${fixture.tool}: '${alias}' -> '${group.canonicalKey}'`).toEqual({
          ...fixture.base,
          [group.canonicalKey]: fixture.value
        })
        expect(result.aliasesApplied).toEqual([
          {
            path: group.canonicalKey,
            alias,
            canonicalKey: group.canonicalKey,
            toolName: fixture.tool,
            duplicate: false
          }
        ])
      }
    }
  })

  it('coalesces a full Antigravity-shaped edit call in one pass', () => {
    const result = coalesceToolArguments('replace', {
      TargetFile: 'src/main/index.ts',
      TargetContent: 'before',
      ReplacementContent: 'after'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.arguments).toEqual({
      path: 'src/main/index.ts',
      old_string: 'before',
      new_string: 'after'
    })
    expect(result.aliasesApplied.map((entry) => entry.alias).sort()).toEqual([
      'ReplacementContent',
      'TargetContent',
      'TargetFile'
    ])
  })

  it('preserves unknown keys untouched', () => {
    const result = coalesceToolArguments('read_file', { filePath: 'a.ts', wibble: 7 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.arguments).toEqual({ path: 'a.ts', wibble: 7 })
  })

  it('resolves the schema through a namespaced provider spelling', () => {
    const result = coalesceToolArguments('mcp__TaskWraith__read_file', { AbsolutePath: 'a.ts' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.schemaResolved).toBe(true)
    expect(result.arguments).toEqual({ path: 'a.ts' })
  })
})

describe('coalesceToolArguments — tool awareness', () => {
  it('only aliases where the canonical schema declares the target key', () => {
    // move_path declares from/to and deliberately has no `path` property.
    const moved = coalesceToolArguments('move_path', { from: 'a.ts', to: 'b.ts', filePath: 'c.ts' })
    expect(moved.ok).toBe(true)
    if (!moved.ok) return
    expect(moved.arguments).toEqual({ from: 'a.ts', to: 'b.ts', filePath: 'c.ts' })
    expect(moved.aliasesApplied).toEqual([])

    // read_file has no `content` property, so a content alias is not its business.
    const read = coalesceToolArguments('read_file', { path: 'a.ts', file_text: 'nope' })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.arguments).toEqual({ path: 'a.ts', file_text: 'nope' })
  })

  it('coalesces directory-native aliases only for list_directory', () => {
    for (const alias of ['target_directory', 'list_dir', 'directory']) {
      const listed = coalesceToolArguments('list_directory', { [alias]: 'papercuts' })
      expect(listed.ok, alias).toBe(true)
      if (!listed.ok) continue
      expect(listed.arguments).toEqual({ path: 'papercuts' })
    }

    const found = coalesceToolArguments('find_files', {
      pattern: '*.ts',
      target_directory: 'papercuts'
    })
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.arguments).toEqual({ pattern: '*.ts', target_directory: 'papercuts' })

    const moved = coalesceToolArguments('move_path', {
      from: 'a.ts',
      to: 'b.ts',
      target_directory: 'papercuts'
    })
    expect(moved.ok).toBe(true)
    if (!moved.ok) return
    expect(moved.arguments).toEqual({
      from: 'a.ts',
      to: 'b.ts',
      target_directory: 'papercuts'
    })
  })

  it('leaves a zero-property tool and an unknown tool untouched', () => {
    const status = coalesceToolArguments('git_status', { filePath: 'a.ts' })
    expect(status.ok).toBe(true)
    if (!status.ok) return
    expect(status.arguments).toEqual({ filePath: 'a.ts' })

    const unknown = coalesceToolArguments('not_a_taskwraith_tool', { filePath: 'a.ts' })
    expect(unknown.ok).toBe(true)
    if (!unknown.ok) return
    expect(unknown.schemaResolved).toBe(false)
    expect(unknown.arguments).toEqual({ filePath: 'a.ts' })
  })

  it('skips an alias that the tool declares as its own property', () => {
    const result = coalesceToolArguments(
      'synthetic_tool',
      { content: 'canonical', text: 'a real property here' },
      {
        inputSchema: {
          type: 'object',
          properties: { content: { type: 'string' }, text: { type: 'string' } }
        }
      }
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.arguments).toEqual({ content: 'canonical', text: 'a real property here' })
    expect(result.aliasesApplied).toEqual([])
  })

  it('honours a caller-supplied schema over the catalogue', () => {
    const result = coalesceToolArguments(
      'read_file',
      { filePath: 'a.ts' },
      { inputSchema: { type: 'object', properties: { from: { type: 'string' } } } }
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.arguments).toEqual({ filePath: 'a.ts' })
  })

  it('exposes the canonical key set it reasons about', () => {
    expect(canonicalArgumentKeysForTool('read_file')).toEqual(new Set(['path', 'offset', 'limit']))
    expect(canonicalArgumentKeysForTool('not_a_taskwraith_tool')).toBeNull()
  })

  it('never lets an alias collide with a real property anywhere in the catalogue', () => {
    const collisions: string[] = []
    for (const definition of createTaskWraithMcpToolDefinitions()) {
      const properties = (definition.inputSchema as { properties?: Record<string, unknown> })
        ?.properties
      if (!properties) continue
      const declared = new Set(Object.keys(properties))
      for (const group of TOOL_ARGUMENT_ALIAS_GROUPS) {
        if (!declared.has(group.canonicalKey)) continue
        for (const alias of group.aliases) {
          if (declared.has(alias))
            collisions.push(`${definition.name}: ${alias}/${group.canonicalKey}`)
        }
      }
    }
    expect(collisions).toEqual([])
  })
})

describe('coalesceToolArguments — duplicates and conflicts', () => {
  it('tolerates a canonical key repeated as an equal alias', () => {
    const result = coalesceToolArguments('read_file', { path: 'a.ts', filePath: 'a.ts' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.arguments).toEqual({ path: 'a.ts' })
    expect(result.aliasesApplied).toEqual([
      {
        path: 'path',
        alias: 'filePath',
        canonicalKey: 'path',
        toolName: 'read_file',
        duplicate: true
      }
    ])
  })

  it('tolerates two equal aliases when the canonical key is absent', () => {
    const result = coalesceToolArguments('read_file', { filePath: 'a.ts', target_file: 'a.ts' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.arguments).toEqual({ path: 'a.ts' })
  })

  it('rejects a canonical/alias disagreement instead of silently choosing', () => {
    const result = coalesceToolArguments('read_file', { path: 'a.ts', filePath: 'b.ts' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('ambiguous_argument_alias')
    expect(result).not.toHaveProperty('arguments')
    expect(result.conflicts).toEqual([
      {
        path: 'path',
        canonicalKey: 'path',
        suppliedKeys: ['path', 'filePath'],
        toolName: 'read_file'
      }
    ])
    expect(result.message).toContain('read_file')
    expect(result.message).toContain('path')
    expect(result.message).toContain('filePath')
  })

  it('rejects two disagreeing aliases and reports every conflict at once', () => {
    const result = coalesceToolArguments('run_shell_command', {
      command: 'ls',
      cmd: 'pwd',
      Cwd: 'src',
      workdir: 'relay'
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.conflicts.map((entry) => entry.canonicalKey)).toEqual(['command', 'cwd'])
    expect(result.conflicts[1].suppliedKeys).toEqual(['Cwd', 'workdir'])
  })
})

describe('coalesceToolArguments — empty values and audit', () => {
  it('carries an empty-string alias value through instead of dropping it', () => {
    const result = coalesceToolArguments('replace', {
      path: 'a.ts',
      old_string: 'before',
      new_str: ''
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.prototype.hasOwnProperty.call(result.arguments, 'new_string')).toBe(true)
    expect(result.arguments).toEqual({ path: 'a.ts', old_string: 'before', new_string: '' })
  })

  it('treats equal empty strings as a duplicate and unequal ones as a conflict', () => {
    const duplicate = coalesceToolArguments('replace', { old_string: '', old_str: '' })
    expect(duplicate.ok).toBe(true)
    if (duplicate.ok) expect(duplicate.arguments).toEqual({ old_string: '' })

    const conflict = coalesceToolArguments('read_file', { path: '', filePath: 'a.ts' })
    expect(conflict.ok).toBe(false)
  })

  it('never mutates the caller object and returns the original for audit', () => {
    const original = Object.freeze({ filePath: 'a.ts', wibble: 7 })
    const result = coalesceToolArguments('read_file', original)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(original).toEqual({ filePath: 'a.ts', wibble: 7 })
    expect(result.originalArguments).toBe(original)
    expect(result.arguments).not.toBe(original)
  })

  it('returns the original arguments alongside a rejection', () => {
    const original = { path: 'a.ts', filePath: 'b.ts' }
    const result = coalesceToolArguments('read_file', original)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.originalArguments).toBe(original)
  })

  it('passes non-object arguments through untouched', () => {
    for (const value of [undefined, null, 'ls', 42, ['a']]) {
      const result = coalesceToolArguments('read_file', value)
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      expect(result.arguments).toBe(value)
      expect(result.aliasesApplied).toEqual([])
    }
  })
})

describe('coalesceCapabilityInvokeArguments — nested gateway targets', () => {
  it('normalizes the inner target arguments against the target schema', () => {
    const result = coalesceCapabilityInvokeArguments({
      name: 'run_shell_command',
      arguments: { CommandLine: 'npm run test', Cwd: 'src' }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.arguments).toEqual({
      name: 'run_shell_command',
      arguments: { command: 'npm run test', cwd: 'src' }
    })
    expect(result.aliasesApplied).toEqual([
      {
        path: 'arguments/command',
        alias: 'CommandLine',
        canonicalKey: 'command',
        toolName: 'run_shell_command',
        duplicate: false
      },
      {
        path: 'arguments/cwd',
        alias: 'Cwd',
        canonicalKey: 'cwd',
        toolName: 'run_shell_command',
        duplicate: false
      }
    ])
  })

  it('reaches the same result through the single direct entry point', () => {
    const result = coalesceToolArguments('capability_invoke', {
      name: 'write_file',
      arguments: { TargetFile: 'a.txt', CodeContent: 'hi' }
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.arguments).toEqual({
      name: 'write_file',
      arguments: { path: 'a.txt', content: 'hi' }
    })
  })

  it('propagates a nested conflict with its nested path and never invokes', () => {
    const result = coalesceCapabilityInvokeArguments({
      name: 'run_shell_command',
      arguments: { command: 'ls', cmd: 'pwd' }
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result).not.toHaveProperty('arguments')
    expect(result.conflicts).toEqual([
      {
        path: 'arguments/command',
        canonicalKey: 'command',
        suppliedKeys: ['command', 'cmd'],
        toolName: 'run_shell_command'
      }
    ])
  })

  it('leaves an unknown or malformed gateway payload untouched', () => {
    const unknownTarget = coalesceCapabilityInvokeArguments({
      name: 'not_a_taskwraith_tool',
      arguments: { filePath: 'a.ts' }
    })
    expect(unknownTarget.ok).toBe(true)
    if (unknownTarget.ok) {
      expect(unknownTarget.arguments).toEqual({
        name: 'not_a_taskwraith_tool',
        arguments: { filePath: 'a.ts' }
      })
    }

    const malformed = coalesceCapabilityInvokeArguments({ name: 'read_file', arguments: 'a.ts' })
    expect(malformed.ok).toBe(true)
    if (malformed.ok) {
      expect(malformed.arguments).toEqual({ name: 'read_file', arguments: 'a.ts' })
    }
  })

  it('does not widen the gateway wrapper itself', () => {
    // `tool`/`args` are NOT accepted spellings: the wrapper contract stays exact.
    const result = coalesceCapabilityInvokeArguments({ tool: 'read_file', args: { path: 'a.ts' } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.arguments).toEqual({ tool: 'read_file', args: { path: 'a.ts' } })
    expect(result.aliasesApplied).toEqual([])
  })
})
