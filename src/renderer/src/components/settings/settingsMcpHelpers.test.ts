import { describe, expect, it } from 'vitest'
import {
  MCP_TOOL_CATALOG,
  MCP_TOOL_GROUP_LABELS,
  MCP_TOOL_GROUP_ORDER,
  countMcpStatusServers,
  countMcpStatusTools,
  formatMcpInvocation,
  getMcpPolicyLabel,
  getMcpToolMeta,
  pluralizeCount,
  resolveMcpToolIconFamily,
  uncategorizedMcpToolsForSettings
} from './settingsMcpHelpers'
import {
  TASKWRAITH_MCP_TOOLS,
  type TaskWraithMcpToolName
} from '../../../../shared/taskWraithMcpCatalog'
import { catalogToolAgenticService } from '../../../../shared/canonicalToolCoalesce'
import { DEFAULT_AGENTIC_SERVICES } from '../../lib/agenticServicesDefaults'
import type { AgenticServicesSettings } from '../../../../main/store/types'

function services(patch: Record<string, string>): AgenticServicesSettings {
  return { ...DEFAULT_AGENTIC_SERVICES, ...patch } as unknown as AgenticServicesSettings
}

describe('settingsMcpHelpers', () => {
  it('keeps the group order and label registries aligned', () => {
    expect(MCP_TOOL_GROUP_ORDER).toHaveLength(12)
    expect(new Set(MCP_TOOL_GROUP_ORDER).size).toBe(MCP_TOOL_GROUP_ORDER.length)
    expect(Object.keys(MCP_TOOL_GROUP_LABELS).sort()).toEqual([...MCP_TOOL_GROUP_ORDER].sort())
  })

  it('groups every catalog tool so Settings shows no uncategorized leftovers', () => {
    expect(TASKWRAITH_MCP_TOOLS.length).toBeGreaterThan(0)
    expect(uncategorizedMcpToolsForSettings()).toEqual([])
  })

  it('serves curated override metadata for run_shell_command', () => {
    const meta = getMcpToolMeta('run_shell_command')
    expect(meta.label).toBe('Run shell command')
    expect(meta.transcript).toBe('Ran shell command')
    expect(meta.group).toBe('runtime')
    expect(meta.iconRef).toBe('tool:terminal')
    expect(meta.policyKey).toBe('shellCommands')
  })

  it('infers metadata for tools without overrides', () => {
    const meta = getMcpToolMeta('git_status')
    expect(meta.label).toBe('Git Status')
    expect(meta.group).toBe('git')
    expect(meta.iconRef).toBe('tool:git')
    expect(meta.policyKey).toBe(catalogToolAgenticService('git_status'))
    expect(meta.description).toContain(MCP_TOOL_GROUP_LABELS.git)
  })

  it('rewrites the appwatch_ prefix in inferred transcript labels', () => {
    expect(getMcpToolMeta('appwatch_status').transcript).toBe('Appwatch status')
    expect(getMcpToolMeta('appwatch_status').label).toBe('Appwatch Status')
  })

  it('pluralizes counts with default and custom plural forms', () => {
    expect(pluralizeCount(1, 'tool')).toBe('1 tool')
    expect(pluralizeCount(2, 'tool')).toBe('2 tools')
    expect(pluralizeCount(0, 'entry', 'entries')).toBe('0 entries')
  })

  it('formats provider-specific MCP invocation names', () => {
    expect(formatMcpInvocation('claude', 'read_file')).toBe('mcp__TaskWraith__read_file')
    expect(formatMcpInvocation('codex', 'read_file')).toBe('TaskWraith__read_file')
  })

  it('labels policy values from the table that matches the policy key', () => {
    // 'allow' exists in both tables with different labels, so these two
    // assertions prove the networkAccess branch selects the network table.
    expect(getMcpPolicyLabel(services({ networkAccess: 'allow' }), 'networkAccess')).toBe('Allow')
    expect(getMcpPolicyLabel(services({ shellCommands: 'allow' }), 'shellCommands')).toBe(
      'Always allow'
    )
    expect(getMcpPolicyLabel(services({ shellCommands: 'deny' }), 'shellCommands')).toBe('Block')
    // Unknown stored values fall back to the raw string.
    expect(getMcpPolicyLabel(services({ shellCommands: 'mystery' }), 'shellCommands')).toBe(
      'mystery'
    )
  })

  it('counts MCP status tools across array, object, and per-server data shapes', () => {
    expect(countMcpStatusTools(null)).toBe(0)
    expect(countMcpStatusTools({ tools: ['a', 'b', 'c'] })).toBe(3)
    expect(countMcpStatusTools({ tools: { a: 1, b: 2 } })).toBe(2)
    expect(countMcpStatusTools({ data: [{ tools: ['x'] }, { tools: { y: 1, z: 1 } }, {}] })).toBe(3)
  })

  it('counts MCP status servers only from array-shaped data', () => {
    expect(countMcpStatusServers(null)).toBe(0)
    expect(countMcpStatusServers({})).toBe(0)
    expect(countMcpStatusServers({ data: [{}, {}] })).toBe(2)
  })

  it('resolves icon families through name, iconRef, then mcp fallback tiers', () => {
    const phantom = 'definitely_not_a_tool' as unknown as TaskWraithMcpToolName
    expect(resolveMcpToolIconFamily({ name: phantom, iconRef: 'tool:terminal' })).toBe('shell')
    expect(resolveMcpToolIconFamily({ name: phantom, iconRef: 'tool:unmapped' })).toBe('mcp')
  })

  it('builds one catalog entry per tool in canonical group-then-label order', () => {
    expect(MCP_TOOL_CATALOG).toHaveLength(TASKWRAITH_MCP_TOOLS.length)
    for (let i = 1; i < MCP_TOOL_CATALOG.length; i += 1) {
      const prev = MCP_TOOL_CATALOG[i - 1]
      const next = MCP_TOOL_CATALOG[i]
      const prevGroup = MCP_TOOL_GROUP_ORDER.indexOf(prev.group)
      const nextGroup = MCP_TOOL_GROUP_ORDER.indexOf(next.group)
      expect(prevGroup).toBeLessThanOrEqual(nextGroup)
      if (prevGroup === nextGroup) {
        expect(prev.label.localeCompare(next.label)).toBeLessThanOrEqual(0)
      }
    }
  })
})
