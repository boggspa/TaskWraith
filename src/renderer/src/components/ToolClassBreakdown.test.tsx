import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  groupToolsByClass,
  READ_ONLY_TOOL_PRESET,
  TOOL_CLASS_LABELS,
  TOOL_CLASS_ORDER
} from '../../../main/ToolClassTaxonomy'
import { ReadOnlyToolClassBreakdown } from './ToolClassBreakdown'

describe('ReadOnlyToolClassBreakdown', () => {
  it('shows all classes, with unavailable classes blocked', () => {
    const html = renderToStaticMarkup(<ReadOnlyToolClassBreakdown />)
    const breakdown = groupToolsByClass([...READ_ONLY_TOOL_PRESET])

    // Every class row renders, with counts sourced from the taxonomy registry
    // (not hardcoded) so curated-tool additions don't stale this test.
    for (const cls of TOOL_CLASS_ORDER) {
      const tools = breakdown[cls]
      if (cls === 'workspace_write' || tools.length === 0) {
        expect(html).toContain(`✗ ${TOOL_CLASS_LABELS[cls]}`)
      } else {
        expect(html).toContain(`✓ ${TOOL_CLASS_LABELS[cls]} (${tools.length})`)
        // Hover title carries the full tool list for the class.
        expect(html).toContain(tools.join(', '))
      }
    }
    // The write class is blocked and never renders a count.
    expect(html).not.toMatch(/Workspace writes \(\d+\)/)
    // Membership sanity: read-only keeps the core workspace read/search tools
    // in the reads class (guards against a taxonomy regression reclassifying
    // them, which the derived counts alone would not catch).
    expect(breakdown.workspace_read).toEqual(
      expect.arrayContaining(['read_file', 'list_directory', 'grep', 'glob', 'workspace_search'])
    )
  })
})
