import { describe, expect, it } from 'vitest'
import {
  taskWraithToolNameForProvider,
  taskWraithToolNamespaceHint
} from './TaskWraithMcpPromptNames'

describe('TaskWraithMcpPromptNames', () => {
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
