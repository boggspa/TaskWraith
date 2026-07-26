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
    expect(hint).toContain('native Cursor tools')
    expect(hint).not.toContain('unavailable')
  })
})
