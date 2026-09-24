import { describe, expect, it } from 'vitest'
import { createTaskWraithMcpToolDefinitions } from '../McpToolCatalog'
import { attachMcpResultRepairHints } from './McpResultRepairHints'
import type { McpResultRepairHint } from './McpResultRepairHints'
import { validateGatewayToolArguments } from './McpToolGateway'

/**
 * DO THE REPAIR TEMPLATES ACTUALLY REPLAY?
 *
 * `attachMcpResultRepairHints` answers a failed tool call with a
 * `retryTemplate` — a concrete corrected call the agent is told to send next.
 * That promise is only worth something if the template would be ACCEPTED. A
 * repair that hands back arguments the tool's own schema rejects does not
 * recover the turn: it spends another one and lands the agent in a second
 * failure, having been told it was handed the fix.
 *
 * Nothing checked that. The repair templates are hand-written literals; the
 * schemas are assembled in `McpToolCatalog.ts` out of constants from all over
 * the tree. The two drift apart silently. This validates each emitted template
 * against the same schema the agent was advertised, through the same validator
 * (`validateGatewayToolArguments`) the gateway applies to real calls.
 *
 * COVERAGE IS NOT THE METRIC HERE. The module scopes repairs to
 * CALLER-CORRECTABLE failures by design and documents why: an environment or
 * host failure cannot be fixed by changing the call, so a corrected template
 * there would be a lie. Tools with no repair branch are therefore NOT treated
 * as a gap. What is checked is that the repairs that exist are replayable.
 *
 * Scenarios are explicit and realistic rather than a generated matrix. A
 * generated (tool x error-code) cross-product fires code-keyed branches for
 * tools that could never return those codes and then "fails" on combinations
 * that cannot occur — noise that buries real findings. Every scenario below is
 * a pairing the tool can actually produce, and each one is asserted to still
 * trigger a repair, so a re-keyed or deleted branch reds here instead of
 * quietly dropping out of coverage.
 */

const TOOL_SCHEMAS = new Map(
  createTaskWraithMcpToolDefinitions().map((tool) => [tool.name as string, tool.inputSchema])
)

interface Scenario {
  name: string
  toolName: string
  receivedArguments: Record<string, unknown>
  result: Record<string, unknown>
}

const SCENARIOS: Scenario[] = [
  {
    name: 'ensemble_control set_round_plan without a plan',
    toolName: 'ensemble_control',
    receivedArguments: { action: 'set_round_plan' },
    result: { ok: false, error: 'missing_required_field' }
  },
  {
    name: 'ensemble_bossman_control set_round_plan without a plan',
    toolName: 'ensemble_bossman_control',
    receivedArguments: { action: 'set_round_plan' },
    result: { ok: false, error: 'missing_required_field' }
  },
  {
    name: 'scout_brief with a non-enum confidence',
    toolName: 'scout_brief',
    receivedArguments: { findings: 'the cache is cold on first paint', confidence: 'high-ish' },
    result: { ok: false, error: 'invalid_confidence' }
  },
  {
    name: 'blackboard_post onto a full board',
    toolName: 'blackboard_post',
    receivedArguments: { key: 'status', value: 'green' },
    result: { ok: false, code: 'blackboard_capacity_exhausted' }
  },
  {
    name: 'blackboard_post with an out-of-range ttl',
    toolName: 'blackboard_post',
    receivedArguments: { key: 'status', value: 'green', ttlMinutes: 99_999 },
    result: { ok: false, code: 'blackboard_ttl_invalid' }
  },
  {
    name: 'blackboard_post with an over-long key',
    toolName: 'blackboard_post',
    receivedArguments: { key: 'k'.repeat(300), value: 'green' },
    result: { ok: false, code: 'blackboard_key_too_long', maxLength: 64, originalLength: 300 }
  },
  {
    name: 'blackboard_post with an over-long value',
    toolName: 'blackboard_post',
    receivedArguments: { key: 'status', value: 'v'.repeat(9000) },
    result: { ok: false, code: 'blackboard_value_too_long', maxLength: 4000, originalLength: 9000 }
  },
  {
    name: 'blackboard_delete selector matching nothing',
    toolName: 'blackboard_delete',
    receivedArguments: { keys: ['retired'] },
    result: {
      ok: false,
      error: 'No blackboard entries matched. Pass ids, keys, category, or all:true to delete.'
    }
  }
]

/**
 * Branches whose template deliberately contains a fill-in placeholder but does
 * NOT set `requiresInput`, so a replayer trusting that flag sends the
 * placeholder verbatim and is rejected by the tool's own schema.
 *
 * `requiresInput` is a real convention, not an idea: `EnsembleFanoutRepair.ts`
 * computes it and its suite asserts both values. The branches below simply do
 * not participate, so the flag cannot currently be trusted as "this template is
 * directly replayable".
 *
 * Schema validation alone does NOT catch these. `planSummary: '<plan>'` is a
 * perfectly valid string and passes the validator above; only the placeholder
 * check finds it. That is why both assertions exist.
 *
 * This list is a BASELINE OF KNOWN GAPS, not an approval. Adding a new
 * placeholder template without `requiresInput` reds this file, and fixing one
 * of these reds it too — at which point delete the entry rather than
 * regenerating the list.
 */
const PLACEHOLDER_WITHOUT_REQUIRES_INPUT = [
  'ensemble_control set_round_plan without a plan',
  'ensemble_bossman_control set_round_plan without a plan',
  'blackboard_post with an out-of-range ttl',
  'blackboard_post with an over-long key',
  'blackboard_post with an over-long value'
]

const PLACEHOLDER = /^<.*>$/

function emitHint(scenario: Scenario): McpResultRepairHint | undefined {
  const enriched = attachMcpResultRepairHints({
    toolName: scenario.toolName,
    receivedArguments: scenario.receivedArguments,
    result: scenario.result
  })
  return (enriched as { repair?: McpResultRepairHint }).repair
}

/**
 * Two template conventions live in this one field: an explicit
 * `{ tool, arguments }` envelope (blackboard repairs, which may redirect to a
 * DIFFERENT tool) and a bare argument object for the tool that just failed
 * (ensemble/scout repairs). Both are legitimate; a replayer must handle both,
 * so this test does too.
 */
function resolveTemplateCall(
  originTool: string,
  template: Record<string, unknown>
): { tool: string; args: Record<string, unknown> } {
  if (typeof template.tool === 'string') {
    const args = template.arguments
    return {
      tool: template.tool,
      args:
        args && typeof args === 'object' && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {}
    }
  }
  return { tool: originTool, args: template }
}

function placeholderKeys(args: Record<string, unknown>): string[] {
  return Object.entries(args)
    .filter(([, value]) => typeof value === 'string' && PLACEHOLDER.test(value))
    .map(([key]) => key)
}

describe('MCP repair templates replay against the advertised schema', () => {
  it.each(SCENARIOS)('still emits a repair for $name', (scenario) => {
    // Drift guard: if a branch is re-keyed or removed, its scenario stops
    // producing a hint and reds here rather than silently leaving coverage.
    expect(emitHint(scenario), `no repair emitted for ${scenario.name}`).toBeDefined()
  })

  it('names a tool that exists in the advertised catalogue', () => {
    for (const scenario of SCENARIOS) {
      const hint = emitHint(scenario)!
      const { tool } = resolveTemplateCall(scenario.toolName, hint.retryTemplate)
      expect(TOOL_SCHEMAS.has(tool), `${scenario.name}: unknown target tool "${tool}"`).toBe(true)
    }
  })

  it('produces directly replayable arguments wherever it claims to', () => {
    const rejected: string[] = []
    for (const scenario of SCENARIOS) {
      const hint = emitHint(scenario)!
      const { tool, args } = resolveTemplateCall(scenario.toolName, hint.retryTemplate)
      if (hint.requiresInput || PLACEHOLDER_WITHOUT_REQUIRES_INPUT.includes(scenario.name)) continue
      const validation = validateGatewayToolArguments(TOOL_SCHEMAS.get(tool), args)
      if (!validation.ok) {
        rejected.push(`${scenario.name} -> ${tool}: ${JSON.stringify(validation.issues)}`)
      }
    }
    // A repair the agent cannot replay is worse than no repair: it costs a
    // second turn and reports a confidence the harness has not earned.
    expect(rejected, 'repair templates rejected by their own tool schema').toEqual([])
  })

  it('pins exactly which templates carry an unflagged placeholder', () => {
    const unflagged: string[] = []
    for (const scenario of SCENARIOS) {
      const hint = emitHint(scenario)!
      const { args } = resolveTemplateCall(scenario.toolName, hint.retryTemplate)
      const placeholders = placeholderKeys(args)
      if (placeholders.length > 0 && !hint.requiresInput) unflagged.push(scenario.name)
    }
    // Both directions red: a NEW unflagged placeholder template appears here,
    // and a FIXED one disappears from it. Either way the baseline is stale and
    // wants editing by hand, not regenerating.
    expect(unflagged.sort(), 'unflagged placeholder templates changed').toEqual(
      [...PLACEHOLDER_WITHOUT_REQUIRES_INPUT].sort()
    )
  })

  it('explains itself and reports the keys it saw', () => {
    for (const scenario of SCENARIOS) {
      const hint = emitHint(scenario)!
      expect(hint.why.length, `${scenario.name} has a thin why`).toBeGreaterThan(20)
      expect(Array.isArray(hint.receivedKeys), `${scenario.name} lost receivedKeys`).toBe(true)
    }
  })
})
