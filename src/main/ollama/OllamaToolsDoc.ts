import {
  createTaskWraithMcpToolDefinitions,
  type TaskWraithMcpToolDefinition
} from '../McpToolCatalog'
import {
  filterTaskWraithMcpToolDefinitionsForProfile,
  GATEWAY_V9_MCP_DIRECT_TOOLS,
  taskWraithMcpAdvertisedToolNamesForProfile
} from '../mcp/McpToolProfiles'
import type { TaskWraithMcpProfileId } from '../store/types'

const OLLAMA_DIRECT_TOOL_NAMES: ReadonlySet<string> = new Set(GATEWAY_V9_MCP_DIRECT_TOOLS)

/**
 * Reproducible generator for `resources/Tools.md` — a full, drift-checked
 * reference for the TaskWraith tool surface that ships with the app for local
 * Ollama models (and humans) to reference.
 *
 * Source of truth is the ONE catalog `createTaskWraithMcpToolDefinitions()`,
 * which throws on any duplicate / unknown / missing tool vs `TASKWRAITH_MCP_TOOLS`
 * — so the generated doc, the model's granted surface, and the catalog cannot
 * drift apart. The output is deterministic (catalog order, insertion-ordered
 * schema keys) so `OllamaToolsDoc.test.ts` can assert byte-identical
 * regeneration and fail CI on any drift.
 *
 * The model cannot `read_file` this doc at runtime (read_file is workspace-scoped;
 * this ships under resources/, outside any workspace) — so the ON-DEMAND runtime
 * lookup is the `tool_help` tool (buildOllamaToolDocSection below), NOT a
 * whitelisted file path. tool_help serves any single tool's section by name, or —
 * on an empty name — the full tool list, from this same catalog. That is the
 * complete answer to "tool docs fetched on demand" for local models: the shipped
 * Tools.md is the human/drift-check reference, and tool_help is the model's live
 * accessor over the identical content. There is no separate lookup to build.
 */

function schemaType(schema: unknown): string | undefined {
  if (!schema || typeof schema !== 'object') return undefined
  const type = (schema as Record<string, unknown>).type
  return Array.isArray(type)
    ? typeof type[0] === 'string'
      ? type[0]
      : undefined
    : typeof type === 'string'
      ? type
      : undefined
}

function schemaPlaceholder(schema: unknown): unknown {
  switch (schemaType(schema)) {
    case 'string':
      return 'text'
    case 'number':
    case 'integer':
      return 0
    case 'boolean':
      return false
    case 'array':
      return []
    case 'object':
      return {}
    default:
      return 'value'
  }
}

interface ToolArgSummary {
  example: string
  required: string[]
  optional: string[]
}

function summarizeToolArgs(def: TaskWraithMcpToolDefinition): ToolArgSummary {
  const schema = (
    def.inputSchema && typeof def.inputSchema === 'object' ? def.inputSchema : {}
  ) as Record<string, unknown>
  const props =
    schema.properties && typeof schema.properties === 'object'
      ? (schema.properties as Record<string, unknown>)
      : {}
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === 'string')
    : []
  const allKeys = Object.keys(props)
  const optional = allKeys.filter((key) => !required.includes(key))
  // Prefer a canonical catalog example when one exists. Enum discriminators in
  // particular cannot be represented by a generic "text" placeholder.
  const catalogExample = Array.isArray(schema.examples)
    ? schema.examples.find((entry): entry is Record<string, unknown> =>
        Boolean(entry && typeof entry === 'object' && !Array.isArray(entry))
      )
    : undefined
  const args: Record<string, unknown> = catalogExample ? { ...catalogExample } : {}
  if (!catalogExample) {
    // Otherwise carry the required args (or the first arg when nothing is
    // required) with type-appropriate placeholders, so a small model has a
    // concrete shape to copy.
    const exampleKeys = required.length ? required : allKeys.slice(0, 1)
    for (const key of exampleKeys) args[key] = schemaPlaceholder(props[key])
  }
  const example = JSON.stringify({
    taskwraith_tool: OLLAMA_DIRECT_TOOL_NAMES.has(def.name)
      ? { name: def.name, arguments: args }
      : { name: 'capability_invoke', arguments: { name: def.name, arguments: args } }
  })
  return { example, required, optional }
}

function accessLabel(def: TaskWraithMcpToolDefinition): string {
  const annotations = (
    def.annotations && typeof def.annotations === 'object' ? def.annotations : {}
  ) as Record<string, unknown>
  // `canvas_eval` is deliberately stricter than the generic mutating-tool
  // label: policy clamps it to one exact desktop-reviewed prompt per call, so
  // no grant or Full Access can make it automatic.
  if (def.name === 'canvas_eval') {
    return 'signed-elevated — denied under Plan; approval-gated under Ask and prompts every permitted call with exact desktop review'
  }
  if (def.name === 'request_tool_permission') {
    return 'permission elicitation — callable under Ask/Plan; the exact target runs only after one-shot user approval and all non-grantable guards still apply'
  }
  if (def.name.startsWith('mesh_scene_') || def.name.startsWith('mesh_topology_')) {
    return 'Mesh Canvas — per-call approval under Ask and Plan; automatic under Accept Edits, Full WS Access, and Full Access unless Mesh Canvas is globally denied'
  }
  if (annotations.readOnlyHint === true) return 'read-only (no approval needed)'
  if (annotations.destructiveHint === true) {
    return 'mutating — governed by your run permission role (denied under Plan, prompts under Ask; prompts under Accept Edits unless granted)'
  }
  return 'governed by your run permission role'
}

// One tool's markdown section (the `## name` heading through its blank line).
// Shared by the full-doc generator and the per-tool `tool_help` runtime lookup so
// both render identically.
function renderToolSectionLines(def: TaskWraithMcpToolDefinition): string[] {
  const { example, required, optional } = summarizeToolArgs(def)
  const lines: string[] = [`## ${def.name}`, '']
  if (def.description) {
    lines.push(def.description, '')
  }
  lines.push(`- Access: ${accessLabel(def)}`)
  lines.push(`- Required args: ${required.length ? required.join(', ') : 'none'}`)
  if (optional.length) {
    lines.push(`- Optional args: ${optional.join(', ')}`)
  }
  lines.push(`- Example: \`${example}\``, '')
  return lines
}

export function buildOllamaToolsMarkdown(): string {
  const defs = createTaskWraithMcpToolDefinitions()
  const lines: string[] = [
    '<!-- GENERATED FILE — do not edit by hand.',
    '     Source of truth: src/main/McpToolCatalog.ts (createTaskWraithMcpToolDefinitions).',
    '     Regenerate: npm run generate:ollama-tools-md',
    '     A drift test (OllamaToolsDoc.test.ts) fails CI if this file is stale. -->',
    '',
    '# TaskWraith tools reference',
    '',
    'Local Ollama models call a directly advertised tool by emitting exactly one JSON object per turn:',
    '',
    '```',
    '{"taskwraith_tool":{"name":"<tool>","arguments":{ ... }}}',
    '```',
    '',
    `The ${defs.length} tools below are the full TaskWraith surface. ${GATEWAY_V9_MCP_DIRECT_TOOLS.length} common tools are callable directly; every other example uses capability_invoke so the top-level tool surface stays compact. Every mutating target (file edits, shell, publishing) is gated by your run's permission role, and paths must stay inside the active workspace.`,
    ''
  ]
  for (const def of defs) {
    lines.push(...renderToolSectionLines(def))
  }
  // Single trailing newline for a clean POSIX file.
  return `${lines.join('\n').replace(/\s+$/, '')}\n`
}

/**
 * Runtime `tool_help` lookup: the markdown section for ONE tool (description,
 * access class, required/optional args, call example). Called with an EMPTY name
 * it lists every tool name (the discovery path for the curated-taxonomy tail).
 * An unknown name returns the same list so a small model can self-correct. Lets a
 * text-protocol local model fetch a tool's exact arguments on demand instead of
 * guessing — without reading the whole doc (which read_file can't reach anyway).
 */
export function buildOllamaToolDocSection(
  name: string,
  profileId?: TaskWraithMcpProfileId | null
): string {
  const wanted = String(name || '').trim()
  const allDefinitions = createTaskWraithMcpToolDefinitions()
  const defs = profileId
    ? profileId.startsWith('taskwraith-gateway-')
      ? filterTaskWraithMcpToolDefinitionsForProfile(profileId, allDefinitions)
      : allDefinitions.filter((definition) =>
          (taskWraithMcpAdvertisedToolNamesForProfile(profileId) as readonly string[]).includes(
            definition.name
          )
        )
    : allDefinitions
  const allNames = defs.map((entry) => entry.name).join(', ')
  if (!wanted) {
    return `All ${defs.length} TaskWraith tools (prefer capability_search; call tool_help with an exact name for its schema, then use capability_invoke for hidden tools): ${allNames}.`
  }
  const def = defs.find((entry) => entry.name === wanted)
  if (!def) {
    return `Unknown tool "${wanted}". Available tools: ${allNames}.`
  }
  return renderToolSectionLines(def).join('\n').trimEnd()
}
