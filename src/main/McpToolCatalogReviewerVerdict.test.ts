import { describe, expect, it } from 'vitest'
import { createTaskWraithMcpToolDefinitions } from './McpToolCatalog'
import {
  resolveGatewayInvocation,
  validateGatewayToolArguments,
  type GatewayToolDefinition
} from './mcp/McpToolGateway'

/**
 * C2b-ii-e — HONEST schema completion for the nested reviewer-verdict action.
 *
 * The handler (C2b-i-b), the index dispatch (C2b-ii-b), and the read-only reachability
 * (C2b-ii-a/c/d) all shipped, but the PUBLISHED ensemble_bossman_control input schema
 * never declared the submit_review_verdict action or the verdict property — so the
 * gateway validator (validateGatewayToolArguments, which enforces `enum`) rejected the
 * exact RO/plan capability_invoke reviewer verdict at target_argument_validation_failed.
 * This closes that pre-existing contract gap by declaring the action + verdict in the
 * catalogue. It grants DISCOVERABILITY only — isExactReviewerVerdictInvocation remains
 * the sole EXECUTION floor (advertise != execute), and the tool is NOT added to any
 * participation / auto-allow / advertise / whole-tool set.
 */

function bossmanSchema(): Record<string, unknown> {
  const bossman = createTaskWraithMcpToolDefinitions().find(
    (tool) => tool.name === 'ensemble_bossman_control'
  )
  if (!bossman) throw new Error('ensemble_bossman_control missing from the catalogue')
  return bossman.inputSchema as Record<string, unknown>
}

// The catalogue definitions are structurally the gateway's definition shape (name +
// inputSchema); the real gateway caller (index.ts) feeds the same catalogue in.
const catalogDefs = () =>
  createTaskWraithMcpToolDefinitions() as unknown as GatewayToolDefinition[]

const exact = (verdict: 'passed' | 'failed') => ({
  action: 'submit_review_verdict',
  gateId: 'g1',
  verdict
})

describe('C2b-ii-e ensemble_bossman_control reviewer-verdict schema completion', () => {
  it('declares submit_review_verdict in the action enum and a verdict passed|failed property', () => {
    const schema = bossmanSchema() as {
      properties?: {
        action?: { enum?: string[] }
        verdict?: { type?: string; enum?: string[] }
      }
    }
    expect(schema.properties?.action?.enum).toContain('submit_review_verdict')
    expect(schema.properties?.verdict).toMatchObject({ type: 'string', enum: ['passed', 'failed'] })
  })

  it('the live gateway validator now ACCEPTS the exact reviewer verdict against the real schema (both verdicts)', () => {
    for (const verdict of ['passed', 'failed'] as const) {
      expect(validateGatewayToolArguments(bossmanSchema(), exact(verdict))).toEqual({ ok: true })
    }
  })

  it('the gateway validator REJECTS an invalid verdict or an invalid action against the real schema', () => {
    const badVerdict = validateGatewayToolArguments(bossmanSchema(), {
      action: 'submit_review_verdict',
      gateId: 'g1',
      verdict: 'waived'
    })
    expect(badVerdict.ok).toBe(false)

    const badAction = validateGatewayToolArguments(bossmanSchema(), {
      action: 'not_a_real_action',
      gateId: 'g1',
      verdict: 'passed'
    })
    expect(badAction.ok).toBe(false)
  })

  it('E2E: RO/plan capability_invoke to the exact reviewer verdict now RESOLVES (ii-d eligibility bypass + ii-e schema)', () => {
    // bossman is a direct tool (excluded from the eligible/hidden set); ii-d bypasses
    // eligibility ONLY for the exact payload, and ii-e now lets it pass schema.
    for (const verdict of ['passed', 'failed'] as const) {
      const res = resolveGatewayInvocation({
        name: 'ensemble_bossman_control',
        arguments: exact(verdict),
        definitions: catalogDefs(),
        eligibleToolNames: [] // bossman NOT eligible
      })
      expect(res.ok, verdict).toBe(true)
      if (res.ok) expect(res.name).toBe('ensemble_bossman_control')
    }
  })

  it('E2E: a non-exact bossman action stays rejected at the gateway floor even though the schema allows it (classifier is the floor)', () => {
    // set_goal is a valid schema action, but the classifier only bypasses eligibility for
    // the EXACT reviewer verdict — so a RO capability_invoke to set_goal stays ineligible.
    const res = resolveGatewayInvocation({
      name: 'ensemble_bossman_control',
      arguments: { action: 'set_goal', goal: 'x' },
      definitions: catalogDefs(),
      eligibleToolNames: []
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('ineligible_target')
  })

  it('E2E: an extra-key reviewer-verdict payload stays rejected at the gateway floor (classifier, not the flat schema)', () => {
    // The flat schema permits extra keys, but the classifier requires EXACTLY
    // {action,gateId,verdict}, so a RO capability_invoke with an extra key stays ineligible.
    const res = resolveGatewayInvocation({
      name: 'ensemble_bossman_control',
      arguments: { action: 'submit_review_verdict', gateId: 'g1', verdict: 'passed', reason: 'x' },
      definitions: catalogDefs(),
      eligibleToolNames: []
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('ineligible_target')
  })
})
