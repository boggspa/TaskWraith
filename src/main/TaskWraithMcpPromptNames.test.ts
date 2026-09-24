import { describe, expect, it } from 'vitest'
import {
  taskWraithToolNameForProvider,
  taskWraithToolNamespaceHint
} from './TaskWraithMcpPromptNames'

describe('TaskWraithMcpPromptNames', () => {
  it('uses Vibe current single-underscore names and requires the actually listed surface', () => {
    expect(taskWraithToolNameForProvider('mistral', 'replace')).toBe('TaskWraith_replace')
    expect(taskWraithToolNameForProvider('mistral', 'run_shell_command')).toBe(
      'TaskWraith_run_shell_command'
    )
    expect(taskWraithToolNamespaceHint('mistral')).toContain('exact listed name')
    expect(taskWraithToolNamespaceHint('mistral')).toContain('managed by TaskWraith')
  })
  it('describes the managed Cursor gateway and its tool namespace', () => {
    expect(taskWraithToolNameForProvider('cursor', 'apply_patch')).toBe('taskwraith__apply_patch')

    const hint = taskWraithToolNamespaceHint('cursor')
    expect(hint).toContain('Managed Cursor runs')
    expect(hint).toContain('TaskWraith gateway')
    expect(hint).toContain('`taskwraith__<tool>`')
    expect(hint).toMatch(/native Cursor tools/i)
    expect(hint).toContain('GetMcpTools')
    expect(hint).toContain('taskwraith-broker')
    expect(hint).toContain('GetDynamicTools')
    expect(hint).not.toContain('unavailable')
  })
})

describe('Kimi tool prompt names', () => {
  it('uses the current Kimi namespace and preserves other provider spellings', () => {
    expect(taskWraithToolNameForProvider('kimi', 'replace')).toBe('mcp__taskwraith__replace')
    expect(taskWraithToolNameForProvider('claude', 'replace')).toBe('mcp__TaskWraith__replace')
    expect(taskWraithToolNameForProvider('codex', 'replace')).toBe('TaskWraith__replace')
    expect(taskWraithToolNameForProvider('cursor', 'replace')).toBe('taskwraith__replace')
    expect(taskWraithToolNamespaceHint('kimi')).toContain('exact listed name')
    expect(taskWraithToolNamespaceHint('kimi')).toContain('availability blocker')
  })
})
