import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ReadOnlyToolClassBreakdown } from './ToolClassBreakdown'

describe('ReadOnlyToolClassBreakdown', () => {
  it('shows all classes, with unavailable classes blocked', () => {
    const html = renderToStaticMarkup(<ReadOnlyToolClassBreakdown />)
    expect(html).toContain('Workspace reads')
    expect(html).toContain('Web reads')
    expect(html).toContain('Orchestration')
    expect(html).toContain('User prompts')
    expect(html).toContain('Workspace writes')
    // Allowed classes show ✓, the write class shows ✗ (blocked).
    expect(html).toContain('✓')
    expect(html).toContain('✗')
    // Read-only permits the current workspace read/search attachment tools.
    expect(html).toContain('Workspace reads (7)')
  })
})
